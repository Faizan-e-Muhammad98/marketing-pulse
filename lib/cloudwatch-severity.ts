const levels: Record<string, string> = {
  LOG: 'info',
  INFO: 'info',
  DEBUG: 'debug',
  VERBOSE: 'trace',
  TRACE: 'trace',
  WARN: 'warn',
  WARNING: 'warn',
  ERROR: 'error',
  FATAL: 'fatal',
  CRITICAL: 'fatal',
};

export function cloudwatchSeverity(raw: string): string {
  const text = raw.replace(/\x1b\[[0-9;]*m/g, '').trimStart();
  const header =
    /^(?:\[Nest\]\s+\d+\s+-\s+[^\n]*?\s+)?(LOG|INFO|DEBUG|VERBOSE|TRACE|WARN|WARNING|ERROR|FATAL|CRITICAL)\s+(?:\[([^\]]+)\]\s*)?/i.exec(
      text,
    );
  if (header) {
    const level = header[1].toUpperCase();
    const context = header[2];
    const body = text.slice(header[0].length).replace(/^\[[^\]\n]+\]\s*:\s*/, '');
    // Known legacy logger methods emit these failures at LOG level. Do not
    // infer errors from arbitrary nested payload keys/values or SQL parameters.
    if (level === 'LOG' && context === 'TypeORM') {
      if (/^(?:DBConnection:\s*[^,]+,\s*)?Error:/i.test(body)) return 'error';
      if (/^Slow Query \([\d.]+ms\):/i.test(body)) return 'warn';
    }
    if (
      level === 'LOG' &&
      context === 'AuditLogEventsService' &&
      /^Failed to create audit log:/i.test(body)
    )
      return 'error';
    return levels[level];
  }
  // Structured records: use only top-level severity, never fields inside data.
  if (text.startsWith('{')) {
    try {
      const record = JSON.parse(text);
      const value = record.level ?? record.severity;
      if (typeof value === 'string') return levels[value.toUpperCase()] || 'info';
      return (
        (
          { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' } as Record<
            number,
            string
          >
        )[value] || 'info'
      );
    } catch {
      return 'info';
    }
  }
  // Untagged exception headlines are useful; a word anywhere in a payload is not.
  if (/^(?:[\w.]*Error|[\w.]*Exception|Error|Exception):/i.test(text)) return 'error';
  if (/^Fatal:/i.test(text)) return 'fatal';
  if (/^Slow Query \([\d.]+ms\):/i.test(text)) return 'warn';
  return 'info';
}
