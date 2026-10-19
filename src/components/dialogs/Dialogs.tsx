import { AnimatePresence, motion } from "motion/react";
import { UpdateDialog } from "./UpdateDialog";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  FolderOpen,
  Gamepad2,
  Info,
  LogIn,
  PackagePlus,
  ScrollText,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import { formatBytes, formatDuration } from "../../lib/format";
import { play } from "../../lib/launch";
import { toast, useDialogs, useInstances, useNav, useToasts } from "../../lib/store";
import { Button } from "../ui/Button";
import { Notice } from "../ui/Feedback";
import { Modal } from "../ui/Overlay";
import { CreateInstanceDialog } from "./CreateInstanceDialog";
import { SignInDialog } from "./SignInDialog";
import "./dialogs.css";

export function Dialogs() {
  return (
    <>
      <SignInDialog />
      <CreateInstanceDialog />
      <PlanDialog />
      <CrashDialog />
      <DemoPrompt />
      <UpdateDialog />
      <Toasts />
    </>
  );
}

function PlanDialog() {
  const plan = useDialogs((s) => s.plan);
  const set = useDialogs((s) => s.set);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setAck(false), [plan]);
  if (!plan) return <Modal open={false} onClose={() => {}} />;
  const p = plan.plan;
  const total = p.files.reduce((a, f) => a + f.size, 0);
  const nothing = p.files.length === 0;

  const confirm = async () => {
    setBusy(true);
    try {
      await api.applyPlan(p);
      set({ plan: null });
    } catch (e) {
      toast.error("Couldn't start the install", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => set({ plan: null })}
      icon={<PackagePlus />}
      title={plan.title}
      description={nothing ? undefined : `${p.files.length} file${p.files.length === 1 ? "" : "s"} · ${formatBytes(total)}`}
      footer={
        <>
          <Button variant="ghost" onClick={() => set({ plan: null })}>
            {nothing ? "Close" : "Cancel"}
          </Button>
          {!nothing && (
            <Button variant="primary" loading={busy} disabled={p.conflicts.length > 0 && !ack} onClick={confirm}>
              Install
            </Button>
          )}
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        {p.conflicts.map((c, i) => (
          <Notice key={`c${i}`} tone="danger">
            {c}
          </Notice>
        ))}
        {p.conflicts.length > 0 && (
          <label className="row" style={{ gap: 10, fontSize: 13 }}>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            I understand — install anyway
          </label>
        )}
        {p.warnings.map((w, i) => (
          <Notice key={`w${i}`} tone="warning">
            {w}
          </Notice>
        ))}
        {p.skipped.map((s, i) => (
          <Notice key={`s${i}`}>{s}</Notice>
        ))}
        {!nothing && (
          <div className="plan-list glass-inset">
            {p.files.map((f) => (
              <div key={f.projectId} className="plan-row">
                {f.iconUrl ? <img src={f.iconUrl} alt="" /> : <div className="plan-icon-fallback" />}
                <div className="grow">
                  <div className="truncate" style={{ fontWeight: 600 }}>
                    {f.title}
                  </div>
                  <div className="t-faint truncate" style={{ fontSize: 12 }}>
                    {f.versionNumber} · {formatBytes(f.size)}
                  </div>
                </div>
                <span className={`chip ${f.reason === "requested" ? "chip--accent" : f.reason === "update" ? "chip--success" : ""}`}>
                  {f.reason === "requested" ? "Selected" : f.reason === "update" ? "Update" : `Needed by ${f.requiredBy ?? "a mod"}`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

function diagnose(text: string): string[] {
  const hints: string[] = [];
  const t = text.toLowerCase();
  if (t.includes("unrecognized vm option") || t.includes("could not create the java virtual machine") && !t.includes("reserve enough space"))
    hints.push("Java rejected one of the launch arguments. Check the instance's extra JVM arguments, or switch the garbage collector preset back to Balanced — some flags only exist in certain Java versions.");
  if (t.includes("could not reserve enough space") || t.includes("outofmemoryerror") || t.includes("java heap space"))
    hints.push("Minecraft ran out of memory or couldn't get the memory it asked for. Adjust the memory slider in the instance's settings (more for big modpacks, less if the computer is low on RAM).");
  if (t.includes("unsupported class file major version"))
    hints.push("The mod loader (or a mod) is too old to read this Minecraft version's code. Update the loader in the instance's settings, or use Fabric for the newest Minecraft versions.");
  if (t.includes("unsupportedclassversionerror") || t.includes("has been compiled by a more recent version of the java runtime"))
    hints.push("A mod or the game needs a newer Java version. Set the instance's Java to Automatic so Vitra picks the right runtime.");
  if (t.includes("modresolutionexception") || t.includes("incompatible mod set") || t.includes("requires") && t.includes("mod"))
    hints.push("Some mods have missing or conflicting dependencies. Open the Mods tab — Vitra can check for updates and missing requirements.");
  if (t.includes("mixin") && (t.includes("failed") || t.includes("error")))
    hints.push("A mod failed to patch the game (Mixin error). This usually means two mods conflict or a mod is for a different Minecraft version.");
  if (t.includes("pixel format not accelerated") || t.includes("glfw error") || t.includes("opengl"))
    hints.push("The graphics driver couldn't start OpenGL. Updating your GPU driver usually fixes this.");
  if (t.includes("exit code: -1073740791") || t.includes("access_violation") || t.includes("exception_access_violation"))
    hints.push("Java crashed in native code — often a graphics driver or overlay (Discord, RivaTuner) issue.");
  return hints;
}

function CrashDialog() {
  const crash = useDialogs((s) => s.crash);
  const set = useDialogs((s) => s.set);
  const navigate = useNav((s) => s.navigate);
  const instances = useInstances((s) => s.instances);
  const [report, setReport] = useState<string | null>(null);
  useEffect(() => {
    setReport(null);
    if (crash?.crashReport) api.readCrashReport(crash.crashReport).then(setReport).catch(() => setReport(null));
  }, [crash]);
  const text = useMemo(() => (report ?? "") + "\n" + (crash?.tail ?? []).join("\n"), [report, crash]);
  const hints = useMemo(() => diagnose(text + `\nexit code: ${crash?.code ?? ""}`), [text, crash]);
  if (!crash) return <Modal open={false} onClose={() => {}} />;
  const inst = instances.find((i) => i.id === crash.instanceId);
  const excerpt = report
    ? report.split("\n").slice(0, 40).join("\n")
    : crash.tail.length
      ? crash.tail.join("\n")
      : "The game closed without writing any output.";

  return (
    <Modal
      open
      onClose={() => set({ crash: null })}
      icon={<XCircle />}
      iconTone="danger"
      size="wide"
      title={`${inst?.name ?? "Minecraft"} crashed`}
      description={`Exit code ${crash.code ?? "unknown"} after ${formatDuration(crash.playedSecs)}.`}
      footer={
        <>
          {crash.crashReport && (
            <Button
              variant="ghost"
              icon={<FolderOpen />}
              onClick={() => api.openInstanceFolder(crash.instanceId, "crash-reports")}
              style={{ marginRight: "auto" }}
            >
              Crash reports folder
            </Button>
          )}
          <Button
            variant="ghost"
            icon={<Copy />}
            onClick={() => {
              navigator.clipboard.writeText(report ?? crash.tail.join("\n"));
              toast.success("Copied to clipboard");
            }}
          >
            Copy
          </Button>
          <Button
            icon={<ScrollText />}
            onClick={() => {
              set({ crash: null });
              navigate("instance", { id: crash.instanceId, tab: "logs" });
            }}
          >
            View logs
          </Button>
          <Button variant="primary" icon={<Gamepad2 />} onClick={() => (set({ crash: null }), play(crash.instanceId))}>
            Try again
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        {hints.map((h, i) => (
          <Notice key={i} tone="warning">
            {h}
          </Notice>
        ))}
        <pre className="crash-log selectable">{excerpt}</pre>
      </div>
    </Modal>
  );
}

function DemoPrompt() {
  const prompt = useDialogs((s) => s.demoPrompt);
  const set = useDialogs((s) => s.set);
  return (
    <Modal
      open={!!prompt}
      onClose={() => set({ demoPrompt: null })}
      icon={<LogIn />}
      title="Sign in to play"
      description={prompt?.reason}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              const p = prompt;
              set({ demoPrompt: null });
              if (p) play(p.instanceId, { world: p.world, demo: true });
            }}
          >
            Play the demo
          </Button>
          <Button variant="primary" icon={<LogIn />} onClick={() => set({ demoPrompt: null, signIn: true })}>
            Sign in with Microsoft
          </Button>
        </>
      }
    >
      <p className="t-muted" style={{ margin: 0 }}>
        {prompt?.server
          ? `Joining ${prompt.server} needs a Microsoft account that owns Minecraft: Java Edition. The free demo can only play its own single-player world.`
          : "Minecraft: Java Edition requires a Microsoft account that owns the game. Without one you can still try the official demo — a 100-minute world with the full game otherwise intact."}
      </p>
    </Modal>
  );
}

function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div className="toasts" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const Icon = t.kind === "success" ? CheckCircle2 : t.kind === "error" ? XCircle : t.kind === "warning" ? AlertTriangle : Info;
          return (
            <motion.div
              key={t.id}
              layout
              className={`toast glass toast--${t.kind}`}
              initial={{ opacity: 0, x: 40, scale: 0.96 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, scale: 0.96, transition: { duration: 0.18 } }}
              transition={{ type: "spring", stiffness: 420, damping: 32 }}
              onClick={() => dismiss(t.id)}
            >
              <Icon className="toast-icon" />
              <div className="grow">
                <div className="toast-title">{t.title}</div>
                {t.body && <div className="toast-body">{t.body}</div>}
                {t.action && (
                  <button
                    className="toast-action"
                    onClick={(e) => {
                      e.stopPropagation();
                      t.action?.run();
                      dismiss(t.id);
                    }}
                  >
                    {t.action.label}
                  </button>
                )}
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
