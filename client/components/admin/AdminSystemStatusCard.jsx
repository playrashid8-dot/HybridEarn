"use client";

import { useCallback, useEffect, useState } from "react";
import { adminFetch } from "../../lib/adminFetch";

const REFRESH_MS = 11000;

/**
 * @typedef {{
 *   mongo: boolean;
 *   redis: boolean;
 *   rpc: boolean;
 *   listener: boolean;
 *   websocket: boolean;
 *   queue: boolean;
 *   worker: boolean;
 *   usersLoaded: number;
 *   executorRunning: boolean;
 * }} AdminSysStatus
 */

function Row({ ok, label }) {
  return (
    <div className="flex items-center gap-2 text-sm text-gray-200">
      <span className="w-5 shrink-0 text-center" aria-hidden>
        {ok ? "✅" : "❌"}
      </span>
      <span className={ok ? "text-gray-100" : "text-red-200/90"}>{label}</span>
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
        queue: Boolean(d?.queue),
        worker: Boolean(d?.worker),
        usersLoaded: Number(d?.usersLoaded ?? 0),
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

  return (
    <section className="mb-6 rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.06] to-white/[0.02] p-5 shadow-lg shadow-black/20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-white">System status</h2>
          <p className="mt-0.5 text-xs text-gray-400">Hybrid engine, data stores, and payout pipeline</p>
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
        <p className="mt-4 text-sm text-gray-400">Loading health…</p>
      ) : error ? (
        <p className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">{error}</p>
      ) : s ? (
        <div className="mt-4 grid gap-x-8 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
          <Row ok={s.mongo} label="MongoDB connected" />
          <Row ok={s.redis} label="Redis connected" />
          <Row ok={s.rpc} label="RPC connected" />
          <Row ok={s.listener} label="Listener active" />
          <Row ok={s.websocket} label="WebSocket active" />
          <Row ok={s.queue} label="Queue working" />
          <Row ok={s.worker} label="Worker reachable" />
          <Row ok={s.executorRunning} label="⚡ Withdraw executor" />
          <div className="flex items-center gap-2 text-sm text-gray-200 sm:col-span-2">
            <span className="w-5 shrink-0 text-center" aria-hidden>
              👤
            </span>
            <span className="tabular-nums">
              Users loaded: <strong className="text-white">{s.usersLoaded}</strong>
            </span>
          </div>
        </div>
      ) : null}

      <p className="mt-4 text-[11px] text-gray-500">Auto-refresh every {REFRESH_MS / 1000}s</p>
    </section>
  );
}
