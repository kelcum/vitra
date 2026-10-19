import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Coffee, FolderInput, MemoryStick, RotateCcw, Wrench } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ICON_KEYS, InstanceIcon } from "../../components/art/PixelIcon";
import { Button } from "../../components/ui/Button";
import { Field, Segmented, Select, Slider, TextInput, Toggle } from "../../components/ui/Controls";
import { Notice } from "../../components/ui/Feedback";
import { Popover } from "../../components/ui/Overlay";
import { api, errorMessage } from "../../lib/api";
import { formatMb, LOADER_LABEL } from "../../lib/format";
import { toast, useInstances, useSettings } from "../../lib/store";
import type { GameVersion, Instance, InstanceView, JavaInstall, Loader, LoaderVersion, SystemInfo } from "../../lib/types";

function strip(view: InstanceView): Instance {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { path, resolvedGameDir, running, ...inst } = view;
  return inst;
}

export function SettingsTab({ instance }: { instance: InstanceView }) {
  const refresh = useInstances((s) => s.refresh);
  const defaultMemory = useSettings((s) => s.settings?.defaultMemoryMb ?? 2048);
  const [draft, setDraft] = useState<Instance>(() => strip(instance));
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [javas, setJavas] = useState<JavaInstall[]>([]);
  const timer = useRef<number>(undefined);
  const pending = useRef<Partial<Instance> | null>(null);
  const latest = useRef(instance);
  latest.current = instance;

  useEffect(() => {
    if (!pending.current) setDraft(strip(instance));
  }, [instance]);
  useEffect(() => {
    api.systemInfo().then(setSys).catch(() => {});
    api.listJava().then(setJavas).catch(() => {});
  }, []);

  const save = (patch: Partial<Instance>) => {
    setDraft((d) => ({ ...d, ...patch }));
    pending.current = { ...pending.current, ...patch };
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      const changes = pending.current;
      pending.current = null;
      if (!changes) return;
      try {
        await api.updateInstance({ ...strip(latest.current), ...changes });
        await refresh();
      } catch (e) {
        toast.error("Couldn't save", errorMessage(e));
      }
    }, 400);
  };

  const maxMem = sys ? Math.max(1024, Math.floor((sys.totalMemoryMb - 1024) / 256) * 256) : 8192;
  const memory = draft.memoryMb ?? defaultMemory;
  const modded = draft.loader !== "vanilla";
  const recommended = sys ? (modded ? sys.recommendedModdedMb : sys.recommendedVanillaMb) : null;

  return (
    <div className="settings-tab">
      <section className="settings-section">
        <h3>General</h3>
        <Field label="Name">
          <TextInput value={draft.name} onChange={(v) => save({ name: v })} style={{ width: 280 }} />
        </Field>
        <Field label="Icon">
          <IconPicker value={draft.icon} onChange={(icon) => save({ icon })} />
        </Field>
      </section>

      <VersionSection instance={instance} />

      <section className="settings-section">
        <h3>
          <MemoryStick /> Memory
        </h3>
        <Field
          label="Use the launcher default"
          description={`Currently ${formatMb(defaultMemory)} — change it in Settings → Game.`}
        >
          <Toggle checked={draft.memoryMb == null} onChange={(v) => save({ memoryMb: v ? null : memory })} />
        </Field>
        {draft.memoryMb != null && (
          <Field
            stack
            label="Maximum memory"
            description={
              <>
                More isn't faster: an oversized heap makes garbage collection pauses longer.{" "}
                {recommended && <>Recommended here: <b>{formatMb(recommended)}</b>{modded ? " (modded)" : ""}.</>}
                {sys && <> This computer has {formatMb(sys.totalMemoryMb)}.</>}
              </>
            }
          >
            <Slider value={memory} min={1024} max={maxMem} step={256} onChange={(v) => save({ memoryMb: v })} format={formatMb} />
          </Field>
        )}
      </section>

      <section className="settings-section">
        <h3>
          <Coffee /> Java
        </h3>
        <JavaPicker value={draft.javaPath} javas={javas} onChange={(javaPath) => save({ javaPath })} />
        <Field
          label="Garbage collector preset"
          description={
            draft.jvmPreset === "low-latency"
              ? "ZGC: fewer frame-time spikes on fast multi-core CPUs (Java 17+). Uses a little more memory."
              : draft.jvmPreset === "balanced"
                ? "G1 tuned like the official launcher — a safe choice for every computer."
                : "No extra flags — only the arguments you write below."
          }
        >
          <Segmented
            value={draft.jvmPreset === "custom" || draft.jvmPreset === "none" ? "none" : draft.jvmPreset}
            onChange={(jvmPreset) => save({ jvmPreset })}
            options={[
              { value: "balanced", label: "Balanced" },
              { value: "low-latency", label: "Low latency" },
              { value: "none", label: "None" },
            ]}
          />
        </Field>
        <Field stack label="Extra JVM arguments" description="Advanced. Added after the memory and preset flags.">
          <textarea
            className="textarea"
            value={draft.jvmArgs}
            spellCheck={false}
            placeholder="-Dexample.flag=true"
            onChange={(e) => save({ jvmArgs: e.target.value })}
          />
        </Field>
        <Field stack label="Extra game arguments">
          <textarea className="textarea" style={{ minHeight: 44 }} value={draft.gameArgs} spellCheck={false} onChange={(e) => save({ gameArgs: e.target.value })} />
        </Field>
      </section>

      <section className="settings-section">
        <h3>Window</h3>
        <Field label="Start in fullscreen">
          <Toggle checked={draft.window.fullscreen} onChange={(v) => save({ window: { ...draft.window, fullscreen: v } })} />
        </Field>
        <Field label="Custom window size" description="The size of the game window when it opens.">
          <Toggle checked={draft.window.custom} onChange={(v) => save({ window: { ...draft.window, custom: v } })} />
          {draft.window.custom && (
            <>
              <SizeInput value={draft.window.width} min={320} onChange={(width) => save({ window: { ...draft.window, width } })} />
              <span className="t-faint">×</span>
              <SizeInput value={draft.window.height} min={240} onChange={(height) => save({ window: { ...draft.window, height } })} />
            </>
          )}
        </Field>
      </section>

      <section className="settings-section">
        <h3>
          <FolderInput /> Game folder
        </h3>
        <Field label="Location" description={<span className="selectable t-mono">{instance.resolvedGameDir}</span>}>
          {draft.gameDir && (
            <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={() => save({ gameDir: null })}>
              Use default
            </Button>
          )}
          <Button
            size="sm"
            onClick={async () => {
              const dir = await openDialog({ directory: true });
              if (dir) save({ gameDir: dir as string });
            }}
          >
            Choose folder…
          </Button>
        </Field>
      </section>

      <section className="settings-section">
        <h3>
          <Wrench /> Maintenance
        </h3>
        <Field label="Repair installation" description="Re-checks every game file against Mojang's checksums and re-downloads anything missing or damaged. Your worlds and mods aren't touched.">
          <Button
            size="sm"
            disabled={instance.running}
            onClick={() => api.installInstance(instance.id, true).catch((e) => toast.error("Repair failed", errorMessage(e)))}
          >
            Repair
          </Button>
        </Field>
      </section>
    </div>
  );
}

