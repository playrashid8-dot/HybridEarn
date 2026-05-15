"use client";

export default function SkeletonCard({ className = "" }) {
  return (
    <div
      className={`animate-pulse h-20 rounded-xl bg-white/10 mb-3 shadow-inner ring-1 ring-white/[0.04] ${className}`}
      aria-hidden
    />
  );
}
