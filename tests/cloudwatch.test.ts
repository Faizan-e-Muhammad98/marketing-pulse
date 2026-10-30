import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { cloudwatch } from '../lib/cloudwatch';
import { put } from '../lib/store';
import { randomUUID } from 'node:crypto';
import type { QueryInput, SourceResult } from '../lib/model';

type Command = {
  constructor: { name: string };
  input: { queryId?: string; maxItems?: number; nextToken?: string; queryString?: string };
};
const row = (id: string, message = 'LOG [Campaign] event') => [
  { field: '@timestamp', value: '2026-10-23 00:00:00.000' },
  { field: '@message', value: message },
  { field: '@ptr', value: id },
];
const input = (): QueryInput => {
  const end = Date.now();
  return { source: 'cloudwatch', view: 'logs', start: end - 21600000, end, refresh: false };
};

function configure(t: TestContext) {
  const keys = [
    'AWS_REGION',
    'CLOUDWATCH_LOG_GROUPS',
    'CLOUDWATCH_MARKETING_PATTERN',
    'CLOUDWATCH_MAX_SCAN_BYTES',
  ];
  const old = keys.map((k) => process.env[k]);
  Object.assign(process.env, {
    AWS_REGION: 'us-west-2',
    CLOUDWATCH_LOG_GROUPS: '/test',
    CLOUDWATCH_MARKETING_PATTERN: 'Campaign',
    CLOUDWATCH_MAX_SCAN_BYTES: '1073741824',
  });
  t.after(() =>
    keys.forEach((key, i) => {
      if (old[i] === undefined) delete process.env[key];
      else process.env[key] = old[i];
    }),
  );
}

async function step(q: QueryInput): Promise<SourceResult> {
  const result = await cloudwatch(q, 'owner');
  if (result.handle) q.handle = result.handle;
  return result;
}

test('CloudWatch streams beyond 1,000 records; replays a page without another AWS call', async (t) => {
  configure(t);
  let starts = 0,
    polls = 0;
  t.mock.method(CloudWatchLogsClient.prototype, 'send', async (c: Command) => {
    if (c.constructor.name === 'StartQueryCommand') {
      starts++;
      assert.match(c.input.queryString!, /limit 100000$/);
      return { queryId: 'large' };
    }
    assert.equal(c.input.maxItems, 250);
    assert.equal(c.input.nextToken, polls ? String(polls) : undefined);
    polls++;
    return {
      status: 'Complete',
      results: Array.from({ length: 250 }, (_, i) => row(`${polls}-${i}`)),
      nextToken: polls < 5 ? String(polls) : undefined,
      statistics: { bytesScanned: 100 },
    };
  });
  const q = input();
  await step(q);
  let count = 0;
  for (let i = 0; i < 5; i++) {
    const previous = q.handle;
    const result = await step(q);
    count += result.events.length;
    assert.equal(result.events.length, 250);
    assert.equal(result.complete, i === 4);
    assert.equal(result.status, i === 4 ? 'ready' : 'pending');
    assert.deepEqual(await cloudwatch({ ...q, handle: previous }, 'owner'), result);
    assert.equal(polls, i + 1);
    await assert.rejects(cloudwatch({ ...q, handle: previous }, 'other-owner'), /invalid/);
  }
  assert.equal(count, 1250);
  assert.equal(starts, 1);
});

test('CloudWatch splits capped windows with exact non-overlapping boundaries and cumulative scan accounting', async (t) => {
  configure(t);
  let starts = 0;
  const windows: string[] = [];
  t.mock.method(CloudWatchLogsClient.prototype, 'send', async (c: Command) => {
    if (c.constructor.name === 'StartQueryCommand') {
      windows.push(c.input.queryString!);
      return { queryId: String(++starts) };
    }
    return c.input.queryId === '1'
      ? {
          status: 'Complete',
          statistics: { recordsMatched: 100001, bytesScanned: 10 },
          results: [row('discard-parent')],
        }
      : {
          status: 'Complete',
          statistics: { recordsMatched: 1, bytesScanned: 20 },
          results: [row(c.input.queryId!)],
        };
  });
  const q = input(),
    middle = Math.floor((q.start + q.end) / 2);
  await step(q);
  assert.equal((await step(q)).events.length, 0); // capped parent is not shown as complete
  await step(q);
  const newer = await step(q);
  assert.equal(newer.status, 'pending');
  assert.equal(newer.events.length, 1);
  await step(q);
  const older = await step(q);
  assert.equal(older.complete, true);
  assert.equal(older.scannedBytes, 50);
  assert.match(windows[1], new RegExp(`>= ${middle} and toMillis\\(@timestamp\\) < ${q.end}`));
  assert.match(windows[2], new RegExp(`>= ${q.start} and toMillis\\(@timestamp\\) < ${middle}`));
  assert.equal(starts, 3);
});

