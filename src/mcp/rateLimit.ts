// How many requests an API token makes to the MCP server: at most `requests` in any `windowMs`
// (a sliding window, in this process's memory -- each instance counts its own).
export interface RateLimit {
  requests: number;
  windowMs: number;
}

export const DEFAULT_MCP_RATE_LIMIT: RateLimit = { requests: 120, windowMs: 60_000 };

export function createRateLimiter({ requests, windowMs }: RateLimit) {
  const seen = new Map<string, number[]>();
  return {
    /** Counts a request by `key`: whether it's allowed, and if not, how long until it would be. */
    take(key: string, now = Date.now()): { allowed: true } | { allowed: false; retryAfterMs: number } {
      const recent = (seen.get(key) ?? []).filter(at => at > now - windowMs);
      if (recent.length >= requests) {
        seen.set(key, recent);
        return { allowed: false, retryAfterMs: recent[0] + windowMs - now };
      }
      recent.push(now);
      seen.set(key, recent);
      return { allowed: true };
    },
  };
}
