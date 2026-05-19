"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AdminLayout, { adminFetch, formatCurrency } from "../../../components/admin/AdminLayout";
import Loader from "../../../components/admin/Loader";
import { CARD } from "../../../lib/adminTheme";
import { showSafeToast } from "../../../lib/toast";
import {
  EventTicker,
  OpsCharts,
  QueuePressureCard,
  ReadOnlyMetric,
  SeverityBadge,
  appendHistory,
  getOpsSeverity,
} from "../../../components/admin/AdminOpsVisuals";

type OverviewActivity = {
  id: string;
  kind: string;
  at: string;
  action: string;
  username?: string;
  amount?: number;
  txHash?: string;
};

type Overview = {
  totalUsers: number;
  activeUsersDeposit50plus: number;
  totalDepositsUsd: number;
  totalWithdrawalsPaidUsd: number;
  pendingWithdrawalsCount: number;
  totalEarningsPaidUsd: number;
  totalSalaryPaidUsd?: number;
  lastActivities: OverviewActivity[];
};

type QueueSnapshot = {
  label: string;
  ok: boolean;
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
  stalled: number;
  deadLetter: number;
  retryAttempts: number;
  failedJobsPreview?: QueueJob[];
  note?: string;
};

type QueueJob = {
  id: string;
  name: string;
  state?: string;
  attemptsMade: number;
  failedReason?: string | null;
  timestamp?: number | null;
  processedOn?: number | null;
  finishedOn?: number | null;
  payloadPreview?: string[];
  data?: unknown;
};

type OpsAlert = {
  severity: "critical" | "warning" | "info" | string;
  title: string;
  detail: string;
};

type RealtimeEvent = {
  id: string;
  type: string;
  title: string;
  user?: string;
  amount?: number;
  txHash?: string | null;
  category?: string;
  at: string;
};

type OpsSnapshot = {
  generatedAt: string;
  status: string;
  health: {
    mongo: boolean;
    redis: boolean;
    bullmq: boolean;
    queueConnectivity: boolean;
    rpc: boolean;
    rpcLatencyMs?: number | null;
    websocketMode: string;
    pollingMode: string;
    depositListener: string;
    payoutWorker: boolean;
    depositWorker: boolean;
    treasurySweep: string;
    recoveryWorker: string;
    queueHeartbeat?: {
      depositAgeMs?: number | null;
      payoutAgeMs?: number | null;
    };
  };
  queues: Record<string, QueueSnapshot>;
  financial: {
    totalDeposits: number;
    totalWithdrawals: number;
    pendingLiabilities: number;
    payoutExposure: number;
    pendingWithdrawals: number;
    pendingDeposits: number;
    realtimeInflow: number;
    realtimeOutflow: number;
    userBalances: Record<string, number>;
  };
  treasury: {
    treasuryUsdt: number | null;
    treasuryBnb: number | null;
    gasReserves: number | null;
    pendingLiabilities: number;
    payoutExposure: number;
    hotWalletHealth: string;
    note: string;
  };
  runtime: {
    uptime: number;
    memory: {
      rssMb: number;
      heapUsedMb: number;
      heapTotalMb: number;
    };
    cpu: {
      loadAvg1m: number;
      loadAvg5m: number;
      cores: number | null;
    };
    mongo: {
      topologyType: string;
    };
  };
  safety: {
    depositListener: string;
    websocketMode: string;
    pollingMode: string;
    mongoTransactions: string;
    payoutExecutor: string;
    depositWorker: string;
    payoutWorker: string;
    duplicateProtections: string[];
    replayProtections: string[];
    treasuryIsolation: string[];
  };
  alerts?: OpsAlert[];
  events?: RealtimeEvent[];
};