function SizeInput({ value, min, onChange }: { value: number; min: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(String(value));
  }, [value, editing]);
  return (
    <TextInput
      value={text}
      onChange={(v) => setText(v.replace(/\D/g, "").slice(0, 5))}
      onFocus={() => setEditing(true)}
      onBlur={() => {
        setEditing(false);
        const n = Math.max(min, Number(text) || 0);
        setText(String(n));
        if (n !== value) onChange(n);
      }}
      style={{ width: 84 }}
    />
  );
}

function IconPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={ref} className="icon-choice" onClick={() => setOpen((o) => !o)} aria-label="Change icon">
        <InstanceIcon icon={value} size={40} />
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} align="end" width={290}>
        <div className="icon-grid" style={{ padding: 4 }}>
          {ICON_KEYS.map((k) => (
            <button
              key={k}
              className="icon-choice"
              aria-pressed={k === value}
              onClick={() => {
                onChange(k);
                setOpen(false);
              }}
            >
              <InstanceIcon icon={k} size={34} />
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

function JavaPicker({ value, javas, onChange }: { value: string | null; javas: JavaInstall[]; onChange: (v: string | null) => void }) {
  const [custom, setCustom] = useState<JavaInstall | null>(null);
  const options = useMemo(() => {
    const list = [
      { value: "auto", label: "Automatic (recommended)", description: "Downloads and uses the exact Java version Mojang specifies" },
      ...javas.map((j) => ({
        value: j.path,
        label: `Java ${j.major} · ${j.vendor || "Unknown vendor"}`,
        description: j.source === "managed" ? `Managed by Vitra (${j.version})` : j.path,
      })),
    ];
    if (value && !javas.some((j) => j.path === value)) {
      list.push({ value, label: custom ? `Java ${custom.major} · ${custom.vendor}` : "Custom Java", description: value });
    }
    return list;
  }, [javas, value, custom]);

  return (
    <Field label="Java runtime" description="Minecraft 1.20.5+ needs Java 21, 26.x needs Java 25, older versions Java 8 or 17. Automatic always picks correctly.">
      <Select value={value ?? "auto"} options={options} onChange={(v) => onChange(v === "auto" ? null : v)} width={300} />
      <Button
        size="sm"
        variant="ghost"
        onClick={async () => {
          const file = await openDialog({ title: "Choose a java or java.exe file" });
          if (!file) return;
          try {
            const info = await api.inspectJava(file as string);
            setCustom(info);
            onChange(info.path);
            toast.success(`Found Java ${info.major}`, info.vendor);
          } catch (e) {
            toast.error("That isn't a usable Java", errorMessage(e));
          }
        }}
      >
        Browse…
      </Button>
    </Field>
  );
}

function VersionSection({ instance }: { instance: InstanceView }) {
  const refresh = useInstances((s) => s.refresh);
  const [versions, setVersions] = useState<GameVersion[] | null>(null);
  const [gameVersion, setGameVersion] = useState(instance.gameVersion);
  const [loader, setLoader] = useState<Loader>(instance.loader);
  const [loaderVersions, setLoaderVersions] = useState<LoaderVersion[] | null>(null);
  const [loaderVersion, setLoaderVersion] = useState<string | null>(instance.loaderVersion);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listGameVersions().then(setVersions).catch(() => setVersions([]));
  }, []);
  useEffect(() => {
    setLoaderVersions(null);
    if (loader === "vanilla") return;
    api
      .listLoaderVersions(loader, gameVersion)
      .then((l) => {
        setLoaderVersions(l);
        if (!l.some((x) => x.version === loaderVersion)) setLoaderVersion(l.find((x) => x.recommended)?.version ?? l[0]?.version ?? null);
      })
      .catch(() => setLoaderVersions([]));
  }, [loader, gameVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const changed =
    gameVersion !== instance.gameVersion || loader !== instance.loader || (loader !== "vanilla" && loaderVersion !== instance.loaderVersion);

  return (
    <section className="settings-section">
      <h3>Version</h3>
      <Field label="Minecraft version">
        <Select
          value={gameVersion}
          onChange={setGameVersion}
          searchable
          width={220}
          options={(versions ?? [])
            .filter((v) => v.kind === "release" || v.kind === "snapshot" || v.id === gameVersion)
            .map((v) => ({ value: v.id, label: v.id, description: v.kind === "snapshot" ? "Snapshot" : undefined }))}
        />
      </Field>
      <Field label="Mod loader">
        <Segmented
          value={loader}
          onChange={setLoader}
          options={(["vanilla", "fabric", "quilt", "forge", "neoforge"] as Loader[]).map((l) => ({ value: l, label: LOADER_LABEL[l] }))}
        />
      </Field>
      {loader !== "vanilla" && (
        <Field label={`${LOADER_LABEL[loader]} version`}>
          <Select
            value={loaderVersion}
            onChange={setLoaderVersion}
            searchable
            width={220}
            placeholder={loaderVersions?.length === 0 ? "Not available" : "Loading…"}
            disabled={!loaderVersions?.length}
            options={(loaderVersions ?? []).map((l) => ({
              value: l.version,
              label: l.version,
              badge: l.recommended ? <span className="chip chip--accent">Recommended</span> : undefined,
            }))}
          />
        </Field>
      )}
      {changed && (
        <div className="col" style={{ gap: 10, paddingTop: 12 }}>
          <Notice tone="warning">
            Changing the version or loader can make installed mods incompatible, and opening a world in an older version can
            damage it. Back up first if you're unsure. Your existing config and worlds are kept.
          </Notice>
          <div className="row">
            <Button
              variant="primary"
              loading={busy}
              disabled={loader !== "vanilla" && !loaderVersion}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.updateInstance({ ...strip(instance), gameVersion, loader, loaderVersion: loader === "vanilla" ? null : loaderVersion });
                  await refresh();
                  await api.installInstance(instance.id, false);
                  toast.success("Version changed", "Downloading the files it needs.");
                } catch (e) {
                  toast.error("Couldn't change the version", errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Apply & install
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setGameVersion(instance.gameVersion);
                setLoader(instance.loader);
                setLoaderVersion(instance.loaderVersion);
              }}
            >
              Revert
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
