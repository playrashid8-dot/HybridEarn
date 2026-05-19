"use client";

import { motion } from "framer-motion";

export default function GlassCard({
  children,
  className = "",
  glow = "purple",
  hover = false,
}: any) {
  const glowMap: any = {
    purple: "from-purple-500/60 via-fuchsia-500/40 to-blue-500/50 shadow-[0_0_42px_rgba(124,58,237,0.24)]",
    cyan: "from-cyan-400/60 via-blue-500/40 to-purple-500/50 shadow-[0_0_42px_rgba(34,211,238,0.18)]",
    gold: "from-yellow-300/70 via-purple-500/40 to-orange-400/50 shadow-[0_0_42px_rgba(234,179,8,0.18)]",
    green: "from-emerald-400/60 via-cyan-500/35 to-purple-500/45 shadow-[0_0_42px_rgba(16,185,129,0.16)]",
  };

  return (
    <motion.div
      whileHover={hover ? { y: -3, scale: 1.01 } : undefined}
      transition={{ duration: 0.25 }}
      className={`rounded-3xl bg-gradient-to-r p-[1px] ${glowMap[glow] || glowMap.purple} ${className}`}
    >
      <div className="h-full rounded-3xl border border-white/10 bg-[#08080d]/90 p-5 backdrop-blur-2xl">
        {children}
      </div>
    </motion.div>
  );
}
