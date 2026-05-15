"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import {
  registerVipToastListener,
  type VipToastPayload,
} from "../../lib/vipToast";

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10Z"
        stroke="currentColor"
        strokeWidth="1.5"
        opacity="0.35"
      />
      <path
        d="m8.5 12.5 2.4 2.4 5.6-5.6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function WarningIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 9v4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="12" cy="16" r="1" fill="currentColor" />
      <path
        d="M10.3 4.3 2.8 17.3c-.5 1 .1 2.2 1.3 2.2h16.8c1.2 0 1.8-1.2 1.3-2.2L13.7 4.3c-.6-1.1-2.1-1.1-2.7 0Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function VipToastHost() {
  const [toast, setToast] = useState<VipToastPayload | null>(null);

  useEffect(() => registerVipToastListener(setToast), []);

  const isSuccess = toast?.type === "success";
  const durationMs = toast?.durationMs ?? 4000;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[100] flex justify-center px-4 pt-6">
      <AnimatePresence mode="wait">
        {toast ? (
          <motion.div
            key={`${toast.type}-${toast.message}-${durationMs}`}
            role="alert"
            aria-live="polite"
            initial={{ opacity: 0, y: -22, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -14, scale: 0.96 }}
            transition={{ type: "spring", damping: 28, stiffness: 320 }}
            className="pointer-events-auto relative max-w-[min(480px,calc(100vw-2rem))]"
          >
            <div
              className={`pointer-events-none absolute -inset-3 -z-10 rounded-[28px] blur-2xl ${
                isSuccess ? "bg-emerald-500/30" : "bg-rose-500/25"
              }`}
              aria-hidden
            />
            <div
              className={`relative overflow-hidden rounded-2xl border px-6 pb-3 pt-4 shadow-[0_12px_48px_rgba(0,0,0,0.35),0_0_0_1px_rgba(255,255,255,0.08)_inset] backdrop-blur-xl ${
                isSuccess
                  ? "border-emerald-400/45 bg-gradient-to-br from-emerald-600/95 via-emerald-700/92 to-teal-800/95 text-white"
                  : "border-rose-400/45 bg-gradient-to-br from-rose-600/95 via-red-700/92 to-red-950/95 text-white"
              }`}
            >
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.18),transparent_55%)]" />
              <div className="relative flex items-start gap-4">
                <div
                  className={`mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border shadow-inner ${
                    isSuccess
                      ? "border-emerald-200/35 bg-emerald-500/25 text-emerald-50"
                      : "border-rose-200/35 bg-rose-500/20 text-rose-50"
                  }`}
                >
                  {isSuccess ? (
                    <CheckIcon className="h-6 w-6 shrink-0" />
                  ) : (
                    <WarningIcon className="h-6 w-6 shrink-0" />
                  )}
                </div>
                <p className="min-w-0 flex-1 pt-1 text-[15px] font-semibold leading-snug tracking-tight">
                  {toast.message}
                </p>
              </div>

              <div className="relative mt-4 h-1 w-full overflow-hidden rounded-full bg-black/25">
                <motion.div
                  key={`bar-${toast.message}`}
                  className={`h-full rounded-full ${
                    isSuccess ? "bg-emerald-200/85" : "bg-rose-200/90"
                  }`}
                  initial={{ scaleX: 1 }}
                  animate={{ scaleX: 0 }}
                  transition={{ duration: durationMs / 1000, ease: "linear" }}
                  style={{ transformOrigin: "left" }}
                />
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