function StatCard({
  title,
  value,
  hint,
}: {
  title: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className={`${CARD} p-5`}>
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{title}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-white">{value}</p>
      {hint ? <p className="mt-1 text-xs text-gray-500">{hint}</p> : null}
    </div>
  );
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${
        ok
          ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-200"
          : "border-amber-400/25 bg-amber-400/10 text-amber-100"
      }`}
    >
      {label}
    </span>
  );
}

function AlertTone({ severity }: { severity: string }) {
  if (severity === "critical") return "border-red-400/30 bg-red-500/10 text-red-100";
  if (severity === "warning") return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  return "border-cyan-400/30 bg-cyan-500/10 text-cyan-100";
}

function TinyMetric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-xl bg-white/[0.04] px-3 py-2">
      <p className="uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-white">{value}</p>
    </div>
  );
}

function QueueCard({
  queueKey,
  queue,
  selected,
  onSelect,
}: {
  queueKey: string;
  queue: QueueSnapshot;
  selected: boolean;
  onSelect: (queueKey: string) => void;
}) {
  const pressure = Math.min(100, Math.max(0, queue.waiting + queue.active + queue.delayed + queue.failed));
  return (
    <button
      type="button"
      onClick={() => onSelect(queueKey)}
      className={`rounded-2xl border p-4 text-left transition ${
        selected
          ? "border-cyan-300/50 bg-cyan-400/10 shadow-lg shadow-cyan-950/30"
          : "border-white/10 bg-black/20 hover:border-white/20 hover:bg-white/[0.04]"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold capitalize text-white">{queue.label}</h3>
        <StatusPill ok={queue.ok} label={queue.ok ? "online" : "offline"} />
      </div>
      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full ${queue.failed > 0 ? "bg-amber-300" : "bg-cyan-300"}`}
          style={{ width: `${Math.min(100, pressure * 8)}%` }}
        />
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
        {[
          ["waiting", queue.waiting],
          ["active", queue.active],
          ["delayed", queue.delayed],
          ["failed", queue.failed],
          ["dead", queue.deadLetter],
          ["retries", queue.retryAttempts],
        ].map(([label, value]) => (
          <TinyMetric key={label} label={String(label)} value={value} />
        ))}
      </div>
      {queue.note ? <p className="mt-3 text-xs leading-relaxed text-gray-500">{queue.note}</p> : null}
    </button>
  );
}

function AlertPanel({ alerts }: { alerts: OpsAlert[] }) {
  return (
    <section className={`${CARD} p-5`}>
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-white">Operational Alerts</h2>
          <p className="mt-1 text-xs text-gray-500">Runtime risks surfaced without changing engine behavior.</p>
        </div>
        <StatusPill ok={!alerts.some((alert) => alert.severity === "critical")} label={`${alerts.length} signals`} />
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {alerts.length === 0 ? (
          <div className="rounded-2xl border border-emerald-400/20 bg-emerald-500/10 p-4 text-sm text-emerald-100">
            No critical operations alerts in the latest snapshot.
          </div>
        ) : (
          alerts.map((alert) => (
            <div key={`${alert.severity}:${alert.title}`} className={`rounded-2xl border p-4 ${AlertTone({ severity: alert.severity })}`}>
              <p className="text-xs font-semibold uppercase tracking-[0.18em]">{alert.severity}</p>
              <h3 className="mt-2 text-sm font-semibold text-white">{alert.title}</h3>
              <p className="mt-1 text-xs leading-relaxed text-current/80">{alert.detail}</p>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function formatDuration(seconds: number) {
  const safe = Math.max(0, Number(seconds || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function formatAge(ms?: number | null) {
  if (ms == null || !Number.isFinite(Number(ms))) return "not reported";
  const seconds = Math.max(0, Math.floor(Number(ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

function RealtimeEventCenter({ events }: { events: RealtimeEvent[] }) {
  return (
    <div className="space-y-4">
      <EventTicker events={events} />
      <section className={`${CARD} p-5`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-white">Realtime Event Center</h2>
            <p className="mt-1 text-xs text-gray-500">Deposits, withdrawals, payout signals, and admin actions from live records.</p>
          </div>
          <StatusPill ok={events.length > 0} label={events.length > 0 ? "streaming" : "empty"} />
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {events.length === 0 ? (
            <p className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-gray-500">No events in this snapshot.</p>
          ) : (
            events.map((event) => (
              <div key={event.id} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="rounded-lg bg-cyan-400/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-cyan-200">
                    {event.type.replaceAll("_", " ")}
                  </span>
                  <span className="text-xs text-gray-500">{event.at ? new Date(event.at).toLocaleString() : "-"}</span>
                </div>
                <p className="mt-2 text-sm font-semibold text-white">{event.title}</p>
                <p className="mt-1 text-xs text-gray-400">
                  {event.user ? `Entity: ${event.user}` : "Entity: system"}
                  {event.amount != null ? ` · ${formatCurrency(event.amount)}` : ""}
                </p>
                {event.txHash ? <p className="mt-1 truncate font-mono text-[10px] text-gray-500">{event.txHash}</p> : null}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function AuditCenter({ events }: { events: RealtimeEvent[] }) {
  const adminEvents = events.filter((event) => event.type === "admin_action");
  return (
    <section className={`${CARD} p-5`}>
      <h2 className="text-sm font-semibold text-white">Immutable Audit Center</h2>
      <p className="mt-1 text-xs text-gray-500">
        Admin actions are append-only records. Deletion controls are intentionally absent.
      </p>
      <div className="mt-4 space-y-2">
        {adminEvents.length === 0 ? (
          <p className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-gray-500">No recent admin audit events.</p>
        ) : (
          adminEvents.slice(0, 8).map((event) => (
            <div key={event.id} className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-white">{event.title}</p>
                <span className="text-xs text-gray-500">{event.at ? new Date(event.at).toLocaleString() : "-"}</span>
              </div>
              <p className="mt-1 text-xs text-gray-400">
                Category: {event.category || "admin"} · Entity: {event.user || "admin"}
              </p>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

export default function AdminOverviewDashboardPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [ops, setOps] = useState<OpsSnapshot | null>(null);
  const [opsHistory, setOpsHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedQueue, setSelectedQueue] = useState("payout");
  const [queueJobs, setQueueJobs] = useState<QueueJob[]>([]);
  const [queueJobsLoading, setQueueJobsLoading] = useState(false);
  const [queueActionBusy, setQueueActionBusy] = useState("");
  const [queueActionMsg, setQueueActionMsg] = useState("");

  const load = useCallback(async (silent = false) => {
    try {
      if (!silent) {
        setLoading(true);
        setError("");
      }
      const [overviewPayload, opsPayload] = await Promise.all([
        adminFetch("/admin/overview"),
        adminFetch("/admin/ops-center"),
      ]);
      const o = overviewPayload?.data?.overview ?? null;
      const nextOps = (opsPayload?.data ?? null) as OpsSnapshot | null;
      setOverview(o);
      setOps(nextOps);
      if (nextOps) setOpsHistory((prev) => appendHistory(prev, nextOps));
      if (silent) setError("");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load overview";
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
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void load(true);
    }, 15000);
    return () => clearInterval(interval);
  }, [load]);

  const loadQueueJobs = useCallback(async (queueKey = selectedQueue, silent = false) => {
    if (queueKey === "sweep" || queueKey === "recovery") {
      setQueueJobs([]);
      if (!silent) setQueueActionMsg("This runtime channel is not a BullMQ queue.");
      return;
    }
    try {
      if (!silent) {
        setQueueJobsLoading(true);
        setQueueActionMsg("");
      }
      const payload = await adminFetch(`/admin/ops-center/queues/${queueKey}/jobs?state=failed&limit=20`);
      setQueueJobs((payload?.data?.jobs ?? []) as QueueJob[]);
      if (!silent) setQueueActionMsg("Failed jobs refreshed.");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load queue jobs";
      if (!silent) {
        setQueueActionMsg(msg);
        showSafeToast(msg);
      }
    } finally {
      if (!silent) setQueueJobsLoading(false);
    }
  }, [selectedQueue]);

  useEffect(() => {
    void loadQueueJobs(selectedQueue, true);
  }, [loadQueueJobs, selectedQueue]);

  const runQueueAction = useCallback(async (action: "pause" | "resume") => {
    try {
      setQueueActionBusy(action);
      setQueueActionMsg("");
      const payload = await adminFetch(`/admin/ops-center/queues/${selectedQueue}/${action}`, { method: "POST" });
      const msg = payload?.msg || `Queue ${action} requested`;
      setQueueActionMsg(msg);
      showSafeToast(msg);
      await load(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : `Queue ${action} failed`;
      setQueueActionMsg(msg);
      showSafeToast(msg);
    } finally {
      setQueueActionBusy("");
    }
  }, [load, selectedQueue]);

  const retryQueueJob = useCallback(async (job: QueueJob) => {
    try {
      setQueueActionBusy(`retry:${job.id}`);
      setQueueActionMsg("");
      const payload = await adminFetch(`/admin/ops-center/queues/${selectedQueue}/jobs/${encodeURIComponent(job.id)}/retry`, {
        method: "POST",
      });
      const msg = payload?.msg || "Queue retry requested";
      setQueueActionMsg(msg);
      showSafeToast(msg);
      await loadQueueJobs(selectedQueue, true);
      await load(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Queue retry blocked";
      setQueueActionMsg(msg);
      showSafeToast(msg);
    } finally {
      setQueueActionBusy("");
    }
  }, [load, loadQueueJobs, selectedQueue]);

  const opsSeverity = getOpsSeverity(ops);
  const AnyQueuePressureCard = QueuePressureCard as any;

  return (
    <AdminLayout
      title="Dashboard"
      subtitle="HybridEarn admin overview — auto-refreshes every 15 seconds."
    >
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-gray-500">
          Live data ·{" "}
          <Link href="/admin/analytics" className="text-purple-300 hover:text-purple-200">
            Open charts & recovery tools
          </Link>
        </p>
        <button
          type="button"
          onClick={() => void load(false)}
          className="rounded-xl border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10"
        >
          Refresh now
        </button>
      </div>

      {loading ? (
        <Loader label="Loading overview…" />
      ) : error ? (
        <div className={`${CARD} border-red-500/20 bg-red-500/10 p-4 text-sm text-red-100`}>
          {error}
        </div>
      ) : overview ? (
        <div className="space-y-8">
          {ops ? (
            <>
              <section className={`${CARD} overflow-hidden p-5`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">
                      Enterprise Fintech Operations Center
                    </p>
                    <h2 className="mt-2 text-xl font-semibold text-white">Runtime command view</h2>
                    <p className="mt-1 text-xs text-gray-500">
                      Snapshot {ops.generatedAt ? new Date(ops.generatedAt).toLocaleString() : "-"} · API uptime{" "}
                      {formatDuration(ops.runtime.uptime)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <SeverityBadge severity={opsSeverity} />
                    <StatusPill ok={ops.health.pollingMode === "active-json-rpc-fallback"} label="JSON-RPC polling" />
                  </div>
                </div>

                <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <StatCard
                    title="Deposit listener"
                    value={ops.health.depositListener}
                    hint="WebSocket disabled is not a failure when polling fallback is active"
                  />
                  <StatCard title="MongoDB" value={ops.health.mongo ? "Connected" : "Offline"} hint={ops.runtime.mongo.topologyType} />
                  <StatCard title="Redis / BullMQ" value={ops.health.redis && ops.health.bullmq ? "Healthy" : "Check"} hint="Queue connectivity and Redis ping" />
                  <StatCard
                    title="Workers"
                    value={ops.health.depositWorker || ops.health.payoutWorker ? "Heartbeat" : "Stale"}
                    hint={`Deposit ${formatAge(ops.health.queueHeartbeat?.depositAgeMs)} · Payout ${formatAge(ops.health.queueHeartbeat?.payoutAgeMs)}`}
                  />
                </div>

                <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {[
                    ["RPC latency", ops.health.rpcLatencyMs == null ? (ops.health.rpc ? "Healthy" : "Down") : `${ops.health.rpcLatencyMs} ms`, ops.health.pollingMode],
                    ["Memory RSS", `${ops.runtime.memory.rssMb} MB`, `Heap ${ops.runtime.memory.heapUsedMb}/${ops.runtime.memory.heapTotalMb} MB`],
                    ["CPU load", `${ops.runtime.cpu.loadAvg1m.toFixed(2)}`, `${ops.runtime.cpu.cores ?? "-"} cores`],
                    ["Mongo safety", ops.safety.mongoTransactions, "Replica-set status affects ACID guarantees"],
                  ].map(([title, value, hint]) => (
                    <StatCard key={title} title={title} value={value} hint={hint} />
                  ))}
                </div>
                {String(ops.safety.mongoTransactions || "").toLowerCase().includes("standalone") ? (
                  <div className="mt-4 rounded-2xl border border-amber-400/25 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-100">
                    <span className="font-bold uppercase tracking-wide">WARNING:</span> Mongo standalone mode: multi-document transactions unavailable. This is scoped to transaction capability and does not mark healthy queues, Redis, or RPC offline.
                  </div>
                ) : null}
              </section>

              <AlertPanel alerts={ops.alerts ?? []} />

              <OpsCharts ops={ops} history={opsHistory} />

              <section className={`${CARD} p-5`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-semibold text-white">Queue Observability Center</h2>
                    <p className="mt-1 text-xs text-gray-500">
                      BullMQ queues plus runtime-driven sweep and recovery scanners.
                    </p>
                  </div>
                  <Link href="/admin/analytics" className="text-xs font-medium text-purple-300 hover:text-purple-200">
                    Recovery tools
                  </Link>
                </div>
                <div className="mt-4 grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
                  {Object.entries(ops.queues).map(([key, queue]) => (
                    <AnyQueuePressureCard
                      key={key}
                      queueKey={key}
                      queue={queue}
                      selected={selectedQueue === key}
                      onSelect={(nextQueue) => {
                        setSelectedQueue(nextQueue);
                        setQueueActionMsg("");
                      }}
                    />
                  ))}
                </div>
              </section>

              <section className={`${CARD} p-5`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold text-white">Failed Job Recovery Center</h2>
                    <p className="mt-1 text-xs text-gray-500">
                      Inspect payloads, pause or resume BullMQ queues, and retry only jobs marked recovery-safe.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void loadQueueJobs(selectedQueue)}
                      disabled={queueJobsLoading || selectedQueue === "sweep" || selectedQueue === "recovery"}
                      className="rounded-xl border border-cyan-300/20 bg-cyan-400/10 px-3 py-1.5 text-xs font-medium text-cyan-100 hover:bg-cyan-400/15 disabled:opacity-50"
                    >
                      {queueJobsLoading ? "Inspecting..." : "Inspect failed jobs"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void runQueueAction("pause")}
                      disabled={Boolean(queueActionBusy) || selectedQueue === "sweep" || selectedQueue === "recovery"}
                      className="rounded-xl border border-amber-300/20 bg-amber-400/10 px-3 py-1.5 text-xs font-medium text-amber-100 hover:bg-amber-400/15 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {queueActionBusy === "pause" ? "Pausing..." : "Pause queue"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void runQueueAction("resume")}
                      disabled={Boolean(queueActionBusy) || selectedQueue === "sweep" || selectedQueue === "recovery"}
                      className="rounded-xl border border-emerald-300/20 bg-emerald-400/10 px-3 py-1.5 text-xs font-medium text-emerald-100 hover:bg-emerald-400/15 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {queueActionBusy === "resume" ? "Resuming..." : "Resume queue"}
                    </button>
                  </div>
                </div>
                <p className="mt-3 text-xs text-gray-500">
                  Selected queue: <span className="font-semibold uppercase text-white">{selectedQueue}</span>
                  {queueActionMsg ? ` · ${queueActionMsg}` : ""}
                </p>
                <div className="mt-4 space-y-3">
                  {queueJobs.length === 0 ? (
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-gray-500">
                      No failed jobs returned for this queue. Sweep and recovery are runtime controls, not BullMQ queues.
                    </div>
                  ) : (
                    queueJobs.map((job) => {
                      const retrySafe =
                        (selectedQueue === "deposit" && job.name === "deposit") ||
                        (selectedQueue === "roi" && job.name === "roi_claim");
                      return (
                        <div key={job.id} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-white">{job.name}</p>
                              <p className="mt-1 truncate font-mono text-[11px] text-gray-500">Job ID: {job.id}</p>
                              <p className="mt-1 text-xs text-gray-400">
                                Attempts {job.attemptsMade} · State {job.state || "failed"}
                                {job.timestamp ? ` · ${new Date(job.timestamp).toLocaleString()}` : ""}
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => void retryQueueJob(job)}
                              disabled={!retrySafe || Boolean(queueActionBusy)}
                              className="rounded-xl border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-gray-100 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {queueActionBusy === `retry:${job.id}`
                                ? "Retrying..."
                                : retrySafe
                                  ? "Retry safe job"
                                  : "Unsafe replay blocked"}
                            </button>
                          </div>
                          {job.failedReason ? (
                            <p className="mt-3 rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-xs text-red-100">
                              {job.failedReason}
                            </p>
                          ) : null}
                          {job.data ? (
                            <pre className="mt-3 max-h-44 overflow-auto rounded-xl bg-black/40 p-3 text-[11px] leading-relaxed text-gray-300">
                              {JSON.stringify(job.data, null, 2)}
                            </pre>
                          ) : null}
                        </div>
                      );
                    })
                  )}
                </div>
              </section>

              <section className={`${CARD} p-5`}>
                <h2 className="text-sm font-semibold text-white">Financial Control Surface</h2>
                <p className="mt-1 text-xs text-gray-500">
                  Read-only live totals. Balance-changing controls must write ledger + audit + snapshots.
                </p>
                <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <StatCard title="Total deposits" value={formatCurrency(ops.financial.totalDeposits)} hint="Credited + swept deposits" />
                  <StatCard title="Total withdrawals" value={formatCurrency(ops.financial.totalWithdrawals)} hint="Paid hybrid withdrawals" />
                  <StatCard title="Pending liabilities" value={formatCurrency(ops.financial.pendingLiabilities)} hint="User pendingWithdraw sum" />
                  <StatCard title="Payout exposure" value={formatCurrency(ops.financial.payoutExposure)} hint={`${ops.financial.pendingWithdrawals} pending withdrawals`} />
                  <StatCard title="Pending deposits" value={String(ops.financial.pendingDeposits)} hint="Detected but not credited/swept" />
                  <StatCard title="Realtime inflow" value={formatCurrency(ops.financial.realtimeInflow)} hint="Last 60 minutes" />
                  <StatCard title="Realtime outflow" value={formatCurrency(ops.financial.realtimeOutflow)} hint="Last 60 minutes" />
                  <StatCard title="Hot wallet health" value={ops.treasury.hotWalletHealth} hint={ops.treasury.note} />
                </div>
              </section>

              <section className={`${CARD} p-5`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-semibold text-white">Treasury Control Center</h2>
                    <p className="mt-1 text-xs text-gray-500">
                      Treasury visibility is read-only here until safe public-wallet balance readers are wired.
                    </p>
                  </div>
                  <StatusPill ok={ops.treasury.hotWalletHealth === "configured"} label={ops.treasury.hotWalletHealth} />
                </div>
                <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <ReadOnlyMetric label="Treasury USDT" value={ops.treasury.treasuryUsdt == null ? null : formatCurrency(ops.treasury.treasuryUsdt)} hint="Safe public-address balance reader." />
                  <ReadOnlyMetric label="Treasury BNB" value={ops.treasury.treasuryBnb == null ? null : String(ops.treasury.treasuryBnb)} hint="Gas wallet visibility." />
                  <ReadOnlyMetric label="Gas reserve" value={ops.treasury.gasReserves == null ? null : String(ops.treasury.gasReserves)} hint="Low gas alert source." />
                  <StatCard title="Payout exposure" value={formatCurrency(ops.treasury.payoutExposure)} hint="Approved, pending, claimable, and review withdrawals" />
                </div>
              </section>

              <section className={`${CARD} p-5`}>
                <h2 className="text-sm font-semibold text-white">Recovery-Safe Runtime Controls</h2>
                <p className="mt-1 text-xs text-gray-500">
                  Use existing recovery APIs. Deposit scans and ROI recovery preserve duplicate and replay protections.
                </p>
                <div className="mt-4 grid gap-3 lg:grid-cols-3">
                  <Link
                    href="/admin/analytics"
                    className="rounded-2xl border border-cyan-300/20 bg-cyan-400/10 p-4 text-sm font-medium text-cyan-100 hover:bg-cyan-400/15"
                  >
                    Open deposit recovery scan tools
                  </Link>
                  <Link
                    href="/admin/analytics"
                    className="rounded-2xl border border-purple-300/20 bg-purple-400/10 p-4 text-sm font-medium text-purple-100 hover:bg-purple-400/15"
                  >
                    Open ROI recovery audit tools
                  </Link>
                  <Link
                    href="/admin/withdrawals"
                    className="rounded-2xl border border-amber-300/20 bg-amber-400/10 p-4 text-sm font-medium text-amber-100 hover:bg-amber-400/15"
                  >
                    Review blocked and suspicious payouts
                  </Link>
                </div>
              </section>

              <section className={`${CARD} p-5`}>
                <h2 className="text-sm font-semibold text-white">Runtime Safety Map</h2>
                <div className="mt-4 grid gap-3 lg:grid-cols-3">
                  {[
                    ["Idempotency protections", ops.safety.duplicateProtections],
                    ["Replay protections", ops.safety.replayProtections],
                    ["Treasury isolation", ops.safety.treasuryIsolation],
                  ].map(([title, rows]) => (
                    <div key={title as string} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                      <h3 className="text-sm font-semibold text-white">{title as string}</h3>
                      <ul className="mt-3 space-y-2 text-xs text-gray-400">
                        {(rows as string[]).map((row) => (
                          <li key={row} className="rounded-lg bg-white/[0.04] px-3 py-2">
                            {row}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </section>

              <RealtimeEventCenter events={ops.events ?? []} />

              <AuditCenter events={ops.events ?? []} />
            </>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <StatCard
              title="Total users"
              value={String(overview.totalUsers ?? 0)}
              hint="All registered accounts"
            />
            <StatCard
              title="Active users"
              value={String(overview.activeUsersDeposit50plus ?? 0)}
              hint="Deposit balance ≥ 50 USDT"
            />
            <StatCard
              title="Total deposits"
              value={formatCurrency(overview.totalDepositsUsd ?? 0)}
              hint="Sum of credited / swept on-chain deposits"
            />
            <StatCard
              title="Total withdrawals (paid)"
              value={formatCurrency(overview.totalWithdrawalsPaidUsd ?? 0)}
              hint="Completed hybrid payouts (net)"
            />
            <StatCard
              title="Pending withdrawals"
              value={String(overview.pendingWithdrawalsCount ?? 0)}
              hint="Awaiting approval or payout"
            />
            <StatCard
              title="Total earnings paid"
              value={formatCurrency(overview.totalEarningsPaidUsd ?? 0)}
              hint={`Paid withdrawals + recorded salary claims${
                overview.totalSalaryPaidUsd != null
                  ? ` · Salary ${formatCurrency(overview.totalSalaryPaidUsd)}`
                  : ""
              }`}
            />
          </div>

          <div className={`${CARD} p-5`}>
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-white">Last 10 activities</h2>
              <Link href="/admin/logs" className="text-xs font-medium text-purple-300 hover:text-purple-200">
                System logs
              </Link>
            </div>
            <p className="mt-1 text-xs text-gray-500">
              Recent deposits, withdrawals, and server-side admin audit events.
            </p>
            <ul className="mt-4 max-h-[28rem] space-y-2 overflow-y-auto pr-1 text-sm">
              {(overview.lastActivities ?? []).length === 0 ? (
                <li className="text-gray-500">No recent activity yet.</li>
              ) : (
                overview.lastActivities.map((row) => (
                  <li
                    key={row.id}
                    className="rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-gray-200"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
                      <span className="rounded-md bg-white/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-300">
                        {row.kind}
                      </span>
                      <span>{row.at ? new Date(row.at).toLocaleString() : "—"}</span>
                    </div>
                    <p className="mt-1 font-medium text-white">{row.action}</p>
                    <p className="text-xs text-gray-400">
                      User: {row.username ?? "—"}
                      {row.amount != null ? ` · ${formatCurrency(row.amount)}` : ""}
                    </p>
                    {row.txHash ? (
                      <p className="mt-1 truncate font-mono text-[10px] text-gray-500">{row.txHash}</p>
                    ) : null}
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
      ) : (
        <div className={`${CARD} p-4 text-sm text-gray-400`}>No overview data.</div>
      )}
    </AdminLayout>
  );
}
