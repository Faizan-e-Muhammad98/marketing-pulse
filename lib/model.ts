export const sources = ['cloudwatch', 'newrelic', 'audit'] as const;

export type Source = (typeof sources)[number];

export type View = 'logs' | 'errors' | 'queries';

export interface LogEvent {
  id: string;
  source: Source;
  timestamp: string;
  service: string;
  severity: string;
  message: string;
  correlationId?: string;
  nativeTraceId?: string;
  endpoint?: string;
  durationMs?: number;
  errorClass?: string;
}

export interface SourceResult {
  source: Source;
  status: 'ready' | 'pending' | 'unconfigured' | 'unavailable' | 'error';
  events: LogEvent[];
  message?: string;
  handle?: string;
  nextCursor?: string;
  complete?: boolean;
  retryAfterMs?: number;
  truncated?: boolean;
  queriedAt: string;
  scannedBytes?: number;
}

export interface QueryInput {
  source: Source;
  view: View;
  start: number;
  end: number;
  refresh: boolean;
  handle?: string;
  cursor?: string;
}

export function validateQuery(params: URLSearchParams, now = Date.now()): QueryInput {
  const source = params.get('source') as Source;
  const view = params.get('view') as View;
  const start = Number(params.get('start'));
  const end = Number(params.get('end'));
  if (
    !sources.includes(source) ||
    !['logs', 'errors', 'queries'].includes(view) ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start <= 0 ||
    end <= start ||
    end - start > 7 * 86400000 ||
    end > now + 60000 ||
    (!(source === 'cloudwatch' && params.get('handle')) && start < now - 7 * 86400000 - 300000)
  ) {
    throw new Error('Choose a valid time range within the last seven days.');
  }
  const handle = params.get('handle') || undefined;
  const cursor = params.get('cursor') || undefined;
  if ((handle && !/^[a-f0-9-]{36}$/.test(handle)) || (cursor && cursor.length > 512))
    throw new Error('Invalid cursor.');
  return { source, view, start, end, refresh: params.get('refresh') === '1', handle, cursor };
}

// Only allowlisted fields reach the browser. Redaction is defense in depth, not a PII classifier.
export function redact(value: unknown): string {
  return String(value ?? '')
    .slice(0, 8000)
    .replace(/\bBearer\s+[\w.\-~+/=]+/gi, 'Bearer [REDACTED]')
    .replace(/([?&][^\s=&#]+)=([^\s&#]*)/g, '$1=[REDACTED]')
    .replace(
      /((?:password|token|secret|authorization|cookie|cardNumber|cvv)\s*["']?\s*[:=]\s*)["']?[^\s,}"']+/gi,
      '$1[REDACTED]',
    )
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[EMAIL]')
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[NUMBER]')
    .replace(/\+?\b\d[\d ().-]{8,}\d\b/g, '[PHONE]');
}

export function signature(event: LogEvent): string {
  const message = event.message
    .toLowerCase()
    .replace(/\[[^\]]*(?:tenant_|system_)[^\]]*\]/g, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/g, '<id>')
    .replace(/\b\d{4}-\d\d-\d\d[t\s][\d:.z+-]+/g, '<time>')
    .replace(/\b\d{4,}\b/g, '<number>')
    .replace(/\s+/g, ' ')
    .trim();
  return [event.source, event.service, event.endpoint || '', event.errorClass || '', message].join(
    '|',
  );
}

export function groupErrors(events: LogEvent[]) {
  const groups = new Map<
    string,
    { key: string; event: LogEvent; count: number; first: string; last: string; events: LogEvent[] }
  >();
  for (const event of events) {
    if (!['error', 'fatal'].includes(event.severity)) continue;
    const key = signature(event);
    const found = groups.get(key);
    if (found) {
      found.count++;
      found.first = event.timestamp < found.first ? event.timestamp : found.first;
      found.last = event.timestamp > found.last ? event.timestamp : found.last;
      found.events.push(event);
    } else
      groups.set(key, {
        key,
        event,
        count: 1,
        first: event.timestamp,
        last: event.timestamp,
        events: [event],
      });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

export function severity(message: string, explicit?: string): string {
  const level = explicit?.toLowerCase();
  if (/\bfatal\b/i.test(message) || level === 'fatal' || level === 'critical') return 'fatal';
  if (/\b(error|exception|failed|failure)\b/i.test(message) || level === 'error') return 'error';
  if (/slow query|\bwarn(?:ing)?\b/i.test(message) || level === 'warn' || level === 'warning')
    return 'warn';
  return level === 'debug' ? 'debug' : level === 'verbose' ? 'trace' : 'info';
}
