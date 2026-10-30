import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { cloudwatchSeverity } from '../lib/cloudwatch-severity';
import { cloudwatch } from '../lib/cloudwatch';
import type { QueryInput } from '../lib/model';

const mqtt =
  ' LOG [MQTTHelper] [tenant_1_example] : Enqueuing the mqtt notification with data {"loyaltyAmount":0,"totalReviews":0,"error":null,"failureReason":null,"message":"failed","fatal":false}';
test('explicit log levels are authoritative, even with error words in nested payloads', () => {
  assert.equal(cloudwatchSeverity(mqtt), 'info');
  assert.equal(cloudwatchSeverity(mqtt.replace(' LOG ', ' WARN ')), 'warn');
  assert.equal(cloudwatchSeverity(mqtt.replace(' LOG ', ' DEBUG ')), 'debug');
  assert.equal(cloudwatchSeverity('ERROR [CampaignService] [trace] : Delivery rejected'), 'error');
  assert.equal(cloudwatchSeverity('\x1b[31mERROR\x1b[0m [CampaignService] : Rejected'), 'error');
  assert.equal(
    cloudwatchSeverity('[Nest] 123 - 10/23/2026, 10:00:00 AM LOG [MQTTHelper] ' + mqtt),
    'info',
  );
  assert.equal(cloudwatchSeverity('Processed request with error count 0'), 'info');
});
test('known legacy TypeORM failures stay errors, while SQL payload content does not override severity', () => {
  assert.equal(
    cloudwatchSeverity(
      'LOG [TypeORM] [tenant_1_example] : Error: statement cancelled, Query: SELECT 1',
    ),
    'error',
  );
  assert.equal(
    cloudwatchSeverity(
      'LOG [TypeORM] [tenant_1_example] : Slow Query (501ms): SELECT error FROM jobs',
    ),
    'warn',
  );
  assert.equal(
    cloudwatchSeverity(
      'LOG [AuditLogEventsService] [tenant_1_example] : Failed to create audit log: unavailable',
    ),
    'error',
  );
  assert.equal(cloudwatchSeverity('TypeError: cannot read property'), 'error');
});
test('structured severity ignores nested customer payloads', () => {
  assert.equal(cloudwatchSeverity('{"level":"info","data":{"level":"error"}}'), 'info');
  assert.equal(cloudwatchSeverity('{"level":50,"message":"query failed"}'), 'error');
});
test('CloudWatch Errors view removes non-error candidates before returning records', async (t) => {
  const keys = ['AWS_REGION', 'CLOUDWATCH_LOG_GROUPS', 'CLOUDWATCH_MARKETING_PATTERN'];
  const old = keys.map((k) => process.env[k]);
  Object.assign(process.env, {
    AWS_REGION: 'us-west-2',
    CLOUDWATCH_LOG_GROUPS: '/test',
    CLOUDWATCH_MARKETING_PATTERN: 'Campaign|Loyalty',
  });
  const records = [
    mqtt,
    'ERROR [CampaignService] [trace] : Delivery failed',
    'LOG [TypeORM] [tenant_1_example] : Error: statement cancelled',
  ];
  t.mock.method(
    CloudWatchLogsClient.prototype,
    'send',
    async (command: { constructor: { name: string } }) =>
      command.constructor.name === 'StartQueryCommand'
        ? { queryId: 'severity-check' }
        : {
            status: 'Complete',
            results: records.map((message, i) => [
              { field: '@message', value: message },
              { field: '@timestamp', value: '2026-10-23 10:00:00.000' },
              { field: '@ptr', value: String(i) },
            ]),
            statistics: { bytesScanned: 100 },
          },
  );
  try {
    const end = Date.now();
    const input: QueryInput = {
      source: 'cloudwatch',
      view: 'errors',
      start: end - 3600000,
      end,
      refresh: false,
    };
    const pending = await cloudwatch(input, 'severity-test');
    input.handle = pending.handle;
    const result = await cloudwatch(input, 'severity-test');
    assert.equal(result.events.length, 2);
    assert.ok(result.events.every((e) => e.severity === 'error'));
  } finally {
    keys.forEach((key, i) => {
      if (old[i] === undefined) delete process.env[key];
      else process.env[key] = old[i];
    });
  }
});
