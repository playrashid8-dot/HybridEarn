"use client";

import { memo, useMemo } from "react";
import { formatCurrency, formatDate } from "./AdminLayout";
import { CARD } from "../../lib/adminTheme";

export function normalizeSeverity(value) {
  const s = String(value || "info").toLowerCase();
  if (s === "critical") return "critical";
  if (s === "warning") return "warning";
  return "info";
}

export function getOpsSeverity(ops) {
  const alerts = Array.isArray(ops?.alerts) ? ops.alerts : [];
  if (alerts.some((alert) => normalizeSeverity(alert.severity) === "critical")) return "critical";
  if (alerts.some((alert) => normalizeSeverity(alert.severity) === "warning")) return "warning";
  return "info";
}

export function severityTone(severity) {
  const s = normalizeSeverity(severity);
  if (s === "critical") {
    return {
      border: "border-red-400/35",
      bg: "bg-red-500/10",
      text: "text-red-100",
      dot: "bg-red-300",
      glow: "shadow-red-950/35",
      label: "CRITICAL",
    };
  }
  if (s === "warning") {
    return {
      border: "border-amber-400/35",
      bg: "bg-amber-500/10",
      text: "text-amber-100",
      dot: "bg-amber-300",
      glow: "shadow-amber-950/30",
      label: "WARNING",
    };
  }
  return {
    border: "border-cyan-400/30",
    bg: "bg-cyan-500/10",
    text: "text-cyan-100",
    dot: "bg-cyan-300",
    glow: "shadow-cyan-950/25",
    label: "INFO",
  };
}

export function SeverityBadge({ severity = "info", children = null }) {
  const tone = severityTone(severity);
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${tone.border} ${tone.bg} ${tone.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${tone.dot} ${severity !== "info" ? "animate-pulse" : ""}`} />
      {children || tone.label}
    </span>
  );
}

export function StatusBadge({ ok, label, tone = "cyan" }) {
  const good = ok
    ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-200"
    : tone === "red"
      ? "border-red-400/30 bg-red-500/10 text-red-100"
      : "border-amber-400/30 bg-amber-500/10 text-amber-100";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${good}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-emerald-300" : tone === "red" ? "bg-red-300" : "bg-amber-300"}`} />
      {label}
    </span>
  );
}

export function SkeletonBlock({ className = "" }) {
  return <div className={`admin-shimmer rounded-xl bg-white/[0.07] ${className}`} />;
}

export function OpsSkeleton({ rows = 6 }) {
  return (
    <section className={`${CARD} p-4 sm:p-5`}>
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-2">
          <SkeletonBlock className="h-3 w-36" />
          <SkeletonBlock className="h-5 w-56" />
        </div>
        <SkeletonBlock className="h-7 w-24 rounded-full" />
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: rows }).map((_, index) => (
          <div key={index} className="rounded-2xl border border-white/10 bg-black/20 p-3">
            <SkeletonBlock className="h-3 w-24" />
            <SkeletonBlock className="mt-3 h-6 w-20" />
            <SkeletonBlock className="mt-2 h-3 w-full" />
          </div>
        ))}
      </div>
    </section>
  );
}

export function StatePanel({ type = "empty", title, detail, actionLabel, onAction }) {
  const tone =
    type === "error"
      ? "border-red-400/25 bg-red-500/10 text-red-100"
      : type === "warning"
        ? "border-amber-400/25 bg-amber-500/10 text-amber-100"
        : "border-white/10 bg-black/20 text-gray-400";
  return (
    <div className={`rounded-2xl border p-4 text-sm ${tone}`}>
      <p className="font-semibold text-white">{title}</p>
      {detail ? <p className="mt-1 text-xs leading-relaxed text-current/80">{detail}</p> : null}
      {onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="mt-3 rounded-xl border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-white transition hover:bg-white/10"
        >
          {actionLabel || "Retry"}
        </button>
      ) : null}
    </div>
  );
}

export function MetricCard({ label, value, hint, loading = false, status = "neutral" }) {
  const ring =
    status === "critical"
      ? "border-red-400/25 shadow-red-950/20"
      : status === "warning"
        ? "border-amber-400/25 shadow-amber-950/20"
        : status === "ok"
          ? "border-emerald-400/20 shadow-emerald-950/15"
          : "border-white/10 shadow-black/20";
  return (
    <div className={`rounded-2xl border bg-black/20 p-3 shadow-lg transition ${ring}`}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-500">{label}</p>
      {loading ? (
        <>
          <SkeletonBlock className="mt-3 h-6 w-24" />
          <SkeletonBlock className="mt-2 h-3 w-full" />
        </>
      ) : (
        <>
          <p className="mt-2 min-h-7 text-xl font-semibold leading-none tabular-nums text-white">{value ?? "Not reported"}</p>
          {hint ? <p className="mt-2 text-[11px] leading-relaxed text-gray-500">{hint}</p> : null}
        </>
      )}
    </div>
  );
}

