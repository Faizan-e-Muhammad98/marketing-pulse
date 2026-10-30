import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceErrorMessage } from '../lib/source-errors';

test('CloudWatch failures provide specific guidance without revealing upstream details', () => {
  const cases = [
    ['ResourceNotFoundException', 'log group not found'],
    ['ExpiredTokenException', 'expired'],
    ['UnrecognizedClientException', 'rejected'],
    ['AccessDeniedException', 'denied access'],
    ['MalformedQueryException', 'configuration is invalid'],
    ['ThrottlingException', 'limits were reached'],
  ];
  for (const [name, expected] of cases) {
    const message = sourceErrorMessage('cloudwatch', {
      name,
      message: 'SECRET_TOKEN customer@example.com internal-account',
    });
    assert.ok(message.includes(expected));
    assert.ok(!message.includes('SECRET_TOKEN'));
    assert.ok(!message.includes('customer@example.com'));
  }
  assert.ok(
    sourceErrorMessage('cloudwatch', new Error('unknown-secret')).includes('Source query failed'),
  );
});
test('missing production cache is distinguished from a source credential problem', () => {
  assert.ok(
    sourceErrorMessage(
      'newrelic',
      new Error('Shared cache must be configured for production.'),
    ).includes('UPSTASH_REDIS_REST_URL'),
  );
});

test('Database failures provide safe, actionable connection guidance', () => {
  const cases = [
    ['ERR_INVALID_URL', 'URL-encode'],
    ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'AUDIT_DB_CA'],
    ['28P01', 'authentication failed'],
    ['3D000', 'does not exist'],
    ['42501', 'SELECT on public.audit_logs'],
    ['42P01', 'not found'],
    ['ETIMEDOUT', 'VPN'],
  ];
  for (const [code, expected] of cases) {
    const message = sourceErrorMessage('audit', {
      code,
      message: 'PRIVATE_PASSWORD private-host customer@example.com',
    });
    assert.ok(message.includes(expected));
    assert.doesNotMatch(message, /PRIVATE_PASSWORD|private-host|customer@example/);
  }
  assert.match(
    sourceErrorMessage(
      'audit',
      new Error('Configure TLS through AUDIT_DB_SSL and AUDIT_DB_CA only'),
    ),
    /Remove sslmode/,
  );
});
