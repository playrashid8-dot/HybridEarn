"use client";

import { useCallback, useEffect, useState } from "react";
import { adminFetch } from "../../lib/adminFetch";
import { MetricCard, SeverityBadge, SkeletonBlock, StatePanel, StatusBadge } from "./AdminOpsVisuals";

const REFRESH_MS = 11000;

/**
 * @typedef {{
 *   mongo: boolean;
 *   redis: boolean;
 *   rpc: boolean;
 *   listener: boolean;
 *   websocket: boolean;
 *   websocketDisabled: boolean;
 *   pollingActive: boolean;
 *   fallbackModeHealthy: boolean;
 *   realtimeHealthy: boolean;
 *   queue: boolean;
 *   worker: boolean;
 *   usersLoaded: number;
 *   executorRunning: boolean;
 * }} AdminSysStatus
 */

function Row({ ok, label, detail }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-gray-200">{label}</span>
        <StatusBadge ok={ok} label={ok ? "ok" : "check"} tone="red" />
      </div>
      {detail ? <p className="mt-2 text-[11px] leading-relaxed text-gray-500">{detail}</p> : null}
    </div>
  );
}

export default function AdminSystemStatusCard() {
  const [status, setStatus] = useState(/** @type {AdminSysStatus | null} */ (null));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) {
      setBusy(true);
      setError("");
    }
    try {
      const payload = await adminFetch("/admin/system/status");
      const d = payload?.data ?? payload;
      const next = {
        mongo: Boolean(d?.mongo),
        redis: Boolean(d?.redis),
        rpc: Boolean(d?.rpc),
        listener: Boolean(d?.listener),
        websocket: Boolean(d?.websocket),
        websocketDisabled: Boolean(d?.websocketDisabled || d?.websocketIntentionallyDisabled),
        pollingActive: Boolean(d?.pollingActive),
        fallbackModeHealthy: Boolean(d?.fallbackModeHealthy),
        realtimeHealthy: Boolean(d?.realtimeHealthy),
        queue: Boolean(d?.queue),
        worker: Boolean(d?.worker),
        usersLoaded: d?.usersLoaded == null ? null : Number(d.usersLoaded),
        executorRunning: Boolean(d?.executorRunning),
      };
      setStatus(next);
      setError("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load system status";
      if (!silent) setError(msg);
    } finally {
      if (!silent) setBusy(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    const onRefresh = () => void load(true);
    if (typeof window !== "undefined") {
      window.addEventListener("nova-admin-refresh-status", onRefresh);
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("nova-admin-refresh-status", onRefresh);
      }
    };
  }, [load]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void load(true);
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const s = status;
  const critical = Boolean(s && (!s.mongo || !s.redis || !s.rpc));
  const warning = Boolean(
    s &&
      !critical &&
      (!s.queue || !s.worker || (!s.realtimeHealthy && !s.fallbackModeHealthy && !s.listener))
  );
  const severity = critical ? "critical" : warning ? "warning" : "info";

  return (
    <section className="mb-4 rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.07] to-white/[0.025] p-4 shadow-lg shadow-black/25 backdrop-blur-xl sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold tracking-tight text-white">Scoped Runtime Status</h2>
            {!loading && !error ? <SeverityBadge severity={severity} /> : null}
          </div>
          <p className="mt-0.5 text-xs text-gray-400">Hybrid engine, data stores, polling fallback, and payout pipeline</p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void load(false)}
          className="shrink-0 rounded-xl border border-white/15 bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-gray-100 transition hover:bg-white/12 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {loading ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="rounded-2xl border border-white/10 bg-black/20 p-3">
              <SkeletonBlock className="h-3 w-24" />
              <SkeletonBlock className="mt-3 h-7 w-20" />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="mt-4">
          <StatePanel type="warning" title="System status unavailable" detail={error} actionLabel="Retry status" onAction={() => void load(false)} />
        </div>
      ) : s ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Row ok={s.mongo} label="MongoDB" detail={s.mongo ? "Connected for platform reads/writes." : "Database connection is not healthy."} />
          <Row ok={s.redis} label="Redis" detail={s.redis ? "Redis orchestration reachable." : "BullMQ orchestration may be unavailable."} />
          <Row ok={s.rpc} label="RPC" detail={s.rpc ? "Blockchain read endpoint reachable." : "Blockchain reads are failing or timing out."} />
          <Row
            ok={s.realtimeHealthy || s.fallbackModeHealthy || s.listener}
            label={
              s.fallbackModeHealthy
                ? "JSON-RPC polling fallback"
                : "Deposit listener active"
            }
            detail={
              s.fallbackModeHealthy
                ? "WebSocket is intentionally bypassed while polling fallback remains active."
                : "Realtime deposit listener reports activity."
            }
          />
          <Row
            ok={s.websocket || s.websocketDisabled}
            label={s.websocketDisabled ? "WebSocket disabled intentionally" : "WebSocket active"}
            detail={s.websocketDisabled ? "This is informational, not a platform outage." : "Socket listener is active."}
          />
          <Row
            ok={s.pollingActive || s.fallbackModeHealthy}
            label={s.fallbackModeHealthy ? "Polling active - healthy fallback" : "Polling active"}
            detail="Polling mode preserves deposit detection without websocket dependency."
          />
          <Row ok={s.queue} label="Queue connectivity" detail={s.queue ? "BullMQ counts can be read." : "Queue health requires attention."} />
          <Row ok={s.worker} label="Worker heartbeat" detail={s.worker ? "Worker pulse is fresh." : "Worker pulse is missing or stale."} />
          <Row ok={s.executorRunning} label="Withdraw executor" detail={s.executorRunning ? "Executor pulse is active." : "Executor is not reported in this API process."} />
          <MetricCard
            label="Users loaded"
            value={s.usersLoaded == null ? "Not reported" : s.usersLoaded.toLocaleString()}
            hint={s.usersLoaded == null ? "Status endpoint did not return a user-map count." : "Live user-map count reported by the hybrid engine."}
            status={s.usersLoaded == null ? "warning" : "neutral"}
          />
        </div>
      ) : null}

      <p className="mt-4 text-[11px] text-gray-500">Auto-refresh every {REFRESH_MS / 1000}s. Warnings are scoped; healthy subsystems are not marked offline.</p>
    </section>
  );
}
