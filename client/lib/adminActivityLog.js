const STORAGE_KEY = "nova_admin_activity_v1";
const MAX_ENTRIES = 200;

export function getAdminLogs() {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    if (parsed.length > MAX_ENTRIES) {
      const trimmed = parsed.slice(-MAX_ENTRIES);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
      } catch {
        /* ignore */
      }
      return trimmed;
    }
    return parsed;
  } catch {
    return [];
  }
}

/** @param {{ level?: 'info' | 'error'; action: string; detail?: string }} entry */
export function pushAdminLog(entry) {
  if (typeof window === "undefined") return;
  try {
    const prev = getAdminLogs();
    const row = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      ts: Date.now(),
      level: entry.level || "info",
      action: entry.action,
      detail: entry.detail || "",
    };
    const next = [row, ...prev].slice(0, MAX_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
}

export function clearAdminLogs() {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
