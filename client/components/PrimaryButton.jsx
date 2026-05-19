"use client";

export default function PrimaryButton({
  loading,
  children,
  className = "",
  disabled = false,
  type = "button",
  ...props
}) {
  return (
    <button
      {...props}
      type={type}
      disabled={disabled || loading}
      className={`w-full rounded-xl p-3 bg-indigo-600 hover:bg-indigo-500 transition duration-200 disabled:pointer-events-none disabled:opacity-50 shadow-lg hover:shadow-xl ${className}`}
    >
      {loading ? "Processing..." : children}
    </button>
  );
}
