"use client";

import { useEffect, useState } from "react";
import GlassCard from "../GlassCard";

/** Dismissal is tied to server `user.lastLogin` so each new login shows the banner again. */
const STORAGE_DISMISS_FOR_LAST_LOGIN = "rewardBannerDismissedLastLogin";
/** Legacy keys — cleared on login and no longer used for visibility. */
const LEGACY_HIDE_BANNER = "hideRewardBanner";
const LEGACY_REWARD_SEEN = "rewardSeen";

/** Second-precision key: avoids false re-show/hide when server vs client ISO differs in milliseconds. */
function normalizeLastLoginKey(value: unknown): string {
  if (value == null || value === "") return "";
  let iso: string;
  if (typeof value === "string") {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    iso = d.toISOString();
  } else if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    iso = value.toISOString();
  } else {
    return "";
  }
  return iso.slice(0, 19);
}

/** Migrate legacy localStorage values (full ISO with ms) to the same second-precision key. */
function normalizeStoredDismissRaw(raw: string | null): string {
  if (raw == null || raw === "") return "";
  const asDate = new Date(raw);
  if (!Number.isNaN(asDate.getTime())) {
    return asDate.toISOString().slice(0, 19);
  }
  return raw.length >= 19 ? raw.slice(0, 19) : raw;
}

const DEPOSIT_BONUS_ROWS: { left: string; right: string }[] = [
  { left: "50 USDT", right: "7 USDT" },
  { left: "100 USDT", right: "13 USDT" },
  { left: "150 USDT", right: "18 USDT" },
  { left: "200 USDT", right: "25 USDT" },
  { left: "300 USDT", right: "35 USDT" },
];

const SALARY_ROWS: { label: string; payout: string }[] = [
  { label: "Stage 1: 10 Direct + 35 Team", payout: "80 USDT" },
  { label: "Stage 2: 25 Direct + 100 Team", payout: "250 USDT" },
  { label: "Stage 3: 45 Direct + 150 Team", payout: "500 USDT" },
];

export default function RewardNotification({
  lastLogin,
}: {
  /** ISO string or Date from `/user/me` (JSON date string). Uses `createdAt` when `lastLogin` is null so first-time accounts still get a key. */
  lastLogin?: string | Date | null;
}) {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    try {
      if (typeof window === "undefined") return;

      const loginKey = normalizeLastLoginKey(lastLogin);
      // No timestamp yet — wait for dashboard bundle (user + dates load together).
      if (!loginKey) {
        setIsVisible(false);
        return;
      }

      const dismissedFor = normalizeStoredDismissRaw(localStorage.getItem(STORAGE_DISMISS_FOR_LAST_LOGIN));
      const shouldShow = dismissedFor !== loginKey;

      setIsVisible(shouldShow);
    } catch {
      setIsVisible(false);
    }
  }, [lastLogin]);

  const handleClose = () => {
    setIsVisible(false);
    try {
      const loginKey = normalizeLastLoginKey(lastLogin);
      if (loginKey) {
        localStorage.setItem(STORAGE_DISMISS_FOR_LAST_LOGIN, loginKey);
      }
      localStorage.removeItem(LEGACY_HIDE_BANNER);
      localStorage.removeItem(LEGACY_REWARD_SEEN);
    } catch {
      // ignore storage errors
    }
  };

  if (!isVisible) return null;

  const sectionHeading =
    "mb-2 flex flex-wrap items-center justify-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider sm:justify-start sm:text-xs";

  return (
    <div className="mt-3 w-full max-w-full sm:mt-4">
      <GlassCard glow="purple" className="shadow-[0_0_36px_rgba(88,28,135,0.22)]">
        <div className="relative pr-9 sm:pr-10">
          <button
            type="button"
            onClick={handleClose}
            className="absolute right-0 top-0 flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-gray-300 transition hover:border-white/20 hover:bg-white/10 hover:text-white active:scale-[0.97] sm:h-9 sm:w-9"
            aria-label="Dismiss reward information"
          >
            <span className="text-lg leading-none">×</span>
          </button>

          <div className="space-y-3 sm:space-y-3.5">
            <section className="text-center sm:text-left">
              <h2 className={`${sectionHeading} text-purple-200/90`}>
                <span aria-hidden>🎁</span>
                <span>First deposit bonus</span>
              </h2>
              <ul className="mx-auto max-w-sm space-y-1 sm:mx-0">
                {DEPOSIT_BONUS_ROWS.map((row) => (
                  <li
                    key={row.left}
                    className="flex items-center justify-center gap-2 text-[11px] tabular-nums text-gray-200 sm:justify-between sm:gap-4 sm:text-xs"
                  >
                    <span className="min-w-[4.5rem] text-right text-gray-300 sm:min-w-[5.25rem] sm:text-left">{row.left}</span>
                    <span className="shrink-0 text-gray-500" aria-hidden>
                      →
                    </span>
                    <span className="min-w-[3.25rem] text-left font-medium text-emerald-200/95">{row.right}</span>
                  </li>
                ))}
              </ul>
            </section>

            <div className="border-t border-white/[0.06]" aria-hidden />

            <section className="text-center sm:text-left">
              <h2 className={`${sectionHeading} text-blue-200/90`}>
                <span aria-hidden>💼</span>
                <span>Salary system</span>
              </h2>
              <ul className="mx-auto max-w-md space-y-1.5 text-[11px] leading-snug text-gray-300 sm:mx-0 sm:text-xs sm:leading-relaxed">
                {SALARY_ROWS.map((row) => (
                  <li
                    key={row.label}
                    className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 sm:justify-start"
                  >
                    <span className="text-center text-white/90 sm:text-left">{row.label}</span>
                    <span className="shrink-0 text-gray-500" aria-hidden>
                      →
                    </span>
                    <span className="tabular-nums font-medium text-emerald-200/90">{row.payout}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      </GlassCard>
    </div>
  );
}

/** Call after successful login so stale keys never suppress the banner for the new session. */
export function clearRewardBannerLoginStorage() {
  try {
    if (typeof window === "undefined") return;
    localStorage.removeItem(LEGACY_REWARD_SEEN);
    localStorage.removeItem(LEGACY_HIDE_BANNER);
    localStorage.removeItem(STORAGE_DISMISS_FOR_LAST_LOGIN);
  } catch {
    // ignore
  }
}
