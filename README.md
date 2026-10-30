# Marketing Pulse

Standalone, read-only Marketing log dashboard for Vercel. This folder has its own package manifest and lockfile; it does not import Zeus code, change its dependencies, or run its migrations. It can be copied into a separate repository unchanged.

## Run locally

Node.js 22.20 or later:

```sh
cd marketing-pulse
npm ci
cp .env.example .env.local
npm run dev
```

Open http://localhost:3000. Local development supports `admin` / `admin` when no password hash is configured. No source credentials or fake telemetry ship with the app. Unconfigured sources are clearly labeled. Local caching/rate limiting uses process memory; production requires Redis.

## Production configuration

1. Set `ADMIN_PASSWORD_HASH`, a random `SESSION_SECRET` (at least 32 characters), and `APP_ORIGIN` to the exact HTTPS dashboard origin. Generate a hash with `npm run hash-password`, passing the password on stdin, not as a shell argument. The output is `salt:hash`. A shell can safely pipe a silently read variable into the script. Production has no default password.
2. Configure `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Redis contains short-lived sanitized telemetry, query handles, locks and rate-limit counters; restrict access accordingly.
3. Configure source envs using `.env.example`. Do not put secrets into `NEXT_PUBLIC_*` variables, commit `.env.local`, or grant preview deployments production access.
4. Deploy with Vercel's project Root Directory set to `marketing-pulse`, or deploy this folder as a standalone repository. Use the Next.js preset and Node.js 22. Set the function region near AWS/RDS. No cron or ingestion worker is required.

### Direct audit database access

Set `AUDIT_DATABASE_URL` and `AUDIT_EVENT_PATTERN`. The adapter only selects allowlisted fields from `public.audit_logs`, uses parameterized SQL, requests a read-only PostgreSQL session, limits its pool to two connections per process, and sets an eight-second statement timeout. Provision a dedicated role with CONNECT, public-schema USAGE and SELECT on `public.audit_logs` only, preferably on a read replica. Do not reuse the main application's DB role. Serverless instances each have their own pool: limit deployment concurrency or use your existing connection pooler for larger traffic.

TLS certificate verification is enabled. Provide the RDS CA bundle via `AUDIT_DB_CA` if needed. Do not include `sslmode` or certificate parameters in the URL, as node-postgres can override the explicit TLS configuration. `AUDIT_DB_SSL=disable` is for local non-production databases only.

Environment variables do not establish network connectivity. A private RDS endpoint still requires Vercel Secure Compute/VPC connectivity (or an existing approved private connection). This implementation intentionally uses direct DB access as requested; no AWS API is deployed. Choose networking before production deployment. Never open RDS to all IP addresses.

The query uses event-name matching to scope Marketing. Confirm that the default regex includes your intended audit events. This is an operational filter, not tenant authorization: the single admin can view all matching tenants. Audit metadata lacks a reliable endpoint field and SQL duration, so those values are not fabricated.

### CloudWatch

Configure explicit log groups and a Marketing regex. Only those groups are queried. Use AWS SDK credentials scoped for `logs:StartQuery`, `logs:GetQueryResults`, and `logs:StopQuery`, with log-group resource restrictions where supported by AWS. No write/delete permissions are needed. Validate IAM action-specific resource support in your account.

Queries start and return immediately; browser polling invokes short server requests. Handles are opaque, bound to the authenticated session and requested time range, and expire after an hour of inactivity. Each scan is stopped on polling after five minutes or the configured cumulative scanned-byte budget; downloading completed result pages can take longer. This budget is a soft safeguard: bytes already scanned are billed, and closing the browser stops polling. It is not a hard cost ceiling.

### New Relic

Set account ID, user key and US/EU region. Configure a separate trusted NRQL WHERE expression for each view (`NEW_RELIC_LOGS_FILTER`, `NEW_RELIC_ERRORS_FILTER`, `NEW_RELIC_QUERIES_FILTER`). Attribute names vary between Log, TransactionError and Span. Each filter must scope the actual Marketing applications/services/routes. No browser-supplied NRQL is accepted. Restrict the user's account roles as well as protecting its key.

The query-performance adapter reads datastore spans with `duration > 0.5` seconds. It does not assume all queries were captured. If no datastore spans exist, no SQL performance data can be inferred from audit controller durations.

## Behavior and deliberate limits

- Three views: Logs, Errors and Query performance. Four ranges: 1h, 6h, 24h and 7d. Ranges end on the current minute for shared-cache reuse; Refresh advances to the current minute.
- Existing plain-text CloudWatch logs are parsed. Query errors can be logged at info level, so error detection also recognizes message patterns. Error counts are source observations, not unique incidents.
- Error grouping is source-specific and normalizes UUIDs/timestamps. It does not merge across sources without proof. Expanded groups show the individual loaded occurrences, trace IDs, first/last times and count.
- Search, severity and service filters apply to loaded data. Pagination displays 50 rows. CloudWatch automatically streams all matching pages, splitting capped queries into smaller windows; New Relic still fetches at most 1,000 candidates and labels capped results. Audit fetches 500 rows and supports keyset-based "Load more". CloudWatch counts are provisional while loading and complete for the configured filters only after all windows finish. Errors are parsed with the same severity rules on every page, so no separate approximate error-count scan is used. Other sources can remain incomplete.
- Query performance shows existing timings strictly above 500ms. The current main project may not emit slow-query logs. No instrumentation was changed.
- Cache TTL is 60 seconds for up to six hours and five minutes for longer ranges. Refresh bypasses cached results with a per-session/filter cooldown. Source failures are isolated. CloudWatch caches the owner-bound initial continuation for that TTL, then caches immutable page replies for one hour so replay does not repeat the scan or download. Final pages are never cached as if they were the entire result.
- Payloads are allowlisted. Basic redaction removes emails, phone-like numbers, credential assignments, URL query values and legacy SQL bind-parameter suffixes. This is not a complete PII detector: SQL literals, free text and customer names can remain. Review your actual source format and restrict dashboard access before connecting production.
- Shared rate limits protect login and source requests. This single-admin MVP does not provide per-user authorization or an audit trail of dashboard reads.
- Seven-day history depends on upstream retention. The inspected main-project audit sweep deletes rows older than seven days. No logs are archived here.

## Checks

```sh
npm run lint
npm run format:check
npm test
npm run typecheck
npm run build
```

Unit tests cover range validation, redaction, grouping, severity normalization, signed sessions and rate limits. Live source correctness and Vercel/RDS connectivity must be verified against the configured environment before release.

## Marketing-only New Relic scope

Set `NEW_RELIC_APP_NAME` to the backend app (currently `AIO_BACKEND_PROD`). Errors are restricted to the request-route allowlist in `lib/marketing-scope.ts`, including current and legacy Gift Card routes, Campaigns/Journeys/Loyalty, Reviews and their webhooks, Menuboards, Brandbook, and other Marketing controllers. Shared payment, order, inventory and guest endpoints are excluded. A generic `/api/*` transaction name does not establish Marketing ownership; the actual request URI is used when available. Missing ownership is excluded.

Datastore spans have no route attributes in this account. Query performance first reads up to 1,000 slow-span candidates, then resolves their `transactionId` against `Transaction.guid` within the selected time range and app. Only spans with a confirmed Marketing parent are returned, with the parent endpoint attached. SQL/table names are never used to guess ownership. Sampled or missing parent transactions and parents outside the selected time window mean incomplete coverage; when the candidate cap is reached, narrow the range. Background operations without a Marketing HTTP parent are not included in this phase.

`NEW_RELIC_ERRORS_FILTER` and `NEW_RELIC_QUERIES_FILTER` are now optional extra restrictions. Existing app-only values are safe: route scoping is always applied as well. Logs still uses `NEW_RELIC_LOGS_FILTER`; this change does not enable backend log forwarding. Cached results are versioned by scope and configuration so the old backend-wide results are not reused. After updating, restart the dev server and refresh the page.

### CloudWatch slow responses

AWS calls have a 20-second deadline, below the 30-second Vercel handler limit. A temporary failure while fetching results keeps the existing query handle and retries polling, rather than starting another billable scan. Three consecutive temporary poll failures stop the query on a best-effort basis and return an actionable error. Authentication/permission failures are not retried. Each scan remains bounded to five minutes; all split scans share the cumulative byte budget. Completed downloads continue beyond five minutes. A StartQuery timeout cannot safely be retried automatically because AWS may already have started the query without returning its ID.

### CloudWatch error classification

The CloudWatch parser respects the explicit Nest log level (LOG/INFO, WARN, ERROR, etc.) or a top-level JSON severity. Error-related words inside notification payloads do not promote a record to an error. Narrow exceptions preserve known TypeORM query failures and audit-write failures emitted at LOG level. Untagged exception headlines are recognized; ambiguous text defaults to info. The Errors view drops non-error candidates after parsing, and cached CloudWatch results are versioned to discard the previous classification. The Insights error keyword filter remains a broad candidate filter; final severity is determined after parsing each page. Marketing keyword scoping is separate and unchanged.

### Complete CloudWatch loading

- The browser receives each redacted page as it arrives and deduplicates by the CloudWatch record pointer. The table renders 50 rows at a time; expanded error groups show the first 50 occurrences. Loaded data is retained if a later request fails.
- The dashboard no longer caps CloudWatch at 1,000 records. A single Insights query requests up to 100,000 rows (the AWS limit), downloaded in 250-record pages, falling back to 100 after a timeout/reset. Completed pages have no artificial polling delay.
- If a query reaches the AWS limit, the adapter splits its time window and processes newer windows first. Explicit half-open millisecond filters prevent gaps/overlaps at boundaries despite the inclusive-second API range. Parent pages are discarded before delivery when AWS supplies match counts; pointer deduplication covers the fallback where the cap is detected while paging. At least 100,000 events at one millisecond cannot be split further and are explicitly reported incomplete.
- Split queries scan data again. CLOUDWATCH_MAX_SCAN_BYTES applies cumulatively across the original and all child queries; repeated polling of one query does not double-count bytes. It remains a soft cost safeguard, not a hard billing cap. A budget failure, expired handle, lost connection, or unsplittable window is never reported as complete.
- Only one normalized page is returned per request. Server continuation state contains cursors/windows/counters, not the growing record collection. Browser memory still grows with loaded records; very large exports should use an export pipeline rather than a browser table. Changing the view/range or refreshing cancels the old browser load; an already running AWS query may finish and incur scan charges.
- “Complete” means all matching records available to these queries and the configured Marketing/source filters, not an immutable snapshot of late-arriving logs. Refresh to include newly ingested records. No database, New Relic, or credential behavior is changed.

Use `npm run format` to format source and documentation with Prettier, and `npm run lint:fix` for ESLint fixes. ESLint uses the Next.js Core Web Vitals and TypeScript rules; Prettier handles formatting separately. Generated files, dependencies, and environment files are excluded.

## Marketing utilization

Open **Utilization** beside **Logs & performance**. This view reads business tables through the existing `AUDIT_DATABASE_URL`, `AUDIT_DB_SSL`, and `AUDIT_DB_CA`; it does not infer adoption from audit logs. No new credentials are needed if the read-only user already has access to these tables.

Counts are distinct live restaurants, with percentages of the live population. Live means an active `public.restaurant`, an active/nondeleted `public.business`, and a matching active restaurant row in `tenant_<businessId>`. Incomplete provisioning and inactive tenant restaurants are excluded. Restaurants without a tenant restaurant table are excluded at discovery.

| Feature    | Database definition                                                                                                                                                                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gift cards | `gift_card_settings` exists and a paid gift card sale in the window: POS `gift_card_ticket`/`payment`, or online `user_gift_card`/`gift_card`/`payment`. Sale time is payment `createdAt`; unpaid and fully refunded sales are excluded.                   |
| Loyalty    | An active, nondeleted `loyalty` tier and total `ticket.paymentInfo.redeemedPoints` greater than 1 on paid/partially refunded tickets created in the window.                                                                                                |
| Campaigns  | `marketing_email_log` with Campaign source and provider message ID, or campaign-linked `customer_marketing_sms` with sent/delivered/read status, in the window. This measures outbound email/SMS, not website/social campaign publication.                 |
| ARM        | Active nonempty `review_response` created in the window, linked to the restaurant through `review`.                                                                                                                                                        |
| Deals      | A paid/partially refunded ticket created in the window with a ticket-level or item-level deal. Voided, rejected, cancelled and moved items do not qualify.                                                                                                 |
| Guestbook  | A linked `restaurant_customer_relation`/`customer` with an email matching basic address syntax or a phone with 7–15 digits and only conventional formatting. No activity-window restriction; this checks format, not verified ownership or deliverability. |
| Journeys   | `journey_result.sent > 0` with Email or Text channel and result date in the window, linked through `journey`. Either channel qualifies.                                                                                                                    |

The window is the last 30 days, ending at the displayed five-minute boundary. Order creation timestamps are a proxy for redemption time because there is no dedicated redemption-event timestamp in these ticket records. Timestamp-without-time-zone columns are interpreted using the DB session timezone (the application's UTC convention).

The authenticated `/api/utilization` endpoint loads four business schemas per page, with at most two simultaneous database queries, using the existing read-only pool and query timeouts. The browser loads pages sequentially and stops when navigating away. Results are cached for five minutes; Refresh bypasses usage-result cache. A snapshot fixes the candidate population for that run (up to one hour). The UI marks partial counts and suppresses percentages until all pages succeed. Missing permissions, incompatible schemas or failed queries are never reported as zero adoption. The endpoint shares the existing production Redis requirement and limits requests to 120/minute.

Read access must include `public.business`, `public.restaurant`, tenant restaurant and the tables in the definitions above. Only restaurant IDs and feature booleans leave SQL; contact details, review text, payment details and message bodies are never returned to the dashboard. No main-project schema changes or database writes are made.
