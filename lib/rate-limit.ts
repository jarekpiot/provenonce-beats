import { NextRequest, NextResponse } from 'next/server';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export class RateLimiter {
  private map = new Map<string, RateLimitEntry>();
  private maxRequests: number;
  private windowMs: number;
  private maxEntries: number;

  constructor(opts: { maxRequests: number; windowMs: number; maxEntries?: number }) {
    this.maxRequests = opts.maxRequests;
    this.windowMs = opts.windowMs;
    this.maxEntries = Math.max(100, opts.maxEntries ?? 20_000);

    const interval = setInterval(() => this.cleanup(), 60_000);
    if (typeof interval === 'object' && 'unref' in interval) {
      interval.unref();
    }
  }

  check(ip: string): RateLimitResult {
    const now = Date.now();
    this.enforceCapacity(now);
    const entry = this.map.get(ip);

    if (!entry || now >= entry.resetAt) {
      const resetAt = now + this.windowMs;
      this.map.set(ip, { count: 1, resetAt });
      this.enforceCapacity(now);
      return { allowed: true, remaining: this.maxRequests - 1, resetAt };
    }

    entry.count++;
    if (entry.count > this.maxRequests) {
      return { allowed: false, remaining: 0, resetAt: entry.resetAt };
    }
    this.enforceCapacity(now);

    return {
      allowed: true,
      remaining: this.maxRequests - entry.count,
      resetAt: entry.resetAt,
    };
  }

  private cleanup() {
    const now = Date.now();
    this.map.forEach((entry, ip) => {
      if (now >= entry.resetAt) {
        this.map.delete(ip);
      }
    });
  }

  private enforceCapacity(now: number) {
    if (this.map.size <= this.maxEntries) return;

    this.cleanup();
    if (this.map.size <= this.maxEntries) return;

    const toDrop = this.map.size - this.maxEntries;
    let dropped = 0;
    for (const key of Array.from(this.map.keys())) {
      this.map.delete(key);
      dropped++;
      if (dropped >= toDrop) break;
    }
  }
}

export function getClientIp(req: NextRequest): string {
  const vercelForwardedFor = req.headers.get('x-vercel-forwarded-for');
  if (vercelForwardedFor) {
    return vercelForwardedFor.trim();
  }

  const realIp = req.headers.get('x-real-ip');
  if (realIp) {
    return realIp.trim();
  }

  const cloudflareIp = req.headers.get('cf-connecting-ip');
  if (cloudflareIp) {
    return cloudflareIp.trim();
  }

  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    const parts = forwarded.split(',');
    return parts[parts.length - 1].trim();
  }
  return '127.0.0.1';
}

export function rateLimitResponse(resetAt: number): NextResponse {
  const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);
  return NextResponse.json(
    { error: 'Too many requests. Please try again later.' },
    {
      status: 429,
      headers: { 'Retry-After': String(Math.max(retryAfter, 1)) },
    },
  );
}
