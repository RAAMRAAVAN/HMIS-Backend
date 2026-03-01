const buckets = new Map();

function getClientKey(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || "unknown";
}

export function createRateLimiter({ windowMs, maxRequests, keyPrefix = "global" }) {
  const ttl = Math.max(windowMs, 1000);

  return function rateLimit(req, res, next) {
    const clientKey = `${keyPrefix}:${getClientKey(req)}`;
    const now = Date.now();

    const current = buckets.get(clientKey);
    if (!current || now > current.resetAt) {
      buckets.set(clientKey, { count: 1, resetAt: now + ttl });
      return next();
    }

    if (current.count >= maxRequests) {
      const retryAfterSeconds = Math.ceil((current.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(Math.max(retryAfterSeconds, 1)));
      return res.status(429).json({
        success: false,
        message: "Too many requests. Please try again shortly.",
      });
    }

    current.count += 1;
    return next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of buckets) {
    if (now > value.resetAt) buckets.delete(key);
  }
}, 60_000).unref();