test('CloudWatch falls back to smaller pages on reset and retains the same query/token', async (t) => {
  configure(t);
  let polls = 0,
    starts = 0;
  t.mock.method(CloudWatchLogsClient.prototype, 'send', async (c: Command) => {
    if (c.constructor.name === 'StartQueryCommand') {
      starts++;
      return { queryId: 'retry' };
    }
    polls++;
    assert.equal(c.input.queryId, 'retry');
    if (polls === 1)
      return {
        status: 'Complete',
        results: [row('first', 'ERROR [Campaign] token=secret')],
        nextToken: 'second',
      };
    assert.equal(c.input.nextToken, 'second');
    if (polls === 2) {
      assert.equal(c.input.maxItems, 250);
      throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    }
    assert.equal(c.input.maxItems, 100);
    return { status: 'Complete', results: [row('second')] };
  });
  const q = input();
  await step(q);
  const first = await step(q);
  assert.doesNotMatch(first.events[0].message, /secret/);
  const retry = await step(q);
  assert.equal(retry.status, 'pending');
  assert.equal(retry.retryAfterMs, undefined);
  assert.equal((await step(q)).complete, true);
  assert.equal(starts, 1);
});

test('CloudWatch stops after three transient failures and rejects permission failures immediately', async (t) => {
  configure(t);
  let stops = 0,
    denied = false;
  t.mock.method(CloudWatchLogsClient.prototype, 'send', async (c: Command) => {
    if (c.constructor.name === 'StartQueryCommand') return { queryId: 'failure' };
    if (c.constructor.name === 'StopQueryCommand') {
      stops++;
      return {};
    }
    throw Object.assign(new Error('private upstream text'), {
      name: denied ? 'AccessDeniedException' : 'AbortError',
    });
  });
  const q = input();
  await step(q);
  await step(q);
  await step(q);
  const result = await step(q);
  assert.equal(result.status, 'error');
  assert.equal(result.complete, false);
  assert.equal(stops, 1);
  denied = true;
  const q2 = input();
  await step(q2);
  await assert.rejects(step(q2), { name: 'AccessDeniedException' });
});

test('CloudWatch applies the budget across parent and child queries', async (t) => {
  configure(t);
  process.env.CLOUDWATCH_MAX_SCAN_BYTES = '1000';
  let starts = 0;
  t.mock.method(CloudWatchLogsClient.prototype, 'send', async (c: Command) =>
    c.constructor.name === 'StartQueryCommand'
      ? { queryId: String(++starts) }
      : {
          status: 'Complete',
          statistics: { recordsMatched: starts === 1 ? 100001 : 1, bytesScanned: 600 },
          results: [row('row')],
        },
  );
  const q = input();
  await step(q);
  await step(q);
  await step(q);
  const result = await step(q);
  assert.equal(result.status, 'error');
  assert.equal(result.scannedBytes, 1200);
  assert.equal(result.complete, false);
  assert.equal(starts, 2);
});

test('CloudWatch does not apply the five-minute scan deadline to completed-page downloads', async (t) => {
  configure(t);
  const q = input();
  q.handle = randomUUID();
  await put(
    `cw:${q.handle}`,
    {
      owner: 'owner',
      start: q.start,
      end: q.end,
      view: q.view,
      window: { start: q.start, end: q.end },
      remaining: [],
      id: 'completed',
      started: Date.now() - 600000,
      nextToken: 'page-two',
      rows: 250,
      queryBytes: 20,
      scannedBytes: 20,
    },
    3600,
  );
  t.mock.method(CloudWatchLogsClient.prototype, 'send', async (c: Command) => {
    assert.equal(c.constructor.name, 'GetQueryResultsCommand');
    return { status: 'Complete', results: [row('last')], statistics: { bytesScanned: 20 } };
  });
  const result = await step(q);
  assert.equal(result.complete, true);
  assert.equal(result.scannedBytes, 20);
});

test('A saturated millisecond is explicitly incomplete rather than silently capped', async (t) => {
  configure(t);
  const q = input();
  q.start = q.end - 1;
  t.mock.method(CloudWatchLogsClient.prototype, 'send', async (c: Command) =>
    c.constructor.name === 'StartQueryCommand'
      ? { queryId: 'dense' }
      : { status: 'Complete', statistics: { recordsMatched: 100000 }, results: [] },
  );
  await step(q);
  const result = await step(q);
  assert.equal(result.status, 'error');
  assert.equal(result.complete, false);
  assert.match(result.message!, /one millisecond/);
});
