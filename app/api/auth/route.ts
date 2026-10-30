import { NextRequest, NextResponse } from 'next/server';
import { cookieName, issueSession, sameOrigin, session, verifyPassword } from '../../../lib/auth';
import { rateLimit } from '../../../lib/store';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  return NextResponse.json(
    { authenticated: !!session(req) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return NextResponse.json({ error: 'Origin rejected.' }, { status: 403 });
  try {
    if (!(await rateLimit('login', 10, 60)))
      return NextResponse.json(
        { error: 'Too many attempts. Try again in a minute.' },
        { status: 429 },
      );
    const body = await req.text();
    if (body.length > 2048) return new Response(null, { status: 413 });
    const { username, password } = JSON.parse(body);
    if (
      typeof username !== 'string' ||
      typeof password !== 'string' ||
      !verifyPassword(username, password)
    )
      return NextResponse.json({ error: 'Invalid username or password.' }, { status: 401 });
    const response = NextResponse.json({ authenticated: true });
    response.cookies.set(cookieName, issueSession(), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: 8 * 3600,
    });
    return response;
  } catch {
    return NextResponse.json(
      { error: 'Sign-in unavailable. Check server authentication and cache configuration.' },
      { status: 503 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  if (!sameOrigin(req)) return new Response(null, { status: 403 });
  const response = NextResponse.json({ authenticated: false });
  response.cookies.delete(cookieName);
  return response;
}
