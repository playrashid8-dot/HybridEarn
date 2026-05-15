const variants = {
  primary:
    "bg-gradient-to-r from-emerald-500 to-green-400 text-gray-950 font-bold shadow-glow-emerald hover:brightness-110 active:scale-[0.98]",
  secondary:
    "border border-blue-500/40 bg-blue-500/15 text-blue-100 hover:bg-blue-500/25 active:scale-[0.98]",
  danger:
    "border border-red-500/45 bg-red-500/15 text-red-100 hover:bg-red-500/25 active:scale-[0.98]",
  ghost:
    "border border-white/10 bg-white/[0.04] text-gray-200 hover:bg-white/[0.08] active:scale-[0.98]",
};

export default function Button({
  children,
  variant = "primary",
  className = "",
  loading = false,
  disabled = false,
  type = "button",
  size = "md",
  ...rest
}) {
  const sizes = {
    sm: "min-h-10 px-4 py-2 text-xs rounded-xl",
    md: "min-h-12 px-5 py-3 text-sm rounded-2xl",
    lg: "min-h-14 px-6 py-3.5 text-base rounded-2xl",
  };

  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={`inline-flex w-full items-center justify-center gap-2 transition disabled:cursor-not-allowed disabled:opacity-45 ${variants[variant] || variants.primary} ${sizes[size] || sizes.md} ${className}`}
      {...rest}
    >
      {loading ? (
        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent opacity-80" />
      ) : null}
      {children}
    </button>
  );
}
