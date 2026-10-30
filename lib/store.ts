import { Redis } from '@upstash/redis';
const memory = new Map<string, { value: unknown; expires: number }>();
const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? Redis.fromEnv()
    : null;

function check() {
  if (!redis && process.env.NODE_ENV === 'production')
    throw new Error('Shared cache must be configured for production.');
}

export async function get<T>(key: string): Promise<T | null> {
  check();
  if (redis) return redis.get<T>(`pulse:${key}`);
  const item = memory.get(key);
  if (!item || item.expires < Date.now()) {
    memory.delete(key);
    return null;
  }
  return item.value as T;
}

export async function put(key: string, value: unknown, seconds: number) {
  check();
  if (redis) {
    await redis.set(`pulse:${key}`, value, { ex: seconds });
    return;
  }
  for (const [k, v] of memory) if (v.expires < Date.now()) memory.delete(k);
  memory.set(key, { value, expires: Date.now() + seconds * 1000 });
}

export async function rateLimit(key: string, limit: number, seconds: number): Promise<boolean> {
  check();
  if (redis) {
    const count = await redis.eval(
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",
      [`pulse:rate:${key}`],
      [seconds],
    );
    return Number(count) <= limit;
  }
  const count = (await get<number>(`rate:${key}`)) || 0;
  if (count >= limit) return false;
  if (count === 0) await put(`rate:${key}`, 1, seconds);
  else memory.get(`rate:${key}`)!.value = count + 1;
  return true;
}

export async function lock(key: string, seconds: number) {
  check();
  if (redis) return !!(await redis.set(`pulse:lock:${key}`, '1', { nx: true, ex: seconds }));
  if (await get(`lock:${key}`)) return false;
  await put(`lock:${key}`, true, seconds);
  return true;
}
