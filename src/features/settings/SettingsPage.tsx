import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { checkForUpdates, useUpdate } from "../../lib/updater";
import { motion } from "motion/react";
import {
  Bell,
  Coffee,
  FolderOpen,
  Gamepad2,
  HardDrive,
  Info,
  KeyRound,
  LogOut,
  Palette,
  RotateCcw,
  Rocket,
  Trash2,
  UserRound,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Logo } from "../../components/art/Logo";
import { PlayerHead } from "../../components/art/PlayerHead";
import { Button } from "../../components/ui/Button";
import { Field, Segmented, Select, Slider, TextInput, Toggle } from "../../components/ui/Controls";
import { Notice, Skeleton } from "../../components/ui/Feedback";
import { ConfirmDialog } from "../../components/ui/Overlay";
import { api, errorMessage } from "../../lib/api";
import { ACCENTS, AUTO_ACCENT, resolvedAccent } from "../../lib/appearance";
import { cx, formatMb, LOADER_LABEL } from "../../lib/format";
import { forgetAccountData } from "../../lib/cache";
import { toast, useAccounts, useActiveAccount, useDialogs, useInstances, useSettings } from "../../lib/store";
import type { Background, GameVersion, JavaInstall, Loader, Settings, StorageInfo } from "../../lib/types";
import "./settings.css";

type Section = "appearance" | "launcher" | "game" | "java" | "storage" | "accounts" | "notifications" | "about";

const SECTIONS: { id: Section; label: string; icon: React.ReactNode }[] = [
  { id: "appearance", label: "Appearance", icon: <Palette /> },
  { id: "launcher", label: "Launcher", icon: <Rocket /> },
  { id: "game", label: "Game defaults", icon: <Gamepad2 /> },
  { id: "java", label: "Java", icon: <Coffee /> },
  { id: "storage", label: "Downloads & storage", icon: <HardDrive /> },
  { id: "accounts", label: "Accounts", icon: <UserRound /> },
  { id: "notifications", label: "Notifications", icon: <Bell /> },
  { id: "about", label: "About", icon: <Info /> },
];

export default function SettingsPage({ initialSection }: { initialSection?: string }) {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const [section, setSection] = useState<Section>((initialSection as Section) ?? "appearance");
  if (!settings) return null;

  return (
    <div className="page-inner">
      <div className="page-head">
        <div className="grow">
          <h1 className="t-title">Settings</h1>
          <p>Changes save automatically.</p>
        </div>
      </div>
      <div className="settings-layout">
        <nav className="glass settings-nav">
          {SECTIONS.map((s) => (
            <button key={s.id} className="nav-item" aria-current={section === s.id ? "page" : undefined} onClick={() => setSection(s.id)}>
              <span className="nav-hover" />
              {section === s.id && <motion.span layoutId="settings-active" className="nav-active" transition={{ type: "spring", stiffness: 480, damping: 38 }} />}
              {s.icon}
              {s.label}
            </button>
          ))}
        </nav>
        <motion.div key={section} className="glass settings-panel" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ type: "spring", stiffness: 380, damping: 34 }}>
          {section === "appearance" && <Appearance s={settings} update={update} />}
          {section === "launcher" && <Launcher s={settings} update={update} />}
          {section === "game" && <GameDefaults s={settings} update={update} />}
          {section === "java" && <JavaSection />}
          {section === "storage" && <Storage s={settings} update={update} />}
          {section === "accounts" && <Accounts s={settings} update={update} />}
          {section === "notifications" && <Notifications s={settings} update={update} />}
          {section === "about" && <About />}
        </motion.div>
      </div>
    </div>
  );
}

type SectionProps = { s: Settings; update: (p: Partial<Settings>) => void };

