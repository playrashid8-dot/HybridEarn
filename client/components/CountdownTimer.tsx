"use client";

import { useEffect, useMemo, useState } from "react";

const formatDuration = (ms: number) => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${hours}h ${minutes}m ${seconds}s`;
};

export default function CountdownTimer({
  targetTime,
  durationMs,
  label = "Countdown",
  completeText = "Ready",
  className = "",
}: any) {
  const target = useMemo(() => {
    if (targetTime) return new Date(targetTime).getTime();
    if (durationMs) return Date.now() + Number(durationMs);
    return 0;
  }, [durationMs, targetTime]);

  const [remaining, setRemaining] = useState(() => Math.max(0, target - Date.now()));

  useEffect(() => {
    setRemaining(Math.max(0, target - Date.now()));
    if (!target) return;

    const interval = setInterval(() => {
      setRemaining(Math.max(0, target - Date.now()));
    }, 1000);

    return () => clearInterval(interval);
  }, [target]);

  return (
    <div className={`rounded-2xl border border-white/10 bg-white/[0.06] p-4 ${className}`}>
      <p className="text-[10px] uppercase tracking-[0.22em] text-gray-500">{label}</p>
      <p className="mt-1 text-lg font-black text-cyan-200">
        {remaining > 0 ? formatDuration(remaining) : completeText}
      </p>
    </div>
  );
}
