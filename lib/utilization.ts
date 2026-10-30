import { database } from './database';
import { get, put } from './store';
import { emptyUsage, utilizationMetrics, type UtilizationBatch } from './utilization-model';
import { utilizationSql } from './utilization-sql';

type Business = { id: number; restaurants: number[] };

export async function utilization(
  offset: number,
  at: number,
  refresh: boolean,
): Promise<UtilizationBatch> {
  const populationKey = `utilization:population:v1:${at}`;
  let businesses = await get<Business[]>(populationKey);
  if (!businesses) {
    const result = await database().query<Business>(`
      SELECT b.id, array_agg(r.id ORDER BY r.id) AS restaurants
      FROM public.restaurant r JOIN public.business b ON b.id = r."businessId"
      JOIN pg_namespace n ON n.nspname = 'tenant_' || b.id::text
      JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = 'restaurant' AND c.relkind IN ('r','p')
      WHERE r."recordStatus"::text = 'Active' AND b.status::text = 'Active' AND b."deletedAt" IS NULL
      GROUP BY b.id ORDER BY b.id`);
    businesses = result.rows;
    await put(populationKey, businesses, 3600);
  }
  if (offset > businesses.length) throw new Error('Invalid utilization page');
  const cacheKey = `utilization:batch:v2:${at}:${offset}`;
  if (!refresh) {
    const cached = await get<UtilizationBatch>(cacheKey);
    if (cached) return cached;
  }
  const selected = businesses.slice(offset, offset + 4);
  const results = await Promise.allSettled(
    selected.map(async (business) => {
      const result = await database().query(utilizationSql(business.id), [
        business.restaurants,
        new Date(at - 30 * 86400000),
        new Date(at),
      ]);
      return result.rows;
    }),
  );
  const batch: UtilizationBatch = {
    at,
    nextOffset: offset + 4 < businesses.length ? offset + 4 : null,
    totalBusinesses: businesses.length,
    liveRestaurants: 0,
    candidateRestaurants: businesses.reduce((sum, b) => sum + b.restaurants.length, 0),
    checkedRestaurants: 0,
    failedBusinesses: 0,
    counts: emptyUsage(),
  };
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      batch.failedBusinesses++;
      continue;
    }
    batch.checkedRestaurants += selected[index].restaurants.length;
    batch.liveRestaurants += result.value.length;
    for (const row of result.value)
      for (const { key } of utilizationMetrics) if (row[key] === true) batch.counts[key]++;
  }
  if (!batch.failedBusinesses) await put(cacheKey, batch, 300);
  return batch;
}
