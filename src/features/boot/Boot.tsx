import { motion } from "motion/react";
import { AlertTriangle, Check, RotateCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Logo } from "../../components/art/Logo";
import { Button } from "../../components/ui/Button";
import { ProgressBar, Spinner } from "../../components/ui/Feedback";
import { api, errorMessage, parseError } from "../../lib/api";
import { wireEvents } from "../../lib/events";
import { useAccounts, useInstances, useNav, useSettings, type Page } from "../../lib/store";
import "./boot.css";

type Status = "pending" | "running" | "done" | "warn" | "error";
interface Stage {
  label: string;
  status: Status;
  detail?: string;
}

const STAGES = ["Loading your settings", "Checking your account", "Verifying installations", "Syncing the Minecraft version list"];

/**
 * Startup runs real work, stage by stage. The bar reports completed stages —
 * never an invented percentage. Non-critical stages (account, network) can
 * warn and continue so the launcher still opens offline.
 */
export function Boot({ onReady }: { onReady: () => void }) {
  const [stages, setStages] = useState<Stage[]>(STAGES.map((label) => ({ label, status: "pending" })));
  const [fatal, setFatal] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const started = useRef(0);

  const mark = (i: number, status: Status, detail?: string) =>
    setStages((s) => s.map((st, j) => (j === i ? { ...st, status, detail } : st)));

  useEffect(() => {
    let cancelled = false;
    started.current = performance.now();
    setFatal(null);
    setStages(STAGES.map((label) => ({ label, status: "pending" })));

    (async () => {
      try {
        mark(0, "running");
        const settings = await useSettings.getState().load();
        await wireEvents();
        mark(0, "done");
        if (cancelled) return;

        mark(1, "running");
        try {
          await useAccounts.getState().refresh();
          const acc = await api.checkActiveAccount();
          mark(1, acc ? "done" : "warn", acc ? `Signed in as ${acc.name}` : "Not signed in — you can sign in later");
        } catch (e) {
          mark(1, "warn", parseError(e).message);
        }
        if (cancelled) return;

        mark(2, "running");
        await useInstances.getState().refresh();
        const n = useInstances.getState().instances.length;
        mark(2, "done", n === 0 ? "No instances yet" : `${n} instance${n === 1 ? "" : "s"} ready`);
        if (cancelled) return;

        mark(3, "running");
        try {
          const latest = await api.latestRelease();
          mark(3, "done", `Latest release: ${latest}`);
        } catch {
          mark(3, "warn", "Offline — using cached data");
        }

        const start = settings.startupPage as Page;
        if (["home", "library", "discover", "servers", "skins", "performance", "settings"].includes(start)) {
          useNav.setState({ page: start, params: {} });
        }
        // Let the logo finish drawing on very fast machines (≈0.9s total).
        const elapsed = performance.now() - started.current;
        window.setTimeout(() => !cancelled && onReady(), Math.max(0, 900 - elapsed) + 250);
      } catch (e) {
        setFatal(errorMessage(e));
        setStages((s) => s.map((st) => (st.status === "running" ? { ...st, status: "error" } : st)));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const done = stages.filter((s) => s.status === "done" || s.status === "warn").length;

  return (
    <motion.div
      className="boot"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.02, transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] } }}
      data-tauri-drag-region
    >
      <motion.div
        className="boot-card glass"
        initial={{ opacity: 0, y: 18, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 200, damping: 24, delay: 0.05 }}
      >
        <div className="boot-logo">
          <div className="boot-logo-glow" />
          <Logo size={76} reveal />
        </div>
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }}>
          <div className="boot-title">Vitra</div>
          <div className="boot-sub">Minecraft launcher</div>
        </motion.div>

        <ProgressBar value={fatal ? done / STAGES.length : Math.max(0.02, done / STAGES.length)} style={{ width: "100%", marginTop: 26 }} />

        <ul className="boot-stages">
          {stages.map((s, i) => (
            <motion.li
              key={s.label}
              data-status={s.status}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: s.status === "pending" ? 0.45 : 1, x: 0 }}
              transition={{ delay: 0.25 + i * 0.05 }}
            >
              <span className="boot-stage-icon">
                {s.status === "running" && <Spinner size={14} />}
                {s.status === "done" && <Check />}
                {s.status === "warn" && <AlertTriangle />}
                {s.status === "error" && <X />}
                {s.status === "pending" && <span className="boot-dot" />}
              </span>
              <span className="grow">
                {s.label}
                {s.detail && <span className="boot-detail">{s.detail}</span>}
              </span>
            </motion.li>
          ))}
        </ul>

        {fatal && (
          <div className="boot-error">
            <div>{fatal}</div>
            <Button size="sm" icon={<RotateCw />} onClick={() => setAttempt((a) => a + 1)}>
              Try again
            </Button>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
