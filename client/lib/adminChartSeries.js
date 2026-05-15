function dayKey(d) {
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return null;
  return x.toISOString().slice(0, 10);
}

function lastNDaysLabels(n) {
  const labels = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date(now);
    dt.setDate(dt.getDate() - i);
    labels.push(dt.toISOString().slice(0, 10));
  }
  return labels;
}

function labelShort(iso) {
  const [, m, d] = iso.split("-");
  return `${m}/${d}`;
}

/** @param {any[]} deposits */
export function buildDepositDailySeries(deposits, days = 14) {
  const keys = lastNDaysLabels(days);
  const sums = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const dep of deposits || []) {
    const k = dayKey(dep.createdAt);
    if (k && sums[k] != null) sums[k] += Number(dep.amount || 0);
  }
  return keys.map((k) => ({
    key: k,
    label: labelShort(k),
    amount: Math.round(sums[k] * 100) / 100,
  }));
}

/** @param {any[]} withdrawals */
export function buildWithdrawDailySeries(withdrawals, days = 14) {
  const keys = lastNDaysLabels(days);
  const netSums = Object.fromEntries(keys.map((k) => [k, 0]));
  const counts = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const w of withdrawals || []) {
    const k = dayKey(w.createdAt);
    if (k == null || netSums[k] == null) continue;
    netSums[k] += Number(w.netAmount || 0);
    counts[k] += 1;
  }
  return keys.map((k) => ({
    key: k,
    label: labelShort(k),
    net: Math.round(netSums[k] * 100) / 100,
    count: counts[k],
  }));
}

/** @param {any[]} users - must include createdAt */
export function buildUserGrowthSeries(users, days = 30) {
  const keys = lastNDaysLabels(days);
  const byDay = {};
  for (const u of users || []) {
    const k = dayKey(u.createdAt);
    if (!k) continue;
    byDay[k] = (byDay[k] || 0) + 1;
  }
  let cumulative = 0;
  /** Count users created on or before `endKey` not in window — approximate baseline */
  const firstKey = keys[0];
  for (const u of users || []) {
    const k = dayKey(u.createdAt);
    if (k && k < firstKey) cumulative += 1;
  }
  return keys.map((k) => {
    cumulative += byDay[k] || 0;
    return {
      key: k,
      label: labelShort(k),
      cumulative,
    };
  });
}
