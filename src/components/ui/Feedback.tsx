import { motion } from "motion/react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { useId, type CSSProperties, type ReactNode } from "react";
import { cx } from "../../lib/format";

export function ProgressBar({ value, thin, style }: { value: number | null; thin?: boolean; style?: CSSProperties }) {
  const indeterminate = value == null;
  return (
    <div
      className={cx("progress", indeterminate && "progress--indeterminate", thin && "progress--thin")}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(value * 100)}
      style={style}
    >
      <div className="progress-fill" style={indeterminate ? undefined : { transform: `scaleX(${Math.max(0.005, value)})` }} />
    </div>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />;
}

export function Skeleton({ w, h = 14, r, style }: { w?: number | string; h?: number | string; r?: number; style?: CSSProperties }) {
  return <div className="skeleton" style={{ width: w ?? "100%", height: h, borderRadius: r, ...style }} />;
}

export function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

export function Notice({
  tone = "info",
  children,
  style,
}: {
  tone?: "info" | "warning" | "danger" | "success";
  children: ReactNode;
  style?: CSSProperties;
}) {
  const Icon = tone === "warning" ? AlertTriangle : tone === "danger" ? XCircle : tone === "success" ? CheckCircle2 : Info;
  return (
    <div className={cx("notice", tone !== "info" && `notice--${tone}`)} style={style}>
      <Icon />
      <div className="grow">{children}</div>
    </div>
  );
}

export interface TabItem<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
  count?: number;
}

export function Tabs<T extends string>({
  items,
  value,
  onChange,
  style,
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (v: T) => void;
  style?: CSSProperties;
}) {
  const id = useId();
  return (
    <div className="tabs" role="tablist" style={style}>
      {items.map((t) => (
        <button key={t.id} role="tab" aria-selected={t.id === value} onClick={() => onChange(t.id)}>
          {t.icon}
          {t.label}
          {t.count != null && <span className="tab-count">{t.count}</span>}
          {t.id === value && (
            <motion.span layoutId={`tab-${id}`} className="tab-indicator" transition={{ type: "spring", stiffness: 500, damping: 40 }} />
          )}
        </button>
      ))}
    </div>
  );
}

export function ProgressRing({ value, size = 22, stroke = 2.5 }: { value: number | null; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flex: "none" }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.2} strokeWidth={stroke} />
      {value == null ? (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${c * 0.28} ${c}`}
          style={{ transformOrigin: "center", animation: "spin 0.9s linear infinite" }}
        />
      ) : (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - Math.min(1, Math.max(0, value)))}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: "stroke-dashoffset var(--d-3) var(--ease-out)" }}
        />
      )}
    </svg>
  );
}
