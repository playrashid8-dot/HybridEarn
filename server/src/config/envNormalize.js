/**
 * Env string normalization (quotes, spacing) and connectivity var aliases.
 * Safe for Railway: never logs secret values, only mutates when fixing obvious formatting.
 */

export function stripOuterQuotes(value) {
  let t = String(value ?? "").trim();
  if (t.length >= 2) {
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      t = t.slice(1, -1).trim();
    }
  }
  return t;
}

export function normalizeMongoUri(raw) {
  return stripOuterQuotes(raw);
}

export function isLikelyMongoUri(uri) {
  const u = stripOuterQuotes(uri);
  return /^mongodb(\+srv)?:\/\//i.test(u);
}

/**
 * @returns {string} First non-empty Redis connection URL from known env keys.
 */
export function resolveRedisUrlFromEnv() {
  const keys = [
    "REDIS_URL",
    "REDISCLOUD_URL",
    "REDIS_PRIVATE_URL",
    "OPENREDIS_URL",
  ];
  for (const key of keys) {
    const v = stripOuterQuotes(process.env[key]);
    if (v) {
      return v;
    }
  }
  return "";
}

/**
 * Apply URI cleanup and Redis alias → REDIS_URL so legacy `process.env.REDIS_URL` checks stay accurate.
 */
export function normalizeProcessEnvConnectivity() {
  const mongo = stripOuterQuotes(process.env.MONGO_URI);
  if (mongo && mongo !== process.env.MONGO_URI) {
    process.env.MONGO_URI = mongo;
  }

  const redis = resolveRedisUrlFromEnv();
  if (redis && !stripOuterQuotes(process.env.REDIS_URL)) {
    process.env.REDIS_URL = redis;
  }
}
