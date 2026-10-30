'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueries } from '@tanstack/react-query';
import {
  groupErrors,
  sources,
  type LogEvent,
  type Source,
  type SourceResult,
  type View,
} from '../lib/model';
import { requestSource } from '../lib/source-client';
import { Utilization } from './utilization';
const labels: Record<Source, string> = {
  cloudwatch: 'CloudWatch',
  newrelic: 'New Relic',
  audit: 'Database',
};
const date = (value: string) => new Date(value).toLocaleString();

export default function Page() {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  );
}

function App() {
  const [auth, setAuth] = useState<boolean | null>(null);
  const [section, setSection] = useState<'telemetry' | 'utilization'>('telemetry');
  const onExpired = useCallback(() => setAuth(false), []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch('/api/auth')
      .then((r) => r.json())
      .then((r) => setAuth(r.authenticated))
      .catch(() => {
        setAuth(false);
        setError('Could not reach the server.');
      });
  }, []);

  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(form)),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      setAuth(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign in failed.');
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    const response = await fetch('/api/auth', { method: 'DELETE' });
    if (response.ok) {
      window.location.reload();
    }
  }

  return (
    <>
      <header className="topbar">
        <Link className="brand" href="/">
          <span className="brand-icon">▥</span>
          <span>
            <b>MARKETING</b> PULSE
          </span>
        </Link>
        <span className="workspace">OBSERVABILITY / MARKETING</span>
        <div className="top-right">
          <span className="readonly">
            <i /> Read only
          </span>
          {auth && (
            <button className="quiet" onClick={logout}>
              Sign out ↗
            </button>
          )}
        </div>
      </header>
      {auth === null ? (
        <main className="login">
          <p>Connecting…</p>
        </main>
      ) : auth ? (
        <>
          <nav className="section-nav" aria-label="Marketing sections">
            <button
              className={section === 'telemetry' ? 'tab active' : 'tab'}
              aria-pressed={section === 'telemetry'}
              onClick={() => setSection('telemetry')}
            >
              Logs &amp; performance
            </button>
            <button
              className={section === 'utilization' ? 'tab active' : 'tab'}
              aria-pressed={section === 'utilization'}
              onClick={() => setSection('utilization')}
            >
              Utilization
            </button>
          </nav>
          {section === 'utilization' ? (
            <Utilization onExpired={onExpired} />
          ) : (
            <Dashboard onExpired={onExpired} />
          )}
        </>
      ) : (
        <main className="login">
          <div className="login-card">
            <span className="eyebrow">YOUR MARKETING CONTROL ROOM</span>
            <h1>Welcome to Pulse.</h1>
            <p className="muted">One place to investigate logs, errors and slow queries.</p>
            <form onSubmit={login}>
              <label>
                Username
                <input name="username" autoComplete="username" required defaultValue="admin" />
              </label>
              <label>
                Password
                <input type="password" name="password" autoComplete="current-password" required />
              </label>
              <button className="primary" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in →'}
              </button>
              {error && (
                <p role="alert" className="error-text">
                  {error}
                </p>
              )}
            </form>
            <p className="small muted">Restricted access · Server-side source connections</p>
          </div>
        </main>
      )}
    </>
  );
}

