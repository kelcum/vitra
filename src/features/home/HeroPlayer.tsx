import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { resolvedMotion } from "../../lib/appearance";
import { useActiveAccount, useNav, useSettings } from "../../lib/store";
import type { ProfileView, VitraCape } from "../../lib/types";
import { defaultSkin, SkinViewer3D } from "../skins/SkinViewer3D";
import { loadVitraCape, type AnimatedCape } from "../skins/vitraCape";

// Coming back to Home shouldn't ask Mojang for the skin every time.
const PROFILE_TTL_MS = 2 * 60 * 1000;
let profileCache: { uuid: string; at: number; profile: ProfileView } | null = null;

/**
 * You, on the Home screen: your skin wearing your Vitra cape (else your Mojang cape), slowly
 * turning. Loaded separately so the 3D engine doesn't slow down startup.
 */
export default function HeroPlayer({ vitraCape }: { vitraCape: VitraCape | null }) {
  const account = useActiveAccount();
  const accent = useSettings((s) => s.settings?.accent ?? "#7c9cff");
  const motion = useSettings((s) => (s.settings ? resolvedMotion(s.settings) : "full"));
  const navigate = useNav((s) => s.navigate);
  const [profile, setProfile] = useState<ProfileView | null>(() =>
    account && profileCache?.uuid === account.uuid ? profileCache.profile : null,
  );
  const [animated, setAnimated] = useState<AnimatedCape | null>(null);
  const fallback = useMemo(() => defaultSkin(accent), [accent]);

  useEffect(() => {
    if (!account) return setProfile(null);
    if (profileCache?.uuid === account.uuid && Date.now() - profileCache.at < PROFILE_TTL_MS) return setProfile(profileCache.profile);
    let live = true;
    api
      .getProfile()
      .then((p) => {
        profileCache = { uuid: account.uuid, at: Date.now(), profile: p };
        if (live) setProfile(p);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [account?.uuid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setAnimated(null);
    if (vitraCape) loadVitraCape(vitraCape).then(setAnimated).catch(() => {});
  }, [vitraCape?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const cape = animated ?? profile?.capes.find((c) => c.active)?.dataUrl ?? null;

  return (
    <div className="hero-player">
      <div className="hero-player-glow" />
      <SkinViewer3D
        skin={profile?.skinDataUrl ?? fallback}
        model={profile?.skinModel ?? "classic"}
        cape={cape}
        elytra={false}
        animation="idle"
        autoRotate={motion === "full"}
        rotateSpeed={0.55}
        view="showcase"
        viewNonce={0}
        zoom={0.68}
        nameTag={profile?.name ?? account?.name ?? null}
        interactive={false}
      />
      <button className="hero-player-link" onClick={() => navigate("skins")}>
        Skins & capes
      </button>
    </div>
  );
}