function Appearance({ s, update }: SectionProps) {
  const setBg = (patch: Partial<Background>) => update({ background: { ...s.background, ...patch } });
  const [panoramaOk, setPanoramaOk] = useState<boolean | null>(null);
  useEffect(() => {
    api.panorama().then(() => setPanoramaOk(true)).catch(() => setPanoramaOk(false));
  }, []);

  const backgrounds: { kind: Background["kind"]; label: string; desc: string; disabled?: boolean }[] = [
    { kind: "liquid", label: "Liquid", desc: "Your latest screenshot, melted into color" },
    { kind: "aurora", label: "Aurora", desc: "Built-in animated art" },
    { kind: "panorama", label: "Title panorama", desc: panoramaOk === false ? "Install a version first" : "From your installed game", disabled: panoramaOk === false },
    { kind: "screenshot", label: "Latest screenshot", desc: "Your most recent in-game shot" },
    { kind: "image", label: "Custom image", desc: s.background.kind === "image" && s.background.value ? "Click to change" : "PNG, JPG or WebP" },
  ];

  return (
    <>
      <h2 className="settings-title">Appearance</h2>
      <Field label="Theme">
        <Segmented
          value={s.theme}
          onChange={(theme) => update({ theme })}
          options={[
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
            { value: "system", label: "System" },
          ]}
        />
      </Field>
      <Field label="Accent color">
        <div className="accent-row">
          <button
            className="accent-swatch accent-auto"
            aria-pressed={s.accent === AUTO_ACCENT}
            aria-label="Match background"
            data-tip="Match background"
            onClick={() => update({ accent: AUTO_ACCENT })}
          />
          {ACCENTS.map((a) => (
            <button
              key={a.value}
              className="accent-swatch"
              style={{ background: a.value }}
              aria-pressed={s.accent.toLowerCase() === a.value}
              aria-label={a.name}
              data-tip={a.name}
              onClick={() => update({ accent: a.value })}
            />
          ))}
          <label className="accent-swatch accent-custom" data-tip="Custom" style={{ background: resolvedAccent(s) }}>
            <input type="color" value={resolvedAccent(s)} onChange={(e) => update({ accent: e.target.value })} />
          </label>
        </div>
      </Field>

      <div className="settings-sub">Liquid glass</div>
      <div className="glass-preview">
        <div className="glass glass-preview-card">
          <div style={{ fontWeight: 650 }}>Preview</div>
          <div className="t-muted" style={{ fontSize: 12.5 }}>Text stays readable at every setting.</div>
        </div>
      </div>
      <Field stack label="Glass intensity" description="Highlights, edge light and color saturation.">
        <Slider value={s.glassIntensity} min={0} max={1} step={0.01} onChange={(v) => update({ glassIntensity: v })} format={(v) => `${Math.round(v * 100)}%`} />
      </Field>
      <Field stack label="Blur" description="Lower blur is lighter on the GPU. Panels automatically become more opaque to stay readable.">
        <Slider value={s.blur} min={0} max={60} onChange={(v) => update({ blur: v })} format={(v) => `${v}px`} />
      </Field>
      <Field stack label="Transparency">
        <Slider value={s.transparency} min={0.15} max={0.95} step={0.01} onChange={(v) => update({ transparency: v })} format={(v) => `${Math.round(v * 100)}%`} />
      </Field>

      <div className="settings-sub">Background</div>
      <div className="bg-options">
        {backgrounds.map((b) => (
          <button
            key={b.kind}
            className={cx("bg-option", s.background.kind === b.kind && "bg-option--active")}
            disabled={b.disabled}
            onClick={async () => {
              if (b.kind === "image") {
                const file = await openDialog({ filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }] });
                if (!file) return;
                try {
                  const stored = await api.importBackground(file as string);
                  setBg({ kind: "image", value: stored });
                } catch (e) {
                  toast.error("Couldn't use that image", errorMessage(e));
                }
              } else setBg({ kind: b.kind });
            }}
          >
            <span className={`bg-thumb bg-thumb--${b.kind}`} />
            <span className="bg-option-label">{b.label}</span>
            <span className="bg-option-desc">{b.desc}</span>
          </button>
        ))}
      </div>
      <Field stack label="Background dimming">
        <Slider value={s.background.dim} min={0} max={0.9} step={0.01} onChange={(v) => setBg({ dim: v })} format={(v) => `${Math.round(v * 100)}%`} />
      </Field>

      <div className="settings-sub">Motion & scale</div>
      <Field label="Animations" description="Reduced keeps essential transitions short; Off disables them completely. Follows your system's reduced-motion setting too.">
        <Segmented
          value={s.motion}
          onChange={(motion) => update({ motion })}
          options={[
            { value: "full", label: "Full" },
            { value: "reduced", label: "Reduced" },
            { value: "off", label: "Off" },
          ]}
        />
      </Field>
      <Field label="Ambient effects" description="Drifting light and particles in the background. Always paused while you play.">
        <Toggle checked={s.ambientEffects} onChange={(v) => update({ ambientEffects: v })} />
      </Field>
      <Field stack label="Interface scale">
        <Slider value={s.uiScale} min={0.8} max={1.4} step={0.05} onChange={(v) => update({ uiScale: v })} format={(v) => `${Math.round(v * 100)}%`} />
      </Field>
    </>
  );
}

