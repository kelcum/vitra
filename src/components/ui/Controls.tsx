import { motion } from "motion/react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { cx } from "../../lib/format";
import { Popover } from "./Overlay";

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="toggle"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  onCommit,
  format,
  disabled,
  label,
  width,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  format?: (v: number) => string;
  disabled?: boolean;
  label?: string;
  width?: number;
}) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <div className="slider-row" style={{ width }}>
      <div className="slider" style={{ ["--pct" as string]: `${pct}%` }}>
        <input
          type="range"
          aria-label={label}
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
          onPointerUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
        />
      </div>
      {format && <span className="slider-value">{format(value)}</span>}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size,
}: {
  value: T;
  options: { value: T; label: string; icon?: ReactNode }[];
  onChange: (v: T) => void;
  size?: "sm";
}) {
  const id = useId();
  return (
    <div className="segmented" role="group" style={size === "sm" ? { fontSize: 12 } : undefined}>
      {options.map((o) => (
        <button key={o.value} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.value === value && (
            <motion.span
              layoutId={`seg-${id}`}
              className="segmented-pill"
              transition={{ type: "spring", stiffness: 500, damping: 38 }}
            />
          )}
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "size"> {
  value: string;
  onChange: (v: string) => void;
  icon?: ReactNode;
  size?: "md" | "lg";
  trailing?: ReactNode;
}

export function TextInput({ value, onChange, icon, size = "md", trailing, className, style, ...rest }: TextInputProps) {
  return (
    <label className={cx("field-input", size === "lg" && "field-input--lg", className)} style={style}>
      {icon}
      <input value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} {...rest} />
      {trailing}
    </label>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = "Search",
  size,
  autoFocus,
  style,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  size?: "md" | "lg";
  autoFocus?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <TextInput
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      icon={<Search />}
      size={size}
      autoFocus={autoFocus}
      style={style}
      trailing={
        value ? (
          <button className="icon-btn icon-btn--sm" aria-label="Clear search" onClick={() => onChange("")}>
            <X />
          </button>
        ) : null
      }
    />
  );
}

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  description?: string;
  icon?: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  placeholder = "Select…",
  searchable,
  size,
  width,
  disabled,
  label,
  renderValue,
}: {
  value: T | null;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  placeholder?: string;
  searchable?: boolean;
  size?: "sm" | "md";
  width?: number | string;
  disabled?: boolean;
  label?: string;
  renderValue?: (o: SelectOption<T>) => ReactNode;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const selected = options.find((o) => o.value === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const choose = (o: SelectOption<T>) => {
    if (o.disabled) return;
    onChange(o.value);
    setOpen(false);
    ref.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(filtered.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = filtered[active];
      if (o) choose(o);
    }
  };

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={cx("select-trigger", size === "sm" && "select-trigger--sm")}
        style={{ width }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKey}
      >
        {selected?.icon}
        <span className="grow truncate" style={{ color: selected ? undefined : "var(--text-3)" }}>
          {selected ? (renderValue ? renderValue(selected) : selected.label) : placeholder}
        </span>
        <ChevronDown />
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width="anchor">
        <div onKeyDown={onKey} style={{ minWidth: 200 }}>
          {searchable && (
            <div style={{ padding: "2px 2px 6px" }}>
              <SearchInput value={query} onChange={(q) => (setQuery(q), setActive(0))} placeholder="Filter" autoFocus />
            </div>
          )}
          <div ref={listRef} role="listbox">
            {filtered.length === 0 && <div className="menu-label t-faint">No matches</div>}
            {filtered.map((o, i) => (
              <button
                key={o.value}
                role="option"
                data-index={i}
                aria-selected={o.value === value}
                data-active={i === active}
                className="menu-item"
                disabled={o.disabled}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(o)}
              >
                {o.icon}
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="truncate" style={{ display: "block" }}>
                    {o.label}
                  </span>
                  {o.description && (
                    <span className="t-faint truncate" style={{ display: "block", fontSize: 12 }}>
                      {o.description}
                    </span>
                  )}
                </span>
                {o.badge}
                {o.value === value && <Check className="menu-check" />}
              </button>
            ))}
          </div>
        </div>
      </Popover>
    </>
  );
}

export function Field({
  label,
  description,
  children,
  stack,
}: {
  label: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  stack?: boolean;
}) {
  return (
    <div className={cx("field", stack && "field--stack")}>
      <div className="field-text">
        <div className="field-label">{label}</div>
        {description && <div className="field-desc">{description}</div>}
      </div>
      <div className="field-control">{children}</div>
    </div>
  );
}
