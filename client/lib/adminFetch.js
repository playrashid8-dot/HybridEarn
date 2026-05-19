/**
 * CSRF-safe admin API wrapper: axios + shared httpOnly session cookies + XSRF priming.
 * Paths are relative to `/api` (`/admin/...` → `${BASE_URL}/admin/...`).
 */
import API, { initCSRF, BASE_URL } from "./api";

export const ADMIN_API_BASE = BASE_URL;

/**
 * @param {string} path e.g. `/admin/stats`
 * @param {import("axios").AxiosRequestConfig & { body?: unknown }} [options]
 */
export async function adminFetch(path, options = {}) {
  const { body, ...restOptions } = options;
  const method = String(restOptions.method || "GET").toUpperCase();
  const unsafe = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  const skipCsrf = String(path).includes("csrf-token");

  if (unsafe && !skipCsrf) {
    await initCSRF(false);
  }

  let data = body;
  if (typeof data === "string") {
    try {
      data = data.trim() ? JSON.parse(data) : undefined;
    } catch {
      /* non-JSON body */
    }
  }
  const userHeaders = { ...(restOptions.headers || {}) };
  delete userHeaders.Authorization;
  delete userHeaders.authorization;

  /** @type {import("axios").AxiosRequestConfig} */
  const cfg = {
    ...restOptions,
    url: path,
    method: method.toLowerCase(),
    data: method === "GET" || method === "HEAD" ? undefined : data,
    headers: userHeaders,
    withCredentials: true,
  };

  try {
    const res = await API.request(cfg);
    const payload = res.data;
    if (payload && typeof payload === "object" && payload.success === false) {
      const msg =
        payload.msg ||
        payload.message ||
        `Request failed (${typeof res.status === "number" ? res.status : ""})`;
      const error = new Error(typeof msg === "string" ? msg : "Unable to complete request");
      error.status = res.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  } catch (err) {
    const status = err.response?.status;
    const payload = err.response?.data;
    const msg =
      payload?.msg ||
      payload?.message ||
      (status === 403
        ? "Forbidden — admin access or session/CSRF issue (request was retried once when applicable)"
        : null) ||
      err.message ||
      `Request failed (${typeof status === "number" ? status : "network"})`;
    const error = new Error(typeof msg === "string" ? msg : "Unable to complete request");
    error.status = status;
    error.payload = payload;
    throw error;
  }
}
