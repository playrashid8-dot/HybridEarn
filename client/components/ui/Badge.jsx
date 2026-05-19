const styles = {
  pending: "border-yellow-500/40 bg-yellow-500/15 text-yellow-100",
  approved: "border-blue-500/35 bg-blue-500/12 text-blue-100",
  rejected: "border-red-500/35 bg-red-500/12 text-red-100",
  completed: "border-emerald-500/35 bg-emerald-500/12 text-emerald-100",
};

export default function Badge({ variant = "pending", children, className = "" }) {
  const v = styles[variant] || styles.pending;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${v} ${className}`}
    >
      {children}
    </span>
  );
}
