import { motion } from "motion/react";
import {
  Boxes,
  ChevronDown,
  Clock,
  Compass,
  FolderOpen,
  Gauge,
  Globe2,
  Package,
  Plus,
  Settings2,
  Shirt,
  Sparkles,
  Zap,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { InstanceIcon } from "../../components/art/PixelIcon";
import { PlayButton } from "../../components/PlayButton";
import { Button, IconButton } from "../../components/ui/Button";
import { ProgressBar, Skeleton } from "../../components/ui/Feedback";
import { Modal, Popover } from "../../components/ui/Overlay";
import { api, errorMessage } from "../../lib/api";
import { fileSrc, formatBytes, formatDuration, formatEta, LOADER_LABEL, relativeTime } from "../../lib/format";
import { play } from "../../lib/launch";
import { perfModsFor } from "../../lib/presets";
import {
  activeTaskFor,
  toast,
  useActiveAccount,
  useDialogs,
  useInstances,
  useNav,
  useSelectedInstance,
  useSettings,
  useTasks,
} from "../../lib/store";
import type { CosmeticsStatus, InstanceView, PatchNote, TextBlock, VitraCape, WorldInfo } from "../../lib/types";
import { useWheelScrollX } from "../../lib/wheel";
import { CapeThumb } from "../skins/VitraCapePanel";
import { loadVitraCape, type AnimatedCape } from "../skins/vitraCape";
import "./home.css";

// The 3D model pulls in the 3D engine, so it loads after the rest of Home.
const HeroPlayer = lazy(() => import("./HeroPlayer"));

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05, delayChildren: 0.05 } },
};
const rise = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { type: "spring" as const, stiffness: 300, damping: 30 } },
};

export function Home() {
  const instances = useInstances((s) => s.instances);
  const loaded = useInstances((s) => s.loaded);
  const selected = useSelectedInstance();
  const showNews = useSettings((s) => s.settings?.showNews ?? true);
  const vitra = useVitraStatus();

  return (
    <motion.div className="page-inner home" variants={stagger} initial="hidden" animate="show">
      {loaded && instances.length === 0 ? (
        <Welcome />
      ) : selected ? (
        <Hero instance={selected} vitraCape={vitra === "error" ? null : (vitra?.cape ?? null)} />
      ) : (
        <HeroSkeleton />
      )}
      {instances.length > 0 && (
        <motion.div className="home-grid" variants={stagger}>
          <motion.div variants={rise} className="glass panel home-worlds">
            <RecentWorlds />
          </motion.div>
          <motion.div variants={rise} className="glass panel">
            <VitraCard status={vitra} />
          </motion.div>
          <motion.div variants={rise} className="glass panel">
            <QuickAccess />
          </motion.div>
        </motion.div>
      )}
      {showNews && (
        <motion.div variants={rise}>
          <News />
        </motion.div>
      )}
    </motion.div>
  );
}

// ------------------------------------------------------------------ hero

function HeroSkeleton() {
  return (
    <div className="hero">
      <Skeleton w={120} h={14} />
      <Skeleton w={380} h={46} style={{ marginTop: 12 }} />
      <Skeleton w={230} h={60} r={20} style={{ marginTop: 26 }} />
    </div>
  );
}

