import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateQuery } from '../lib/model';
test('long CloudWatch downloads can continue at the seven-day boundary; new or other-source queries cannot bypass lookback', () => {
  const now = Date.now(),
    start = now - 7 * 86400000 - 3600000,
    end = now - 3600000;
  const p = new URLSearchParams({
    source: 'cloudwatch',
    view: 'logs',
    start: String(start),
    end: String(end),
    handle: '12345678-1234-1234-1234-123456789012',
  });
  assert.equal(validateQuery(p, now).start, start); // cloudwatch validates the stored owner/range before use
  p.set('source', 'audit');
  assert.throws(() => validateQuery(p, now));
  p.set('source', 'cloudwatch');
  p.delete('handle');
  assert.throws(() => validateQuery(p, now));
});
