import { database } from './database';
import { redact, severity, type QueryInput, type SourceResult } from './model';

export async function audit(input: QueryInput): Promise<SourceResult> {
  const base = { source: 'audit' as const, events: [], queriedAt: new Date().toISOString() };
  if (input.view === 'queries')
    return {
      ...base,
      status: 'unavailable',
      message:
        'Audit controller durations are not SQL timings. Use CloudWatch or New Relic for query performance.',
    };
  if (!process.env.AUDIT_DATABASE_URL || !process.env.AUDIT_EVENT_PATTERN)
    return {
      ...base,
      status: 'unconfigured',
      message: 'Set AUDIT_DATABASE_URL and AUDIT_EVENT_PATTERN.',
    };
  let cursor: { time: string; id: number } | undefined;
  if (input.cursor) {
    cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString());
    if (!cursor || !Number.isSafeInteger(cursor.id) || !Number.isFinite(Date.parse(cursor.time)))
      throw new Error('Invalid audit cursor');
  }
  const values: unknown[] = [
    new Date(input.start),
    new Date(input.end),
    process.env.AUDIT_EVENT_PATTERN,
  ];
  const errorFilter =
    input.view === 'errors'
      ? `AND ("eventName" LIKE '% - Error' OR "requestMetadata"->'res'->>'error' IS NOT NULL)`
      : '';
  const cursorFilter = cursor ? 'AND ("createdAt", id) < ($4::timestamptz, $5::integer)' : '';
  if (cursor) values.push(cursor.time, cursor.id);
  const result = await database().query(
    `SELECT id, "createdAt", "eventName", "requestMetadata"->>'traceId' AS trace,
    "requestMetadata"->'res'->>'error' AS error, "requestMetadata"->'res'->>'message' AS message
    FROM public.audit_logs WHERE "createdAt" >= $1 AND "createdAt" < $2 AND "eventName" ~* $3
    ${errorFilter} ${cursorFilter} ORDER BY "createdAt" DESC, id DESC LIMIT 501`,
    values,
  );
  const rows = result.rows.slice(0, 500);
  const last = rows.at(-1);
  return {
    ...base,
    status: 'ready',
    truncated: result.rows.length > 500,
    nextCursor:
      result.rows.length > 500 && last
        ? Buffer.from(JSON.stringify({ time: last.createdAt.toISOString(), id: last.id })).toString(
            'base64url',
          )
        : undefined,
    events: rows.map((row) => ({
      id: `audit:${row.id}`,
      source: 'audit',
      timestamp: row.createdAt.toISOString(),
      service: 'backend',
      message: redact(row.error || row.message || row.eventName),
      severity:
        row.error || String(row.eventName).endsWith(' - Error')
          ? 'error'
          : severity(String(row.message || '')),
      correlationId: row.trace ? redact(row.trace) : undefined,
      errorClass: row.eventName?.replace(/ - Error$/, ''),
    })),
  };
}
