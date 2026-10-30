import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
  StopQueryCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { randomUUID } from 'node:crypto';
import { get, put, lock } from './store';
import { cloudwatchSeverity } from './cloudwatch-severity';
import { redact, type QueryInput, type SourceResult } from './model';
const RESULT_LIMIT = 100000;
const HANDLE_TTL = 3600;
interface Window {
  start: number;
  end: number;
}
interface QueryState {
  owner: string;
  start: number;
  end: number;
  view: string;
  window: Window;
  remaining: Window[];
  id?: string;
  started?: number;
  pollFailures?: number;
  pageSize?: number;
  nextToken?: string;
  rows: number;
  scannedBytes: number;
  queryBytes: number;
}
let client: CloudWatchLogsClient;

export async function cloudwatch(input: QueryInput, owner: string): Promise<SourceResult> {
  const base = {
    source: 'cloudwatch' as const,
    events: [],
    queriedAt: new Date().toISOString(),
    complete: false,
  };
  const groups = process.env.CLOUDWATCH_LOG_GROUPS?.split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const pattern = process.env.CLOUDWATCH_MARKETING_PATTERN;
  if (!groups?.length || !process.env.AWS_REGION || !pattern)
    return {
      ...base,
      status: 'unconfigured',
      message: 'Set AWS_REGION, CLOUDWATCH_LOG_GROUPS and CLOUDWATCH_MARKETING_PATTERN.',
    };
  if (groups.length > 50 || /[\/\r\n]/.test(pattern))
    throw new Error('Invalid CloudWatch configuration');
  client ||= new CloudWatchLogsClient({ region: process.env.AWS_REGION, maxAttempts: 1 });
  const stored = input.handle ? await get<QueryState>(`cw:${input.handle}`) : null;
  if (
    input.handle &&
    (!stored ||
      stored.owner !== owner ||
      stored.start !== input.start ||
      stored.end !== input.end ||
      stored.view !== input.view)
  )
    throw new Error('Expired or invalid query');
  // Handles describe immutable continuation positions. Replaying one returns the same page.
  if (input.handle) {
    const reply = await get<SourceResult>(`cw-reply:${input.handle}`);
    if (reply) return reply;
    if (!(await lock(`cw-page:${input.handle}`, 30)))
      return {
        ...base,
        status: 'pending',
        handle: input.handle,
        message: 'Waiting for the current CloudWatch page.',
      };
  }
  const state: QueryState = stored
    ? structuredClone(stored)
    : {
        owner,
        start: input.start,
        end: input.end,
        view: input.view,
        window: { start: input.start, end: input.end },
        remaining: [],
        rows: 0,
        scannedBytes: 0,
        queryBytes: 0,
      };

  async function reply(result: SourceResult, next?: QueryState): Promise<SourceResult> {
    if (next) {
      const handle = randomUUID();
      await put(`cw:${handle}`, next, HANDLE_TTL);
      result.handle = handle;
    }
    if (input.handle) await put(`cw-reply:${input.handle}`, result, HANDLE_TTL);
    return result;
  }

  async function stopQuery() {
    try {
      await client.send(new StopQueryCommand({ queryId: state.id }), {
        abortSignal: AbortSignal.timeout(3000),
      });
    } catch {
      /* best effort */
    }
  }

  const budget = Number(process.env.CLOUDWATCH_MAX_SCAN_BYTES || 1073741824);
  if (!Number.isFinite(budget) || budget <= 0) throw new Error('Invalid CloudWatch configuration');
  if (!state.id && state.scannedBytes >= budget)
    return reply({
      ...base,
      status: 'error',
      scannedBytes: state.scannedBytes,
      message:
        'CloudWatch loading is incomplete: the total scan budget was reached. Narrow the range or adjust CLOUDWATCH_MAX_SCAN_BYTES.',
    });
  if (!state.id) {
    const condition =
      input.view === 'errors'
        ? '| filter @message like /(?i)(error|exception|failed|failure|fatal|critical)/'
        : input.view === 'queries'
          ? '| filter @message like /Slow Query/'
          : '';
    // StartQuery uses inclusive seconds; the explicit half-open millisecond filter prevents overlap.
    const query = `fields @timestamp, @message, @log, @ptr | filter toMillis(@timestamp) >= ${state.window.start} and toMillis(@timestamp) < ${state.window.end} | filter @message like /${pattern}/ ${condition} | sort @timestamp desc | limit ${RESULT_LIMIT}`;
    const result = await client.send(
      new StartQueryCommand({
        logGroupNames: groups,
        startTime: Math.floor(state.window.start / 1000),
        endTime: Math.ceil(state.window.end / 1000),
        queryString: query,
      }),
      { abortSignal: AbortSignal.timeout(20000) },
    );
    if (!result.queryId) throw new Error('No CloudWatch query ID');
    state.id = result.queryId;
    state.started = Date.now();
    return reply(
      {
        ...base,
        status: 'pending',
        scannedBytes: state.scannedBytes,
        message: 'CloudWatch is scanning the selected time range.',
      },
      state,
    );
  }
  // Limit query execution, not the time needed to download a completed query's pages.
  if (!state.nextToken && Date.now() - state.started! > 300000) {
    await stopQuery();
    return reply({
      ...base,
      status: 'error',
      message:
        'CloudWatch loading is incomplete: a query exceeded five minutes. Narrow the time range and refresh.',
    });
  }
  let result;
  try {
    result = await client.send(
      new GetQueryResultsCommand({
        queryId: state.id,
        maxItems: state.pageSize || 250,
        nextToken: state.nextToken,
      }),
      { abortSignal: AbortSignal.timeout(20000) },
    );
  } catch (error) {
    const failure = error as {
      name?: string;
      code?: string;
      $metadata?: { httpStatusCode?: number };
    };
    const transient =
      ['TimeoutError', 'AbortError', 'ThrottlingException', 'ServiceUnavailableException'].includes(
        failure.name || '',
      ) ||
      ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(failure.code || '') ||
      (failure.$metadata?.httpStatusCode || 0) >= 500;
    if (!transient) throw error;
    if (
      ['TimeoutError', 'AbortError'].includes(failure.name || '') ||
      ['ETIMEDOUT', 'ECONNRESET'].includes(failure.code || '')
    )
      state.pageSize = 100;
    state.pollFailures = (state.pollFailures || 0) + 1;
    if (state.pollFailures >= 3) {
      await stopQuery();
      return reply({
        ...base,
        status: 'error',
        message:
          'CloudWatch loading is incomplete after three consecutive temporary failures. Loaded records are retained; refresh once connectivity recovers.',
      });
    }
    return reply(
      {
        ...base,
        status: 'pending',
        message: 'CloudWatch is slow to respond. Retrying the existing query.',
      },
      state,
    );
  }
  state.pollFailures = 0;
  const queryBytes = Math.max(state.queryBytes, result.statistics?.bytesScanned || 0);
  state.scannedBytes += queryBytes - state.queryBytes;
  state.queryBytes = queryBytes;
  if (state.scannedBytes > budget) {
    if (result.status === 'Running' || result.status === 'Scheduled') await stopQuery();
    return reply({
      ...base,
      status: 'error',
      scannedBytes: state.scannedBytes,
      message:
        'CloudWatch loading is incomplete: the total scan budget was exceeded. Narrow the range or adjust CLOUDWATCH_MAX_SCAN_BYTES.',
    });
  }
  if (result.status === 'Running' || result.status === 'Scheduled')
    return reply({ ...base, status: 'pending', scannedBytes: state.scannedBytes }, state);
  if (result.status !== 'Complete')
    return reply({
      ...base,
      status: 'error',
      message:
        'CloudWatch loading is incomplete: the query did not complete. Narrow the time range and refresh.',
    });
  const rows = state.rows + (result.results?.length || 0);
  // Split before emitting a capped query whenever AWS supplies its full match count.
  // The row-count fallback also handles missing statistics; the client deduplicates @ptr IDs.
  if (
    Math.max(result.statistics?.recordsMatched || 0, result.statistics?.resultCount || 0, rows) >=
    RESULT_LIMIT
  ) {
    if (state.window.end - state.window.start <= 1)
      return reply({
        ...base,
        status: 'error',
        message:
          'CloudWatch loading is incomplete: at least 100,000 matches share one millisecond. Use narrower log-group or Marketing filters.',
      });
    const middle = Math.floor((state.window.start + state.window.end) / 2);
    state.remaining.unshift({ start: state.window.start, end: middle });
    state.window = { start: middle, end: state.window.end };
    state.id = undefined;
    state.nextToken = undefined;
    state.rows = 0;
    state.queryBytes = 0;
    return reply(
      {
        ...base,
        status: 'pending',
        retryAfterMs: 0,
        scannedBytes: state.scannedBytes,
        message: 'Splitting a high-volume range into smaller time windows.',
      },
      state,
    );
  }
  const events = (result.results || [])
    .map((fields, index) => {
      const row = Object.fromEntries(fields.map((f) => [f.field!, f.value!]));
      const raw = row['@message'] || '';
      const duration = /Slow Query \((\d+(?:\.\d+)?)ms\)/.exec(raw);
      const message = redact(raw.replace(/-- parameters[\s\S]*/i, '-- parameters [REDACTED]'));
      return {
        id: `cloudwatch:${row['@ptr'] || state.id + ':' + (state.rows + index)}`,
        source: 'cloudwatch' as const,
        timestamp: new Date(
          row['@timestamp'].replace(' ', 'T') +
            (/[zZ]|[+-]\d\d:\d\d$/.test(row['@timestamp']) ? '' : 'Z'),
        ).toISOString(),
        service: redact(row['@log'] || 'CloudWatch'),
        message,
        severity: cloudwatchSeverity(raw),
        correlationId: /\[((?:tenant_|system_)[^\]]+|[0-9a-f]{8}-[0-9a-f-]{27,})\]/i.exec(raw)?.[1],
        durationMs: duration ? Number(duration[1]) : undefined,
      };
    })
    .filter(
      (e) =>
        (input.view !== 'queries' || (e.durationMs !== undefined && e.durationMs > 500)) &&
        (input.view !== 'errors' || e.severity === 'error' || e.severity === 'fatal'),
    );
  state.rows = rows;
  if (result.nextToken) {
    state.nextToken = result.nextToken;
    return reply(
      {
        ...base,
        status: 'pending',
        events,
        retryAfterMs: 0,
        scannedBytes: state.scannedBytes,
        message: 'Loading remaining CloudWatch records…',
      },
      state,
    );
  }
  const nextWindow = state.remaining.shift();
  if (nextWindow) {
    state.window = nextWindow;
    state.id = undefined;
    state.nextToken = undefined;
    state.rows = 0;
    state.queryBytes = 0;
    return reply(
      {
        ...base,
        status: 'pending',
        events,
        retryAfterMs: 0,
        scannedBytes: state.scannedBytes,
        message: 'Loading the next CloudWatch time window…',
      },
      state,
    );
  }
  return reply({
    ...base,
    status: 'ready',
    events,
    complete: true,
    truncated: false,
    scannedBytes: state.scannedBytes,
    message: 'All matching CloudWatch records loaded for the selected range.',
  });
}
