import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "../../lib/format";

type Variant = "default" | "primary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  iconRight?: ReactNode;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", size = "md", icon, iconRight, loading, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cx("btn", variant !== "default" && `btn--${variant}`, size !== "md" && `btn--${size}`, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="btn-spinner" aria-hidden /> : icon}
      {children}
      {iconRight}
    </button>
  );
});

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: "sm" | "md";
  tipPos?: "top" | "bottom" | "right";
  tip?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = "md", tipPos, tip = true, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      aria-label={label}
      data-tip={tip ? label : undefined}
      data-tip-pos={tipPos}
      className={cx("icon-btn", size === "sm" && "icon-btn--sm", className)}
      {...rest}
    >
      {children}
    </button>
  );
});
