// Token bucket: `capacity` burst, refilled at `perSec`. One per WebSocket
// connection, plus a keyed set for per-IP limits on the HTTP endpoints.

export class TokenBucket {
  constructor(capacity, perSec, now = Date.now) {
    this.capacity = capacity;
    this.perSec = perSec;
    this.now = now;
    this.tokens = capacity;
    this.last = now();
  }

  refill() {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.perSec);
    this.last = t;
    return this.tokens;
  }

  take() {
    if (this.refill() < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export class KeyedLimiter {
  constructor(capacity, perSec) {
    this.capacity = capacity;
    this.perSec = perSec;
    this.buckets = new Map();
    // Drop buckets that have refilled completely so the map can't grow forever.
    this.sweeper = setInterval(() => {
      for (const [k, b] of this.buckets) {
        if (b.refill() >= b.capacity) this.buckets.delete(k);
      }
    }, 60_000);
    this.sweeper.unref();
  }

  allow(key) {
    let b = this.buckets.get(key);
    if (!b) this.buckets.set(key, (b = new TokenBucket(this.capacity, this.perSec)));
    return b.take();
  }

  close() {
    clearInterval(this.sweeper);
  }
}
