import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { GET as logs } from '../app/api/logs/route';
import { POST as login, DELETE as logout } from '../app/api/auth/route';
import { issueSession, sameOrigin } from '../lib/auth';

test('cross-origin login/logout is blocked while local development supports 127.0.0.1', async () => {
  const req = new NextRequest('http://localhost:3000/api/auth', {
    method: 'POST',
    headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
  });
  assert.equal(sameOrigin(req), true);
  const hostile = new NextRequest('http://localhost:3000/api/auth', {
    method: 'POST',
    headers: { host: 'localhost:3000', origin: 'https://attacker.example' },
  });
  assert.equal((await login(hostile)).status, 403);
  assert.equal((await logout(hostile)).status, 403);
});
test('log endpoints require authentication before processing input', async () => {
  assert.equal((await logs(new NextRequest('http://localhost:3000/api/logs'))).status, 401);
});
test('authenticated queries reject out-of-range input', async () => {
  const req = new NextRequest(
    'http://localhost:3000/api/logs?source=audit&view=logs&start=1&end=2',
    { headers: { cookie: `pulse_session=${issueSession()}` } },
  );
  assert.equal((await logs(req)).status, 400);
});
test('configured session gets explicit unconfigured state, not fabricated records', async () => {
  const now = Date.now();
  const req = new NextRequest(
    `http://localhost:3000/api/logs?source=audit&view=logs&start=${now - 3600000}&end=${now}`,
    { headers: { cookie: `pulse_session=${issueSession()}` } },
  );
  const response = await logs(req);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'unconfigured');
  assert.deepEqual(body.events, []);
});

test('CloudWatch caches the initial continuation, never the final page as the full result', async (t) => {
  const { CloudWatchLogsClient } = await import('@aws-sdk/client-cloudwatch-logs');
  const keys = ['AWS_REGION', 'CLOUDWATCH_LOG_GROUPS', 'CLOUDWATCH_MARKETING_PATTERN'];
  const old = keys.map((k) => process.env[k]);
  Object.assign(process.env, {
    AWS_REGION: 'us-west-2',
    CLOUDWATCH_LOG_GROUPS: '/test',
    CLOUDWATCH_MARKETING_PATTERN: 'Campaign',
  });
  t.after(() =>
    keys.forEach((key, i) => {
      if (old[i] === undefined) delete process.env[key];
      else process.env[key] = old[i];
    }),
  );
  let starts = 0,
    polls = 0;
  t.mock.method(
    CloudWatchLogsClient.prototype,
    'send',
    async (c: { constructor: { name: string } }) => {
      if (c.constructor.name === 'StartQueryCommand') {
        starts++;
        return { queryId: 'route-paged' };
      }
      polls++;
      return {
        status: 'Complete',
        nextToken: polls === 1 ? 'next' : undefined,
        results: [
          [
            { field: '@timestamp', value: '2026-10-23 00:00:00.000' },
            { field: '@message', value: 'LOG [Campaign] ok' },
            { field: '@ptr', value: String(polls) },
          ],
        ],
      };
    },
  );
  const end = Date.now(),
    cookie = `pulse_session=${issueSession()}`;
  const url = `http://localhost:3000/api/logs?source=cloudwatch&view=logs&start=${end - 60000}&end=${end}`;
  const call = async (handle?: string) =>
    (
      await logs(
        new NextRequest(url + (handle ? `&handle=${handle}` : ''), { headers: { cookie } }),
      )
    ).json();
  const initial = await call();
  const first = await call(initial.handle);
  const final = await call(first.handle);
  assert.equal(first.events.length, 1);
  assert.equal(final.complete, true);
  assert.deepEqual(await call(), initial);
  assert.equal(starts, 1);
  assert.deepEqual(await call(initial.handle), first);
  assert.equal(polls, 2);
});
