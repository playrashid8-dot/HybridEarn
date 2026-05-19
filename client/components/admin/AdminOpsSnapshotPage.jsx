"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import AdminLayout, { adminFetch, formatCurrency, formatDate } from "./AdminLayout";
import { CARD } from "../../lib/adminTheme";
import { showSafeToast } from "../../lib/toast";
import {
  EventTicker,
  MetricCard,
  OpsCharts,
  OpsSkeleton,
  QueuePressureCard,
  ReadOnlyMetric,
  SeverityBadge,
  StatePanel,
  StatusBadge,
  appendHistory,
  getOpsSeverity,
  normalizeSeverity,
  severityTone,
} from "./AdminOpsVisuals";

const REFRESH_MS = 15000;

function severityOrderForSort(severity) {
  const s = normalizeSeverity(severity);
  if (s === "critical") return 3;
  if (s === "warning") return 2;
  return 1;
}

function Pill({ ok, children }) {
  return <StatusBadge ok={ok} label={children} />;
}

function Metric({ label, value, hint }) {
  return <MetricCard label={label} value={value} hint={hint} />;
}

function QueueRows({ ops }) {
  const queues = Object.entries(ops?.queues || {});
  return (
    <section className={`${CARD} p-4 sm:p-5`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-white">Queue Observability</h2>
          <p className="mt-1 text-xs text-gray-500">
            Live BullMQ counts, pressure bars, retry heat, failed-job glow, and worker activity signals from the existing endpoint.
          </p>
        </div>
        <StatusBadge ok={queues.every(([, queue]) => queue?.ok)} label={`${queues.length} channels`} />
      </div>
      {queues.length === 0 ? (
        <div className="mt-4">
          <StatePanel title="No queue channels reported" detail="The operations snapshot did not include queue data." />
        </div>
      ) : (
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {queues.map(([key, queue]) => (
            <QueuePressureCard key={key} queueKey={key} queue={queue} />
          ))}
        </div>
      )}
    </section>
  );
}

function TreasuryRows({ ops }) {
  const treasury = ops?.treasury || {};
  return (
    <section className={`${CARD} p-4 sm:p-5`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-white">Treasury & Financial Center</h2>
          <p className="mt-1 text-xs text-gray-500">
            Live liability and exposure data with secure read-only placeholders for unexposed wallet balances.
          </p>
        </div>
        <Pill ok={treasury.hotWalletHealth === "configured"}>{treasury.hotWalletHealth || "not reported"}</Pill>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Pending liabilities" value={formatCurrency(treasury.pendingLiabilities)} />
        <Metric label="Payout exposure" value={formatCurrency(treasury.payoutExposure)} />
        <ReadOnlyMetric label="Treasury USDT" value={treasury.treasuryUsdt == null ? null : formatCurrency(treasury.treasuryUsdt)} hint="Safe public-address balance reader." />
        <ReadOnlyMetric label="Gas reserve" value={treasury.gasReserves == null ? null : String(treasury.gasReserves)} hint="Read-only gas wallet visibility." />
      </div>
      {treasury.note ? (
        <p className="mt-4 rounded-xl border border-amber-400/20 bg-amber-500/10 px-4 py-3 text-xs leading-relaxed text-amber-100">
          <span className="font-semibold uppercase tracking-wide">Roadmap:</span>{" "}
          {treasury.note}
        </p>
      ) : null}
    </section>
  );
}

function RuntimeRows({ ops }) {
  const health = ops?.health || {};
  const runtime = ops?.runtime || {};
  const memory = runtime.memory || {};
  const cpu = runtime.cpu || {};
  const fallback = health.pollingMode === "active-json-rpc-fallback";
  const mongoTopology = runtime.mongo?.topologyType || "not reported";
  const mongoTransactions = ops?.safety?.mongoTransactions || "";
  const mongoScopedWarning = String(mongoTransactions).toLowerCase().includes("standalone");
  return (
    <section className={`${CARD} p-4 sm:p-5`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-white">Runtime Monitor</h2>
          <p className="mt-1 text-xs text-gray-500">API health, process runtime, queue heartbeat, and realtime mode.</p>
        </div>
        <SeverityBadge severity={mongoScopedWarning ? "warning" : "info"}>
          {mongoScopedWarning ? "Mongo transaction warning" : "Runtime info"}
        </SeverityBadge>
      </div>
      {mongoScopedWarning ? (
        <div className="mt-4 rounded-2xl border border-amber-400/25 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-100">
          <span className="font-bold uppercase tracking-wide">WARNING:</span> Mongo standalone mode: multi-document transactions unavailable. Other healthy systems remain operational.
        </div>
      ) : null}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="API uptime" value={`${Math.floor(Number(runtime.uptime || 0) / 60)}m`} />
        <Metric label="Memory RSS" value={`${memory.rssMb ?? "-"} MB`} hint={`Heap ${memory.heapUsedMb ?? "-"}/${memory.heapTotalMb ?? "-"} MB`} />
        <Metric label="CPU load" value={Number(cpu.loadAvg1m || 0).toFixed(2)} hint={`${cpu.cores ?? "-"} cores`} />
        <Metric label="RPC" value={health.rpcLatencyMs == null ? (health.rpc ? "Healthy" : "Down") : `${health.rpcLatencyMs} ms`} />
        <Metric label="Mongo connection" value={health.mongo ? "Connected" : "Offline"} hint={mongoTopology} />
        <Metric label="Redis/BullMQ" value={health.redis && health.bullmq ? "Healthy" : "Check"} />
        <Metric label="Deposit listener" value={fallback ? "ACTIVE - JSON-RPC POLLING FALLBACK" : health.depositListener || "Not reported"} />
        <Metric label="Workers" value={health.depositWorker || health.payoutWorker ? "Heartbeat" : "Stale"} />
      </div>
    </section>
  );
}

function RecoveryRows({ ops }) {
  return (
    <section className={`${CARD} p-5`}>
      <h2 className="text-sm font-semibold text-white">Recovery Center</h2>
      <p className="mt-1 text-xs text-gray-500">
        Recovery channels are surfaced from live runtime state. Mutating recovery actions remain on the existing analytics
        and dashboard recovery tools where CSRF and backend safety checks already exist.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Recovery worker" value={ops?.health?.recoveryWorker || "not reported"} />
        <Metric label="Deposit failed jobs" value={Number(ops?.queues?.deposit?.failed || 0)} />
        <Metric label="ROI failed jobs" value={Number(ops?.queues?.roi?.failed || 0)} />
        <Metric label="Payout failed jobs" value={Number(ops?.queues?.payout?.failed || 0)} />
      </div>
    </section>
  );
}

function SecurityRows({ ops }) {
  const safety = ops?.safety || {};
  return (
    <section className={`${CARD} p-5`}>
      <h2 className="text-sm font-semibold text-white">Security Center</h2>
      <p className="mt-1 text-xs text-gray-500">Production safety invariants reported by the operations snapshot.</p>
      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        {[
          ["Duplicate protections", safety.duplicateProtections],
          ["Replay protections", safety.replayProtections],
          ["Treasury isolation", safety.treasuryIsolation],
        ].map(([title, rows]) => (
          <div key={title} className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <h3 className="text-sm font-semibold text-white">{title}</h3>
            <ul className="mt-3 space-y-2 text-xs text-gray-400">
              {(rows || []).map((row) => (
                <li key={row} className="rounded-lg bg-white/[0.04] px-3 py-2">
                  {row}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function EventsRows({ ops, adminOnly = false }) {
  const events = (ops?.events || []).filter((event) => !adminOnly || event.type === "admin_action");
  return (
    <div className="space-y-4">
      {!adminOnly ? <EventTicker events={events} /> : null}
      <section className={`${CARD} p-4 sm:p-5`}>
        <h2 className="text-sm font-semibold text-white">{adminOnly ? "Immutable Audit Center" : "Realtime Event Center"}</h2>
        <p className="mt-1 text-xs text-gray-500">
          {adminOnly
            ? "Append-only admin audit events from backend records. Deletion controls are intentionally absent."
            : "Recent deposit, withdrawal, payout, ROI, and admin action events from live records."}
        </p>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {events.length === 0 ? (
            <StatePanel title="No events in this snapshot" detail="The live event feed returned no matching records." />
          ) : (
            events.map((event) => {
              const eventSeverity = String(event.type || "").includes("failed") ? "warning" : "info";
              const tone = severityTone(eventSeverity);
              return (
                <div key={event.id} className={`rounded-2xl border bg-black/20 p-4 ${tone.border}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <SeverityBadge severity={eventSeverity}>{String(event.type || "").replaceAll("_", " ")}</SeverityBadge>
                    <span className="text-xs text-gray-500">{formatDate(event.at)}</span>
                  </div>
                  <p className="mt-2 text-sm font-semibold text-white">{event.title}</p>
                  <p className="mt-1 text-xs text-gray-400">
                    Entity: {event.user || "system"}
                    {event.amount != null ? ` - ${formatCurrency(event.amount)}` : ""}
                  </p>
                  {event.txHash ? <p className="mt-1 truncate font-mono text-[10px] text-gray-500">{event.txHash}</p> : null}
                </div>
              );
            })
          )}
        </div>
      </section>
      </div>
  );
}

function SettingsRows({ ops }) {
  return (
    <section className={`${CARD} p-4 sm:p-5`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-white">Settings</h2>
          <p className="mt-1 text-xs text-gray-500">
            Runtime settings are read-only. Mutating controls await secure backend exposure with audit logging.
          </p>
        </div>
        <SeverityBadge severity="info">Read-only</SeverityBadge>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <ReadOnlyMetric label="WebSocket mode" value={ops?.health?.websocketMode || null} hint="Runtime mode reported by backend." unavailableLabel="Runtime mode was not reported." />
        <ReadOnlyMetric label="Polling mode" value={ops?.health?.pollingMode || null} hint="Polling fallback state reported by backend." unavailableLabel="Polling mode was not reported." />
        <ReadOnlyMetric label="Mongo transactions" value={ops?.safety?.mongoTransactions || null} hint="Transaction capability reported by topology diagnostics." unavailableLabel="Transaction diagnostics not reported." />
        <ReadOnlyMetric label="Payout executor" value={ops?.safety?.payoutExecutor || null} hint="Executor ownership is reported without changing worker locks." unavailableLabel="Executor status not reported." />
      </div>
    </section>
  );
}

function DomainRows({ mode, ops, history }) {
  if (mode === "treasury") {
    return (
      <div className="space-y-4">
        <TreasuryRows ops={ops} />
        <OpsCharts ops={ops} history={history} />
      </div>
    );
  }
  if (mode === "queues") {
    return (
      <div className="space-y-4">
        <QueueRows ops={ops} />
        <OpsCharts ops={ops} history={history} />
      </div>
    );
  }
  if (mode === "runtime") {
    return (
      <div className="space-y-4">
        <RuntimeRows ops={ops} />
        <OpsCharts ops={ops} history={history} />
      </div>
    );
  }
  if (mode === "recovery") return <RecoveryRows ops={ops} />;
  if (mode === "security") return <SecurityRows ops={ops} />;
  if (mode === "audit") return <EventsRows ops={ops} adminOnly />;
  if (mode === "settings") return <SettingsRows ops={ops} />;
  if (mode === "roi") {
    return (
      <div className="space-y-4">
        <QueueRows ops={{ queues: { roi: ops?.queues?.roi } }} />
        <RecoveryRows ops={ops} />
      </div>
    );
  }
  if (mode === "staking" || mode === "referrals") {
    return (
      <section className={`${CARD} p-5`}>
        <h2 className="text-sm font-semibold text-white">{mode === "staking" ? "Staking" : "Referrals"} Operations</h2>
        <p className="mt-1 text-xs text-gray-500">
          No dedicated admin backend endpoint is currently exposed for this domain. This page is connected to live platform
          totals only and avoids fake controls until backend actions are implemented with audit logging.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="User deposit balances" value={formatCurrency(ops?.financial?.userBalances?.depositBalance)} />
          <Metric label="Reward balances" value={formatCurrency(ops?.financial?.userBalances?.rewardBalance)} />
          <Metric label="Total earnings" value={formatCurrency(ops?.financial?.userBalances?.totalEarnings)} />
          <Metric label="Total withdrawals" value={formatCurrency(ops?.financial?.userBalances?.totalWithdraw)} />
        </div>
      </section>
    );
  }
  return <EventsRows ops={ops} />;
}

export default function AdminOpsSnapshotPage({ mode, title, subtitle }) {
  const [ops, setOps] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (silent = false) => {
    try {
      if (!silent) {
        setLoading(true);
        setError("");
      }
      const payload = await adminFetch("/admin/ops-center");
      const nextOps = payload?.data || null;
      setOps(nextOps);
      if (nextOps) setHistory((prev) => appendHistory(prev, nextOps));
      if (silent) setError("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load operations snapshot";
      if (!silent) {
        setError(msg);
        showSafeToast(msg);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void load(true);
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const severity = useMemo(() => getOpsSeverity(ops), [ops]);
  const topAlerts = useMemo(() => {
    const alerts = Array.isArray(ops?.alerts) ? ops.alerts : [];
    return [...alerts].sort(
      (a, b) => (severityOrderForSort(b.severity) - severityOrderForSort(a.severity))
    );
  }, [ops]);

  return (
    <AdminLayout title={title} subtitle={subtitle}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-gray-500">
          Snapshot: {ops?.generatedAt ? formatDate(ops.generatedAt) : "not loaded"} · auto-refresh {REFRESH_MS / 1000}s · samples {history.length}
        </div>
        <button
          type="button"
          onClick={() => void load(false)}
          className="rounded-xl border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-gray-200 transition hover:bg-white/10"
        >
          Refresh now
        </button>
      </div>

      {loading ? (
        <OpsSkeleton rows={8} />
      ) : error ? (
        <StatePanel type="error" title="Operations snapshot unavailable" detail={error} actionLabel="Retry snapshot" onAction={() => void load(false)} />
      ) : ops ? (
        <div className="space-y-4">
          <div className={`${CARD} overflow-hidden p-4`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-cyan-300">VIP Crypto Exchange Operations Center</p>
                <p className="mt-1 text-sm text-gray-400">Connected to `/admin/ops-center` with httpOnly-cookie auth and existing polling.</p>
              </div>
              <SeverityBadge severity={severity} />
            </div>
            {topAlerts.length > 0 ? (
              <div className="mt-4 grid gap-2 lg:grid-cols-3">
                {topAlerts.slice(0, 3).map((alert) => {
                  const tone = severityTone(alert.severity);
                  return (
                    <div key={`${alert.severity}:${alert.title}`} className={`rounded-2xl border p-3 ${tone.border} ${tone.bg}`}>
                      <p className={`text-[10px] font-bold uppercase tracking-[0.18em] ${tone.text}`}>{normalizeSeverity(alert.severity)}</p>
                      <p className="mt-1 text-sm font-semibold text-white">{alert.title}</p>
                      <p className="mt-1 text-[11px] leading-relaxed text-gray-400">{alert.detail}</p>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="mt-3 rounded-xl border border-cyan-400/20 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100">
                INFO: No critical or warning signals in the latest operations snapshot.
              </p>
            )}
          </div>
          <DomainRows mode={mode} ops={ops} history={history} />
        </div>
      ) : (
        <StatePanel title="No operations snapshot returned" detail="The backend responded without ops-center data." />
      )}
    </AdminLayout>
  );
}
