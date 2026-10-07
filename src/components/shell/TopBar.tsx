import { getCurrentWindow } from "@tauri-apps/api/window";
import { motion } from "motion/react";
import {
  ArrowDownToLine,
  ArrowUpCircle,
  Check,
  Compass,
  Copy,
  Gauge,
  House,
  LayoutGrid,
  LogIn,
  LogOut,
  Minus,
  Plus,
  Server,
  Settings,
  Shirt,
  Square,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import { cx, formatBytes, formatEta } from "../../lib/format";
import { toast, useAccounts, useActiveAccount, useDialogs, useNav, useSettings, useTasks, type Page } from "../../lib/store";
import { useUpdate } from "../../lib/updater";
import { Logo } from "../art/Logo";
import { PlayerHead } from "../art/PlayerHead";
import { IconButton } from "../ui/Button";
import { ProgressBar, ProgressRing } from "../ui/Feedback";
import { Popover } from "../ui/Overlay";

const NAV: { page: Page; label: string; icon: React.ReactNode; match?: Page[] }[] = [
  { page: "home", label: "Home", icon: <House /> },
  { page: "library", label: "Library", icon: <LayoutGrid />, match: ["instance"] },
  { page: "discover", label: "Discover", icon: <Compass /> },
  { page: "servers", label: "Servers", icon: <Server /> },
  { page: "skins", label: "Skins", icon: <Shirt /> },
  { page: "performance", label: "Performance", icon: <Gauge /> },
];

/**
 * The whole app chrome in one floating bar: brand, the main navigation as a
 * liquid-glass pill, activity, settings, account and the window controls.
 */
export function TopBar() {
  return (
    <header className="topbar" data-tauri-drag-region>
      <div className="topbar-side" data-tauri-drag-region>
        <div className="topbar-brand" data-tauri-drag-region>
          <Logo size={20} />
          <span>Vitra</span>
        </div>
      </div>
      <MainNav />
      <div className="topbar-side topbar-side--end" data-tauri-drag-region>
        <UpdatePill />
        <TaskCenter />
        <SettingsButton />
        <AccountButton />
        <span className="topbar-divider" />
        <WindowControls />
      </div>
    </header>
  );
}

function MainNav() {
  const page = useNav((s) => s.page);
  const navigate = useNav((s) => s.navigate);
  return (
    <nav className="topnav glass" aria-label="Main">
      {NAV.map((n) => {
        const active = n.page === page || !!n.match?.includes(page);
        return (
          <button key={n.page} className="topnav-item" aria-current={active ? "page" : undefined} onClick={() => navigate(n.page)} data-tip={n.label} data-tip-pos="bottom">
            {active && <motion.span layoutId="topnav-bubble" className="topnav-bubble" transition={{ type: "spring", stiffness: 520, damping: 40, mass: 0.9 }} />}
            {n.icon}
            <span className="topnav-label">{n.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function UpdatePill() {
  const status = useUpdate((s) => s.status);
  const version = useUpdate((s) => s.update?.version);
  const progress = useUpdate((s) => s.progress);
  const setDialogs = useDialogs((s) => s.set);
  if (!["available", "downloading", "installing"].includes(status)) return null;
  const label = status === "available" ? `Update to ${version}` : status === "installing" ? "Restarting…" : `Updating ${Math.round((progress ?? 0) * 100)}%`;
  return (
    <motion.button
      className="update-pill"
      initial={{ opacity: 0, scale: 0.85, x: 8 }}
      animate={{ opacity: 1, scale: 1, x: 0 }}
      transition={{ type: "spring", stiffness: 420, damping: 28 }}
      onClick={() => setDialogs({ update: true })}
    >
      <ArrowUpCircle />
      <span>{label}</span>
    </motion.button>
  );
}

function SettingsButton() {
  const page = useNav((s) => s.page);
  const navigate = useNav((s) => s.navigate);
  return (
    <button
      className={cx("orb-btn", page === "settings" && "orb-btn--active")}
      aria-label="Settings"
      data-tip="Settings"
      data-tip-pos="bottom"
      onClick={() => navigate("settings")}
    >
      <Settings />
    </button>
  );
}

function WindowControls() {
  const win = getCurrentWindow();
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const sync = () => win.isMaximized().then(setMaximized).catch(() => {});
    sync();
    win.onResized(sync).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, [win]);
  return (
    <div className="win-controls">
      <button className="win-btn" aria-label="Minimize" onClick={() => win.minimize()}>
        <Minus />
      </button>
      <button className="win-btn" aria-label={maximized ? "Restore" : "Maximize"} onClick={() => win.toggleMaximize()}>
        {maximized ? <Copy style={{ transform: "scaleX(-1)", width: 13 }} /> : <Square style={{ width: 12 }} />}
      </button>
      <button className="win-btn win-btn--close" aria-label="Close" onClick={() => win.close()}>
        <X />
      </button>
    </div>
  );
}

function TaskCenter() {
  const tasks = useTasks((s) => s.tasks);
  const dismiss = useTasks((s) => s.dismiss);
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const list = useMemo(
    () =>
      Object.values(tasks)
        .filter((t) => t.kind !== "launch" || t.state === "running")
        .sort((a, b) => (a.state === "running" ? -1 : 1) - (b.state === "running" ? -1 : 1) || b.startedAt - a.startedAt),
    [tasks],
  );
  const running = list.filter((t) => t.state === "running");
  const overall =
    running.length === 1 ? running[0].progress : running.length > 1 ? running.reduce((a, t) => a + (t.progress ?? 0), 0) / running.length : null;

  return (
    <>
      <button
        ref={ref}
        className={cx("orb-btn", running.length > 0 && "orb-btn--busy", open && "orb-btn--active")}
        aria-label={running.length ? `${running.length} in progress` : "Downloads"}
        data-tip={running.length ? `${running.length} in progress` : "Downloads"}
        data-tip-pos="bottom"
        onClick={() => setOpen((o) => !o)}
      >
        {running.length ? <ProgressRing value={overall} size={20} /> : <ArrowDownToLine />}
        {running.length > 1 && <span className="orb-badge">{running.length}</span>}
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={340} align="end">
        <div className="menu-label t-label">Activity</div>
        {list.length === 0 && (
          <div style={{ padding: "18px 12px 20px", color: "var(--text-3)", fontSize: 13 }}>
            Nothing downloading. Installs, mod downloads and backups show up here.
          </div>
        )}
        {list.map((t) => (
          <div key={t.id} className="task-row">
            <div className="row">
              <div className="grow">
                <div className="task-title truncate">{t.title}</div>
                <div className="t-faint truncate" style={{ fontSize: 12 }}>
                  {t.state === "running" ? t.stage : t.state === "done" ? "Completed" : t.state === "cancelled" ? "Cancelled" : t.error}
                </div>
              </div>
              {t.state === "running" ? (
                <IconButton label="Cancel" size="sm" tipPos="bottom" onClick={() => api.cancelTask(t.id)}>
                  <X />
                </IconButton>
              ) : (
                <IconButton label="Dismiss" size="sm" tipPos="bottom" onClick={() => dismiss(t.id)}>
                  {t.state === "done" ? <Check /> : <X />}
                </IconButton>
              )}
            </div>
            {t.state === "running" && (
              <>
                <ProgressBar value={t.progress} style={{ marginTop: 8 }} />
                <div className="task-meta">
                  {t.bytesTotal > 0 && (
                    <span>
                      {formatBytes(t.bytesDone)} / {formatBytes(t.bytesTotal)}
                    </span>
                  )}
                  {t.bytesTotal === 0 && t.filesTotal > 0 && (
                    <span>
                      {t.filesDone} / {t.filesTotal} files
                    </span>
                  )}
                  {t.bytesPerSec > 0 && <span>{formatBytes(t.bytesPerSec)}/s</span>}
                  <span className="spacer" />
                  {formatEta(t.etaSecs) && <span>{formatEta(t.etaSecs)}</span>}
                </div>
              </>
            )}
          </div>
        ))}
      </Popover>
    </>
  );
}

const skinSrc = (url: string | null | undefined) => url?.replace(/^http:\/\//, "https://") ?? null;

function AccountButton() {
  const account = useActiveAccount();
  const accounts = useAccounts((s) => s.accounts);
  const refresh = useAccounts((s) => s.refresh);
  const update = useSettings((s) => s.update);
  const setDialogs = useDialogs((s) => s.set);
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        ref={ref}
        className={cx("account-orb", open && "account-orb--open")}
        aria-label={account ? `Account: ${account.name}` : "Sign in"}
        data-tip={account?.name ?? "Sign in"}
        data-tip-pos="bottom"
        onClick={() => setOpen((o) => !o)}
      >
        <PlayerHead src={skinSrc(account?.skinUrl)} size={28} radius={9} />
        <span className={cx("account-orb-dot", account && "account-orb-dot--on")} />
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={270} align="end">
        <div className="account-card">
          <PlayerHead src={skinSrc(account?.skinUrl)} size={40} radius={10} />
          <div className="grow">
            <div className="truncate" style={{ fontWeight: 650 }}>
              {account?.name ?? "Not signed in"}
            </div>
            <div className="t-faint truncate" style={{ fontSize: 12 }}>
              {account ? (account.ownsGame ? "Microsoft account" : "Demo access") : "Sign in to play online"}
            </div>
          </div>
        </div>
        {accounts.length > 1 && <div className="menu-label t-label">Switch account</div>}
        {accounts.length > 1 &&
          accounts.map((a) => (
            <button
              key={a.uuid}
              className="menu-item"
              aria-selected={a.uuid === account?.uuid}
              onClick={async () => {
                await api.setActiveAccount(a.uuid);
                update({ activeAccount: a.uuid });
                setOpen(false);
              }}
            >
              <PlayerHead src={skinSrc(a.skinUrl)} size={22} radius={5} />
              <span className="grow truncate">{a.name}</span>
              {a.uuid === account?.uuid && <Check className="menu-check" />}
            </button>
          ))}
        <div className="menu-sep" />
        <button
          className="menu-item"
          onClick={() => {
            setOpen(false);
            setDialogs({ signIn: true });
          }}
        >
          {accounts.length ? <Plus /> : <LogIn />}
          {accounts.length ? "Add another account" : "Sign in with Microsoft"}
        </button>
        {account && (
          <button
            className="menu-item menu-item--danger"
            onClick={async () => {
              setOpen(false);
              try {
                await api.removeAccount(account.uuid);
                await refresh();
                toast.info(`Signed out ${account.name}`);
              } catch (e) {
                toast.error("Couldn't sign out", errorMessage(e));
              }
            }}
          >
            <LogOut />
            Sign out
          </button>
        )}
      </Popover>
    </>
  );
}
