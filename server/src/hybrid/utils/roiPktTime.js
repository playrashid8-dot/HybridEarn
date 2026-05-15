/**
 * Pakistan (Asia/Karachi) daily ROI window. Karachi is UTC+5 year-round (no DST).
 * 5:00 AM PKT === 00:00:00.000 UTC on the same calendar date in Karachi.
 */

export function getPakistanTime() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Karachi" }));
}

function getPktYmdParts(instant = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const pick = (t) => parts.find((p) => p.type === t)?.value;
  return {
    y: Number(pick("year")),
    m: Number(pick("month")),
    d: Number(pick("day")),
    hour: Number(pick("hour")),
    minute: Number(pick("minute")),
    second: Number(pick("second")),
  };
}

/** Start of today's 05:00 PKT expressed as UTC (midnight UTC on today's PKT calendar date). */
export function getTodayPktFiveAmUtc(instant = new Date()) {
  const { y, m, d } = getPktYmdParts(instant);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
}

/** Earliest UTC instant strictly after `from` where the clock crosses 05:00 in Asia/Karachi. */
export function getNextPktFiveAmUtc(from = new Date()) {
  const { y, m, d } = getPktYmdParts(from);
  let candidate = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
  while (candidate.getTime() <= from.getTime()) {
    candidate = new Date(candidate.getTime() + 86400000);
  }
  return candidate;
}

export function isAfter5AM() {
  const pkt = getPakistanTime();
  return pkt.getHours() >= 5;
}

export function alreadyClaimedToday(lastClaim) {
  if (!lastClaim) return false;

  const nowPkt = getPakistanTime();
  const last = new Date(
    new Date(lastClaim).toLocaleString("en-US", { timeZone: "Asia/Karachi" }),
  );

  return (
    nowPkt.toDateString() === last.toDateString() && last.getHours() >= 5
  );
}

/**
 * For atomic updates: claim allowed only if last claim is before today's 05:00 PKT boundary,
 * assuming the caller already verified current time >= 05:00 PKT.
 */
export function getClaimWindowStartUtc(now = new Date()) {
  return getTodayPktFiveAmUtc(now);
}

/**
 * Server-side eligibility for UI (deposit summary + ROI status).
 */
export function getPktRoiClaimFlags(lastDailyClaim) {
  const after5 = isAfter5AM();
  const claimedToday = alreadyClaimedToday(lastDailyClaim);

  let countdownTargetIso = null;
  if (!after5) {
    countdownTargetIso = getTodayPktFiveAmUtc().toISOString();
  } else if (claimedToday) {
    countdownTargetIso = getNextPktFiveAmUtc(new Date()).toISOString();
  }

  return {
    isAfter5AMPkt: after5,
    claimedTodayPkt: claimedToday,
    roiCountdownTargetIso: countdownTargetIso,
  };
}
