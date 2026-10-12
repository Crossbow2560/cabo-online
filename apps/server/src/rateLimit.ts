import type { IncomingHttpHeaders } from 'node:http';

export interface Limit {
  /** Max hits per key within the window. */
  limit: number;
  windowMs: number;
}

export interface Limiter {
  /** Records a hit for `key`; `ok: false` means it was over the limit (and wasn't counted). */
  hit(key: string): { ok: boolean; retryAfterMs: number };
  stop(): void;
}

/** Sliding-window limiter kept in memory: fine for one server process. */
export function createLimiter({ limit, windowMs }: Limit): Limiter {
  const hits = new Map<string, number[]>();
  // Drop keys whose hits have all expired, so memory stays bounded.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, ts] of hits) if (ts[ts.length - 1] <= cutoff) hits.delete(k);
  }, Math.max(windowMs, 10_000));
  sweep.unref();

  return {
    hit(key) {
      const now = Date.now();
      const ts = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (ts.length >= limit) {
        hits.set(key, ts);
        return { ok: false, retryAfterMs: ts[0] + windowMs - now };
      }
      ts.push(now);
      hits.set(key, ts);
      return { ok: true, retryAfterMs: 0 };
    },
    stop: () => clearInterval(sweep),
  };
}

/** A limiter that never refuses (rate limits turned off). */
export const noLimit: Limiter = { hit: () => ({ ok: true, retryAfterMs: 0 }), stop: () => {} };

/**
 * The caller's IP. Behind a trusted reverse proxy, the proxy's headers name the real client
 * (Cloudflare's first); otherwise only the socket address can be believed.
 */
export function clientIp(headers: IncomingHttpHeaders, remoteAddress: string | undefined, trustProxy: boolean) {
  if (trustProxy) {
    const cf = headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf) return cf.trim();
    const xff = headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return remoteAddress ?? 'unknown';
}