function Hero({ instance, vitraCape }: { instance: InstanceView; vitraCape: VitraCape | null }) {
  const instances = useInstances((s) => s.instances);
  const update = useSettings((s) => s.update);
  const navigate = useNav((s) => s.navigate);
  const setDialogs = useDialogs((s) => s.set);
  const tasks = useTasks((s) => s.tasks);
  const task = activeTaskFor(tasks, instance.id);
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const running = useInstances((s) => !!s.running[instance.id]);

  const status = running ? "Running" : task ? task.title : instance.installedVersion ? "Ready to play" : "Not installed yet";

  return (
    <motion.section className="hero hero--with-player" variants={rise}>
      <Suspense fallback={null}>
        <HeroPlayer vitraCape={vitraCape} />
      </Suspense>
      <div className="hero-status">
        <span className={`hero-dot ${running ? "hero-dot--live" : task ? "hero-dot--busy" : instance.installedVersion ? "hero-dot--ready" : ""}`} />
        {status}
      </div>
      <button ref={ref} className="hero-switch" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        <InstanceIcon icon={instance.icon} size={54} />
        <span className="t-hero truncate">{instance.name}</span>
        <ChevronDown className="hero-chevron" />
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={340}>
        <div className="menu-label t-label">Switch instance</div>
        {instances.map((i) => (
          <button
            key={i.id}
            className="menu-item"
            aria-selected={i.id === instance.id}
            onClick={() => {
              update({ selectedInstance: i.id });
              setOpen(false);
            }}
          >
            <InstanceIcon icon={i.icon} size={30} />
            <span className="grow" style={{ minWidth: 0 }}>
              <span className="truncate" style={{ display: "block", fontWeight: 600 }}>
                {i.name}
              </span>
              <span className="t-faint" style={{ fontSize: 12 }}>
                {i.gameVersion} · {LOADER_LABEL[i.loader]}
              </span>
            </span>
          </button>
        ))}
        <div className="menu-sep" />
        <button
          className="menu-item"
          onClick={() => {
            setOpen(false);
            setDialogs({ createInstance: true });
          }}
        >
          <Plus /> New instance
        </button>
      </Popover>

      <div className="hero-chips">
        <span className="chip">Minecraft {instance.gameVersion}</span>
        <span className={`chip ${instance.loader !== "vanilla" ? "chip--accent" : ""}`}>
          {LOADER_LABEL[instance.loader]}
          {instance.loaderVersion ? ` ${instance.loaderVersion}` : ""}
        </span>
        {instance.modpack && (
          <span className="chip">
            <Package /> {instance.modpack.title}
          </span>
        )}
        {instance.playTimeSecs > 0 && (
          <span className="chip">
            <Clock /> {formatDuration(instance.playTimeSecs)} played
          </span>
        )}
      </div>

      <div className="hero-actions">
        <PlayButton instance={instance} />
        <div className="hero-secondary glass">
          <IconButton label="Mods & content" onClick={() => navigate("instance", { id: instance.id, tab: "mods" })}>
            <Boxes />
          </IconButton>
          <IconButton label="Open game folder" onClick={() => api.openInstanceFolder(instance.id)}>
            <FolderOpen />
          </IconButton>
          <IconButton label="Instance settings" onClick={() => navigate("instance", { id: instance.id, tab: "settings" })}>
            <Settings2 />
          </IconButton>
        </div>
      </div>

      {task && task.state === "running" && (
        <div className="hero-progress">
          <div className="row" style={{ justifyContent: "space-between", fontSize: 12.5 }}>
            <span className="t-muted">{task.stage}</span>
            <span className="t-faint t-num">
              {task.bytesTotal > 0 ? `${formatBytes(task.bytesDone)} of ${formatBytes(task.bytesTotal)}` : task.filesTotal > 0 ? `${task.filesDone} / ${task.filesTotal}` : ""}
              {task.bytesPerSec > 0 && ` · ${formatBytes(task.bytesPerSec)}/s`}
              {formatEta(task.etaSecs) && ` · ${formatEta(task.etaSecs)}`}
            </span>
          </div>
          <ProgressBar value={task.progress} />
        </div>
      )}
    </motion.section>
  );
}

// ------------------------------------------------------------------ welcome

