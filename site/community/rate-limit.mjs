const DEFAULT_LIMITS = Object.freeze({
  analytics: { perSource: 240, global: 20_000, windowMs: 60 * 1_000 },
  submission: { perSource: 5, global: 200, windowMs: 60 * 60 * 1_000 },
  vote: { perSource: 60, global: 5_000, windowMs: 60 * 1_000 },
  poll: { perSource: 180, global: 20_000, windowMs: 60 * 1_000 },
});

export class RateLimiter {
  #limits;
  #buckets = new Map();
  #now;
  #checks = 0;

  constructor({ limits = {}, now = () => Date.now() } = {}) {
    this.#limits = {};
    for (const [action, defaults] of Object.entries(DEFAULT_LIMITS)) {
      const configured = { ...defaults, ...(limits[action] ?? {}) };
      for (const field of ['perSource', 'global', 'windowMs']) {
        if (!Number.isSafeInteger(configured[field]) || configured[field] <= 0) {
          throw new TypeError(`Invalid ${action} rate limit: ${field}`);
        }
      }
      this.#limits[action] = configured;
    }
    this.#now = now;
  }

  check(action, sourceHash) {
    const limit = this.#limits[action];
    if (!limit) throw new TypeError(`Unknown rate-limit action: ${action}`);
    const now = this.#now();
    const sourceKey = `${action}:source:${sourceHash}`;
    const globalKey = `${action}:global`;
    const source = this.#current(sourceKey, now, limit.windowMs);
    const global = this.#current(globalKey, now, limit.windowMs);

    if (source.count >= limit.perSource || global.count >= limit.global) {
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil((Math.max(source.resetAt, global.resetAt) - now) / 1_000)),
      };
    }

    source.count += 1;
    global.count += 1;
    this.#buckets.set(sourceKey, source);
    this.#buckets.set(globalKey, global);

    this.#checks += 1;
    if (this.#checks % 1_000 === 0) this.#prune(now);
    return { allowed: true, retryAfter: 0 };
  }

  #current(key, now, windowMs) {
    const existing = this.#buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      return { count: 0, resetAt: now + windowMs };
    }
    return existing;
  }

  #prune(now) {
    for (const [key, bucket] of this.#buckets) {
      if (bucket.resetAt <= now) this.#buckets.delete(key);
    }
  }
}

export const defaultRateLimits = DEFAULT_LIMITS;
