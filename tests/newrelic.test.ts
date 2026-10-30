import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMarketingRequest, marketingPatterns } from '../lib/marketing-scope';
import { newrelic } from '../lib/newrelic';

test('Marketing ownership uses route boundaries and excludes generic/shared endpoints', () => {
  for (const path of [
    '/api/gift-card/settings',
    '/api/marketing/gift-card/listing',
    '/api/campaign',
    '/api/review-management/review/1',
    '/api/screen/playlists',
    '/api/webhook/google-notification/review',
    '/api/brandbook',
  ])
    assert.ok(isMarketingRequest(path), path);
  for (const path of [
    '/api/payment/process-payment',
    '/api/menu/website/1',
    '/api/guest/1',
    '/api/campaign-other',
    '/api/payment?next=/api/campaign',
    '/api/*',
    '/api/webhook/payment',
  ])
    assert.equal(isMarketingRequest(path), false, path);
  assert.ok(isMarketingRequest(undefined, 'WebTransaction/Expressjs/GET//api/gift-card/settings'));
  assert.equal(
    isMarketingRequest('/api/payment', 'WebTransaction/Expressjs/GET//api/gift-card/settings'),
    false,
  );
  assert.equal(isMarketingRequest(undefined, 'WebTransaction/Expressjs/GET//api/*'), false);
  assert.ok(
    [...marketingPatterns(), ...marketingPatterns(true)].every((pattern) => pattern.length <= 256),
  );
});
test('query performance returns only spans with confirmed Marketing parents', async () => {
  const originalFetch = globalThis.fetch;
  const keys = [
    'NEW_RELIC_ACCOUNT_ID',
    'NEW_RELIC_USER_KEY',
    'NEW_RELIC_APP_NAME',
    'NEW_RELIC_QUERIES_FILTER',
  ];
  const previous = keys.map((key) => process.env[key]);
  Object.assign(process.env, {
    NEW_RELIC_ACCOUNT_ID: '123',
    NEW_RELIC_USER_KEY: 'test-key',
    NEW_RELIC_APP_NAME: 'test-app',
    NEW_RELIC_QUERIES_FILTER: '',
  });
  const queries: string[] = [];
  globalThis.fetch = async (_url, options) => {
    const nrql = JSON.parse(String(options?.body)).variables.nrql;
    queries.push(nrql);
    const results =
      queries.length === 1
        ? [
            {
              guid: 'marketing-span',
              timestamp: Date.now(),
              transactionId: 'aaaaaaaaaaaaaaaa',
              duration: 0.9,
              name: 'SELECT shared_table',
            },
            {
              guid: 'payments-span',
              timestamp: Date.now(),
              transactionId: 'bbbbbbbbbbbbbbbb',
              duration: 1.1,
              name: 'SELECT shared_table',
            },
            { guid: 'orphan-span', timestamp: Date.now(), duration: 1.2, name: 'SELECT campaign' },
          ]
        : [
            {
              facet: 'aaaaaaaaaaaaaaaa',
              uri: '/api/campaign/list',
              endpoint: 'WebTransaction/Expressjs/GET//api/campaign/list',
            },
            {
              facet: 'bbbbbbbbbbbbbbbb',
              uri: '/api/payment',
              endpoint: 'WebTransaction/Expressjs/GET//api/payment',
            },
          ];
    return Response.json({ data: { actor: { account: { nrql: { results } } } } });
  };
  try {
    const result = await newrelic({
      source: 'newrelic',
      view: 'queries',
      start: Date.now() - 3600000,
      end: Date.now(),
      refresh: false,
    });
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].id, 'newrelic:marketing-span');
    assert.equal(result.events[0].endpoint, '/api/campaign/list');
    assert.ok(queries[0].includes('duration > 0.5'));
    assert.ok(queries[1].includes('guid IN'));
    assert.ok(queries[1].includes('RLIKE'));
  } finally {
    globalThis.fetch = originalFetch;
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});
