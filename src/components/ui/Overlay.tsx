import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/format";
import { IconButton } from "./Button";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  iconTone?: "accent" | "danger" | "warning";
  size?: "md" | "wide" | "xl";
  footer?: ReactNode;
  dismissable?: boolean;
  children?: ReactNode;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  icon,
  iconTone = "accent",
  size = "md",
  footer,
  dismissable = true,
  children,
}: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissable) onClose();
    };
    window.addEventListener("keydown", onKey);
    const t = window.setTimeout(() => {
      const el = ref.current?.querySelector<HTMLElement>("[data-autofocus], input, button:not([data-modal-close])");
      el?.focus();
    }, 60);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
    };
  }, [open, dismissable, onClose]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="modal-scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget && dismissable) onClose();
          }}
        >
          <motion.div
            ref={ref}
            role="dialog"
            aria-modal="true"
            className={cx("modal glass", size !== "md" && `modal--${size}`)}
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 6 }}
            transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.8 }}
          >
            {(title || icon) && (
              <div className="modal-head">
                {icon && <div className={cx("modal-icon", iconTone !== "accent" && `modal-icon--${iconTone}`)}>{icon}</div>}
                <div className="grow">
                  {title && <h2>{title}</h2>}
                  {description && <p>{description}</p>}
                </div>
                {dismissable && (
                  <IconButton label="Close" tip={false} onClick={onClose} data-modal-close>
                    <X />
                  </IconButton>
                )}
              </div>
            )}
            {children && <div className="modal-body">{children}</div>}
            {footer && <div className="modal-foot">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

interface PopoverProps {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  align?: "start" | "end";
  width?: number | "anchor";
  className?: string;
  children: ReactNode;
}

export function Popover({ anchor, open, onClose, align = "start", width, className, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width?: number; maxHeight: number; up: boolean } | null>(null);

  const place = useCallback(() => {
    const a = anchor.current;
    if (!a) return;
    const r = a.getBoundingClientRect();
    const w = width === "anchor" ? r.width : width;
    const vh = window.innerHeight;
    const below = vh - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 220 && above > below;
    const maxHeight = Math.min(360, Math.max(120, up ? above : below));
    const popW = w ?? 220;
    let left = align === "end" ? r.right - popW : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - popW - 8));
    setPos({ top: up ? r.top - 6 : r.bottom + 6, left, width: w, maxHeight, up });
  }, [anchor, align, width]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
    };
  }, [open, onClose, anchor, place]);

  return createPortal(
    <AnimatePresence>
      {open && pos && (
        <motion.div
          ref={ref}
          className={cx("popover glass", className)}
          style={{
            top: pos.up ? undefined : pos.top,
            bottom: pos.up ? window.innerHeight - pos.top : undefined,
            left: pos.left,
            width: pos.width,
            maxHeight: pos.maxHeight,
            transformOrigin: pos.up ? "bottom" : "top",
          }}
          initial={{ opacity: 0, scale: 0.97, y: pos.up ? 4 : -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
          transition={{ type: "spring", stiffness: 520, damping: 36 }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
}

export function Menu({
  trigger,
  items,
  align = "end",
}: {
  trigger: (props: { ref: RefObject<HTMLButtonElement | null>; onClick: () => void; open: boolean }) => ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      {trigger({ ref, onClick: () => setOpen((o) => !o), open })}
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} align={align} width={210}>
        {items.map((item, i) => (
          <div key={i}>
            {item.separatorBefore && <div className="menu-sep" />}
            <button
              className={cx("menu-item", item.danger && "menu-item--danger")}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.icon}
              {item.label}
            </button>
          </div>
        ))}
      </Popover>
    </>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  danger,
  icon,
  onConfirm,
  onClose,
  busy,
  children,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  icon?: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
  busy?: boolean;
  children?: ReactNode;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      icon={icon}
      iconTone={danger ? "danger" : "accent"}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button className={cx("btn", danger ? "btn--danger" : "btn--primary")} onClick={onConfirm} disabled={busy} data-autofocus>
            {busy && <span className="btn-spinner" />}
            {confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
