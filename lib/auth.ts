import { createHmac, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
const cookieName = 'pulse_session';

export { cookieName };

function secret() {
  const value = process.env.SESSION_SECRET;
  if (value && value.length >= 32) return value;
  if (process.env.NODE_ENV === 'production')
    throw new Error('Set SESSION_SECRET to at least 32 characters.');
  return 'local-development-only-marketing-pulse-secret';
}

function sign(value: string) {
  return createHmac('sha256', secret()).update(value).digest('base64url');
}

export function issueSession() {
  const data = Buffer.from(
    JSON.stringify({ id: randomUUID(), exp: Date.now() + 8 * 3600000 }),
  ).toString('base64url');
  return `${data}.${sign(data)}`;
}

export function verifySession(token?: string): string | null {
  if (!token || token.length > 1024) return null;
  const [data, signature, extra] = token.split('.');
  if (!data || !signature || extra) return null;
  const expected = sign(data);
  const actual = Buffer.from(signature);
  if (
    actual.length !== Buffer.byteLength(expected) ||
    !timingSafeEqual(actual, Buffer.from(expected))
  )
    return null;
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString());
    return parsed.exp > Date.now() && typeof parsed.id === 'string' ? parsed.id : null;
  } catch {
    return null;
  }
}

export function session(request: NextRequest) {
  return verifySession(request.cookies.get(cookieName)?.value);
}

export function sameOrigin(request: NextRequest) {
  const configured = process.env.APP_ORIGIN;
  if (configured) return request.headers.get('origin') === configured;
  if (process.env.NODE_ENV === 'production') return false;
  // Next's development server may normalize nextUrl to localhost even for 127.0.0.1.
  const host = request.headers.get('host');
  return (
    !!host &&
    /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) &&
    request.headers.get('origin') === `http://${host}`
  );
}

export function verifyPassword(username: string, password: string) {
  if (username !== (process.env.ADMIN_USERNAME || 'admin') || password.length > 256) return false;
  const hash = process.env.ADMIN_PASSWORD_HASH;
  if (!hash) return process.env.NODE_ENV !== 'production' && password === 'admin';
  const [salt, hex] = hash.split(':');
  if (!salt || !/^[a-f0-9]{128}$/.test(hex || ''))
    throw new Error('Invalid password hash configuration.');
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(hex, 'hex'));
}
