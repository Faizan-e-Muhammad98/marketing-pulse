import { redact, severity, type QueryInput, type SourceResult } from './model';
import { isMarketingRequest, marketingCondition, nrqlString } from './marketing-scope';
type Row = Record<string, unknown>;

export async function newrelic(input: QueryInput): Promise<SourceResult> {
  const base = { source: 'newrelic' as const, events: [], queriedAt: new Date().toISOString() };
  const account = process.env.NEW_RELIC_ACCOUNT_ID;
  const key = process.env.NEW_RELIC_USER_KEY;
  const app = process.env.NEW_RELIC_APP_NAME;
  const filter = process.env[`NEW_RELIC_${input.view.toUpperCase()}_FILTER`];
  if (!account || !key || (input.view === 'logs' ? !filter : !app)) {
    return {
      ...base,
      status: 'unconfigured',
      message:
        input.view === 'logs'
          ? 'Set New Relic credentials and NEW_RELIC_LOGS_FILTER to scope Marketing logs.'
          : 'Set New Relic credentials and NEW_RELIC_APP_NAME. Errors and query performance are automatically limited to Marketing routes.',
    };
  }
  if (!/^\d+$/.test(account)) throw new Error('Invalid New Relic account');
  const endpoint =
    process.env.NEW_RELIC_REGION === 'EU'
      ? 'https://api.eu.newrelic.com/graphql'
      : 'https://api.newrelic.com/graphql';

  async function query(nrql: string): Promise<Row[]> {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'API-Key': key! },
      cache: 'no-store',
      signal: AbortSignal.timeout(12000),
      body: JSON.stringify({
        query:
          'query($account:Int!,$nrql:Nrql!){ actor { account(id:$account) { nrql(query:$nrql, timeout:10) { results } } } }',
        variables: { account: Number(account), nrql },
      }),
    });
    if (!response.ok) throw new Error('New Relic request failed');
    const body = await response.json();
    if (body.errors) throw new Error('New Relic query failed');
    const rows = body.data?.actor?.account?.nrql?.results;
    if (!Array.isArray(rows)) throw new Error('Invalid New Relic result');
    return rows;
  }

  const range = `SINCE ${input.start} UNTIL ${input.end}`;
  const appScope = `(appName = ${nrqlString(app || '')} OR \`entity.name\` = ${nrqlString(app || '')})`;
  const extra = filter ? `AND (${filter})` : '';
  const columns =
    'timestamp, guid, appName, `entity.name`, message, `error.message`, `error.class`, level, severity, correlationId, `aio-trace-id`, `trace.id`, traceId, `request.uri`, transactionName, name, `db.statement`, duration, transactionId';
  let rows: Row[];
  let truncated = false;
  let message: string | undefined;
  if (input.view === 'queries') {
    // Fetch bounded candidates, then resolve their parent transactions. SQL/table names
    // cannot identify a module: Marketing and other modules share database tables.
    const candidates = await query(
      `FROM Span SELECT ${columns} WHERE ${appScope} ${extra} AND category = 'datastore' AND duration > 0.5 ${range} LIMIT 1000`,
    );
    truncated = candidates.length >= 1000;
    const ids = [
      ...new Set(
        candidates
          .map((row) => row.transactionId)
          .filter((id): id is string => typeof id === 'string' && /^[a-f0-9]{16,64}$/i.test(id)),
      ),
    ];
    const parents = ids.length
      ? await query(
          `FROM Transaction SELECT latest(name) AS endpoint, latest(\`request.uri\`) AS uri WHERE appName = ${nrqlString(app!)} AND guid IN (${ids.map(nrqlString).join(',')}) AND ${marketingCondition('name')} FACET guid ${range} LIMIT 1000`,
        )
      : [];
    const marketingParents = new Map(
      parents
        .filter((row) => isMarketingRequest(row.uri, row.endpoint))
        .map((row) => [String(row.guid || row.facet), row]),
    );
    rows = candidates
      .filter(
        (row) => typeof row.transactionId === 'string' && marketingParents.has(row.transactionId),
      )
      .map((row) => ({
        ...row,
        'request.uri': marketingParents.get(String(row.transactionId))!.uri,
        transactionName: marketingParents.get(String(row.transactionId))!.endpoint,
      }));
    message =
      'Marketing requests only. Sampled datastore spans over 500ms with a matching Marketing parent transaction; missing parents are excluded.';
    if (truncated)
      message += ' Candidate limit reached; narrow the time range for fuller coverage.';
  } else {
    const where =
      input.view === 'errors'
        ? `${appScope} ${extra} AND ${marketingCondition('transactionName')}`
        : `(${filter})`;
    rows = await query(
      `FROM ${input.view === 'errors' ? 'TransactionError' : 'Log'} SELECT ${columns} WHERE ${where} ${range} LIMIT 1000`,
    );
    truncated = rows.length >= 1000;
    if (input.view === 'errors') {
      rows = rows.filter((row) => isMarketingRequest(row['request.uri'], row.transactionName));
      message =
        'Marketing routes only, including Reviews, Menuboards and Brandbook. Unattributed and non-Marketing errors are excluded.';
    }
  }
  return {
    ...base,
    status: 'ready',
    truncated,
    message,
    events: rows.map((row, index) => ({
      id: `newrelic:${row.guid || row['span.id'] || `${row.timestamp}:${index}`}`,
      source: 'newrelic',
      timestamp: new Date(Number(row.timestamp)).toISOString(),
      service: redact(row.appName || row['entity.name'] || 'New Relic'),
      message: redact(
        row['error.message'] || row.message || row['db.statement'] || row.name || 'Event',
      ),
      severity:
        input.view === 'errors'
          ? 'error'
          : input.view === 'queries'
            ? 'warn'
            : severity(
                String(row.message || ''),
                typeof (row.level || row.severity) === 'string'
                  ? String(row.level || row.severity)
                  : undefined,
              ),
      correlationId:
        row.correlationId || row['aio-trace-id']
          ? redact(row.correlationId || row['aio-trace-id'])
          : undefined,
      nativeTraceId:
        row['trace.id'] || row.traceId ? redact(row['trace.id'] || row.traceId) : undefined,
      endpoint:
        row['request.uri'] || row.transactionName
          ? redact(row['request.uri'] || row.transactionName)
          : undefined,
      errorClass: row['error.class'] ? redact(row['error.class']) : undefined,
      durationMs:
        input.view === 'queries' && Number.isFinite(Number(row.duration))
          ? Number(row.duration) * 1000
          : undefined,
    })),
  };
}
