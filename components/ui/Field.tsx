"use client";
import { forwardRef } from "react";

export const inputCls = "h-12 w-full rounded-[14px] border border-line bg-surface px-3.5 text-[16px] text-ink placeholder:text-muted/70 outline-none focus:border-accent focus:ring-2 focus:ring-accent/25 transition-[box-shadow,border-color] duration-100";

export function Label({ htmlFor, children, hint }: { htmlFor: string; children: React.ReactNode; hint?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 flex items-baseline justify-between text-[14px] font-medium text-ink">
      <span>{children}</span>
      {hint && <span className="text-[12px] font-normal text-muted">{hint}</span>}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input({ className = "", ...p }, ref) {
  return <input ref={ref} {...p} className={`${inputCls} ${className}`} />;
});

export function Button({ variant = "primary", size = "md", className = "", ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "md" | "sm" | "chip" }) {
  const v = {
    primary: "bg-ink text-white font-semibold hover:bg-ink-2 shadow-[var(--shadow-1)]",
    secondary: "bg-surface text-ink border border-line hover:bg-sunken font-medium",
    ghost: "text-accent font-medium hover:bg-accent-tint",
    danger: "text-danger font-medium hover:bg-danger/5",
  }[variant];
  const s = { md: "h-12 px-6 rounded-full text-[15px]", sm: "h-10 px-4 rounded-full text-[14px]", chip: "h-9 px-3.5 rounded-full text-[14px]" }[size];
  return <button {...p} className={`inline-flex items-center justify-center gap-2 transition-[background-color,transform] duration-100 active:scale-[.98] ${v} ${s} ${className}`} />;
}

export function Toast({ text, action }: { text: string | null; action?: { label: string; onClick: () => void } | null }) {
  return (
    <div aria-live="polite" className={`pointer-events-none fixed inset-x-0 bottom-6 z-[100] flex justify-center px-4 transition-opacity duration-150 ${text ? "opacity-100" : "opacity-0"}`}>
      {text && (
        <div className={`flex max-w-[min(92vw,520px)] items-center gap-3 rounded-full bg-ink py-2.5 text-[14px] text-white shadow-[var(--shadow-2)] ${action ? "pointer-events-auto pl-5 pr-2" : "px-5"}`}>
          <span className="min-w-0">{text}</span>
          {action && <button onClick={action.onClick} className="h-8 shrink-0 rounded-full bg-lime px-3.5 text-[13px] font-semibold text-ink">{action.label}</button>}
        </div>
      )}
    </div>
  );
}
