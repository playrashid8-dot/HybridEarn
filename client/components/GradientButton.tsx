"use client";

import { motion } from "framer-motion";

export default function GradientButton({
  children,
  onClick,
  loading = false,
  disabled = false,
  className = "",
  type = "button",
}: any) {
  const isDisabled = disabled || loading;

  return (
    <motion.button
      type={type}
      whileTap={{ scale: 0.96 }}
      onClick={onClick}
      disabled={isDisabled}
      className={`w-full rounded-2xl bg-gradient-to-r from-[#6366F1] via-indigo-500 to-indigo-600 px-4 py-3 text-sm font-bold text-white shadow-md transition hover:scale-105 hover:shadow-[0_8px_32px_rgba(99,102,241,0.4)] disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:scale-100 ${className}`}
    >
      <span className="flex items-center justify-center gap-2">
        {loading && (
          <span className="h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
        )}
        {children}
      </span>
    </motion.button>
  );
}