export function ReadOnlyMetric({ label, value, hint, unavailableLabel = "Awaiting secure backend exposure" }) {
  const unavailable = value == null || value === "";
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-black/20 p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-500">{label}</p>
        <span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${unavailable ? "border-amber-300/25 bg-amber-400/10 text-amber-100" : "border-cyan-300/25 bg-cyan-400/10 text-cyan-100"}`}>
          {unavailable ? "read-only pending" : "read-only"}
        </span>
      </div>
      <p className="mt-2 text-xl font-semibold tabular-nums text-white">{unavailable ? "Unavailable" : value}</p>
      <p className="mt-2 text-[11px] leading-relaxed text-gray-500">{unavailable ? unavailableLabel : hint}</p>
      {unavailable ? <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(110deg,transparent,rgba(251,191,36,0.06),transparent)]" /> : null}
    </div>
  );
}

export function buildHistoryPoint(ops) {
  if (!ops) return null;
  const queues = Object.values(ops.queues || {});
  const failedJobs = queues.reduce((sum, queue) => sum + Number(queue?.failed || 0), 0);
  const queueThroughput = queues.reduce((sum, queue) => sum + Number(queue?.completed || 0), 0);
  const depositEvents = (ops.events || []).filter((event) => String(event.type || "").startsWith("deposit_")).length;
  const withdrawalEvents = (ops.events || []).filter((event) => String(event.type || "").startsWith("withdrawal_")).length;
  const payoutHeartbeatMs = ops.health?.queueHeartbeat?.payoutAgeMs;
  return {
    at: ops.generatedAt || new Date().toISOString(),
    label: ops.generatedAt ? new Date(ops.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "now",
    inflow: Number(ops.financial?.realtimeInflow || 0),
    outflow: Number(ops.financial?.realtimeOutflow || 0),
    rpcLatency: Number(ops.health?.rpcLatencyMs || 0),
    depositThroughput: depositEvents,
    withdrawalThroughput: withdrawalEvents,
    queueThroughput,
    failedJobs,
    memory: Number(ops.runtime?.memory?.rssMb || 0),
    cpu: Number(ops.runtime?.cpu?.loadAvg1m || 0),
    payoutLatency: payoutHeartbeatMs == null ? null : Math.round(Number(payoutHeartbeatMs) / 1000),
    workerHeartbeat: ops.health?.depositWorker || ops.health?.payoutWorker ? 1 : 0,
  };
}

export function appendHistory(prev, ops) {
  const point = buildHistoryPoint(ops);
  if (!point) return prev;
  const next = [...prev.filter((item) => item.at !== point.at), point];
  return next.slice(-24);
}

function sparkPath(points, key, width, height) {
  const values = points.map((point) => Number(point[key])).filter((value) => Number.isFinite(value));
  if (values.length === 0) return "";
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const spread = Math.max(max - min, 1);
  return points
    .map((point, index) => {
      const value = Number(point[key]);
      const safe = Number.isFinite(value) ? value : min;
      const x = points.length <= 1 ? width - 4 : (index / (points.length - 1)) * (width - 8) + 4;
      const y = height - 6 - ((safe - min) / spread) * (height - 14);
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

export function MiniChart({ title, value, suffix = "", series, dataKey, color = "#67e8f9", hint }) {
  const path = useMemo(() => sparkPath(series || [], dataKey, 220, 68), [series, dataKey]);
  const enoughData = (series || []).length >= 2;
  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-500">{title}</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-white">
            {value ?? "Collecting"}{value != null ? suffix : ""}
          </p>
        </div>
        <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[9px] uppercase tracking-wide text-gray-400">
          live
        </span>
      </div>
      <svg viewBox="0 0 220 68" className="mt-2 h-16 w-full overflow-visible" role="img" aria-label={`${title} trend`}>
        <defs>
          <linearGradient id={`fill-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d="M4 62 H216" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
        {path ? (
          <>
            <path d={`${path} L216 64 L4 64 Z`} fill={`url(#fill-${dataKey})`} />
            <path d={path} fill="none" stroke={color} strokeLinecap="round" strokeWidth="2.25" />
          </>
        ) : null}
      </svg>
      <p className="mt-1 text-[11px] leading-relaxed text-gray-500">
        {enoughData ? hint : "Collecting verified polling samples for trend history."}
      </p>
    </div>
  );
}

