import type { NextFunction, Request, Response } from "express";

const API_KEY = process.env.P2P_API_KEY || "";
const RATE_LIMIT_WINDOW_MS = Number(process.env.P2P_RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX = Number(process.env.P2P_RATE_LIMIT_MAX || 300);

const buckets = new Map<string, { count: number; resetAt: number }>();

function clientKey(req: Request) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || req.socket.remoteAddress || "unknown";
}

export function rateLimit(req: Request, res: Response, next: NextFunction) {
  const key = clientKey(req);
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return next();
  }

  bucket.count += 1;

  if (bucket.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "rate limit exceeded" });
  }

  next();
}

export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  if (!API_KEY) return next();

  const provided = req.headers["x-p2p-api-key"];
  if (provided === API_KEY) return next();

  return res.status(401).json({ error: "invalid api key" });
}
