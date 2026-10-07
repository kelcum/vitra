import { AtSign, Check, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { TextInput } from "../../components/ui/Controls";
import { Notice, Skeleton } from "../../components/ui/Feedback";
import { Modal } from "../../components/ui/Overlay";
import { api, errorMessage } from "../../lib/api";
import { toast, useAccounts } from "../../lib/store";
import type { NameChangeInfo, ProfileView } from "../../lib/types";
import { NAME_RE, nameIdeas, nameProblem } from "./names";

/** How many free names to suggest. */
const IDEAS = 6;
const DAY_MS = 86_400_000;

const longDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });

type Result = {
  name: string;
  /** "yours" when it's already your name; null when Mojang paused before checking it. */
  status: "available" | "taken" | "not_allowed" | "invalid" | "yours" | null;
  ideas: string[];
  limited: boolean;
};

/**
 * Change your Minecraft name without going to minecraft.net. Checks the name with Mojang and, when
 * it's taken, suggests the closest names that are still free.
 */
export function NameChangeDialog({
  open,
  current,
  onClose,
  onChanged,
}: {
  open: boolean;
  current: string;
  onClose: () => void;
  onChanged: (profile: ProfileView) => void;
}) {
  const [info, setInfo] = useState<NameChangeInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setInfo(null);
    setInfoError(null);
    setQuery("");
    setResult(null);
    setError(null);
    setConfirm(null);
    api.nameChangeInfo().then(setInfo).catch((e) => setInfoError(errorMessage(e)));
  }, [open]);

  const allowed = info?.allowed ?? false;
  const typed = query.trim();
  const problem = nameProblem(typed);

  const check = async () => {
    if (!typed) return;
    setChecking(true);
    setError(null);
    try {
      const own = typed.toLowerCase() === current.toLowerCase();
      const valid = NAME_RE.test(typed);
      const ideas = nameIdeas(typed).filter((n) => n.toLowerCase() !== current.toLowerCase());
      const r = await api.checkNames([...(valid && !own ? [typed] : []), ...ideas], IDEAS + 1);
      const self = r.results.find((x) => x.name === typed);
      setResult({
        name: typed,
        status: own ? "yours" : !valid ? "invalid" : (self?.status ?? null),
        ideas: r.results.filter((x) => x.status === "available" && x.name !== typed).map((x) => x.name).slice(0, IDEAS),
        limited: r.limited,
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setChecking(false);
    }
  };

  const change = async () => {
    if (!confirm) return;
    setSaving(true);
    try {
      const profile = await api.changeName(confirm);
      onChanged(profile);
      await useAccounts.getState().refresh();
      toast.success(`You're ${profile.name} now`, "Rejoin servers and worlds to show the new name.");
      onClose();
    } catch (e) {
      toast.error("Couldn't change your name", errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const verdict = (r: Result) => {
    switch (r.status) {
      case "available":
        return { tone: "ok", text: `${r.name} is free` };
      case "taken":
        return { tone: "bad", text: `${r.name} is taken` };
      case "not_allowed":
        return { tone: "bad", text: `Mojang doesn't allow ${r.name}` };
      case "invalid":
        return { tone: "bad", text: nameProblem(r.name) ?? `${r.name} can't be a name` };
      case "yours":
        return { tone: "neutral", text: "That's already your name" };
      default:
        return { tone: "neutral", text: `Couldn't check ${r.name} yet` };
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={<AtSign />}
      title={confirm ? "Change your name?" : "Change your name"}
      description={confirm ? undefined : "Vitra checks names with Mojang and suggests close ones that are still free."}
      footer={
        confirm ? (
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)} disabled={saving}>
              Back
            </Button>
            <Button variant="primary" loading={saving} onClick={change}>
              Change to {confirm}
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      {confirm ? (
        <div className="col" style={{ gap: 14 }}>
          <div className="name-swap">
            <span className="t-faint">{current}</span>
            <span className="name-swap-arrow">→</span>
            <b>{confirm}</b>
          </div>
          <p className="t-muted" style={{ margin: 0, lineHeight: 1.6, fontSize: 13 }}>
            Mojang allows one name change every 30 days, so you won't be able to change it again until{" "}
            <b>{longDate(Date.now() + 30 * DAY_MS)}</b>. Your skin, capes, worlds and friends stay the same.
          </p>
        </div>
      ) : (
        <div className="col" style={{ gap: 14 }}>
          {infoError && <Notice tone="warning">{infoError}</Notice>}
          {info && !info.allowed && (
            <Notice tone="warning">
              You changed your name recently.{" "}
              {info.nextChangeAt ? `Mojang lets you change it again on ${longDate(info.nextChangeAt)}.` : "Mojang doesn't allow another change yet."} You can still
              look for names now.
            </Notice>
          )}
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              check();
            }}
          >
            <TextInput value={query} onChange={setQuery} placeholder="New name" icon={<AtSign />} className="grow" autoFocus />
            <Button type="submit" variant="primary" icon={<Search />} loading={checking} disabled={!typed}>
              Check
            </Button>
          </form>
          {problem && result?.name !== typed && (
            <span className="t-faint" style={{ fontSize: 12.5, marginTop: -6 }}>
              {problem}
            </span>
          )}
          {error && <Notice tone="warning">{error}</Notice>}

          {checking && !result && <Skeleton h={46} r={12} />}
          {result && (
            <>
              {(() => {
                const v = verdict(result);
                return (
                  <div className={`name-verdict name-verdict--${v.tone}`}>
                    {v.tone === "ok" ? <Check /> : v.tone === "bad" ? <X /> : <AtSign />}
                    <span className="grow">{v.text}</span>
                    {result.status === "available" && (
                      <Button size="sm" variant="primary" disabled={!allowed} onClick={() => setConfirm(result.name)}>
                        Use this name
                      </Button>
                    )}
                  </div>
                );
              })()}
              <div>
                <div className="t-label" style={{ marginBottom: 8 }}>
                  {result.status === "available" ? "Also free" : "Close names that are free"}
                </div>
                {result.ideas.length > 0 ? (
                  <div className="name-ideas">
                    {result.ideas.map((n) => (
                      <button key={n} className="name-idea" disabled={!allowed} onClick={() => setConfirm(n)} data-tip={allowed ? "Use this name" : undefined}>
                        {n}
                      </button>
                    ))}
                  </div>
                ) : (
                  <span className="t-faint" style={{ fontSize: 12.5 }}>
                    {result.limited ? "" : "Nothing free close to that. Try a slightly different name."}
                  </span>
                )}
                {result.limited && (
                  <span className="t-faint" style={{ display: "block", fontSize: 12.5, marginTop: 8 }}>
                    Mojang paused name checks for a moment. Check again in a minute for more ideas.
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
