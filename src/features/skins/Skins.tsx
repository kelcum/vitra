import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { motion } from "motion/react";
import { AtSign, Check, CloudUpload, Download, ExternalLink, Flame, LogIn, MoreHorizontal, Pencil, RotateCw, Search, Shirt, Trash2, Upload, UserRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { SkinFront } from "../../components/art/PlayerHead";
import { Button, IconButton } from "../../components/ui/Button";
import { Segmented, Select, Slider, TextInput, Toggle } from "../../components/ui/Controls";
import { Empty, Notice, Skeleton } from "../../components/ui/Feedback";
import { Menu, Modal } from "../../components/ui/Overlay";
import { api, errorMessage, parseError } from "../../lib/api";
import { useContentVersion } from "../../lib/events";
import { toast, useAccounts, useActiveAccount, useDialogs, useSelectedInstance, useSettings } from "../../lib/store";
import type { FoundSkin, ProfileView, SavedSkin } from "../../lib/types";
import { defaultSkin, SkinViewer3D, type AnimationKind, type ViewAngle } from "./SkinViewer3D";
import type { AnimatedCape } from "./vitraCape";
import { NameChangeDialog } from "./NameChange";
import { PopularSkins } from "./PopularSkins";
import { VitraCapePanel } from "./VitraCapePanel";
import "./skins.css";

const APPLIED_KEY = "vitra.appliedSkin";
/** Modrinth project of the Capes mod, which draws OptiFine capes in game. */
const CAPES_MOD = "89Wsn8GD";

/**
 * OptiFine capes come as 46×22 (or 92×44, …) images laid out like a vanilla
 * cape; OptiFine pads them onto a 64×32 (or 128×64, …) canvas, so do the same
 * before handing them to the 3D viewer.
 */
async function padOptifineCape(src: string): Promise<string> {
  const img = new Image();
  img.src = src;
  await img.decode();
  let w = 64;
  let h = 32;
  while (w < img.width || h < img.height) {
    w *= 2;
    h *= 2;
  }
  if (w === img.width && h === img.height) return src;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(img, 0, 0);
  return canvas.toDataURL("image/png");
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i += 7) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
}

