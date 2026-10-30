import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupErrors, redact, severity, validateQuery, type LogEvent } from '../lib/model';
import { issueSession, verifySession, verifyPassword } from '../lib/auth';
import { rateLimit } from '../lib/store';
const now = Date.now();
test('time ranges reject unbounded scans and invalid sources', () => {
  const params = new URLSearchParams({
    source: 'audit',
    view: 'logs',
    start: String(now - 3600000),
    end: String(now),
  });
  assert.equal(validateQuery(params, now).source, 'audit');
  params.set('start', String(now - 8 * 86400000));
  assert.throws(() => validateQuery(params, now));
  params.set('source', 'other');
  assert.throws(() => validateQuery(params, now));
});
test('redaction removes credentials, email, and URL parameters', () => {
  const result = redact(
    'Bearer abc.def password=secret bob@example.com /api?token=abc&email=alice@example.com',
  );
  for (const value of ['abc.def', 'secret', 'bob@example.com', 'alice@example.com', 'token=abc'])
    assert.ok(!result.includes(value));
});
test('legacy query errors logged at info still classify as errors', () => {
  assert.equal(severity('Error: query failed', 'log'), 'error');
  assert.equal(severity('Slow Query (501ms): SELECT 1'), 'warn');
});
test('grouping combines volatile UUIDs but preserves source and meaningful error codes', () => {
  const base: LogEvent = {
    id: '1',
    source: 'audit',
    timestamp: '2026-10-22T01:00:00Z',
    service: 'backend',
    severity: 'error',
    message: 'Request 123e4567-e89b-12d3-a456-426614174000 failed 401',
  };
  const events: LogEvent[] = [
    base,
    {
      ...base,
      id: '2',
      timestamp: '2026-10-22T02:00:00Z',
      message: base.message.replace('426614174000', '426614174001'),
    },
    { ...base, id: '3', source: 'newrelic' },
    { ...base, id: '4', message: base.message.replace('401', '500') },
  ];
  const groups = groupErrors(events);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].last, '2026-10-22T02:00:00Z');
});
test('sessions reject tampering and malformed tokens', () => {
  const token = issueSession();
  assert.ok(verifySession(token));
  assert.equal(verifySession(`${token}x`), null);
  assert.equal(verifySession('bad'), null);
  assert.equal(verifySession(`${token}.extra`), null);
});
test('development admin login rejects other users/passwords', () => {
  assert.equal(verifyPassword('admin', 'wrong'), false);
  assert.equal(verifyPassword('other', 'admin'), false);
});
test('rate limiting stops requests after the configured budget', async () => {
  const key = `test-${Date.now()}`;
  assert.equal(await rateLimit(key, 2, 60), true);
  assert.equal(await rateLimit(key, 2, 60), true);
  assert.equal(await rateLimit(key, 2, 60), false);
});
