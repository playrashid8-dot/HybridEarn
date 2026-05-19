"use client";

import type { ReactNode } from "react";

type Action = {
  label: string;
  onClick: () => void;
};

export default function EmptyState({
  text = "No data available",
  title,
  className = "",
  icon,
  action,
}: {
  text?: string;
  title?: string;
  className?: string;
  icon?: ReactNode;
  action?: Action;
}) {
  return (
    <div
      className={`rounded-2xl border border-white/[0.08] bg-[#111827]/80 px-6 py-10 text-center shadow-inner ring-1 ring-white/[0.04] ${className}`}
      role="status"
    >
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500/20 to-blue-600/20 text-2xl ring-1 ring-white/[0.08]">
        {icon ?? (
          <span className="text-emerald-200/95" aria-hidden>
            📤
          </span>
        )}
      </div>
      {title ? (
        <p className="text-sm font-semibold text-white">{title}</p>
      ) : null}
      <p className={`text-sm text-gray-400 ${title ? "mt-1" : ""}`}>{text}</p>
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-6 min-h-[44px] w-full max-w-[240px] rounded-2xl border border-emerald-500/40 bg-emerald-500/15 px-4 py-3 text-xs font-bold text-emerald-100 transition hover:bg-emerald-500/25 active:scale-[0.98]"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