export default function Skins() {
  const account = useActiveAccount();
  const accountsLoaded = useAccounts((s) => s.loaded);
  const accent = useSettings((s) => s.settings?.accent ?? "#7c9cff");
  const setDialogs = useDialogs((s) => s.set);
  const [skins, setSkins] = useState<SavedSkin[] | null>(null);
  const [profile, setProfile] = useState<ProfileView | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string | null; src: string; model: "classic" | "slim" } | null>(null);
  const [capeId, setCapeId] = useState<string | null>(null);
  // undefined while loading, null when the account has no OptiFine cape.
  const [ofCape, setOfCape] = useState<string | null | undefined>(undefined);
  const [ofPreview, setOfPreview] = useState(false);
  // undefined = not previewing a Vitra cape; null = previewing "no Vitra cape".
  const [vitraPreview, setVitraPreview] = useState<AnimatedCape | null | undefined>(undefined);
  const [view, setView] = useState<ViewAngle>("showcase");
  const [viewNonce, setViewNonce] = useState(0);
  const [animation, setAnimation] = useState<AnimationKind>("idle");
  const [autoRotate, setAutoRotate] = useState(false);
  const [elytra, setElytra] = useState(false);
  const [zoom, setZoom] = useState(0.85);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ path: string; name: string; model: "classic" | "slim" } | null>(null);
  const [renaming, setRenaming] = useState<SavedSkin | null>(null);
  const [tab, setTab] = useState<"library" | "popular" | "find">("library");
  const [changingName, setChangingName] = useState(false);
  const fallback = useMemo(() => defaultSkin(accent), [accent]);

  const loadSkins = () => api.listSkins().then(setSkins).catch(() => setSkins([]));
  useEffect(() => {
    loadSkins();
  }, []);

  useEffect(() => {
    setProfile(null);
    setProfileError(null);
    if (!account) return;
    api
      .getProfile()
      .then((p) => {
        setProfile(p);
        setCapeId(p.capes.find((c) => c.active)?.id ?? null);
      })
      .catch((e) => setProfileError(parseError(e).message));
    setOfCape(undefined);
    setOfPreview(false);
    api
      .optifineCape()
      .then((url) => (url ? padOptifineCape(url) : null))
      .then(setOfCape)
      .catch(() => setOfCape(null));
  }, [account?.uuid]); // eslint-disable-line react-hooks/exhaustive-deps

  // Initial preview: the account's live skin, else the first saved one.
  useEffect(() => {
    if (preview) return;
    if (profile?.skinDataUrl) setPreview({ id: null, src: profile.skinDataUrl, model: profile.skinModel });
    else if (skins?.length) setPreview({ id: skins[0].id, src: skins[0].dataUrl, model: skins[0].model });
  }, [profile, skins]); // eslint-disable-line react-hooks/exhaustive-deps

  const appliedId = useMemo(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(APPLIED_KEY) ?? "null");
      if (stored && profile?.skinDataUrl && stored.profileHash === hash(profile.skinDataUrl)) return stored.id as string;
    } catch {
      /* storage unavailable */
    }
    return null;
  }, [profile]);

  const mojangCape = profile?.capes.find((c) => c.id === capeId)?.dataUrl ?? null;
  const cape = vitraPreview !== undefined ? (vitraPreview ?? mojangCape) : ofPreview && ofCape ? ofCape : mojangCape;
  const capeChanged = profile && (profile.capes.find((c) => c.active)?.id ?? null) !== capeId;

  const pickFile = async () => {
    const file = await openDialog({ filters: [{ name: "Minecraft skin", extensions: ["png"] }] });
    if (!file) return;
    const path = file as string;
    const name = path.split(/[\\/]/).pop()!.replace(/\.png$/i, "");
    setAdding({ path, name, model: "classic" });
  };

  const apply = async (skin: SavedSkin) => {
    setBusy(skin.id);
    try {
      const p = await api.applySkin(skin.id);
      setProfile(p);
      if (p.skinDataUrl) {
        try {
          localStorage.setItem(APPLIED_KEY, JSON.stringify({ id: skin.id, profileHash: hash(p.skinDataUrl) }));
        } catch {
          /* storage unavailable */
        }
      }
      toast.success("Skin updated", "It shows up in-game the next time you join a world or server.");
    } catch (e) {
      toast.error("Couldn't change your skin", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const applyCape = async () => {
    setBusy("cape");
    try {
      const p = await api.setCape(capeId);
      setProfile(p);
      toast.success(capeId ? "Cape equipped" : "Cape hidden");
    } catch (e) {
      toast.error("Couldn't change your cape", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const current = preview ?? { id: null, src: fallback, model: "classic" as const };
  // Turn the model around when a cape is picked, so you see it.
  const showCape = () => {
    setView("showcase");
    setViewNonce((n) => n + 1);
    setAutoRotate(false);
  };

  return (
    <div className="page-inner">
      <div className="page-head">
        <div className="grow">
          <h1 className="t-title">Skins</h1>
          <p>Preview, collect and apply skins. Changes go to your Minecraft account and show up everywhere.</p>
        </div>
        {account && (
          <Button
            icon={<Download />}
            onClick={() =>
              api
                .saveCurrentSkin()
                .then(() => (loadSkins(), toast.success("Saved your current skin to the library")))
                .catch((e) => toast.error("Couldn't save", errorMessage(e)))
            }
          >
            Save current skin
          </Button>
        )}
        <Button icon={<Upload />} onClick={pickFile}>
          Add skin
        </Button>
      </div>

      <div className="skins-layout">
        <motion.section className="glass skin-stage" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }}>
          <div className="skin-stage-glow" />
          <SkinViewer3D
            skin={current.src}
            model={current.model}
            cape={cape}
            elytra={elytra}
            animation={animation}
            autoRotate={autoRotate}
            view={view}
            viewNonce={viewNonce}
            zoom={zoom}
            nameTag={profile?.name ?? account?.name ?? null}
          />
          <div className="skin-controls glass">
            <Segmented
              value={view}
              onChange={(v) => {
                setView(v);
                setViewNonce((n) => n + 1);
                setAutoRotate(false);
              }}
              options={[
                { value: "front", label: "Front" },
                { value: "back", label: "Back" },
                { value: "left", label: "Left" },
                { value: "right", label: "Right" },
              ]}
            />
            <Select
              value={animation}
              onChange={setAnimation}
              size="sm"
              width={120}
              options={[
                { value: "idle", label: "Idle" },
                { value: "walk", label: "Walk" },
                { value: "run", label: "Run" },
                { value: "wave", label: "Wave" },
                { value: "crouch", label: "Crouch" },
                { value: "none", label: "Still" },
              ]}
            />
            <IconButton label={autoRotate ? "Stop turning" : "Turntable"} className={autoRotate ? "icon-btn--on" : ""} onClick={() => setAutoRotate((a) => !a)}>
              <RotateCw />
            </IconButton>
            <div style={{ width: 120 }}>
              <Slider value={zoom} min={0.5} max={1.4} step={0.01} onChange={setZoom} label="Zoom" />
            </div>
          </div>
          <div className="skin-stage-caption">
            <span className="chip">{current.model === "slim" ? "Slim arms" : "Classic arms"}</span>
            {current.id === null && profile?.skinDataUrl === current.src && <span className="chip chip--success">On your account</span>}
            {!preview && <span className="chip">Placeholder skin</span>}
            {preview?.id === "found" && <span className="chip chip--accent">Preview, not saved</span>}
          </div>
        </motion.section>

        <section className="skin-side">
          <div className="glass panel">
            <div className="panel-head">
              <UserRound />
              <h2>Account</h2>
              {profile && (
                <>
                  <span className="spacer" />
                  <Button size="sm" icon={<AtSign />} onClick={() => setChangingName(true)}>
                    Change name
                  </Button>
                </>
              )}
            </div>
            {!accountsLoaded ? (
              <Skeleton h={40} />
            ) : !account ? (
              <div className="col" style={{ gap: 12 }}>
                <span className="t-muted" style={{ fontSize: 13 }}>
                  Sign in to apply skins and choose capes. You can still collect and preview skins without an account.
                </span>
                <Button icon={<LogIn />} onClick={() => setDialogs({ signIn: true })}>
                  Sign in with Microsoft
                </Button>
              </div>
            ) : profileError ? (
              <Notice tone="warning">{profileError}</Notice>
            ) : !profile ? (
              <Skeleton h={80} />
            ) : (
              <div className="col" style={{ gap: 12 }}>
                <button
                  className={`skin-account ${preview?.id === null && preview.src === profile.skinDataUrl ? "skin-account--active" : ""}`}
                  onClick={() => profile.skinDataUrl && setPreview({ id: null, src: profile.skinDataUrl, model: profile.skinModel })}
                >
                  {profile.skinDataUrl && <SkinFront src={profile.skinDataUrl} slim={profile.skinModel === "slim"} height={58} />}
                  <div className="grow" style={{ textAlign: "left" }}>
                    <div style={{ fontWeight: 650 }}>{profile.name}</div>
                    <div className="t-faint" style={{ fontSize: 12 }}>
                      Current skin · {profile.skinModel === "slim" ? "slim" : "classic"}
                    </div>
                  </div>
                </button>
                <div className="t-label">Cape</div>
                {profile.capes.length === 0 ? (
                  <span className="t-faint" style={{ fontSize: 12.5 }}>
                    No Mojang capes on this account. They come from events, Minecon and account migration.
                  </span>
                ) : (
                  <>
                    <div className="cape-row">
                      <button className="cape-choice" aria-pressed={!ofPreview && vitraPreview === undefined && capeId === null} onClick={() => (setCapeId(null), setOfPreview(false), setVitraPreview(undefined))}>
                        <span className="cape-none">None</span>
                      </button>
                      {profile.capes.map((c) => (
                        <button key={c.id} className="cape-choice" aria-pressed={!ofPreview && vitraPreview === undefined && capeId === c.id} onClick={() => (setCapeId(c.id), setOfPreview(false), setVitraPreview(undefined), showCape())} data-tip={c.alias}>
                          {c.dataUrl ? <CapeFront src={c.dataUrl} /> : <span className="cape-none">{c.alias}</span>}
                          {c.active && <span className="cape-active" />}
                        </button>
                      ))}
                    </div>
                    <div className="row">
                      <label className="row t-faint" style={{ fontSize: 12.5, gap: 8 }}>
                        <Toggle checked={elytra} onChange={setElytra} label="Preview as elytra" /> Preview as elytra
                      </label>
                      <span className="spacer" />
                      <Button size="sm" variant={capeChanged ? "primary" : "default"} disabled={!capeChanged} loading={busy === "cape"} onClick={applyCape}>
                        {capeChanged ? "Apply cape" : "Applied"}
                      </Button>
                    </div>
                  </>
                )}
                <OptifineCape
                  cape={ofCape}
                  previewing={ofPreview && vitraPreview === undefined}
                  onPreview={(v) => (setOfPreview(v), setVitraPreview(undefined), v && showCape())}
                  elytra={elytra}
                  onElytra={setElytra}
                  showElytraToggle={profile.capes.length === 0}
                />
              </div>
            )}
          </div>

          <VitraCapePanel previewing={vitraPreview !== undefined} onPreview={(c) => (setVitraPreview(c), setOfPreview(false), c && showCape())} />

          <div className="glass panel skin-library">
            <div className="panel-head">
              {tab === "library" ? <Shirt /> : tab === "popular" ? <Flame /> : <Search />}
              <h2>{tab === "library" ? "Library" : tab === "popular" ? "Popular skins" : "Find skins"}</h2>
              {tab === "library" && (
                <span className="t-faint" style={{ fontSize: 12 }}>
                  {skins?.length ?? 0} saved
                </span>
              )}
              <span className="spacer" />
              <Segmented
                size="sm"
                value={tab}
                onChange={setTab}
                options={[
                  { value: "library", label: "Library" },
                  { value: "popular", label: "Popular" },
                  { value: "find", label: "Find" },
                ]}
              />
            </div>
            {tab === "popular" ? (
              <PopularSkins
                previewing={preview?.id === "found" ? preview.src : null}
                onPreview={(f) => setPreview({ id: "found", src: f.dataUrl, model: f.model })}
                canApply={!!account?.ownsGame}
                onSaved={async (saved, applyNow) => {
                  await loadSkins();
                  setPreview({ id: saved.id, src: saved.dataUrl, model: saved.model });
                  if (applyNow) await apply(saved);
                  else toast.success("Saved to your library", saved.name);
                  setTab("library");
                }}
              />
            ) : tab === "find" ? (
              <FindSkins
                previewing={preview?.id === "found" ? preview.src : null}
                onPreview={(f) => setPreview({ id: "found", src: f.dataUrl, model: f.model })}
                canApply={!!account?.ownsGame}
                onSaved={async (saved, applyNow) => {
                  await loadSkins();
                  setPreview({ id: saved.id, src: saved.dataUrl, model: saved.model });
                  if (applyNow) await apply(saved);
                  else toast.success("Saved to your library", saved.name);
                  setTab("library");
                }}
              />
            ) : skins === null ? (
              <div className="skin-grid">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} h={150} r={14} />
                ))}
              </div>
            ) : skins.length === 0 ? (
              <Empty icon={<Shirt />} title="No saved skins" action={<Button icon={<Upload />} onClick={pickFile}>Add a PNG skin</Button>}>
                Add 64×64 or 64×32 skin files to preview them in 3D and switch between them quickly.
              </Empty>
            ) : (
              <div className="skin-grid">
                {skins.map((s) => (
                  <div
                    key={s.id}
                    className={`skin-card ${preview?.id === s.id ? "skin-card--selected" : ""}`}
                    onClick={() => setPreview({ id: s.id, src: s.dataUrl, model: s.model })}
                    role="button"
                    tabIndex={0}
                  >
                    {appliedId === s.id && (
                      <span className="skin-applied" data-tip="On your account">
                        <Check />
                      </span>
                    )}
                    <SkinFront src={s.dataUrl} slim={s.model === "slim"} height={88} />
                    <div className="skin-card-name truncate">{s.name}</div>
                    <div className="row" style={{ gap: 4 }} onClick={(e) => e.stopPropagation()}>
                      <Button
                        size="sm"
                        variant={appliedId !== s.id && preview?.id === s.id ? "primary" : "default"}
                        icon={appliedId === s.id ? <Check /> : <CloudUpload />}
                        disabled={!account || !account.ownsGame || appliedId === s.id}
                        loading={busy === s.id}
                        onClick={() => apply(s)}
                      >
                        {appliedId === s.id ? "Applied" : "Apply"}
                      </Button>
                      <Menu
                        trigger={({ ref, onClick }) => (
                          <IconButton ref={ref} label="More" size="sm" onClick={onClick}>
                            <MoreHorizontal />
                          </IconButton>
                        )}
                        items={[
                          { label: "Rename / arm style", icon: <Pencil />, onSelect: () => setRenaming(s) },
                          {
                            label: "Delete",
                            icon: <Trash2 />,
                            danger: true,
                            onSelect: async () => {
                              await api.deleteSkin(s.id);
                              if (preview?.id === s.id) setPreview(null);
                              loadSkins();
                            },
                          },
                        ]}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>

      <Modal
        open={!!adding}
        onClose={() => setAdding(null)}
        icon={<Upload />}
        title="Add skin"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAdding(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                if (!adding) return;
                try {
                  const s = await api.importSkin(adding.path, adding.name, adding.model);
                  setAdding(null);
                  await loadSkins();
                  setPreview({ id: s.id, src: s.dataUrl, model: s.model });
                } catch (e) {
                  toast.error("Couldn't add the skin", errorMessage(e));
                }
              }}
            >
              Add to library
            </Button>
          </>
        }
      >
        {adding && (
          <div className="col" style={{ gap: 14 }}>
            <TextInput value={adding.name} onChange={(name) => setAdding({ ...adding, name })} placeholder="Name" />
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="t-muted">Arm style</span>
              <Segmented
                value={adding.model}
                onChange={(model) => setAdding({ ...adding, model })}
                options={[
                  { value: "classic", label: "Classic (4px)" },
                  { value: "slim", label: "Slim (3px)" },
                ]}
              />
            </div>
          </div>
        )}
      </Modal>
      <RenameDialog skin={renaming} onClose={() => setRenaming(null)} onSaved={loadSkins} />
      <NameChangeDialog open={changingName} current={profile?.name ?? ""} onClose={() => setChangingName(false)} onChanged={setProfile} />
    </div>
  );
}

function RenameDialog({ skin, onClose, onSaved }: { skin: SavedSkin | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [model, setModel] = useState<"classic" | "slim">("classic");
  useEffect(() => {
    if (skin) {
      setName(skin.name);
      setModel(skin.model);
    }
  }, [skin]);
  return (
    <Modal
      open={!!skin}
      onClose={onClose}
      icon={<Pencil />}
      title="Edit skin"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              if (!skin) return;
              await api.updateSkin(skin.id, name, model).catch((e) => toast.error("Couldn't save", errorMessage(e)));
              onSaved();
              onClose();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        <TextInput value={name} onChange={setName} />
        <Segmented
          value={model}
          onChange={setModel}
          options={[
            { value: "classic", label: "Classic arms" },
            { value: "slim", label: "Slim arms" },
          ]}
        />
      </div>
    </Modal>
  );
}

/** The visible front of a cape texture (10×16 region at 1,1). */
function CapeFront({ src }: { src: string }) {
  return (
    <span
      className="cape-front"
      style={{
        backgroundImage: `url(${src})`,
      }}
    />
  );
}

// ------------------------------------------------------------------ OptiFine

function OptifineCape({
  cape,
  previewing,
  onPreview,
  elytra,
  onElytra,
  showElytraToggle,
}: {
  cape: string | null | undefined;
  previewing: boolean;
  onPreview: (v: boolean) => void;
  elytra: boolean;
  onElytra: (v: boolean) => void;
  showElytraToggle: boolean;
}) {
  const [opening, setOpening] = useState(false);
  const edit = async () => {
    setOpening(true);
    try {
      await api.openOptifineCapeEditor();
      toast.success("Opened OptiFine's cape editor", "You're signed in there automatically. Changes show up within a few minutes.");
    } catch (e) {
      toast.error("Couldn't open OptiFine", errorMessage(e));
    } finally {
      setOpening(false);
    }
  };

  return (
    <>
      <div className="t-label" style={{ marginTop: 4 }}>
        OptiFine cape
      </div>
      {cape === undefined ? (
        <Skeleton h={64} r={12} />
      ) : cape === null ? (
        <span className="t-faint" style={{ fontSize: 12.5 }}>
          No OptiFine cape on this account. OptiFine capes come with a donation at optifine.net.
        </span>
      ) : (
        <>
          <div className="of-cape">
            <button className="cape-choice" aria-pressed={previewing} onClick={() => onPreview(!previewing)} data-tip={previewing ? "Previewing" : "Preview"}>
              <CapeFront src={cape} />
            </button>
            <div className="grow">
              <div style={{ fontWeight: 650 }}>Your OptiFine cape</div>
              <div className="t-faint" style={{ fontSize: 12 }}>
                Seen by players using OptiFine or the Capes mod.
              </div>
            </div>
            <Button size="sm" icon={<ExternalLink />} loading={opening} onClick={edit}>
              Edit
            </Button>
          </div>
          {showElytraToggle && (
            <label className="row t-faint" style={{ fontSize: 12.5, gap: 8 }}>
              <Toggle checked={elytra} onChange={onElytra} label="Preview as elytra" /> Preview as elytra
            </label>
          )}
          <CapesInGame />
        </>
      )}
    </>
  );
}

/** Whether the selected instance can draw OptiFine capes, with a one-click fix. */
function CapesInGame() {
  const instance = useSelectedInstance();
  const contentVersion = useContentVersion((s) => s.v);
  const setDialogs = useDialogs((s) => s.set);
  const [shown, setShown] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const modded = !!instance && instance.loader !== "vanilla";

  useEffect(() => {
    setShown(null);
    if (!instance || !modded) return;
    api
      .listContent(instance.id, "mod")
      .then((items) => setShown(items.some((i) => i.enabled && (i.projectId === CAPES_MOD || /optifine|optifabric/i.test(i.fileName)))))
      .catch(() => setShown(false));
  }, [instance?.id, contentVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!instance) return null;
  if (!modded) {
    return (
      <div className="of-ingame t-faint">
        {instance.name} is vanilla, which can't draw OptiFine capes. Pick a Fabric or Forge instance to see them in game.
      </div>
    );
  }
  if (shown === null) return <Skeleton h={34} r={10} />;
  if (shown) {
    return (
      <div className="of-ingame of-ingame--on">
        <Check />
        <span>
          Shows in game in <b>{instance.name}</b>
        </span>
      </div>
    );
  }
  return (
    <div className="of-ingame">
      <span className="grow">
        Not shown in <b>{instance.name}</b> yet. The Capes mod draws OptiFine capes in game.
      </span>
      <Button
        size="sm"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const plan = await api.planInstall(instance.id, [{ projectId: "capes", projectType: "mod", title: "Capes" }]);
            setDialogs({ plan: { plan, title: "Show OptiFine capes in game" } });
          } catch (e) {
            toast.error("Couldn't add the Capes mod", errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Add Capes mod
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------ find

const QUICK_PICKS = ["Notch", "jeb_", "Dinnerbone", "Technoblade", "Dream", "Grian"];

/** Finds skins by player name (Mojang's public profiles) or by link. */
function FindSkins({
  previewing,
  onPreview,
  canApply,
  onSaved,
}: {
  previewing: string | null;
  onPreview: (f: FoundSkin) => void;
  canApply: boolean;
  onSaved: (saved: SavedSkin, applyNow: boolean) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<FoundSkin | null>(null);
  const [foundHost, setFoundHost] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState<"save" | "apply" | null>(null);

  const search = async (raw?: string) => {
    const q = (raw ?? query).trim();
    if (!q) return;
    if (raw) setQuery(raw);
    setSearching(true);
    setError(null);
    try {
      const isLink = /^https?:\/\//i.test(q);
      const f = isLink ? await api.fetchSkinLink(q) : await api.findPlayerSkin(q);
      setFound(f);
      setFoundHost(isLink ? new URL(q).host.replace(/^www\./, "") : null);
      onPreview(f);
    } catch (e) {
      setFound(null);
      setError(errorMessage(e));
    } finally {
      setSearching(false);
    }
  };

  const save = async (applyNow: boolean) => {
    if (!found) return;
    setSaving(applyNow ? "apply" : "save");
    try {
      const name = found.source === "player" ? `${found.name}'s skin` : found.name;
      const saved = await api.saveFoundSkin(name, found.model, found.dataUrl);
      await onSaved(saved, applyNow);
      setFound(null);
      setQuery("");
    } catch (e) {
      toast.error("Couldn't save the skin", errorMessage(e));
    } finally {
      setSaving(null);
    }
  };

  const setModel = (model: "classic" | "slim") => {
    if (!found) return;
    const next = { ...found, model };
    setFound(next);
    onPreview(next);
  };

  return (
    <div className="col" style={{ gap: 14 }}>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <TextInput value={query} onChange={setQuery} placeholder="Player name or skin link" icon={<Search />} className="grow" autoFocus />
        <Button type="submit" variant="primary" loading={searching} disabled={!query.trim()}>
          Search
        </Button>
      </form>
      <div className="quick-picks">
        <span className="t-faint">Try</span>
        {QUICK_PICKS.map((n) => (
          <button key={n} className="quick-pick" onClick={() => search(n)}>
            {n}
          </button>
        ))}
      </div>

      {error && <Notice tone="warning">{error}</Notice>}

      {found ? (
        <div className={`found-skin glass-inset ${previewing === found.dataUrl ? "found-skin--previewing" : ""}`}>
          <button className="found-skin-art" onClick={() => onPreview(found)} data-tip="Show on the model">
            <SkinFront src={found.dataUrl} slim={found.model === "slim"} height={104} />
          </button>
          <div className="col grow" style={{ gap: 8, minWidth: 0 }}>
            <div>
              <div className="found-skin-name truncate">{found.name}</div>
              <div className="t-faint" style={{ fontSize: 12 }}>
                {found.source === "player" ? "Current skin of this player" : `From ${foundHost ?? "a link"}`}
              </div>
            </div>
            <Segmented
              size="sm"
              value={found.model}
              onChange={setModel}
              options={[
                { value: "classic", label: "Classic arms" },
                { value: "slim", label: "Slim arms" },
              ]}
            />
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <Button size="sm" icon={<Download />} loading={saving === "save"} disabled={!!saving} onClick={() => save(false)}>
                Save
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon={<CloudUpload />}
                loading={saving === "apply"}
                disabled={!!saving || !canApply}
                onClick={() => save(true)}
              >
                Save & apply
              </Button>
            </div>
          </div>
        </div>
      ) : (
        !error && (
          <p className="t-faint" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6 }}>
            Type any player's name to borrow their current skin, or paste a skin link. On skin sites, copy the link of the
            Download button. Found skins show on the model before you save anything.
          </p>
        )
      )}
    </div>
  );
}