function Welcome() {
  const setDialogs = useDialogs((s) => s.set);
  const navigate = useNav((s) => s.navigate);
  const refresh = useInstances((s) => s.refresh);
  const [busy, setBusy] = useState<string | null>(null);

  const quick = async (kind: "vanilla" | "fabric") => {
    setBusy(kind);
    try {
      const latest = await api.latestRelease();
      let gameVersion = latest;
      if (kind === "fabric") {
        // Use the newest release Fabric already supports.
        const supported = new Set(await api.listLoaderGameVersions("fabric"));
        const versions = await api.listGameVersions();
        gameVersion = versions.find((v) => v.kind === "release" && supported.has(v.id))?.id ?? latest;
      }
      const inst = await api.createInstance({
        name: kind === "vanilla" ? `Minecraft ${gameVersion}` : `Fabric ${gameVersion} · Performance`,
        gameVersion,
        loader: kind,
        loaderVersion: null,
        icon: kind === "vanilla" ? "grass" : "diamond",
      });
      useSettings.getState().update({ selectedInstance: inst.id, onboarded: true });
      await refresh();
      await api.installInstance(inst.id, false);
      if (kind === "fabric") {
        const plan = await api.planInstall(
          inst.id,
          perfModsFor("fabric", "all").map((m) => ({ projectId: m.slug, projectType: "mod" as const, title: m.title })),
        );
        await api.applyPlan(plan);
        toast.success("Performance pack on its way", `${plan.files.length} optimization mods are downloading.`);
      }
    } catch (e) {
      toast.error("Couldn't set up the instance", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <motion.section className="welcome" variants={rise}>
      <div className="t-label">Welcome</div>
      <h1 className="t-hero">Let's get you playing.</h1>
      <p className="t-muted welcome-lead">
        Pick a starting point. Vitra downloads everything it needs, verifies every file, and keeps each instance's mods
        and worlds separate.
      </p>
      <div className="welcome-grid">
        <button className="welcome-card glass" onClick={() => quick("vanilla")} disabled={!!busy}>
          <div className="welcome-icon">
            <Globe2 />
          </div>
          <div className="welcome-title">Latest release</div>
          <div className="t-muted">The newest version of Minecraft, unmodified.</div>
          {busy === "vanilla" && <ProgressBar value={null} thin style={{ marginTop: 12 }} />}
        </button>
        <button className="welcome-card glass welcome-card--accent" onClick={() => quick("fabric")} disabled={!!busy}>
          <div className="welcome-icon">
            <Zap />
          </div>
          <div className="welcome-title">Fabric + performance</div>
          <div className="t-muted">Sodium, Lithium and friends, preinstalled for high frame rates.</div>
          {busy === "fabric" && <ProgressBar value={null} thin style={{ marginTop: 12 }} />}
        </button>
        <button className="welcome-card glass" onClick={() => navigate("discover", { type: "modpack" })} disabled={!!busy}>
          <div className="welcome-icon">
            <Compass />
          </div>
          <div className="welcome-title">Browse modpacks</div>
          <div className="t-muted">Install a complete modpack from Modrinth in one click.</div>
        </button>
        <button className="welcome-card glass" onClick={() => setDialogs({ createInstance: true })} disabled={!!busy}>
          <div className="welcome-icon">
            <Sparkles />
          </div>
          <div className="welcome-title">Custom setup</div>
          <div className="t-muted">Choose any version and Fabric, Quilt, Forge or NeoForge.</div>
        </button>
      </div>
    </motion.section>
  );
}

// ------------------------------------------------------------------ cards

function RecentWorlds() {
  const [worlds, setWorlds] = useState<WorldInfo[] | null>(null);
  const instances = useInstances((s) => s.instances);
  useEffect(() => {
    api.recentWorlds(4).then(setWorlds).catch(() => setWorlds([]));
  }, [instances]);

  return (
    <>
      <div className="panel-head">
        <Globe2 />
        <h2>Jump back in</h2>
      </div>
      {worlds === null ? (
        <div className="col" style={{ gap: 10 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="row" style={{ gap: 12 }}>
              <Skeleton w={40} h={40} r={10} />
              <div className="grow col" style={{ gap: 6 }}>
                <Skeleton w="60%" />
                <Skeleton w="35%" h={11} />
              </div>
            </div>
          ))}
        </div>
      ) : worlds.length === 0 ? (
        <div className="t-faint" style={{ fontSize: 13, padding: "8px 2px" }}>
          Worlds you play appear here so you can jump straight back in.
        </div>
      ) : (
        <div className="world-list">
          {worlds.map((w) => (
            <button key={`${w.instanceId}/${w.folder}`} className="world-row" onClick={() => play(w.instanceId, { world: w.folder })}>
              {w.icon ? <img src={fileSrc(w.icon)} alt="" className="world-icon" /> : <div className="world-icon world-icon--empty" />}
              <div className="grow">
                <div className="truncate" style={{ fontWeight: 600 }}>
                  {w.folder}
                </div>
                <div className="t-faint truncate" style={{ fontSize: 12 }}>
                  {w.instanceName} · {relativeTime(w.lastPlayed)}
                </div>
              </div>
              <span className="world-play">Play</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// Vitra's numbers change slowly; one request a minute is plenty, however often Home opens.
const STATUS_TTL_MS = 60 * 1000;
let statusCache: { key: string; at: number; value: CosmeticsStatus } | null = null;

/** Your Vitra cape plus how many people play on Vitra. undefined while loading. */
function useVitraStatus(): CosmeticsStatus | "error" | undefined {
  const account = useActiveAccount();
  const key = account?.uuid ?? "";
  const fresh = statusCache?.key === key && Date.now() - statusCache.at < STATUS_TTL_MS ? statusCache.value : undefined;
  const [status, setStatus] = useState<CosmeticsStatus | "error" | undefined>(fresh);
  useEffect(() => {
    if (fresh) return setStatus(fresh);
    let live = true;
    api
      .cosmeticsStatus()
      .then((s) => {
        statusCache = { key, at: Date.now(), value: s };
        if (live) setStatus(s);
      })
      .catch(() => live && setStatus("error"));
    return () => {
      live = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return status;
}

function VitraCard({ status }: { status: CosmeticsStatus | "error" | undefined }) {
  const navigate = useNav((s) => s.navigate);
  const account = useActiveAccount();
  const [art, setArt] = useState<AnimatedCape | null>(null);
  const data = status === "error" ? undefined : status;
  const cape = data?.cape ?? null;
  const preset = data?.presets.find((p) => p.cape.id === cape?.id);

  useEffect(() => {
    setArt(null);
    // No cape yet: show off a free one instead.
    const show = cape ?? data?.presets[0]?.cape;
    if (show) loadVitraCape(show).then(setArt).catch(() => {});
  }, [cape?.id, data?.presets[0]?.cape.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const count = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString());

  return (
    <>
      <div className="panel-head">
        <Sparkles />
        <h2>Vitra</h2>
        {!!data?.online && <span className="vitra-live">{data.online} in game</span>}
      </div>
      <div className="col" style={{ gap: 10, flex: 1 }}>
        <div className="stat-grid">
          <div className="stat">
            <div className="stat-value">{data ? count(data.online) : <Skeleton w={28} h={18} />}</div>
            <div className="stat-label">Playing on Vitra now</div>
          </div>
          <div className="stat">
            <div className="stat-value">{data ? count(data.players) : <Skeleton w={28} h={18} />}</div>
            <div className="stat-label">Vitra players</div>
          </div>
        </div>
        <button className="vitra-cape-row" onClick={() => navigate("skins")}>
          <span className="vitra-cape-art">
            <CapeThumb cape={art} />
          </span>
          <span className="grow" style={{ minWidth: 0 }}>
            <span className="truncate" style={{ display: "block", fontWeight: 650 }}>
              {status === "error" ? "Cape server unreachable" : cape ? (preset?.name ?? "Your own cape") : "Free animated capes"}
            </span>
            <span className="t-faint truncate" style={{ display: "block", fontSize: 12 }}>
              {cape ? "Your Vitra cape, seen by everyone on Vitra" : account ? "Pick one, or upload a GIF" : "Sign in to wear one in game"}
            </span>
          </span>
          <span className="vitra-cape-go">{cape ? "Change" : "Pick one"}</span>
        </button>
      </div>
    </>
  );
}

function QuickAccess() {
  const navigate = useNav((s) => s.navigate);
  const selected = useSelectedInstance();
  const tiles = [
    { label: "Mods", icon: <Boxes />, go: () => navigate("discover", { type: "mod" }) },
    { label: "Modpacks", icon: <Package />, go: () => navigate("discover", { type: "modpack" }) },
    { label: "Skins", icon: <Shirt />, go: () => navigate("skins") },
    { label: "Performance", icon: <Gauge />, go: () => navigate("performance") },
    { label: "Shaders", icon: <Sparkles />, go: () => (selected ? navigate("instance", { id: selected.id, tab: "shaders" }) : navigate("discover", { type: "shader" })) },
    { label: "Settings", icon: <Settings2 />, go: () => navigate("settings") },
  ];
  return (
    <>
      <div className="panel-head">
        <Compass />
        <h2>Quick access</h2>
      </div>
      <div className="tile-grid">
        {tiles.map((t) => (
          <button key={t.label} className="tile" onClick={t.go}>
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ news

function News() {
  const [notes, setNotes] = useState<PatchNote[] | null>(null);
  const [error, setError] = useState(false);
  const [openNote, setOpenNote] = useState<PatchNote | null>(null);
  const rowRef = useWheelScrollX<HTMLDivElement>();
  useEffect(() => {
    api
      .patchNotes(8)
      .then(setNotes)
      .catch(() => setError(true));
  }, []);
  if (error) return null;

  return (
    <section className="news">
      <div className="row" style={{ padding: "6px 8px 10px" }}>
        <h2 className="t-section" style={{ margin: 0 }}>
          Minecraft updates
        </h2>
        <span className="t-faint" style={{ fontSize: 12 }}>
          Official Java Edition patch notes
        </span>
      </div>
      <div className="news-row" ref={rowRef}>
        {notes === null
          ? [0, 1, 2, 3].map((i) => <Skeleton key={i} w={260} h={190} r={20} style={{ flex: "none" }} />)
          : notes.map((n) => (
              <button key={n.id} className="news-card glass" onClick={() => setOpenNote(n)}>
                {n.image && <img src={n.image} alt="" loading="lazy" />}
                <div className="news-body">
                  <span className={`chip ${n.kind === "release" ? "chip--accent" : ""}`}>{noteLabel(n)}</span>
                  <div className="news-title clamp-2">{n.title}</div>
                  <div className="t-faint" style={{ fontSize: 12 }}>
                    {new Date(n.date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                  </div>
                </div>
              </button>
            ))}
      </div>
      <PatchNoteDialog note={openNote} onClose={() => setOpenNote(null)} />
    </section>
  );
}

function noteLabel(n: PatchNote): string {
  if (n.kind === "release") return "Release";
  if (/-rc-?\d/i.test(n.version)) return "Release candidate";
  if (/-pre-?\d/i.test(n.version)) return "Pre-release";
  return "Snapshot";
}

function PatchNoteDialog({ note, onClose }: { note: PatchNote | null; onClose: () => void }) {
  const [blocks, setBlocks] = useState<TextBlock[] | null>(null);
  const setDialogs = useDialogs((s) => s.set);
  useEffect(() => {
    setBlocks(null);
    if (note) api.patchNoteBody(note.contentPath).then(setBlocks).catch(() => setBlocks([{ kind: "p", text: note.shortText }]));
  }, [note]);
  const content = useMemo(() => blocks?.slice(0, 220), [blocks]);
  return (
    <Modal
      open={!!note}
      onClose={onClose}
      title={note?.title}
      description={note ? new Date(note.date).toLocaleDateString(undefined, { dateStyle: "long" }) : undefined}
      size="wide"
      footer={
        note && (
          <Button
            variant="primary"
            icon={<Plus />}
            onClick={() => {
              onClose();
              setDialogs({ createInstance: { gameVersion: note.version, loader: "vanilla" } });
            }}
          >
            Create a {note.version} instance
          </Button>
        )
      }
    >
      <div className="patch-body selectable">
        {!content ? (
          <div className="col" style={{ gap: 8 }}>
            {[90, 100, 80, 95, 60].map((w, i) => (
              <Skeleton key={i} w={`${w}%`} />
            ))}
          </div>
        ) : (
          content.map((b, i) =>
            b.kind === "h" ? (
              <h3 key={i}>{b.text}</h3>
            ) : b.kind === "li" ? (
              <div key={i} className="patch-li">
                {b.text}
              </div>
            ) : (
              <p key={i}>{b.text}</p>
            ),
          )
        )}
      </div>
    </Modal>
  );
}

