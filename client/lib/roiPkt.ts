/**
 * Hybrid ROI countdown helper (Pakistan time). Mirrors dashboard spec — display only;
 * server (`/roi/claim`) enforces the real window via `roiCountdownTargetIso` when available.
 */
export function getTimeUntil5AM(): { hours: number; minutes: number; seconds: number } {
  const now = new Date();
  const pkt = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Karachi" }));

  const target = new Date(pkt);
  target.setHours(5, 0, 0, 0);

  if (pkt >= target) {
    target.setDate(target.getDate() + 1);
  }

  const diff = target.getTime() - pkt.getTime();

  return {
    hours: Math.floor(diff / (1000 * 60 * 60)),
    minutes: Math.floor((diff / (1000 * 60)) % 60),
    seconds: Math.floor((diff / 1000) % 60),
  };
}

export function countdownPartsFromIso(targetIso: string | null | undefined): {
  hours: number;
  minutes: number;
  seconds: number;
} | null {
  if (!targetIso) return null;
  const targetMs = new Date(targetIso).getTime();
  if (!Number.isFinite(targetMs)) return null;
  const diff = Math.max(0, targetMs - Date.now());
  return {
    hours: Math.floor(diff / (1000 * 60 * 60)),
    minutes: Math.floor((diff / (1000 * 60)) % 60),
    seconds: Math.floor((diff / 1000) % 60),
  };
}

export function formatHms(parts: { hours: number; minutes: number; seconds: number }): string {
  const h = String(parts.hours).padStart(2, "0");
  const m = String(parts.minutes).padStart(2, "0");
  const s = String(parts.seconds).padStart(2, "0");
  return `${h}:${m}:${s}`;
}
