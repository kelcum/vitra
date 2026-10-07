import { motion } from "motion/react";
import { Activity, Check, Cpu, Gauge, Info, MemoryStick, MonitorCog, Sparkles, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { InstanceIcon } from "../../components/art/PixelIcon";
import { Button } from "../../components/ui/Button";
import { Field, Segmented, Select, Slider, Toggle } from "../../components/ui/Controls";
import { Empty, Notice, Skeleton } from "../../components/ui/Feedback";
import { api, errorMessage } from "../../lib/api";
import { useContentVersion } from "../../lib/events";
import { formatMb, LOADER_LABEL } from "../../lib/format";
import { GRAPHICS_PRESETS, PERFORMANCE_MODS, type GraphicsPreset } from "../../lib/presets";
import { toast, useDialogs, useInstances, useSelectedInstance, useSettings } from "../../lib/store";
import type { InstanceView, SystemInfo } from "../../lib/types";
import "./performance.css";

export default function Performance() {
  const instances = useInstances((s) => s.instances);
  const selected = useSelectedInstance();
  const [targetId, setTargetId] = useState<string | null>(selected?.id ?? null);
  const target = instances.find((i) => i.id === targetId) ?? null;
  const [sys, setSys] = useState<SystemInfo | null>(null);

  useEffect(() => {
    api.systemInfo().then(setSys).catch(() => {});
  }, []);

  return (
    <div className="page-inner">
      <div className="page-head">
        <div className="grow">
          <h1 className="t-title">Performance</h1>
          <p>Tune each instance for frame rate, smoothness or looks. Every change here is real and reversible.</p>
        </div>
        {instances.length > 0 && (
          <div className="col" style={{ gap: 4 }}>
            <span className="t-label">Instance</span>
            <Select
              value={targetId}
              onChange={setTargetId}
              width={260}
              options={instances.map((i) => ({
                value: i.id,
                label: i.name,
                description: `${i.gameVersion} · ${LOADER_LABEL[i.loader]}`,
                icon: <InstanceIcon icon={i.icon} size={22} radius={6} />,
              }))}
            />
          </div>
        )}
      </div>

      <Hardware sys={sys} />

      {!target ? (
        <div className="glass">
          <Empty icon={<Gauge />} title="No instance to tune">
            Create an instance first, then come back to optimize it.
          </Empty>
        </div>
      ) : (
        <>
          <Presets instance={target} />
          <div className="perf-grid">
            <div className="glass panel">
              <FineTuning instance={target} />
            </div>
            <div className="glass panel">
              <OptimizationMods instance={target} />
            </div>
          </div>
          <div className="glass panel">
            <MemoryAndJvm instance={target} sys={sys} />
          </div>
          <div className="glass panel">
            <div className="panel-head">
              <Activity />
              <h2>Measuring real performance</h2>
            </div>
            <div className="perf-notes">
              <p>
                Vitra doesn't display made-up FPS numbers. Press <kbd>F3</kbd> in-game to see your actual frame rate and frame
                times, and compare before/after in the same spot of the same world.
              </p>
              <p>
                Lightweight scenes can reach very high frame rates (hundreds, sometimes over a thousand with Sodium on a fast
                GPU at a short view distance) — but results depend on your hardware, Minecraft version, resolution, shaders and
                the world itself. No preset can promise a number.
              </p>
              <p>
                On laptops, plug in the charger and make sure Java uses the dedicated GPU (Windows Settings → Display →
                Graphics → add <span className="t-mono">javaw.exe/java.exe</span> → High performance).
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Hardware({ sys }: { sys: SystemInfo | null }) {
  const items = sys
    ? [
        { icon: <Cpu />, label: "Processor", value: sys.cpu || "Unknown", sub: `${sys.cores} cores · ${sys.threads} threads` },
        { icon: <MonitorCog />, label: "Graphics", value: sys.gpus[0] ?? "Unknown", sub: sys.gpus.length > 1 ? `+ ${sys.gpus.slice(1).join(", ")}` : sys.os },
        {
          icon: <MemoryStick />,
          label: "Memory",
          value: formatMb(sys.totalMemoryMb),
          sub: `${formatMb(sys.availableMemoryMb)} free · launcher uses ${sys.launcherMemoryMb} MB`,
        },
      ]
    : null;
  return (
    <div className="hw-grid">
      {(items ?? [0, 1, 2]).map((it, i) =>
        typeof it === "number" ? (
          <div key={i} className="glass hw-card">
            <Skeleton w={36} h={36} r={10} />
            <div className="grow col" style={{ gap: 6 }}>
              <Skeleton w="40%" h={11} />
              <Skeleton w="80%" />
            </div>
          </div>
        ) : (
          <motion.div key={it.label} className="glass hw-card" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
            <div className="hw-icon">{it.icon}</div>
            <div className="grow">
              <div className="t-label">{it.label}</div>
              <div className="hw-value truncate" title={it.value}>
                {it.value}
              </div>
              <div className="t-faint truncate" style={{ fontSize: 12 }}>
                {it.sub}
              </div>
            </div>
          </motion.div>
        ),
      )}
    </div>
  );
}

function Presets({ instance }: { instance: InstanceView }) {
  const setDialogs = useDialogs((s) => s.set);
  const refresh = useInstances((s) => s.refresh);
  const [busy, setBusy] = useState<string | null>(null);
  const modded = instance.loader !== "vanilla";

  const apply = async (p: GraphicsPreset) => {
    setBusy(p.id);
    try {
      await api.setGameOptions(instance.id, p.options);
      const { path, resolvedGameDir, running, ...inst } = instance;
      void path;
      void resolvedGameDir;
      void running;
      await api.updateInstance({ ...inst, jvmPreset: p.jvmPreset, performancePreset: p.id });
      await refresh();
      if (modded && p.mods !== "none") {
        const mods = PERFORMANCE_MODS.filter((m) => m.loaders.includes(instance.loader) && (p.mods === "all" || m.core));
        const plan = await api.planInstall(
          instance.id,
          mods.map((m) => ({ projectId: m.slug, projectType: "mod" as const, title: m.title })),
        );
        if (plan.files.length > 0 || plan.conflicts.length > 0) {
          setDialogs({ plan: { plan, title: `${p.title}: optimization mods` } });
        } else {
          toast.success(`${p.title} applied`, "Video settings updated; optimization mods were already installed.");
        }
      } else {
        toast.success(`${p.title} applied`, modded ? "Video settings updated." : "Video settings updated. Vanilla can't use optimization mods — create a Fabric instance for the biggest gains.");
      }
    } catch (e) {
      toast.error("Couldn't apply the preset", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const icons = { "max-fps": <Zap />, balanced: <Gauge />, quality: <Sparkles /> };
  return (
    <div className="preset-grid">
      {GRAPHICS_PRESETS.map((p, i) => {
        const active = instance.performancePreset === p.id;
        return (
          <motion.div
            key={p.id}
            className={`glass preset-card ${active ? "preset-card--active" : ""}`}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 + i * 0.05 }}
          >
            <div className="row">
              <div className="preset-icon">{icons[p.id]}</div>
              <div className="grow">
                <div className="preset-title">{p.title}</div>
              </div>
              {active && (
                <span className="chip chip--accent">
                  <Check /> Active
                </span>
              )}
            </div>
            <p className="t-muted preset-desc">{p.description}</p>
            <ul className="preset-list">
              <li>View distance {p.options.renderDistance} chunks</li>
              <li>{p.options.graphicsMode === "0" ? "Fast graphics" : "Fancy graphics"}, {p.options.enableVsync === "true" ? "VSync on" : "uncapped FPS"}</li>
              <li>{modded ? (p.mods === "all" ? "All optimization mods" : "Core optimization mods") : "Video settings only (vanilla)"}</li>
            </ul>
            <Button variant={active ? "default" : "primary"} loading={busy === p.id} disabled={instance.running} onClick={() => apply(p)}>
              {active ? "Re-apply" : "Apply"}
            </Button>
          </motion.div>
        );
      })}
    </div>
  );
}

function FineTuning({ instance }: { instance: InstanceView }) {
  const [opts, setOpts] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    api.getGameOptions(instance.id).then(setOpts).catch(() => setOpts({}));
  }, [instance.id, instance.performancePreset, instance.lastPlayed]);

  const num = (k: string, d: number) => {
    const v = Number(opts?.[k]);
    return Number.isFinite(v) && opts?.[k] !== undefined ? v : d;
  };
  const set = (k: string, v: string) => setOpts((o) => ({ ...(o ?? {}), [k]: v }));
  const commit = (values: Record<string, string>) =>
    api.setGameOptions(instance.id, values).catch((e) => toast.error("Couldn't save", errorMessage(e)));

  const fps = num("maxFps", 120);
  const vsync = (opts?.enableVsync ?? "true") === "true";

  return (
    <>
      <div className="panel-head">
        <MonitorCog />
        <h2>Fine tuning</h2>
      </div>
      {instance.running && <Notice tone="warning">Close the game to change these — Minecraft rewrites its options when it exits.</Notice>}
      {!opts ? (
        <Skeleton h={160} />
      ) : (
        <>
          {Object.keys(opts).length === 0 && (
            <Notice style={{ marginBottom: 6 }}>No options file yet — values you set here are used on first launch.</Notice>
          )}
          <Field stack label="Render distance" description="The biggest single factor for FPS and memory use.">
            <Slider
              value={num("renderDistance", 12)}
              min={2}
              max={32}
              onChange={(v) => set("renderDistance", String(v))}
              onCommit={(v) => commit({ renderDistance: String(v) })}
              format={(v) => `${v} chunks`}
              disabled={instance.running}
            />
          </Field>
          <Field stack label="Simulation distance" description="How far away the world keeps ticking (mobs, crops, redstone).">
            <Slider
              value={num("simulationDistance", 12)}
              min={5}
              max={32}
              onChange={(v) => set("simulationDistance", String(v))}
              onCommit={(v) => commit({ simulationDistance: String(v) })}
              format={(v) => `${v} chunks`}
              disabled={instance.running}
            />
          </Field>
          <Field stack label="Frame rate limit">
            <Slider
              value={fps}
              min={30}
              max={260}
              step={10}
              onChange={(v) => set("maxFps", String(v))}
              onCommit={(v) => commit({ maxFps: String(v) })}
              format={(v) => (v >= 260 ? "Unlimited" : `${v} FPS`)}
              disabled={instance.running}
            />
          </Field>
          <Field label="VSync" description="Smooth, tear-free frames capped at your monitor's refresh rate. Off = lowest input latency.">
            <Toggle
              checked={vsync}
              disabled={instance.running}
              onChange={(v) => {
                set("enableVsync", String(v));
                commit({ enableVsync: String(v) });
              }}
            />
          </Field>
        </>
      )}
    </>
  );
}

function OptimizationMods({ instance }: { instance: InstanceView }) {
  const setDialogs = useDialogs((s) => s.set);
  const contentVersion = useContentVersion((s) => s.v);
  const [installed, setInstalled] = useState<Set<string> | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const available = useMemo(() => PERFORMANCE_MODS.filter((m) => m.loaders.includes(instance.loader)), [instance.loader]);

  useEffect(() => {
    if (instance.loader === "vanilla") return setInstalled(new Set());
    setInstalled(null);
    api
      .listContent(instance.id, "mod")
      .then((items) => setInstalled(new Set(items.map((i) => i.title.toLowerCase()))))
      .catch(() => setInstalled(new Set()));
  }, [instance.id, instance.loader, contentVersion]);

  useEffect(() => {
    if (!installed) return;
    setChosen(new Set(available.filter((m) => m.core && !installed.has(m.title.toLowerCase())).map((m) => m.slug)));
  }, [installed, available]);

  const isInstalled = (title: string) => installed?.has(title.toLowerCase()) ?? false;

  const install = async () => {
    setBusy(true);
    try {
      const mods = available.filter((m) => chosen.has(m.slug));
      const plan = await api.planInstall(
        instance.id,
        mods.map((m) => ({ projectId: m.slug, projectType: "mod" as const, title: m.title })),
      );
      setDialogs({ plan: { plan, title: "Install optimization mods" } });
    } catch (e) {
      toast.error("Couldn't prepare the install", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="panel-head">
        <Zap />
        <h2>Optimization mods</h2>
      </div>
      {instance.loader === "vanilla" ? (
        <Notice>
          Vanilla instances can't load mods. The largest FPS gains come from Sodium and friends — create a Fabric instance
          (or switch this one in its settings) to use them.
        </Notice>
      ) : installed === null ? (
        <Skeleton h={200} />
      ) : (
        <>
          <div className="perf-mods">
            {available.map((m) => {
              const has = isInstalled(m.title);
              return (
                <label key={m.slug} className={`perf-mod ${has ? "perf-mod--installed" : ""}`}>
                  <input
                    type="checkbox"
                    checked={has || chosen.has(m.slug)}
                    disabled={has}
                    onChange={(e) =>
                      setChosen((cur) => {
                        const next = new Set(cur);
                        if (e.target.checked) next.add(m.slug);
                        else next.delete(m.slug);
                        return next;
                      })
                    }
                  />
                  <div className="grow">
                    <div className="row" style={{ gap: 8 }}>
                      <span style={{ fontWeight: 600 }}>{m.title}</span>
                      {has && <span className="chip chip--success">Installed</span>}
                    </div>
                    <div className="t-faint" style={{ fontSize: 12.5 }}>
                      {m.why}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <Info style={{ width: 14, color: "var(--text-3)" }} />
            <span className="t-faint grow" style={{ fontSize: 12 }}>
              Only mods with a release for {LOADER_LABEL[instance.loader]} {instance.gameVersion} are installed; you'll see a summary first.
            </span>
            <Button variant="primary" disabled={chosen.size === 0} loading={busy} onClick={install}>
              Install {chosen.size || ""}
            </Button>
          </div>
        </>
      )}
    </>
  );
}

function MemoryAndJvm({ instance, sys }: { instance: InstanceView; sys: SystemInfo | null }) {
  const refresh = useInstances((s) => s.refresh);
  const defaultMemory = useSettings((s) => s.settings?.defaultMemoryMb ?? 2048);
  const [memory, setMemory] = useState(instance.memoryMb ?? defaultMemory);
  useEffect(() => setMemory(instance.memoryMb ?? defaultMemory), [instance.id, instance.memoryMb, defaultMemory]);
  const modded = instance.loader !== "vanilla";
  const recommended = sys ? (modded ? sys.recommendedModdedMb : sys.recommendedVanillaMb) : null;
  const max = sys ? Math.max(1024, Math.floor((sys.totalMemoryMb - 1024) / 256) * 256) : 8192;

  const save = async (patch: { memoryMb?: number; jvmPreset?: string }) => {
    const { path, resolvedGameDir, running, ...inst } = instance;
    void path;
    void resolvedGameDir;
    void running;
    try {
      await api.updateInstance({ ...inst, ...patch });
      await refresh();
    } catch (e) {
      toast.error("Couldn't save", errorMessage(e));
    }
  };

  return (
    <>
      <div className="panel-head">
        <MemoryStick />
        <h2>Memory & Java</h2>
      </div>
      <Field
        stack
        label="Allocated memory"
        description={
          <>
            {recommended && (
              <>
                Recommended for this {modded ? "modded" : "vanilla"} instance: <b>{formatMb(recommended)}</b>.{" "}
              </>
            )}
            Giving Minecraft too much memory makes garbage-collection pauses longer, and leaves less for your system.
          </>
        }
      >
        <div className="row" style={{ gap: 14 }}>
          <div className="grow">
            <Slider value={memory} min={1024} max={max} step={256} onChange={setMemory} onCommit={(v) => save({ memoryMb: v })} format={formatMb} />
          </div>
          {recommended && memory !== recommended && (
            <Button size="sm" variant="ghost" onClick={() => (setMemory(recommended), save({ memoryMb: recommended }))}>
              Use recommended
            </Button>
          )}
        </div>
      </Field>
      <Field
        label="Garbage collector"
        description={
          instance.jvmPreset === "low-latency"
            ? "ZGC — shortest pauses, best on 6+ core CPUs with Java 17 or newer."
            : "G1 tuned like Mojang's own launcher. The safe default."
        }
      >
        <Segmented
          value={instance.jvmPreset === "low-latency" ? "low-latency" : "balanced"}
          onChange={(v) => save({ jvmPreset: v })}
          options={[
            { value: "balanced", label: "Balanced (G1)" },
            { value: "low-latency", label: "Low latency (ZGC)" },
          ]}
        />
      </Field>
    </>
  );
}