function Launcher({ s, update }: SectionProps) {
  return (
    <>
      <h2 className="settings-title">Launcher</h2>
      <Field label="Open on" description="The page shown when Vitra starts.">
        <Select
          value={s.startupPage}
          onChange={(startupPage) => update({ startupPage })}
          width={200}
          options={[
            { value: "home", label: "Home" },
            { value: "library", label: "Library" },
            { value: "discover", label: "Discover" },
            { value: "servers", label: "Servers" },
            { value: "skins", label: "Skins" },
          ]}
        />
      </Field>
      <Field label="When the game starts" description="Minimizing frees the GPU from drawing the launcher while you play.">
        <Select
          value={s.onGameLaunch}
          onChange={(onGameLaunch) => update({ onGameLaunch })}
          width={200}
          options={[
            { value: "minimize", label: "Minimize Vitra" },
            { value: "hide", label: "Hide Vitra" },
            { value: "keep", label: "Keep Vitra open" },
          ]}
        />
      </Field>
      <Field label="Bring Vitra back when the game closes">
        <Toggle checked={s.reopenOnExit} onChange={(v) => update({ reopenOnExit: v })} disabled={s.onGameLaunch === "keep"} />
      </Field>
      <Field label="Show Minecraft updates on Home" description="Official Java Edition patch notes from Mojang.">
        <Toggle checked={s.showNews} onChange={(v) => update({ showNews: v })} />
      </Field>
      <Field
        label="Vitra badges and capes"
        description={
          <>
            In Fabric 26.3 instances, shows the Vitra badge next to players using Vitra and everyone's Vitra capes, and
            yours to them. Uses Vitra's server, api.xan.gripe: it gets your player name and UUID, and while you play,
            that you're on Vitra and the UUIDs of players around you.{" "}
            <a
              href="https://xan.gripe/vitra/privacy/"
              onClick={(e) => {
                e.preventDefault();
                api.openUrl("https://xan.gripe/vitra/privacy/");
              }}
            >
              Privacy
            </a>
          </>
        }
      >
        <Toggle checked={s.cosmetics} onChange={(v) => update({ cosmetics: v })} />
      </Field>
      <VitraDataField />
      <Field
        label="Discord status"
        description="Shows on your Discord profile that you're using Vitra, and what you're playing. Needs the Discord app running; turning this off clears it."
      >
        <Toggle checked={s.discordPresence} onChange={(v) => update({ discordPresence: v })} />
      </Field>
      <Field label="Show the server you're on" description="Adds the server's name and player count to your Discord status. Off: it just says you're on a server.">
        <Toggle checked={s.discordShowServer} onChange={(v) => update({ discordShowServer: v })} disabled={!s.discordPresence} />
      </Field>
      <Field
        label="Memories"
        description="Keeps a picture of big moments while you play, like your first diamonds or beating the Ender Dragon, in every version and modpack. In Fabric 26.3 instances also where it happened, first visits to rare biomes and rare mobs you spot (Vitra adds its mod for this, which stays offline when badges and capes are off). Pictures stay on this PC."
      >
        <Toggle checked={s.memories} onChange={(v) => update({ memories: v })} />
      </Field>
      <Field label="Every advancement" description="Also keeps the smaller advancements (and in Fabric 26.3, every first biome), not just milestones and challenges.">
        <Toggle checked={s.memoriesEveryAdvancement} onChange={(v) => update({ memoriesEveryAdvancement: v })} disabled={!s.memories} />
      </Field>
    </>
  );
}

