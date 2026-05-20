import logger from "../utils/logger.js";

export const TOKEN_COOKIE_NAME = "token";
export const XSRF_TOKEN_COOKIE_NAME = "XSRF-TOKEN";

const parseExplicitBool = (value) => {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return null;
};

const collectUrlHints = () => {
  const raw = [
    process.env.PUBLIC_API_URL,
    process.env.API_PUBLIC_URL,
    process.env.CLIENT_ORIGIN,
    process.env.CLIENT_ORIGINS,
    process.env.NEXT_PUBLIC_API_URL,
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.CORS_ORIGINS,
  ];

  return raw
    .flatMap((entry) => String(entry ?? "").split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
};

/** Align browser cookie lifetime with JWT `expiresIn` (string or seconds number). */
export const jwtExpiresInToMaxAgeMs = (expiresIn) => {
  if (expiresIn == null || expiresIn === "") {
    return 7 * 24 * 60 * 60 * 1000;
  }
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn)) {
    return Math.floor(expiresIn * 1000);
  }
  const raw = String(expiresIn).trim();
  if (/^\d+$/.test(raw)) {
    return Math.floor(Number(raw) * 1000);
  }
  const compact = /^(\d+)\s*([smhd])/i.exec(raw.replace(/\s/g, ""));
  if (!compact) {
    return 7 * 24 * 60 * 60 * 1000;
  }
  const amount = Number(compact[1]);
  const unit = compact[2].toLowerCase();
  const units = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  return Math.floor(amount * (units[unit] || units.d));
};

/**
 * Secure cookies when HTTPS is in use (production domain or TLS-terminated proxy).
 * HTTP VPS/IP deployments: secure=false so browsers accept auth cookies.
 *
 * Override anytime with COOKIE_SECURE=true|false.
 */
export const resolveCookieSecure = () => {
  const explicit = parseExplicitBool(process.env.COOKIE_SECURE);
  if (explicit !== null) return explicit;

  if (
    parseExplicitBool(process.env.FORCE_HTTPS) === true ||
    parseExplicitBool(process.env.TRUST_HTTPS) === true
  ) {
    return true;
  }

  const hints = collectUrlHints();
  const hasHttps = hints.some((url) => /^https:\/\//i.test(url));
  const hasHttp = hints.some((url) => /^http:\/\//i.test(url));

  if (hasHttp && !hasHttps) return false;
  if (hasHttps && !hasHttp) return true;
  if (hasHttp && hasHttps) {
    logger.warn("cookie config: mixed HTTP/HTTPS URL hints — defaulting secure=false; set COOKIE_SECURE explicitly", {
      hintCount: hints.length,
    });
    return false;
  }

  const isProd =
    process.env.NODE_ENV === "production" ||
    process.env.RAILWAY_ENVIRONMENT === "production";

  return isProd;
};

/** Cross-site SPA (HTTPS): SameSite=None + Secure. Same-site HTTP VPS: lax. */
export const resolveCookieSameSite = () => {
  const explicit = String(process.env.COOKIE_SAME_SITE || "").trim().toLowerCase();
  if (["lax", "strict", "none"].includes(explicit)) return explicit;

  return resolveCookieSecure() ? "none" : "lax";
};

export const getBaseCookieOptions = (overrides = {}) => ({
  secure: resolveCookieSecure(),
  sameSite: resolveCookieSameSite(),
  path: "/",
  ...overrides,
});

export const getAuthCookieOptions = (overrides = {}) =>
  getBaseCookieOptions({
    httpOnly: true,
    maxAge: jwtExpiresInToMaxAgeMs(process.env.JWT_EXPIRES_IN),
    ...overrides,
  });

export const getAuthClearCookieOptions = (overrides = {}) => {
  const { maxAge: _maxAge, expires: _expires, ...rest } = getAuthCookieOptions(overrides);
  return rest;
};

/** csurf `_csrf` secret cookie (httpOnly). */
export const getCsrfSecretCookieOptions = (overrides = {}) =>
  getBaseCookieOptions({
    httpOnly: true,
    ...overrides,
  });

/** Readable double-submit token for SPA headers. */
export const getXsrfTokenCookieOptions = (overrides = {}) =>
  getBaseCookieOptions({
    httpOnly: false,
    maxAge: 24 * 60 * 60 * 1000,
    ...overrides,
  });

export const getCsurfMiddlewareOptions = () => ({
  cookie: getCsrfSecretCookieOptions(),
});

export const logCookieConfig = (context = "startup") => {
  const secure = resolveCookieSecure();
  const sameSite = resolveCookieSameSite();

  logger.info("cookie auth configuration", {
    context,
    secure,
    sameSite,
    nodeEnv: process.env.NODE_ENV || "development",
    cookieSecureEnv: process.env.COOKIE_SECURE ?? "(auto)",
    urlHintCount: collectUrlHints().length,
  });

  if (sameSite === "none" && !secure) {
    logger.warn("cookie config: SameSite=None requires Secure — browsers will reject auth/CSRF cookies on HTTP", {
      sameSite,
      secure,
    });
  }
};

export const logAuthCookieOperation = (operation, meta = {}) => {
  logger.info(`auth cookie ${operation}`, {
    secure: resolveCookieSecure(),
    sameSite: resolveCookieSameSite(),
    ...meta,
  });
};

export const logCsrfFailure = (req, reason = "invalid token") => {
  const cookieNames = Object.keys(req.cookies || {});
  logger.warn("csrf validation failed", {
    reason,
    method: req.method,
    path: req.originalUrl,
    origin: req.headers.origin || null,
    referer: req.headers.referer || null,
    cookieNames,
    hasCsrfHeader: Boolean(
      req.headers["x-csrf-token"] ||
        req.headers["csrf-token"] ||
        req.headers["x-xsrf-token"],
    ),
    cookieSecure: resolveCookieSecure(),
    cookieSameSite: resolveCookieSameSite(),
  });
};

export const logAuthFailure = (req, reason, extra = {}) => {
  const cookieNames = Object.keys(req.cookies || {});
  logger.warn("auth failure", {
    reason,
    method: req.method,
    path: req.originalUrl,
    origin: req.headers.origin || null,
    hasTokenCookie: Boolean(req.cookies?.[TOKEN_COOKIE_NAME]),
    cookieNames,
    ...extra,
  });
};
