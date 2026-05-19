"use client";

export default function Loader({ label = "Loading..." }) {
  return (
    <div className="flex min-h-[220px] items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-sm text-gray-400">
        <span className="h-10 w-10 rounded-full border-2 border-purple-500 border-t-transparent animate-spin" />
        <span>{label}</span>
      </div>
    </div>
  );
}
