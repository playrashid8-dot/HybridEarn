import type { InputHTMLAttributes } from "react";

export type UiInputProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
  className?: string;
  inputClassName?: string;
};

export default function Input({
  label,
  hint,
  className = "",
  inputClassName = "",
  id,
  ...rest
}: UiInputProps) {
  const inputId =
    id || (label ? String(label).replace(/\s+/g, "-").toLowerCase().slice(0, 48) : undefined);

  return (
    <label className={`flex flex-col gap-2 text-left ${className}`} htmlFor={inputId}>
      {label ? <span className="text-xs font-medium text-gray-400">{label}</span> : null}
      <input
        id={inputId}
        className={`w-full rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm text-white outline-none ring-0 transition placeholder:text-gray-600 focus:border-emerald-500/40 focus:shadow-[0_0_24px_rgba(16,185,129,0.12)] disabled:opacity-45 ${inputClassName}`}
        {...rest}
      />
      {hint ? <span className="text-[10px] text-gray-500">{hint}</span> : null}
    </label>
  );
}
