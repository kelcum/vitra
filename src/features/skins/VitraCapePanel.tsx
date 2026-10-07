import { Check, ImagePlus, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Notice, Skeleton } from "../../components/ui/Feedback";
import { api, errorMessage } from "../../lib/api";
import { forgetAccountData } from "../../lib/cache";
import { toast, useActiveAccount, useSelectedInstance, useSettings } from "../../lib/store";
import type { CosmeticsStatus, VitraCape } from "../../lib/types";
import { loadVitraCape, prepareCape, type AnimatedCape, type PreparedCape } from "./vitraCape";

type Choice = { kind: "none" } | { kind: "preset"; slug: string } | { kind: "current" } | { kind: "upload" };

const same = (a: Choice, b: Choice) =>
  a.kind === b.kind && (a.kind !== "preset" || (b.kind === "preset" && a.slug === b.slug));

/** The visible outside of a cape (the 10×16 face at 1,1), animated when the cape is. */
export function CapeThumb({ cape }: { cape: AnimatedCape | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !cape) return;
    const g = c.getContext("2d")!;
    g.imageSmoothingEnabled = false;
    let i = 0;
    const draw = () => {
      const f = cape.frames[i];
      const s = f.width / 64;
      g.clearRect(0, 0, c.width, c.height);
      g.drawImage(f, s, s, 10 * s, 16 * s, 0, 0, c.width, c.height);
      i = (i + 1) % cape.frames.length;
    };
    draw();
    if (cape.frames.length < 2) return;
    const t = setInterval(draw, Math.max(30, cape.delay));
    return () => clearInterval(t);
  }, [cape]);
  return <canvas ref={ref} className="vcape-thumb" width={30} height={48} />;
}

/**
 * Free Vitra capes: presets or your own picture / GIF. Everyone playing on Vitra sees them, next to
 * the Vitra badge on your name.
 */
