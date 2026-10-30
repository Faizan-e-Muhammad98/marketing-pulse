import type { Source } from './model';

// Map known failures to fixed text. Never expose an upstream message: it can
// include credentials, SQL, customer data, or internal account identifiers.
export function sourceErrorMessage(source: Source, error: unknown): string {
  const failure = error as { name?: string; code?: string; message?: string } | null;
  if (failure?.message === 'Shared cache must be configured for production.') {
    return 'Production requires shared caching. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN, then restart the server.';
  }
  if (source === 'audit') {
    if (failure?.message === 'Configure TLS through AUDIT_DB_SSL and AUDIT_DB_CA only')
      return 'Remove sslmode and certificate parameters from AUDIT_DATABASE_URL. Configure TLS using AUDIT_DB_SSL and AUDIT_DB_CA.';
    const messages: Record<string, string> = {
      ERR_INVALID_URL:
        'AUDIT_DATABASE_URL is invalid. Use a PostgreSQL connection URL, URL-encode the username/password, and quote the value in .env.local. A literal # in an unquoted value starts a comment.',
      UNABLE_TO_GET_ISSUER_CERT_LOCALLY:
        'Database certificate verification failed. Set AUDIT_DB_CA to the official CA bundle for your database provider (the regional AWS RDS bundle for RDS).',
      UNABLE_TO_VERIFY_LEAF_SIGNATURE:
        'Database certificate verification failed. Check AUDIT_DB_CA and the server certificate chain.',
      SELF_SIGNED_CERT_IN_CHAIN:
        'Database certificate verification failed. Configure the trusted database CA in AUDIT_DB_CA.',
      ENOTFOUND:
        'Database hostname could not be resolved. Check AUDIT_DATABASE_URL and your DNS/VPN connection.',
      ECONNREFUSED:
        'Database connection was refused. Check the host, port, and database network access.',
      ETIMEDOUT:
        'Database connection timed out. Check VPN/private-network access and database firewall rules.',
      '28P01':
        'Database authentication failed. Check the username and URL-encoded password in AUDIT_DATABASE_URL.',
      '3D000':
        'The configured PostgreSQL database does not exist. Check the database name at the end of AUDIT_DATABASE_URL.',
      '42501':
        'Database access was denied. The read-only user needs CONNECT, schema USAGE, and SELECT on public.audit_logs.',
      '42P01':
        'public.audit_logs was not found in the configured database. Check the database name and table schema.',
      '42703':
        'The audit table columns do not match the adapter. Check id, createdAt, eventName, and requestMetadata.',
      '57014':
        'The audit query was cancelled or exceeded its statement timeout. Try a shorter range and check the audit table indexes.',
    };
    if (failure?.code && messages[failure.code]) return messages[failure.code];
  }
  if (source === 'cloudwatch') {
    const name = failure?.name || failure?.code;
    if (name === 'TimeoutError' || name === 'AbortError')
      return 'AWS did not return a query ID within 20 seconds. Check connectivity and refresh. The query may have started in CloudWatch; avoid repeated refreshes.';
    if (name === 'ResourceNotFoundException')
      return 'CloudWatch log group not found. Check the exact CLOUDWATCH_LOG_GROUPS names, AWS_REGION, and the AWS account used by your credentials.';
    if (['ExpiredToken', 'ExpiredTokenException'].includes(name || ''))
      return 'AWS temporary credentials have expired. Renew AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN together, then restart the server.';
    if (
      [
        'UnrecognizedClientException',
        'InvalidClientTokenId',
        'InvalidSignatureException',
        'SignatureDoesNotMatch',
      ].includes(name || '')
    )
      return 'AWS credentials were rejected. Check that the access key, secret and any session token belong to the same active credential set.';
    if (['AccessDeniedException', 'AccessDenied'].includes(name || ''))
      return 'AWS denied access to CloudWatch Logs Insights. Check logs:StartQuery, logs:GetQueryResults and logs:StopQuery permissions for the configured log groups.';
    if (name === 'CredentialsProviderError')
      return 'AWS credentials were not found. Configure AWS credentials on the dashboard server.';
    if (
      name === 'MalformedQueryException' ||
      failure?.message === 'Invalid CloudWatch configuration'
    )
      return 'CloudWatch query configuration is invalid. Check CLOUDWATCH_MARKETING_PATTERN (no slash delimiters or line breaks) and use at most 50 log groups.';
    if (name === 'ThrottlingException' || name === 'LimitExceededException')
      return 'CloudWatch query limits were reached. Wait briefly or narrow the time range before refreshing.';
    if (failure?.message === 'Expired or invalid query')
      return 'This CloudWatch query handle expired or the server restarted. Refresh logs to start a new query.';
  }
  if (failure?.name === 'TimeoutError' || failure?.name === 'AbortError')
    return 'The source request timed out. Check connectivity or try a shorter time range.';
  return 'Source query failed. Check server credentials, source filters, connectivity and shared-cache configuration.';
}
