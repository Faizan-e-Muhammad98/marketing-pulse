'use client';
import { useEffect, useState } from 'react';
import { addUsage, utilizationMetrics, type UtilizationBatch } from '../lib/utilization-model';

export function Utilization({ onExpired }: { onExpired: () => void }) {
  const [generation, setGeneration] = useState(0);
  const [data, setData] = useState<UtilizationBatch | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      let total: UtilizationBatch | null = null;
      let offset: number | null = 0;
      let at: number | undefined;
      setLoading(true);
      setError('');
      setData(null);
      try {
        while (offset !== null) {
          const params = new URLSearchParams({ offset: String(offset) });
          if (at !== undefined) params.set('at', String(at));
          if (generation) params.set('refresh', '1');
          const response = await fetch(`/api/utilization?${params}`, { signal: controller.signal });
          if (response.status === 401) {
            onExpired();
            return;
          }
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || 'Could not load utilization.');
          const batch = body as UtilizationBatch;
          total = addUsage(total, batch);
          if (controller.signal.aborted) return;
          setData(total);
          offset = batch.nextOffset;
          at = batch.at;
        }
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Could not load utilization.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void load();
    return () => controller.abort();
  }, [generation, onExpired]);
  const complete = !!data && !loading && !error && data.failedBusinesses === 0;
  return (
    <main className="dashboard">
      <div className="usage-heading">
        <div>
          <span className="eyebrow">MARKETING ADOPTION</span>
          <h1>Utilization</h1>
          <p className="muted">Restaurants using Marketing · Rolling 30 days</p>
        </div>
        <button className="primary" disabled={loading} onClick={() => setGeneration((n) => n + 1)}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>
      <p className="muted">
        Live restaurants are active locations in active businesses with a matching active restaurant
        record in their provisioned tenant schema. Setup and Guestbook checks use current data;
        activity uses the 30-day window.
      </p>
      <div role="status" aria-live="polite" className="usage-status">
        {data
          ? `${data.checkedRestaurants.toLocaleString()} of ${data.candidateRestaurants.toLocaleString()} restaurant records checked${loading ? ' — loading more…' : ''}.`
          : loading
            ? 'Checking live restaurants…'
            : 'Usage data unavailable.'}
        {data && data.failedBusinesses > 0 && (
          <span>
            {' '}
            {data.failedBusinesses} business(es) could not be checked. Check tenant table
            permissions, schema compatibility and query timeouts.
          </span>
        )}
        {!complete && data && (
          <span> Counts are partial; percentages appear when coverage is complete.</span>
        )}
      </div>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <div className="usage-grid">
        <article className="usage-card">
          <span className="eyebrow">Restaurants Live</span>
          <strong>
            {data ? `${!complete ? '≥ ' : ''}${data.liveRestaurants.toLocaleString()}` : '—'}
          </strong>
          <p>Active &amp; provisioned</p>
        </article>
        {utilizationMetrics.map(({ key, label, description }) => (
          <article className="usage-card" key={key}>
            <span className="eyebrow">{label}</span>
            <strong>
              {data && data.checkedRestaurants > 0
                ? `${!complete ? '≥ ' : ''}${data.counts[key].toLocaleString()}`
                : complete
                  ? '0'
                  : '—'}
            </strong>
            <span className="usage-percent">
              {complete && data.liveRestaurants > 0
                ? `${((100 * data.counts[key]) / data.liveRestaurants).toFixed(1)}% of live restaurants`
                : 'Restaurants'}
            </span>
            <p>{description}</p>
          </article>
        ))}
      </div>
      <p className="small muted">
        {data && (
          <>
            Activity window: {new Date(data.at - 30 * 86400000).toLocaleString()} –{' '}
            {new Date(data.at).toLocaleString()}.{' '}
          </>
        )}
        Results cached for 5 minutes. Each restaurant counts once per feature. Contact validation
        checks format, not deliverability. Paid-order activity excludes unpaid and fully refunded
        orders.
      </p>
    </main>
  );
}
