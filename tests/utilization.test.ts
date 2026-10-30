import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NextRequest } from 'next/server';
import { GET } from '../app/api/utilization/route';
import { issueSession } from '../lib/auth';
import {
  addUsage,
  emptyUsage,
  utilizationInput,
  type UtilizationBatch,
} from '../lib/utilization-model';
import { utilizationSql } from '../lib/utilization-sql';

test('utilization requires authentication before reading the DB', async () => {
  const response = await GET(new NextRequest('http://localhost/api/utilization'));
  assert.equal(response.status, 401);
});

test('invalid utilization pagination is rejected before reading the DB', async () => {
  const response = await GET(
    new NextRequest('http://localhost/api/utilization?offset=-4', {
      headers: { cookie: `pulse_session=${issueSession()}` },
    }),
  );
  assert.equal(response.status, 400);
});

test('snapshot stays bounded and pagination cannot inject SQL', () => {
  const now = 1800000000000;
  assert.deepEqual(utilizationInput(new URLSearchParams(), now), {
    at: now,
    offset: 0,
    refresh: false,
  });
  for (const value of ['-4', '1', 'NaN', '4;DROP TABLE restaurant'])
    assert.throws(() => utilizationInput(new URLSearchParams({ offset: value }), now));
  for (const at of [now + 300000, now - 3600001, 1.5])
    assert.throws(() => utilizationInput(new URLSearchParams({ at: String(at) }), now));
  assert.throws(() => utilizationSql(Number.NaN));
  assert.throws(() => utilizationSql(-1));
  assert.throws(() => utilizationSql(1.5));
});

test('batch accumulation preserves coverage and keeps the candidate population fixed', () => {
  const batch: UtilizationBatch = {
    at: 1800000000000,
    nextOffset: 4,
    totalBusinesses: 5,
    liveRestaurants: 5,
    candidateRestaurants: 9,
    checkedRestaurants: 5,
    failedBusinesses: 0,
    counts: { ...emptyUsage(), giftCards: 3 },
  };
  const next = {
    ...batch,
    nextOffset: null,
    liveRestaurants: 1,
    checkedRestaurants: 1,
    failedBusinesses: 1,
    counts: { ...emptyUsage(), giftCards: 1 },
  };
  const sum = addUsage(addUsage(null, batch), next);
  assert.equal(sum.liveRestaurants, 6);
  assert.equal(sum.candidateRestaurants, 9);
  assert.equal(sum.checkedRestaurants, 6);
  assert.equal(sum.counts.giftCards, 4);
  assert.equal(sum.failedBusinesses, 1);
  assert.equal(sum.nextOffset, null);
  assert.equal(batch.counts.giftCards, 3);
});

test('usage counts restaurants once and excludes failed business queries from coverage', async (t) => {
  const { Pool } = await import('pg');
  const { utilization } = await import('../lib/utilization');
  const oldUrl = process.env.AUDIT_DATABASE_URL;
  process.env.AUDIT_DATABASE_URL = 'postgresql://unused:unused@localhost/unused';
  let queries = 0;
  t.mock.method(Pool.prototype, 'query', async (sql: string) => {
    queries++;
    if (sql.includes('FROM public.restaurant'))
      return {
        rows: [
          { id: 123, restaurants: [1, 3] },
          { id: 124, restaurants: [2] },
        ],
      };
    if (sql.includes('tenant_124')) throw new Error('permission denied (private details)');
    return {
      rows: [
        {
          id: 1,
          giftCards: true,
          loyalty: false,
          campaigns: true,
          arm: false,
          deals: false,
          guestbook: true,
          journeys: true,
        },
      ],
    };
  });
  try {
    const result = await utilization(0, 1800000000000, true);
    assert.equal(queries, 3);
    assert.equal(result.liveRestaurants, 1);
    assert.equal(result.candidateRestaurants, 3);
    assert.equal(result.checkedRestaurants, 2);
    assert.equal(result.failedBusinesses, 1);
    assert.equal(result.counts.giftCards, 1);
    assert.equal(result.counts.loyalty, 0);
    assert.equal(JSON.stringify(result).includes('private details'), false);
  } finally {
    if (oldUrl === undefined) delete process.env.AUDIT_DATABASE_URL;
    else process.env.AUDIT_DATABASE_URL = oldUrl;
  }
});