export function OpsCharts({ ops, history = [] }) {
  const latest = history[history.length - 1] || buildHistoryPoint(ops);
  const series = history.length ? history : latest ? [latest] : [];
  return (
    <section className={`${CARD} p-4 sm:p-5`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-white">Realtime Fintech Telemetry</h2>
          <p className="mt-1 text-xs text-gray-500">Lightweight SVG charts from verified polling snapshots. No synthetic balances or worker state.</p>
        </div>
        <StatusBadge ok={series.length >= 2} label={series.length >= 2 ? `${series.length} samples` : "warming up"} />
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MiniChart title="Treasury inflow" value={latest ? formatCurrency(latest.inflow) : null} series={series} dataKey="inflow" color="#34d399" hint="Last-hour credited and swept deposit inflow." />
        <MiniChart title="Treasury outflow" value={latest ? formatCurrency(latest.outflow) : null} series={series} dataKey="outflow" color="#fbbf24" hint="Last-hour paid withdrawal outflow." />
        <MiniChart title="RPC latency" value={latest?.rpcLatency || null} suffix=" ms" series={series} dataKey="rpcLatency" color="#60a5fa" hint="Average RPC endpoint latency reported by runtime health." />
        <MiniChart title="Deposit throughput" value={latest?.depositThroughput ?? null} series={series} dataKey="depositThroughput" color="#22d3ee" hint="Recent deposit events visible in the live event feed." />
        <MiniChart title="Withdrawal throughput" value={latest?.withdrawalThroughput ?? null} series={series} dataKey="withdrawalThroughput" color="#a78bfa" hint="Recent withdrawal events visible in the live event feed." />
        <MiniChart title="Queue throughput" value={latest?.queueThroughput ?? null} series={series} dataKey="queueThroughput" color="#2dd4bf" hint="BullMQ completed-job counters from queue snapshots." />
        <MiniChart title="Runtime memory" value={latest?.memory ?? null} suffix=" MB" series={series} dataKey="memory" color="#c084fc" hint="API process RSS memory from the ops snapshot." />
        <MiniChart title="CPU load" value={latest?.cpu?.toFixed ? latest.cpu.toFixed(2) : latest?.cpu} series={series} dataKey="cpu" color="#fb7185" hint="One-minute process host load average." />
        <MiniChart title="Failed jobs trend" value={latest?.failedJobs ?? null} series={series} dataKey="failedJobs" color="#f87171" hint="Total failed jobs across reported queues." />
        <MiniChart title="Payout latency signal" value={latest?.payoutLatency ?? null} suffix=" s" series={series} dataKey="payoutLatency" color="#f59e0b" hint="Payout worker heartbeat age, not a fabricated payout SLA." />
        <MiniChart title="Worker heartbeat" value={latest?.workerHeartbeat ?? null} series={series} dataKey="workerHeartbeat" color="#86efac" hint="Boolean heartbeat signal sampled from runtime state." />
      </div>
    </section>
  );
}

export const QueuePressureCard = memo(function QueuePressureCard({ queueKey, queue, selected = false, onSelect }) {
  const waiting = Number(queue?.waiting || 0);
  const active = Number(queue?.active || 0);
  const delayed = Number(queue?.delayed || 0);
  const failed = Number(queue?.failed || 0);
  const retries = Number(queue?.retryAttempts || 0);
  const totalPressure = waiting + active + delayed + failed;
  const pressurePct = Math.min(100, totalPressure === 0 ? (active > 0 ? 8 : 0) : totalPressure * 10);
  const retryHeat = Math.min(100, retries * 12 + failed * 20);
  const healthScore = queue?.ok ? Math.max(0, 100 - failed * 18 - retries * 4 - waiting * 2 - delayed) : 0;
  const ButtonOrDiv = onSelect ? "button" : "div";
  return (
    <ButtonOrDiv
      type={onSelect ? "button" : undefined}
      onClick={onSelect ? () => onSelect(queueKey) : undefined}
      className={`group rounded-2xl border p-3 text-left transition ${selected ? "border-cyan-300/50 bg-cyan-400/10 shadow-lg shadow-cyan-950/30" : failed > 0 ? "border-amber-300/35 bg-amber-500/[0.07] shadow-lg shadow-amber-950/20" : "border-white/10 bg-black/20 hover:border-white/20 hover:bg-white/[0.04]"}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold capitalize text-white">{queue?.label || queueKey}</h3>
          <p className="mt-0.5 text-[11px] text-gray-500">Health score {healthScore}/100</p>
        </div>
        <StatusBadge ok={Boolean(queue?.ok)} label={queue?.ok ? "online" : "offline"} tone="red" />
      </div>
      <div className="mt-3 space-y-2">
        <Bar label="Pressure" value={pressurePct} color={failed > 0 ? "bg-amber-300" : "bg-cyan-300"} pulse={active > 0} />
        <Bar label="Retry heat" value={retryHeat} color={failed > 0 ? "bg-red-300" : "bg-emerald-300"} pulse={failed > 0} />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <Tiny label="wait" value={waiting} />
        <Tiny label="active" value={<span className={active > 0 ? "text-cyan-200" : ""}>{active}</span>} pulse={active > 0} />
        <Tiny label="delay" value={delayed} />
        <Tiny label="failed" value={<span className={failed > 0 ? "text-amber-100" : ""}>{failed}</span>} pulse={failed > 0} />
        <Tiny label="dead" value={Number(queue?.deadLetter || 0)} />
        <Tiny label="retry" value={retries} />
      </div>
      {queue?.note ? <p className="mt-3 text-[11px] leading-relaxed text-gray-500">{queue.note}</p> : null}
    </ButtonOrDiv>
  );
});

function Bar({ label, value, color, pulse }) {
  return (
    <div>
      <div className="flex justify-between text-[10px] uppercase tracking-wide text-gray-500">
        <span>{label}</span>
        <span>{Math.round(value)}%</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div className={`h-full rounded-full ${color} transition-all duration-700 ${pulse ? "admin-live-pulse" : ""}`} style={{ width: `${Math.max(4, value)}%` }} />
      </div>
    </div>
  );
}

function Tiny({ label, value, pulse }) {
  return (
    <div className={`rounded-xl border border-white/5 bg-white/[0.04] px-2 py-1.5 ${pulse ? "ring-1 ring-cyan-300/20" : ""}`}>
      <p className="text-[9px] uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-0.5 text-base font-semibold tabular-nums text-white">{value}</p>
    </div>
  );
}

export function EventTicker({ events = [] }) {
  const deduped = useMemo(() => {
    const seen = new Set();
    return events.filter((event) => {
      const key = event?.id || `${event?.type}:${event?.at}:${event?.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [events]);
  const tickerEvents = deduped.length ? [...deduped, ...deduped] : [];
  return (
    <section className={`${CARD} overflow-hidden p-0`}>
      <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
        <SeverityBadge severity={deduped.some((event) => String(event.type || "").includes("failed")) ? "warning" : "info"}>LIVE</SeverityBadge>
        <div>
          <h2 className="text-sm font-semibold text-white">Operational Event Ticker</h2>
          <p className="text-[11px] text-gray-500">Deduped events from deposits, withdrawals, payouts, queue warnings, and admin audit records.</p>
        </div>
      </div>
      {tickerEvents.length === 0 ? (
        <div className="px-4 py-3 text-sm text-gray-500">No live events in this snapshot.</div>
      ) : (
        <div className="admin-ticker-mask overflow-hidden">
          <div className="admin-event-ticker flex w-max gap-3 px-4 py-3">
            {tickerEvents.map((event, index) => {
              const severity = eventSeverity(event);
              const tone = severityTone(severity);
              return (
                <div key={`${event.id || event.title}-${index}`} className={`flex min-w-[18rem] items-center gap-3 rounded-2xl border px-3 py-2 ${tone.border} ${tone.bg}`}>
                  <span className={`h-2 w-2 shrink-0 rounded-full ${tone.dot}`} />
                  <div className="min-w-0">
                    <p className="truncate text-xs font-semibold text-white">{event.title || String(event.type || "event").replaceAll("_", " ")}</p>
                    <p className="truncate text-[11px] text-gray-400">
                      {String(event.type || "runtime").replaceAll("_", " ")} · {event.at ? formatDate(event.at) : "time unavailable"}
                      {event.amount != null ? ` · ${formatCurrency(event.amount)}` : ""}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function eventSeverity(event) {
  const text = `${event?.type || ""} ${event?.title || ""}`.toLowerCase();
  if (text.includes("failed") || text.includes("blocked") || text.includes("suspicious")) return "warning";
  if (text.includes("recovery") || text.includes("admin")) return "info";
  return "info";
}
