import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestSource } from '../lib/source-client';
import type { LogEvent, SourceResult } from '../lib/model';
const event = (id: string): LogEvent => ({
  id,
  source: 'cloudwatch',
  timestamp: '2026-10-23T00:00:00Z',
  message: 'event',
  severity: 'info',
  service: 'test',
});
const response = (events: LogEvent[], complete = false): SourceResult => ({
  source: 'cloudwatch',
  status: complete ? 'ready' : 'pending',
  events,
  complete,
  handle: 'next',
  retryAfterMs: 0,
  queriedAt: '2026-10-23T00:00:00Z',
});

test('client publishes first page early, merges later pages and deduplicates replays', async (t) => {
  let calls = 0;
  const counts: number[] = [];
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 2) assert.deepEqual(counts, [1]);
    return Response.json(
      calls === 1
        ? response([event('one')])
        : calls === 2
          ? response([event('one'), event('two')])
          : response([event('three')], true),
    );
  });
  const result = await requestSource('cloudwatch', 'logs', 1, 2, false, undefined, undefined, (r) =>
    counts.push(r.events.length),
  );
  assert.deepEqual(counts, [1, 2, 3]);
  assert.equal(result.complete, true);
  assert.equal(result.events.length, 3);
});

test('client preserves loaded pages on network or source failures', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls === 1) return Response.json(response([event('kept')]));
    throw new Error('Network unavailable');
  });
  const result = await requestSource('cloudwatch', 'logs', 1, 2, false);
  assert.equal(result.status, 'error');
  assert.equal(result.complete, false);
  assert.equal(result.events[0].id, 'kept');
  assert.match(result.message!, /incomplete/);
});

test('client cancellation stops further requests and does not report complete', async (t) => {
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json(response([event('one')]));
  });
  await assert.rejects(
    requestSource('cloudwatch', 'logs', 1, 2, false, controller.signal, undefined, () =>
      controller.abort(),
    ),
  );
  assert.equal(calls, 1);
});

test('client preserves session-expired handling', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 401 }));
  await assert.rejects(requestSource('cloudwatch', 'logs', 1, 2, false), /SESSION_EXPIRED/);
});

test('client backs off on rate limits and resumes the same continuation', async (t) => {
  let calls = 0;
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls++;
    urls.push(url);
    if (calls === 1) return Response.json(response([event('first')]));
    if (calls === 2) return new Response('{}', { status: 429, headers: { 'Retry-After': '1' } });
    return Response.json(response([event('last')], true));
  });
  const result = await requestSource('cloudwatch', 'logs', 1, 2, false);
  assert.equal(result.events.length, 2);
  assert.equal(result.complete, true);
  assert.equal(urls[1], urls[2]);
});

test('source budget errors retain earlier pages and remain incomplete', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      ++calls === 1
        ? response([event('first')])
        : { ...response([]), status: 'error', message: 'Scan budget exceeded' },
    ),
  );
  const result = await requestSource('cloudwatch', 'logs', 1, 2, false);
  assert.equal(result.events.length, 1);
  assert.equal(result.complete, false);
  assert.equal(result.status, 'error');
});
