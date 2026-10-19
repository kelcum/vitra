import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { lazy, Suspense, useEffect, useState } from "react";
import { Background } from "./components/art/Background";
import { Dialogs } from "./components/dialogs/Dialogs";
import { TopBar } from "./components/shell/TopBar";
import { Spinner } from "./components/ui/Feedback";
import { Boot } from "./features/boot/Boot";
import { Home } from "./features/home/Home";
import { onSystemAppearanceChange, applyAppearance, resolvedMotion } from "./lib/appearance";
import { useNav, useSettings } from "./lib/store";
import { startUpdateChecks } from "./lib/updater";

const Library = lazy(() => import("./features/library/Library"));
const InstancePage = lazy(() => import("./features/instance/InstancePage"));
const Memories = lazy(() => import("./features/memories/Memories"));
const Discover = lazy(() => import("./features/discover/Discover"));
const Servers = lazy(() => import("./features/servers/Servers"));
const Skins = lazy(() => import("./features/skins/Skins"));
const Performance = lazy(() => import("./features/performance/Performance"));
const SettingsPage = lazy(() => import("./features/settings/SettingsPage"));

function Shell() {
  const page = useNav((s) => s.page);
  const params = useNav((s) => s.params);
  const key = page === "instance" ? `instance-${params.id}` : page;
  useEffect(() => startUpdateChecks(), []);

  return (
    <motion.div className="app" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }}>
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} transition={{ type: "spring", stiffness: 260, damping: 30, delay: 0.05 }}>
        <TopBar />
      </motion.div>
      <div className="app-body">
        <main className="main">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={key}
              className="page"
              initial={{ opacity: 0, y: 12, scale: 0.995 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, transition: { duration: 0.12, ease: "easeIn" } }}
              transition={{ type: "spring", stiffness: 380, damping: 36, mass: 0.8 }}
            >
              <Suspense
                fallback={
                  <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
                    <Spinner />
                  </div>
                }
              >
                {page === "home" && <Home />}
                {page === "library" && <Library />}
                {page === "instance" && <InstancePage id={params.id} initialTab={params.tab} />}
                {page === "memories" && <Memories />}
                {page === "discover" && <Discover initialType={params.type} />}
                {page === "servers" && <Servers />}
                {page === "skins" && <Skins />}
                {page === "performance" && <Performance />}
                {page === "settings" && <SettingsPage initialSection={params.section} />}
              </Suspense>
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </motion.div>
  );
}

export function App() {
  const [ready, setReady] = useState(false);
  const settings = useSettings((s) => s.settings);

  useEffect(() => {
    onSystemAppearanceChange(() => {
      const s = useSettings.getState().settings;
      if (s) applyAppearance(s);
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.key === "ArrowLeft") useNav.getState().back();
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) useNav.getState().back();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mouseup", onMouse);
    const onContext = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest("input, textarea, .selectable")) e.preventDefault();
    };
    window.addEventListener("contextmenu", onContext);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mouseup", onMouse);
      window.removeEventListener("contextmenu", onContext);
    };
  }, []);

  const motionPref = settings ? resolvedMotion(settings) : "full";

  return (
    <MotionConfig reducedMotion={motionPref === "full" ? "never" : "always"}>
      <Background />
      <AnimatePresence mode="wait">{ready ? <Shell key="shell" /> : <Boot key="boot" onReady={() => setReady(true)} />}</AnimatePresence>
      {ready && <Dialogs />}
    </MotionConfig>
  );
}