function Dashboard({ onExpired }: { onExpired: () => void }) {
  const [view, setView] = useState<View>('logs');
  const [hours, setHours] = useState(1);
  const [end, setEnd] = useState(() => Math.floor(Date.now() / 60000) * 60000);
  const [generation, setGeneration] = useState(0);
  const [source, setSource] = useState('all');
  const [level, setLevel] = useState('all');
  const [search, setSearch] = useState('');
  const [service, setService] = useState('all');
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [extra, setExtra] = useState<LogEvent[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState('');
  const start = end - hours * 3600000;
  const progressKey = `${view}:${start}:${end}:${generation}`;
  const [progress, setProgress] = useState<{ key: string; result: SourceResult }>();
  const queries = useQueries({
    queries: sources.map((s) => ({
      queryKey: ['logs', s, view, start, end, generation],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        requestSource(
          s,
          view,
          start,
          end,
          generation > 0,
          signal,
          undefined,
          s === 'cloudwatch' ? (result) => setProgress({ key: progressKey, result }) : undefined,
        ),
      staleTime: 60000,
      gcTime: 0,
    })),
  });
  const cloudwatchQuery = queries[0];
  const cloudwatchResult =
    progress?.key === progressKey && (cloudwatchQuery.isFetching || !cloudwatchQuery.data)
      ? progress.result
      : cloudwatchQuery.data;
  const newrelicResult = queries[1].data;
  const auditResult = queries[2].data;
  const results = [cloudwatchResult, newrelicResult, auditResult];
  const loading = queries.some((q) => q.isFetching);
  useEffect(() => {
    if (queries.some((q) => q.error?.message === 'SESSION_EXPIRED')) onExpired();
  }, [queries, onExpired]);

  function resetPagination() {
    setPage(0);
    setExpanded(null);
  }

  function resetResults() {
    setExtra([]);
    setCursor(undefined);
    setMoreError('');
    resetPagination();
  }

  const all = useMemo(
    () =>
      [
        ...new Map(
          [
            ...[cloudwatchResult, newrelicResult, auditResult].flatMap(
              (result) => result?.events || [],
            ),
            ...extra,
          ].map((e) => [`${e.source}:${e.id}`, e]),
        ).values(),
      ].sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
    [cloudwatchResult, newrelicResult, auditResult, extra],
  );
  const filtered = useMemo(
    () =>
      all.filter(
        (e) =>
          (source === 'all' || e.source === source) &&
          (level === 'all' || e.severity === level) &&
          (service === 'all' || e.service === service) &&
          `${e.message} ${e.correlationId || ''} ${e.nativeTraceId || ''} ${e.endpoint || ''} ${e.errorClass || ''}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      ),
    [all, source, level, service, search],
  );
  const groups = useMemo(() => (view === 'errors' ? groupErrors(filtered) : []), [view, filtered]);
  const records = view === 'errors' ? groups : filtered;
  const connected = results.filter((result) => result?.status === 'ready').length;
  const truncated = results.some((result) => result?.truncated);
  const auditCursor = cursor === '' ? undefined : cursor || queries[2].data?.nextCursor;
  const updated = results
    .flatMap((result) => (result ? [result.queriedAt] : []))
    .sort()
    .at(-1);

  async function moreAudit() {
    setLoadingMore(true);
    setMoreError('');
    try {
      const result = await requestSource('audit', view, start, end, false, undefined, auditCursor);
      if (result.status !== 'ready') throw new Error(result.message || 'Could not load more.');
      setExtra((current) => [...current, ...result.events]);
      setCursor(result.nextCursor || '');
    } catch (e) {
      setMoreError(e instanceof Error ? e.message : 'Could not load more.');
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <main className="dashboard">
      <div className="heading">
        <div>
          <span className="eyebrow">MARKETING OPERATIONS</span>
          <h1>
            Every signal. One place<span className="coral">.</span>
          </h1>
          <p className="muted">
            Investigate activity, spot failures, and find what’s slowing you down.
          </p>
        </div>
        <button
          className="primary"
          disabled={loadingMore}
          onClick={() => {
            setEnd(Math.floor(Date.now() / 60000) * 60000);
            setGeneration((g) => g + 1);
            resetResults();
          }}
        >
          ↻ {loading ? 'Reading sources…' : 'Refresh logs'}
        </button>
      </div>
      <div className="source-grid">
        {sources.map((s, i) => {
          const q = queries[i];
          const data = results[i];
          const status = q.isFetching
            ? 'Reading source'
            : q.error
              ? 'Request failed'
              : data?.status === 'ready'
                ? 'Connected'
                : data?.status === 'unconfigured'
                  ? 'Not configured'
                  : data?.status === 'unavailable'
                    ? 'Not available'
                    : 'Connection issue';
          return (
            <div className="source-card" key={s}>
              <div className="card-title">
                <span className={`source-icon ${s}`}>
                  {s === 'cloudwatch' ? '☁' : s === 'newrelic' ? '◈' : '▤'}
                </span>
                <strong>{labels[s]}</strong>
                <span className={`status-dot ${status === 'Connected' ? 'green' : ''}`} />
              </div>
              <div className="source-status">
                {status}
                <span>
                  {data
                    ? `${data.events.length.toLocaleString()} records${s === 'cloudwatch' && !data.complete ? ' loaded' : ''}`
                    : '—'}
                </span>
              </div>
              <p className="small muted">
                {q.error?.message === 'SESSION_EXPIRED'
                  ? 'Session expired'
                  : q.error?.message ||
                    data?.message ||
                    (s === 'cloudwatch'
                      ? 'Application and worker logs'
                      : s === 'newrelic'
                        ? 'Logs, errors and datastore spans'
                        : 'Read-only API audit activity')}
              </p>
            </div>
          );
        })}
      </div>
      <div className="toolbar">
        <nav aria-label="Telemetry views">
          {(['logs', 'errors', 'queries'] as View[]).map((v) => (
            <button
              key={v}
              className={view === v ? 'tab active' : 'tab'}
              onClick={() => {
                if (view !== v || generation !== 0) resetResults();
                setView(v);
                setGeneration(0);
              }}
            >
              {v === 'logs' ? '≡  Logs' : v === 'errors' ? '⊗  Errors' : '◷  Query performance'}
            </button>
          ))}
        </nav>
        <div className="range" aria-label="Time range">
          {[1, 6, 24, 168].map((h) => (
            <button
              key={h}
              aria-pressed={hours === h}
              className={hours === h ? 'selected' : ''}
              onClick={() => {
                const nextEnd = Math.floor(Date.now() / 60000) * 60000;
                if (hours !== h || generation !== 0 || end !== nextEnd) resetResults();
                setHours(h);
                setGeneration(0);
                setEnd(nextEnd);
              }}
            >
              {h === 168 ? '7 days' : h === 1 ? '1 hour' : `${h} hours`}
            </button>
          ))}
        </div>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>
              {view === 'logs'
                ? 'Activity stream'
                : view === 'errors'
                  ? 'Error groups'
                  : 'Slow queries'}
            </h2>
            <p className="small muted">
              {view === 'errors'
                ? 'Counts cover loaded observations. CloudWatch counts are complete only when its loading finishes; other sources may remain bounded.'
                : view === 'queries'
                  ? 'Available query timings over 500ms. Missing telemetry is not zero slow queries.'
                  : 'Read-only events from your configured Marketing sources.'}
            </p>
          </div>
          <span className="count">
            {records.length.toLocaleString()} {view === 'errors' ? 'groups' : 'records'}
          </span>
        </div>
        <div className="filters">
          <input
            aria-label="Search loaded records"
            placeholder="⌕  Search messages, endpoints or trace IDs…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              resetPagination();
            }}
          />
          <select
            aria-label="Source"
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              resetPagination();
            }}
          >
            <option value="all">All sources</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {labels[s]}
              </option>
            ))}
          </select>
          <select
            aria-label="Severity"
            value={level}
            onChange={(e) => {
              setLevel(e.target.value);
              resetPagination();
            }}
          >
            <option value="all">All severities</option>
            {['fatal', 'error', 'warn', 'info', 'debug', 'trace'].map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
          <select
            aria-label="Service"
            value={service}
            onChange={(e) => {
              setService(e.target.value);
              resetPagination();
            }}
          >
            <option value="all">All services</option>
            {[...new Set(all.map((e) => e.service))].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        {cloudwatchResult && cloudwatchResult.status !== 'unconfigured' && (
          <div className="notice" role="status">
            CloudWatch: {cloudwatchResult.events.length.toLocaleString()} matching records loaded.{' '}
            {cloudwatchResult.complete
              ? 'Complete for the selected range and configured filters.'
              : loading && queries[0].isFetching
                ? 'Loading continues in the background; filters and counts are provisional.'
                : 'Incomplete — see the CloudWatch source message. Loaded records are retained.'}
          </div>
        )}
        {truncated && (
          <div className="notice">
            Some source results are bounded. Filters and counts apply to loaded records; additional
            audit records can be loaded below. CloudWatch coverage is shown separately above.
          </div>
        )}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{view === 'errors' ? 'LAST SEEN' : 'TIMESTAMP'}</th>
                <th>SOURCE</th>
                <th>SEVERITY</th>
                <th>{view === 'queries' ? 'QUERY / OPERATION' : 'MESSAGE'}</th>
                <th>{view === 'errors' ? 'COUNT' : view === 'queries' ? 'DURATION' : 'SERVICE'}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {view === 'errors'
                ? groups
                    .slice(page * 50, (page + 1) * 50)
                    .map((g) => (
                      <EventRow
                        key={g.key}
                        event={g.event}
                        rowKey={g.key}
                        expanded={expanded}
                        toggle={setExpanded}
                        last={g.last}
                        extra={String(g.count)}
                        occurrences={g.events}
                        detail={`First seen: ${date(g.first)} · Last seen: ${date(g.last)} · ${g.count} source observations`}
                      />
                    ))
                : filtered
                    .slice(page * 50, (page + 1) * 50)
                    .map((e) => (
                      <EventRow
                        key={e.id}
                        event={e}
                        rowKey={e.id}
                        expanded={expanded}
                        toggle={setExpanded}
                        extra={view === 'queries' ? `${e.durationMs?.toFixed(1)} ms` : e.service}
                      />
                    ))}
            </tbody>
          </table>
        </div>
        {!records.length && (
          <div className="empty">
            <span className="empty-icon">{loading ? '◌' : '⌕'}</span>
            <h3>
              {loading
                ? 'Listening to your sources'
                : connected
                  ? 'No matching records'
                  : 'Connect your first source'}
            </h3>
            <p>
              {loading
                ? 'CloudWatch queries can take a moment. CloudWatch records appear as each page arrives.'
                : connected
                  ? 'Try another time range or clear the filters. Check source status for gaps.'
                  : 'Add source credentials and Marketing filters to the server environment to see live activity here.'}
            </p>
            <span className="empty-caption">
              {connected
                ? `${connected} of 3 sources available`
                : 'CloudWatch · New Relic · PostgreSQL'}
            </span>
          </div>
        )}
        <div className="pagination">
          <span className="small muted">
            {records.length
              ? `${page * 50 + 1}–${Math.min((page + 1) * 50, records.length)} of ${records.length}`
              : 'No records loaded'}{' '}
            · Filters apply to loaded records
          </span>
          <div>
            {auditCursor && (
              <button disabled={loadingMore} onClick={moreAudit}>
                {loadingMore ? 'Loading…' : 'Load more audit records'}
              </button>
            )}
            <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              ← Previous
            </button>
            <button
              disabled={(page + 1) * 50 >= records.length}
              onClick={() => setPage((p) => p + 1)}
            >
              Next →
            </button>
          </div>
        </div>
        {moreError && (
          <p role="alert" className="notice">
            {moreError}
          </p>
        )}
      </section>
      <footer>
        <span>
          <i className="status-dot green" />{' '}
          {updated ? `Last queried ${date(updated)}` : 'Awaiting source configuration'} · Times
          shown in your local timezone
        </span>
        <span>7-day lookback · Server-side credentials</span>
      </footer>
    </main>
  );
}

function EventRow({
  event: e,
  rowKey,
  expanded,
  toggle,
  extra,
  last,
  detail,
  occurrences,
}: {
  event: LogEvent;
  rowKey: string;
  expanded: string | null;
  toggle: (value: string | null) => void;
  extra?: string;
  last?: string;
  detail?: string;
  occurrences?: LogEvent[];
}) {
  const open = expanded === rowKey;
  return (
    <>
      <tr>
        <td className="timestamp">{date(last || e.timestamp)}</td>
        <td>
          <span className={`badge ${e.source}`}>{labels[e.source]}</span>
        </td>
        <td>
          <span className={`severity ${e.severity}`}>{e.severity}</span>
        </td>
        <td className="message">{e.message}</td>
        <td className="metric">{extra}</td>
        <td>
          <button
            aria-label="Toggle event details"
            aria-expanded={open}
            className="quiet"
            onClick={() => toggle(open ? null : rowKey)}
          >
            {open ? '−' : '+'}
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6}>
            <div className="details">
              {detail && <p>{detail}</p>}
              <dl>
                <dt>Application correlation ID</dt>
                <dd>{e.correlationId || 'Not available'}</dd>
                <dt>Native trace ID</dt>
                <dd>{e.nativeTraceId || 'Not available'}</dd>
                <dt>Endpoint</dt>
                <dd>{e.endpoint || 'Not available'}</dd>
                <dt>Service</dt>
                <dd>{e.service}</dd>
              </dl>
              <pre>{e.message}</pre>
              {occurrences && (
                <div>
                  <h3>Loaded occurrences</h3>
                  {occurrences.slice(0, 50).map((item) => (
                    <p key={item.id}>
                      {date(item.timestamp)} ·{' '}
                      {item.correlationId || item.nativeTraceId || 'No trace ID'}
                      <br />
                      {item.message}
                    </p>
                  ))}
                  {occurrences.length > 50 && (
                    <p>
                      Showing the first 50 of {occurrences.length.toLocaleString()} loaded
                      occurrences.
                    </p>
                  )}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
