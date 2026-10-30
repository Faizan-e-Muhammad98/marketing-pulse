import type { LogEvent, Source, SourceResult, View } from './model';

// Pages contain only new records. Keep prior pages on failure and deduplicate replays/split windows.
export async function requestSource(
  source: Source,
  view: View,
  start: number,
  end: number,
  refresh: boolean,
  signal?: AbortSignal,
  cursor?: string,
  onProgress?: (result: SourceResult) => void,
): Promise<SourceResult> {
  const params = new URLSearchParams({
    source,
    view,
    start: String(start),
    end: String(end),
    refresh: refresh ? '1' : '0',
  });
  if (cursor) params.set('cursor', cursor);
  const records = new Map<string, LogEvent>();
  const deadline = Date.now() + 330000;
  let latest: SourceResult | undefined;
  try {
    // CloudWatch bounds each scan server-side; downloading all pages can exceed five minutes.
    while (source === 'cloudwatch' || Date.now() < deadline) {
      signal?.throwIfAborted();
      const response = await fetch(`/api/logs?${params}`, { signal, cache: 'no-store' });
      if (response.status === 429 && source === 'cloudwatch') {
        const seconds = Number(response.headers.get('Retry-After') || 2);
        await wait(
          Number.isFinite(seconds) ? Math.min(60, Math.max(1, seconds)) * 1000 : 2000,
          signal,
        );
        continue;
      }
      if (response.status === 401) throw new Error('SESSION_EXPIRED');
      const body: SourceResult & { error?: string } = await response.json();
      if (!response.ok) throw new Error(body.error || 'Request failed.');
      for (const event of body.events || []) records.set(event.id, event);
      latest = { ...body, events: [...records.values()] };
      signal?.throwIfAborted();
      onProgress?.(latest);
      if (body.status !== 'pending') return latest;
      if (!body.handle) throw new Error('Missing source continuation.');
      params.set('handle', body.handle);
      params.delete('refresh');
      if (body.retryAfterMs === 0) continue;
      await wait(2000, signal);
    }
    throw new Error('Query timed out. Narrow the range and retry.');
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.message === 'SESSION_EXPIRED'))
      throw error;
    if (source !== 'cloudwatch') throw error;
    const result: SourceResult = {
      ...latest,
      source,
      status: 'error',
      complete: false,
      events: [...records.values()],
      queriedAt: latest?.queriedAt || new Date().toISOString(),
      message: `CloudWatch loading is incomplete. ${error instanceof Error ? error.message : 'Request failed.'}`,
    };
    onProgress?.(result);
    return result;
  }
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('Cancelled'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      signal.removeEventListener('abort', abort);
      abort();
    }
  });
}
