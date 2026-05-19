/** Non-production diagnostics only — avoids console spam in prod builds. */
export function devWarn(...args) {
  if (process.env.NODE_ENV !== "production") {
    console.warn(...args);
  }
}