function GameDefaults({ s, update }: SectionProps) {
  const [total, setTotal] = useState<number | null>(null);
  const [versions, setVersions] = useState<GameVersion[]>([]);
  useEffect(() => {
    api.systemInfo().then((i) => setTotal(i.totalMemoryMb)).catch(() => {});
    api.listGameVersions().then(setVersions).catch(() => {});
  }, []);
  const max = total ? Math.max(1024, Math.floor((total - 1024) / 256) * 256) : 8192;
  return (
    <>
      <h2 className="settings-title">Game defaults</h2>
      <Field stack label="Default memory" description="Used by instances without their own memory setting. Vitra never allocates all of your RAM.">
        <Slider value={s.defaultMemoryMb} min={1024} max={max} step={256} onChange={(v) => update({ defaultMemoryMb: v })} format={formatMb} />
      </Field>
      <Field label="Default mod loader for new instances">
        <Segmented
          value={s.defaultLoader}
          onChange={(defaultLoader) => update({ defaultLoader })}
          options={(["vanilla", "fabric", "quilt", "forge", "neoforge"] as Loader[]).map((l) => ({ value: l, label: LOADER_LABEL[l] }))}
        />
      </Field>
      <Field label="Default Minecraft version">
        <Select
          value={s.defaultVersion ?? "latest"}
          onChange={(v) => update({ defaultVersion: v === "latest" ? null : v })}
          searchable
          width={200}
          options={[{ value: "latest", label: "Latest release" }, ...versions.filter((v) => v.kind === "release").map((v) => ({ value: v.id, label: v.id }))]}
        />
      </Field>
      <Field stack label="Global JVM arguments" description="Added to every instance before its own arguments. Leave empty unless you know you need something.">
        <textarea className="textarea" value={s.defaultJvmArgs} spellCheck={false} onChange={(e) => update({ defaultJvmArgs: e.target.value })} />
      </Field>
    </>
  );
}

const RUNTIMES = [
  { component: "java-runtime-epsilon", major: 25, label: "Java 25", desc: "Minecraft 26.1 and newer" },
  { component: "java-runtime-delta", major: 21, label: "Java 21", desc: "Minecraft 1.20.5 – 1.21.x" },
  { component: "java-runtime-gamma", major: 17, label: "Java 17", desc: "Minecraft 1.18 – 1.20.4" },
  { component: "jre-legacy", major: 8, label: "Java 8", desc: "Minecraft 1.16 and older" },
];

