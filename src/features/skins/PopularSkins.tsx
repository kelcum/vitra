import { CloudUpload, Download } from "lucide-react";
import { useEffect, useState } from "react";
import { SkinFront } from "../../components/art/PlayerHead";
import { Button } from "../../components/ui/Button";
import { Skeleton } from "../../components/ui/Feedback";
import { api, errorMessage } from "../../lib/api";
import { toast } from "../../lib/store";
import type { FoundSkin, SavedSkin } from "../../lib/types";

/**
 * Well-known players. Nobody publishes a list of the most-worn skins (NameMC's trending lists
 * aren't open to apps), so these are fetched live from Mojang: always each player's current skin.
 */
const POPULAR = [
  "Technoblade", "Dream", "GeorgeNotFound", "Sapnap", "TommyInnit", "Tubbo",
  "Ph1LzA", "WilburSoot", "Ranboo", "Quackity", "Skeppy", "BadBoyHalo",
  "Grian", "MumboJumbo", "xisumavoid", "Purpled", "Illumina", "CaptainSparklez",
  "Fundy", "Hbomb94", "Smajor1995", "Notch", "jeb_", "Dinnerbone",
];

/** Lookups survive switching tabs; null means the player has no custom skin or doesn't exist. */
const cache = new Map<string, FoundSkin | null>();
const loaded = () => POPULAR.map((n) => cache.get(n)).filter((f): f is FoundSkin => !!f);

export function PopularSkins({
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
  const [skins, setSkins] = useState<FoundSkin[]>(loaded);
  const [loading, setLoading] = useState(() => POPULAR.some((n) => !cache.has(n)));
  const [selected, setSelected] = useState<FoundSkin | null>(null);
  const [saving, setSaving] = useState<"save" | "apply" | null>(null);

  useEffect(() => {
    let live = true;
    const todo = POPULAR.filter((n) => !cache.has(n));
    let next = 0;
    // Three lookups at a time keeps well under Mojang's limits.
    const worker = async () => {
      while (live && next < todo.length) {
        const name = todo[next++];
        try {
          cache.set(name, await api.findPlayerSkin(name));
        } catch (e) {
          // Remember players that don't exist or use a default skin; retry anything else later.
          if (/^No Minecraft player|default skins/.test(errorMessage(e))) cache.set(name, null);
        }
        if (live) setSkins(loaded());
      }
    };
    Promise.all([worker(), worker(), worker()]).then(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  const save = async (applyNow: boolean) => {
    if (!selected) return;
    setSaving(applyNow ? "apply" : "save");
    try {
      const saved = await api.saveFoundSkin(`${selected.name}'s skin`, selected.model, selected.dataUrl);
      await onSaved(saved, applyNow);
    } catch (e) {
      toast.error("Couldn't save the skin", errorMessage(e));
    } finally {
      setSaving(null);
    }
  };

  const active = selected && previewing === selected.dataUrl ? selected : null;

  return (
    <div className="col" style={{ gap: 12 }}>
      {active ? (
        <div className="popular-actions glass-inset">
          <span className="grow truncate" style={{ fontSize: 13 }}>
            <b>{active.name}</b>
            <span className="t-faint">'s skin is on the model</span>
          </span>
          <Button size="sm" icon={<Download />} loading={saving === "save"} disabled={!!saving} onClick={() => save(false)}>
            Save
          </Button>
          <Button size="sm" variant="primary" icon={<CloudUpload />} loading={saving === "apply"} disabled={!!saving || !canApply} onClick={() => save(true)}>
            Save & apply
          </Button>
        </div>
      ) : (
        <p className="t-faint" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6 }}>
          The current skins of well-known players. Click one to try it on.
        </p>
      )}
      <div className="skin-grid">
        {skins.map((f) => (
          <button
            key={f.name}
            className={`skin-card ${previewing === f.dataUrl ? "skin-card--selected" : ""}`}
            onClick={() => {
              setSelected(f);
              onPreview(f);
            }}
          >
            <SkinFront src={f.dataUrl} slim={f.model === "slim"} height={88} />
            <div className="skin-card-name truncate">{f.name}</div>
          </button>
        ))}
        {loading && [0, 1, 2].map((i) => <Skeleton key={i} h={130} r={14} />)}
      </div>
    </div>
  );
}
