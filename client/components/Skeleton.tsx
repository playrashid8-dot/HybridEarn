"use client";

import { motion } from "framer-motion";
import SkeletonCard from "./SkeletonCard";

export function SkeletonLine({ className = "" }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-lg bg-white/10 ${className}`}
      aria-hidden
    />
  );
}

export default function PageSkeleton() {
  return (
    <div className="space-y-6 py-4">
      <div className="flex gap-4">
        <SkeletonLine className="h-12 w-12 shrink-0 rounded-2xl" />
        <div className="flex-1 space-y-2 pt-1">
          <SkeletonLine className="h-3 w-32" />
          <SkeletonLine className="h-5 w-48 max-w-full" />
        </div>
      </div>
      <SkeletonLine className="h-36 w-full rounded-3xl" />
      <div className="grid grid-cols-2 gap-3">
        <SkeletonCard />
        <SkeletonCard />
      </div>
      <div className="space-y-2">
        <SkeletonCard className="h-14" />
        <SkeletonCard className="h-14" />
      </div>
      <SkeletonLine className="h-48 w-full rounded-3xl" />
    </div>
  );
}

export function SkeletonPulse({ className = "" }: { className?: string }) {
  return (
    <motion.div
      className={`rounded-xl bg-gradient-to-r from-white/[0.06] via-white/[0.12] to-white/[0.06] bg-[length:200%_100%] ${className}`}
      animate={{ backgroundPosition: ["200% 0", "-200% 0"] }}
      transition={{ repeat: Infinity, duration: 2.4, ease: "linear" }}
      aria-hidden
    />
  );
}
