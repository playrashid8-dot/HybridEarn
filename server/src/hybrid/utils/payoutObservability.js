/**
 * Hybrid payout / claim telemetry — lightweight in-memory counters for ops dashboards.
 */

const pct = (n, d) =>
  !Number.isFinite(n) || !Number.isFinite(d) || d <= 0 ? 0 : Math.round((n / d) * 1000) / 10;

let rpcSamples = [];
const RPC_SAMPLE_CAP = Number(process.env.HYBRID_PAYOUT_RPC_SAMPLES_CAP || 200);

/** @typedef {{ locked: number, pendingNext: number, latest: number|null, mismatchedRecovery: boolean }} NonceDiag */
/** @type {NonceDiag|null} */
let lastNonceDiag = null;

/** @typedef {{ cached: boolean|null, ttlMs?: number|null, gasLimitSuggested?: string|null }} GasDiag */
/** @type {GasDiag|null} */
let lastGasDiag = null;

const counters = {
  payoutAttempts: 0,
  payoutsBroadcast: 0,
  payoutsMarkedPaid: 0,
  payoutsFailedRpc: 0,
  payoutsNonceRecovery: 0,
  payoutsIdempotentSkip: 0,
  payoutsDeadLetterBlocked: 0,
  payoutsStaleRecoveries: 0,
  payoutWalletMutexBusy: 0,
  payoutsGasBump: 0,
  claimRoiOk: 0,
  claimRoiFail: 0,
  claimSalaryOk: 0,
  claimSalaryFail: 0,
  rpcTimedOut: 0,
};

export function recordRpcDurationMs(ms, label = "payout") {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) {
    return;
  }
  rpcSamples.push({ t: Date.now(), ms: n, label: String(label || "payout") });
  if (rpcSamples.length > RPC_SAMPLE_CAP) {
    rpcSamples = rpcSamples.slice(-RPC_SAMPLE_CAP);
  }
}

export function bumpPayout(metric) {
  if (counterKey(metric)) {
    counters[metric] += 1;
  }
}

/** @returns {metric is keyof counters} */
function counterKey(metric) {
  return Object.prototype.hasOwnProperty.call(counters, metric);
}

export function recordNonceDiagnostics(diag) {
  lastNonceDiag = {
    locked: Number(diag?.locked ?? 0),
    pendingNext: Number(diag?.pendingNext ?? 0),
    latest: diag?.latest == null ? null : Number(diag.latest),
    mismatchedRecovery: Boolean(diag?.mismatchedRecovery),
  };
}

export function recordGasDiagnostics(diag) {
  lastGasDiag = {
    cached: diag?.cached == null ? null : Boolean(diag.cached),
    ttlMs:
      diag?.ttlMs != null && Number.isFinite(Number(diag.ttlMs)) ? Number(diag.ttlMs) : undefined,
    gasLimitSuggested:
      diag?.gasLimitSuggested != null ? String(diag.gasLimitSuggested) : undefined,
  };
}

/** @returns {Promise<T>} */
export async function withPayoutRpcTimeout(fn, ms, label = "rpc") {
  const cap = Math.max(1000, Number(ms) || 25_000);
  const started = Date.now();
  /** @type {ReturnType<typeof setTimeout>} */
  let timer;
  const timeoutPromise = new Promise((_, rej) => {
    timer = setTimeout(() => {
      rej(new Error(`RPC timeout (${cap}ms) ${label}`));
    }, cap);
  });
  try {
    /** @type {T} */
    const out = await Promise.race([fn(), timeoutPromise]);
    recordRpcDurationMs(Date.now() - started, label);
    return out;
  } catch (err) {
    const msg = String(err?.message || err || "");
    if (/rpc timeout/i.test(msg)) {
      counters.rpcTimedOut += 1;
      bumpPayout("payoutsFailedRpc");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function bumpClaimRoi(success) {
  if (success) {
    counters.claimRoiOk += 1;
  } else {
    counters.claimRoiFail += 1;
  }
}

export function bumpClaimSalary(success) {
  if (success) {
    counters.claimSalaryOk += 1;
  } else {
    counters.claimSalaryFail += 1;
  }
}

export function payoutObservabilitySnapshot() {
  const recent = rpcSamples.filter((x) => Date.now() - x.t < 300_000);
  const agg = recent.reduce(
    (acc, s) => {
      acc.ms += s.ms;
      acc.n += 1;
      return acc;
    },
    { ms: 0, n: 0 }
  );

  const p50Approx = () => {
    if (recent.length === 0) {
      return null;
    }
    const sorted = [...recent].sort((a, b) => a.ms - b.ms);
    const mid = sorted[Math.floor(sorted.length / 2)];
    return Number(mid.ms.toFixed(1));
  };

  return {
    counters: { ...counters },
    rpcLatencyLast5Min: {
      samples: agg.n,
      avgMs:
        agg.n > 0
          ? Math.round((agg.ms / agg.n) * 10) / 10
          : null,
      p50ApproxMs: p50Approx(),
    },
    lastNonceDiag: lastNonceDiag ? { ...lastNonceDiag } : null,
    lastGasDiag: lastGasDiag ? { ...lastGasDiag } : null,
    claimSuccessRates: {
      roiOkPctOfAttempts: pct(counters.claimRoiOk, counters.claimRoiOk + counters.claimRoiFail),
      salaryOkPctOfAttempts: pct(
        counters.claimSalaryOk,
        counters.claimSalaryOk + counters.claimSalaryFail,
      ),
    },
  };
}
