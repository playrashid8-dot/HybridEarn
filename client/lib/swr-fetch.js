import API, { normalize } from "./api";
import { devWarn } from "./devWarn";
import { fetchCurrentUser } from "./session";
import { fetchHybridSummary } from "./hybrid";

const DEFAULT_TIMEOUT_MS = 4000;

/**
 * Prefer over long axios timeouts for HybridEarn dashboards — fails fast UX.
 */
export function withRaceTimeout(promise, ms = DEFAULT_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error(""), { code: "TIMEOUT" })), ms),
    ),
  ]);
}

export async function safeFetch(fn) {
  try {
    return await fn();
  } catch (err) {
    devWarn("API fallback:", err?.message);
    return null;
  }
}

export const USER_ME_SWR_KEY = "/user/me";
export const HYBRID_SUMMARY_SWR_KEY = "/hybrid/deposit/summary";
export const DASHBOARD_SUMMARY_SWR_KEY = "/user/dashboard-summary";

/** Parallel bundle: user + hybrid summary (one SWR, shared timeout per request). */
export const DASHBOARD_MAIN_BUNDLE_KEY = "dashboard-main-bundle";

/** Team page: user + dashboard-summary in parallel. */
export const TEAM_PAGE_BUNDLE_KEY = "team-page-bundle";

export function fetchUserMeSWR() {
  return safeFetch(() => withRaceTimeout(fetchCurrentUser(), DEFAULT_TIMEOUT_MS));
}

export function fetchHybridSummarySWR() {
  return safeFetch(() =>
    withRaceTimeout(fetchHybridSummary(), DEFAULT_TIMEOUT_MS),
  );
}

export function fetchDashboardSummarySWR() {
  return safeFetch(() =>
    withRaceTimeout(
      API.get(DASHBOARD_SUMMARY_SWR_KEY).then((res) => {
        const r = normalize(res.data);
        if (!r.success) throw new Error(r.msg || "Failed to load dashboard summary");
        return r.data;
      }),
      DEFAULT_TIMEOUT_MS,
    ),
  );
}

export function fetchDashboardMainBundleSWR() {
  return Promise.all([fetchUserMeSWR(), fetchHybridSummarySWR()]).then(([user, hybrid]) => ({
    user,
    hybrid,
  }));
}

export function fetchTeamPageBundleSWR() {
  return Promise.all([fetchUserMeSWR(), fetchDashboardSummarySWR()]).then(([user, summary]) => ({
    user,
    summary,
  }));
}

/** Shared configuration: no refresh when tab hidden, 15s interval, stable revalidation. */
export const hybridDashboardSWRConfig = Object.freeze({
  refreshInterval: 15000,
  revalidateOnFocus: true,
  refreshWhenHidden: false,
  shouldRetryOnError: false,
  keepPreviousData: true,
  dedupingInterval: 2500,
});
