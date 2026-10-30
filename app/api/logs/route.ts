import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { session } from '../../../lib/auth';
import { get, put, lock, rateLimit } from '../../../lib/store';
import { validateQuery, type SourceResult } from '../../../lib/model';
import { cloudwatch } from '../../../lib/cloudwatch';
import { newrelic } from '../../../lib/newrelic';
import { audit } from '../../../lib/audit';
import { sourceErrorMessage } from '../../../lib/source-errors';

export const runtime = 'nodejs';

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const owner = session(req);
  if (!owner) return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
  let input;
  try {
    input = validateQuery(req.nextUrl.searchParams);
  } catch {
    return NextResponse.json({ error: 'Invalid query or time range.' }, { status: 400 });
  }
  try {
    if (!(await rateLimit('source-requests', 180, 60)))
      return NextResponse.json(
        { error: 'Query limit reached. Try again shortly.' },
        { status: 429, headers: { 'Retry-After': '60' } },
      );
    const scope =
      input.source === 'newrelic'
        ? [
            'marketing-v1',
            process.env.NEW_RELIC_ACCOUNT_ID,
            process.env.NEW_RELIC_APP_NAME,
            process.env.NEW_RELIC_REGION,
            process.env[`NEW_RELIC_${input.view.toUpperCase()}_FILTER`],
          ]
        : input.source === 'cloudwatch'
          ? [
              'full-range-v1',
              process.env.AWS_REGION,
              process.env.CLOUDWATCH_LOG_GROUPS,
              process.env.CLOUDWATCH_MARKETING_PATTERN,
            ]
          : null;
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          input.source,
          input.view,
          input.start,
          input.end,
          input.cursor || '',
          scope,
          input.source === 'cloudwatch' ? owner : '',
        ]),
      )
      .digest('hex');
    if (!input.handle && !input.refresh) {
      const cached = await get<SourceResult>(`result:${key}`);
      if (cached) return NextResponse.json(cached);
    }
    if (!input.handle && !(await lock(`${owner}:${key}`, input.refresh ? 15 : 3)))
      return NextResponse.json(
        { error: 'A query just started. Please wait a few seconds.' },
        { status: 429, headers: { 'Retry-After': input.refresh ? '15' : '3' } },
      );
    const result =
      input.source === 'cloudwatch'
        ? await cloudwatch(input, owner)
        : input.source === 'newrelic'
          ? await newrelic(input)
          : await audit(input);
    if (
      (input.source !== 'cloudwatch' && result.status === 'ready') ||
      (input.source === 'cloudwatch' && !input.handle && result.status === 'pending')
    )
      await put(`result:${key}`, result, input.end - input.start > 6 * 3600000 ? 300 : 60);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    // Do not log upstream errors: they may contain SQL, credentials or customer data.
    return NextResponse.json({
      source: input.source,
      status: 'error',
      events: [],
      queriedAt: new Date().toISOString(),
      message: sourceErrorMessage(input.source, error),
    } satisfies SourceResult);
  }
}
