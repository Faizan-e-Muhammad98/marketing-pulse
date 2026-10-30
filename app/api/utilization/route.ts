import { NextRequest, NextResponse } from 'next/server';
import { session } from '../../../lib/auth';
import { rateLimit } from '../../../lib/store';
import { utilization } from '../../../lib/utilization';
import { utilizationInput } from '../../../lib/utilization-model';

export const runtime = 'nodejs';

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  if (!session(req)) return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
  let input;
  try {
    input = utilizationInput(req.nextUrl.searchParams);
  } catch {
    return NextResponse.json(
      { error: 'Invalid utilization page or expired snapshot. Refresh to restart.' },
      { status: 400 },
    );
  }
  try {
    if (!(await rateLimit('utilization', 120, 60)))
      return NextResponse.json(
        { error: 'Usage request limit reached. Please try again shortly.' },
        { status: 429 },
      );
    const result = await utilization(input.offset, input.at, input.refresh);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json(
      {
        error:
          'Could not load utilization. Check database connectivity, shared cache, and read access to public restaurant/business and tenant Marketing tables.',
      },
      { status: 503 },
    );
  }
}
