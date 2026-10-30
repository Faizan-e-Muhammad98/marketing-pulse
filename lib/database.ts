import { Pool } from 'pg';
let pool: Pool | undefined;

export function database() {
  if (!process.env.AUDIT_DATABASE_URL) throw new Error('AUDIT_DATABASE_URL is not configured');
  const url = new URL(process.env.AUDIT_DATABASE_URL);
  if (['sslmode', 'sslcert', 'sslkey', 'sslrootcert'].some((key) => url.searchParams.has(key)))
    throw new Error('Configure TLS through AUDIT_DB_SSL and AUDIT_DB_CA only');
  pool ||= new Pool({
    connectionString: process.env.AUDIT_DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    statement_timeout: 8000,
    query_timeout: 10000,
    application_name: 'marketing-pulse-readonly',
    options: '-c default_transaction_read_only=on',
    ssl:
      process.env.AUDIT_DB_SSL === 'disable' && process.env.NODE_ENV !== 'production'
        ? false
        : {
            rejectUnauthorized: true,
            ...(process.env.AUDIT_DB_CA
              ? { ca: process.env.AUDIT_DB_CA.replace(/\\n/g, '\n') }
              : {}),
          },
  });
  return pool;
}