export function VitraCapePanel({ previewing, onPreview }: { previewing: boolean; onPreview: (cape: AnimatedCape | null) => void }) {
  const account = useActiveAccount();
  const instance = useSelectedInstance();
  const enabled = useSettings((s) => s.settings?.cosmetics ?? true);
  const [status, setStatus] = useState<CosmeticsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [art, setArt] = useState<Record<string, AnimatedCape>>({});
  const [choice, setChoice] = useState<Choice>({ kind: "none" });
  const [upload, setUpload] = useState<PreparedCape | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [supported, setSupported] = useState<boolean | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = (c: VitraCape | null | undefined) => {
    if (c) loadVitraCape(c).then((a) => setArt((m) => ({ ...m, [c.id]: a }))).catch(() => {});
  };

  const refresh = () =>
    api
      .cosmeticsStatus()
      .then((s) => {
        setStatus(s);
        setError(null);
        s.presets.forEach((p) => load(p.cape));
        load(s.cape);
        const preset = s.presets.find((p) => p.cape.id === s.cape?.id);
        setChoice(preset ? { kind: "preset", slug: preset.slug } : s.cape ? { kind: "current" } : { kind: "none" });
      })
      .catch((e) => setError(errorMessage(e)));

  useEffect(() => {
    refresh();
  }, [account?.uuid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setSupported(null);
    if (instance) api.cosmeticsSupported(instance.loader, instance.gameVersion).then(setSupported).catch(() => setSupported(false));
  }, [instance?.id, instance?.loader, instance?.gameVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const capeFor = (c: Choice): AnimatedCape | null => {
    if (c.kind === "upload") return upload;
    if (c.kind === "current") return status?.cape ? art[status.cape.id] ?? null : null;
    if (c.kind === "preset") {
      const p = status?.presets.find((x) => x.slug === c.slug);
      return p ? art[p.cape.id] ?? null : null;
    }
    return null;
  };

  const pick = (c: Choice) => {
    setChoice(c);
    onPreview(capeFor(c));
  };

  // Show your Vitra cape on the model once it has loaded.
  useEffect(() => {
    if (status?.cape && art[status.cape.id] && !previewing && choice.kind !== "none") onPreview(capeFor(choice));
  }, [status?.cape?.id, art[status?.cape?.id ?? ""]]); // eslint-disable-line react-hooks/exhaustive-deps

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setPreparing(true);
    try {
      const prepared = await prepareCape(file);
      setUpload(prepared);
      setChoice({ kind: "upload" });
      onPreview(prepared);
    } catch (e) {
      toast.error("Couldn't use that image", errorMessage(e));
    } finally {
      setPreparing(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const currentChoice: Choice = (() => {
    const preset = status?.presets.find((p) => p.cape.id === status?.cape?.id);
    return preset ? { kind: "preset", slug: preset.slug } : status?.cape ? { kind: "current" } : { kind: "none" };
  })();
  const changed = !same(choice, currentChoice);

  const apply = async () => {
    setSaving(true);
    try {
      if (choice.kind === "preset") await api.setVitraCape({ preset: choice.slug });
      else if (choice.kind === "upload" && upload) await api.setVitraCape({ image: upload.png, frames: upload.frames.length, delay: upload.delay });
      else if (choice.kind === "none") await api.setVitraCape({});
      forgetAccountData();
      await refresh();
      if (choice.kind === "upload") setUpload(null);
      toast.success(choice.kind === "none" ? "Vitra cape off" : "Vitra cape on", "Players on Vitra see it within a minute. Rejoin a world to see it yourself.");
    } catch (e) {
      toast.error("Couldn't change your Vitra cape", errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="glass panel">
      <div className="panel-head">
        <Sparkles />
        <h2>Vitra cape</h2>
        <span className="chip chip--accent">Free</span>
        <span className="spacer" />
        <Button size="sm" icon={<ImagePlus />} loading={preparing} onClick={() => fileRef.current?.click()}>
          Upload GIF or image
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/gif,image/png,image/webp,image/jpeg"
          hidden
          onChange={(e) => onFile(e.target.files?.[0])}
        />
      </div>
      <p className="t-faint" style={{ margin: "0 0 12px", fontSize: 12.5, lineHeight: 1.55 }}>
        Animated capes included. Everyone playing on Vitra sees yours, and a Vitra badge next to your name.
      </p>

      {error ? (
        <Notice tone="warning">Couldn't reach Vitra's cape server: {error}</Notice>
      ) : !status ? (
        <div className="cape-row">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} w={54} h={72} r={12} />
          ))}
        </div>
      ) : (
        <div className="col" style={{ gap: 12 }}>
          <div className="cape-row">
            <button className="cape-choice" aria-pressed={previewing && choice.kind === "none"} onClick={() => pick({ kind: "none" })}>
              <span className="cape-none">None</span>
              {currentChoice.kind === "none" && <span className="cape-active" />}
            </button>
            {status.presets.map((p) => {
              const c: Choice = { kind: "preset", slug: p.slug };
              return (
                <button key={p.slug} className="cape-choice" aria-pressed={previewing && same(choice, c)} onClick={() => pick(c)} data-tip={p.name}>
                  <CapeThumb cape={art[p.cape.id] ?? null} />
                  {same(currentChoice, c) && <span className="cape-active" />}
                </button>
              );
            })}
            {status.cape && currentChoice.kind === "current" && (
              <button className="cape-choice" aria-pressed={previewing && choice.kind === "current"} onClick={() => pick({ kind: "current" })} data-tip="Your cape">
                <CapeThumb cape={art[status.cape.id] ?? null} />
                <span className="cape-active" />
              </button>
            )}
            {upload && (
              <button className="cape-choice" aria-pressed={previewing && choice.kind === "upload"} onClick={() => pick({ kind: "upload" })} data-tip="Your upload">
                <CapeThumb cape={upload} />
              </button>
            )}
          </div>

          <div className="row">
            <span className="t-faint grow" style={{ fontSize: 12.5 }}>
              {choice.kind === "upload" && upload
                ? `${upload.frames.length > 1 ? `${upload.frames.length} frames` : "Still image"} · not applied yet`
                : choice.kind === "preset"
                  ? status.presets.find((p) => p.slug === choice.slug)?.name
                  : choice.kind === "current"
                    ? "Your own cape"
                    : "No Vitra cape"}
            </span>
            <Button
              size="sm"
              variant={changed ? "primary" : "default"}
              disabled={!changed || !account}
              loading={saving}
              onClick={apply}
              icon={changed ? undefined : <Check />}
            >
              {!account ? "Sign in to wear it" : changed ? "Apply" : "Applied"}
            </Button>
          </div>

          {instance && (
            <div className={`of-ingame ${enabled && supported ? "of-ingame--on" : ""}`}>
              {enabled && supported && <Check />}
              <span className="grow">
                {!enabled ? (
                  <>Turned off in Settings → Launcher.</>
                ) : supported === null ? (
                  <>Checking {instance.name}…</>
                ) : supported ? (
                  <>
                    Shows in game in <b>{instance.name}</b>
                  </>
                ) : (
                  <>
                    Vitra capes show in <b>Fabric 26.3</b> instances. {instance.name} is{" "}
                    {instance.loader === "vanilla" ? "vanilla" : `${instance.loader} ${instance.gameVersion}`}.
                  </>
                )}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