function JavaSection() {
  const [javas, setJavas] = useState<JavaInstall[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => api.listJava().then(setJavas).catch(() => setJavas([]));
  useEffect(() => {
    load();
  }, []);
  return (
    <>
      <h2 className="settings-title">Java</h2>
      <Notice style={{ marginBottom: 8 }}>
        Instances set to <b>Automatic</b> download the exact Java runtime Mojang specifies for their version, verified file by
        file — you normally don't need to do anything here.
      </Notice>
      <div className="settings-sub">Mojang runtimes</div>
      {RUNTIMES.map((r) => {
        const has = javas?.some((j) => j.component === r.component);
        return (
          <Field key={r.component} label={r.label} description={r.desc}>
            {has ? (
              <span className="chip chip--success">Installed</span>
            ) : (
              <Button
                size="sm"
                loading={busy === r.component}
                onClick={async () => {
                  setBusy(r.component);
                  try {
                    await api.installJavaRuntime(r.component, r.major);
                    await load();
                  } catch (e) {
                    toast.error(`Couldn't install ${r.label}`, errorMessage(e));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Install
              </Button>
            )}
          </Field>
        );
      })}
      <div className="settings-sub">Found on this computer</div>
      {javas === null ? (
        <Skeleton h={60} />
      ) : javas.filter((j) => j.source === "system").length === 0 ? (
        <div className="t-faint" style={{ fontSize: 13, padding: "6px 0" }}>
          No other Java installations found.
        </div>
      ) : (
        javas
          .filter((j) => j.source === "system")
          .map((j) => (
            <Field key={j.path} label={`Java ${j.major} · ${j.vendor || "Unknown"}`} description={<span className="t-mono selectable">{j.path}</span>}>
              <span className="chip">{j.version}</span>
            </Field>
          ))
      )}
    </>
  );
}

function Storage({ s, update }: SectionProps) {
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const load = () => api.storageInfo().then(setInfo).catch(() => {});
  useEffect(() => {
    load();
  }, [s.gameDataDir]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = info
    ? [
        ["Instances (worlds, mods, config)", info.instancesMb],
        ["Libraries", info.librariesMb],
        ["Assets (sounds, languages)", info.assetsMb],
        ["Game versions", info.versionsMb],
        ["Java runtimes", info.runtimesMb],
        ["Backups", info.backupsMb],
        ["Cache", info.cacheMb],
      ]
    : [];
  const total = rows.reduce((a, [, v]) => a + (v as number), 0);
  const changeDir = (dir: string | null) => {
    update({ gameDataDir: dir });
    // Settings save is debounced; reload instances from the new location after it lands.
    window.setTimeout(() => useInstances.getState().refresh(), 700);
  };
  return (
    <>
      <h2 className="settings-title">Downloads & storage</h2>
      <Field stack label="Parallel downloads" description="How many files download at once. Higher is faster on fast connections; lower is gentler on slow ones.">
        <Slider value={s.downloadConcurrency} min={1} max={64} onChange={(v) => update({ downloadConcurrency: v })} format={(v) => `${v} at a time`} />
      </Field>
      <Field
        label="Game data location"
        description={
          <>
            <span className="t-mono selectable">{info?.dataDir ?? "…"}</span>
            <br />
            Changing it doesn't move existing files — copy them over yourself, or keep using the old location.
          </>
        }
      >
        {s.gameDataDir && (
          <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={() => changeDir(null)}>
            Default
          </Button>
        )}
        <Button
          size="sm"
          onClick={async () => {
            const dir = await openDialog({ directory: true });
            if (dir) changeDir(dir as string);
          }}
        >
          Change…
        </Button>
        <Button size="sm" variant="ghost" icon={<FolderOpen />} onClick={() => info && api.openPath(info.dataDir)}>
          Open
        </Button>
      </Field>
      <div className="settings-sub">Disk usage {info && <span className="t-faint">· {formatMb(total)} total</span>}</div>
      {!info ? (
        <Skeleton h={120} />
      ) : (
        <div className="usage">
          <div className="usage-bar">
            {rows.map(([label, mb], i) => (
              <span key={label as string} style={{ flex: Math.max(0.002, (mb as number) / Math.max(1, total)), opacity: 1 - i * 0.11 }} />
            ))}
          </div>
          {rows.map(([label, mb], i) => (
            <div key={label as string} className="usage-row">
              <span className="usage-dot" style={{ opacity: 1 - i * 0.11 }} />
              <span className="grow">{label}</span>
              <span className="t-num t-muted">{formatMb(mb as number)}</span>
            </div>
          ))}
        </div>
      )}
      <Field label="Clear cache" description="Removes cached icons, textures and installers. Your instances and game files are untouched.">
        <Button
          size="sm"
          icon={<Trash2 />}
          onClick={async () => {
            await api.clearCache();
            load();
            toast.success("Cache cleared");
          }}
        >
          Clear
        </Button>
      </Field>
    </>
  );
}

function Accounts({ s, update }: SectionProps) {
  const accounts = useAccounts((st) => st.accounts);
  const refresh = useAccounts((st) => st.refresh);
  const setDialogs = useDialogs((st) => st.set);
  const [clientId, setClientId] = useState(s.msaClientId ?? "");
  return (
    <>
      <h2 className="settings-title">Accounts</h2>
      {accounts.length === 0 ? (
        <Field label="No accounts" description="Sign in with the Microsoft account that owns Minecraft: Java Edition.">
          <Button variant="primary" onClick={() => setDialogs({ signIn: true })}>
            Sign in
          </Button>
        </Field>
      ) : (
        accounts.map((a) => (
          <Field
            key={a.uuid}
            label={
              <span className="row" style={{ gap: 10 }}>
                <PlayerHead src={a.skinUrl?.replace(/^http:\/\//, "https://")} size={26} radius={6} />
                {a.name}
                {a.uuid === s.activeAccount && <span className="chip chip--accent">Active</span>}
              </span>
            }
            description={a.ownsGame ? "Owns Minecraft: Java Edition" : "Doesn't own Java Edition — demo only"}
          >
            {a.uuid !== s.activeAccount && (
              <Button size="sm" onClick={async () => (await api.setActiveAccount(a.uuid), update({ activeAccount: a.uuid }))}>
                Use
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              icon={<LogOut />}
              onClick={async () => {
                await api.removeAccount(a.uuid).catch((e) => toast.error("Couldn't sign out", errorMessage(e)));
                await refresh();
                await useSettings.getState().load();
              }}
            >
              Sign out
            </Button>
          </Field>
        ))
      )}
      {accounts.length > 0 && (
        <div style={{ paddingTop: 10 }}>
          <Button onClick={() => setDialogs({ signIn: true })}>Add another account</Button>
        </div>
      )}
      <div className="settings-sub">Security</div>
      <p className="t-muted" style={{ fontSize: 13, lineHeight: 1.6, margin: "0 0 8px" }}>
        Sign-in happens on Microsoft's website — Vitra never sees your password. Sign-in tokens are encrypted on disk with
        a key kept in your operating system's credential store (Windows Credential Manager / macOS Keychain).
      </p>
      <div className="settings-sub">Advanced</div>
      <Field
        stack
        label="Custom Microsoft app"
        description="Vitra signs in with its own Microsoft app, so this stays empty. Only developers with their own Mojang-approved Azure app need it."
      >
        <div className="row">
          <TextInput
            value={clientId}
            onChange={setClientId}
            placeholder="Built-in (recommended)"
            icon={<KeyRound />}
            className="grow"
            style={clientId ? { fontFamily: "var(--font-mono)" } : undefined}
          />
          <Button
            disabled={clientId.trim() === (s.msaClientId ?? "")}
            onClick={() => {
              const id = clientId.trim();
              if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
                toast.error("That doesn't look like an app ID", "It's a GUID like 1a2b3c4d-…, from the app's Overview page in Azure.");
                return;
              }
              update({ msaClientId: id || null });
              toast.success(id ? "Custom app saved" : "Using Vitra's built-in sign-in");
            }}
          >
            Save
          </Button>
          {s.msaClientId && (
            <Button
              variant="ghost"
              onClick={() => {
                setClientId("");
                update({ msaClientId: null });
                toast.success("Using Vitra's built-in sign-in");
              }}
            >
              Use built-in
            </Button>
          )}
        </div>
      </Field>
    </>
  );
}

function Notifications({ s, update }: SectionProps) {
  const n = s.notifications;
  return (
    <>
      <h2 className="settings-title">Notifications</h2>
      <Field label="Downloads and installs" description="When an install, modpack or backup finishes.">
        <Toggle checked={n.downloads} onChange={(v) => update({ notifications: { ...n, downloads: v } })} />
      </Field>
      <Field label="Crash reports" description="Show what went wrong when Minecraft closes unexpectedly.">
        <Toggle checked={n.crashes} onChange={(v) => update({ notifications: { ...n, crashes: v } })} />
      </Field>
      <Field label="Minecraft updates" description="Highlight new releases in the Home news section.">
        <Toggle checked={n.gameUpdates} onChange={(v) => update({ notifications: { ...n, gameUpdates: v } })} />
      </Field>
    </>
  );
}

function About() {
  const replace = useSettings((s) => s.replace);
  const s = useSettings((st) => st.settings);
  const update = useSettings((st) => st.update);
  const [confirm, setConfirm] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const { status, update: available, error, lastChecked } = useUpdate();
  const setDialogs = useDialogs((st) => st.set);
  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);
  return (
    <>
      <div className="about">
        <Logo size={56} />
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>Vitra</div>
          <div className="t-muted">Version {version ?? "…"}</div>
        </div>
      </div>
      <p className="t-muted" style={{ fontSize: 13, lineHeight: 1.6 }}>
        Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft. Mods and packs are provided
        by Modrinth and their authors.
      </p>
      <div className="settings-sub">Updates</div>
      <Field
        label={
          status === "available" && available
            ? `Vitra ${available.version} is available`
            : status === "current"
              ? "You're on the latest version"
              : "Check for updates"
        }
        description={
          status === "error" && error
            ? `Couldn't check: ${error}`
            : lastChecked
              ? `Last checked ${new Date(lastChecked).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`
              : "Updates are signed, so Vitra only installs real ones."
        }
      >
        {status === "available" ? (
          <Button size="sm" variant="primary" onClick={() => setDialogs({ update: true })}>
            See update
          </Button>
        ) : (
          <Button size="sm" loading={status === "checking"} onClick={() => checkForUpdates({ silent: false })}>
            Check now
          </Button>
        )}
      </Field>
      {s && (
        <Field label="Check automatically" description="When Vitra starts and every few hours. You always choose when to install.">
          <Toggle checked={s.checkUpdates} onChange={(v) => update({ checkUpdates: v })} />
        </Field>
      )}

      <div className="settings-sub">Reset</div>
      <Field label="Reset all settings" description="Restores appearance and launcher settings to their defaults. Accounts, instances and skins are kept.">
        <Button size="sm" variant="danger" icon={<RotateCcw />} onClick={() => setConfirm(true)}>
          Reset
        </Button>
      </Field>
      <ConfirmDialog
        open={confirm}
        danger
        title="Reset all settings?"
        description="Appearance, behaviour and defaults go back to how they were on first launch."
        confirmLabel="Reset"
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          try {
            replace(await api.resetSettings());
            toast.success("Settings reset");
          } catch (e) {
            toast.error("Couldn't reset", errorMessage(e));
          }
          setConfirm(false);
        }}
      />
    </>
  );
}

/** Deletes what Vitra's cosmetics server keeps about the signed-in player. */
function VitraDataField() {
  const account = useActiveAccount();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!account) return null;
  return (
    <Field
      label="Your Vitra cosmetics data"
      description="Deletes your record on api.xan.gripe: your name and UUID, when you last played on Vitra, your Vitra cape and the capes you uploaded."
    >
      <Button size="sm" variant="danger" icon={<Trash2 />} onClick={() => setConfirming(true)}>
        Delete
      </Button>
      <ConfirmDialog
        open={confirming}
        danger
        icon={<Trash2 />}
        title="Delete your Vitra cosmetics data?"
        description={`Removes ${account.name}'s record from Vitra's server, including your Vitra cape and uploaded capes. If badges and capes stay on, a new record is made the next time you play a Fabric 26.3 instance, without a cape.`}
        confirmLabel="Delete"
        busy={busy}
        onClose={() => setConfirming(false)}
        onConfirm={async () => {
          setBusy(true);
          try {
            await api.deleteVitraData();
            forgetAccountData();
            toast.success("Your Vitra cosmetics data is deleted");
            setConfirming(false);
          } catch (e) {
            toast.error("Couldn't delete your data", errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      />
    </Field>
  );
}
