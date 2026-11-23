import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/funnel-display/500.css";
import "@fontsource/funnel-display/700.css";
import "@fontsource/funnel-sans/400.css";
import "@fontsource/funnel-sans/500.css";
import "@fontsource/funnel-sans/600.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles.css";
import { store, flushSaves, useLoaded } from "./lib/store";
import { requestPersistence } from "./lib/db";
import { migrateOldData } from "./lib/migrate";
import { recoverInterruptedRecordings, recorder } from "./lib/recorder";
import { transcriber } from "./lib/transcriber";
import { botWatcher } from "./lib/bot";
import { Toasts, go, toast, useRoute } from "./ui/kit";
import { Home } from "./ui/Home";
import { RecordScreen } from "./ui/Record";
import { MeetingScreen } from "./ui/Meeting";
import { AskScreen } from "./ui/Ask";
import { SettingsScreen } from "./ui/Settings";
import { Rail } from "./ui/Rail";
import { TasksScreen } from "./ui/Tasks";

function applyTheme() {
  const t = localStorage.getItem("sd-theme") || "system";
  document.documentElement.dataset.theme = t;
}
applyTheme();

class Boundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <h1>Something broke on this screen.</h1>
        <p>Your recordings and notes are saved on this device. Reloading usually fixes it.</p>
        <pre>{this.state.error.message}</pre>
        <button className="btn btn-ink" onClick={() => location.reload()}>
          Reload
        </button>
        <button className="btn btn-quiet" onClick={() => ((location.hash = "#/"), location.reload())}>
          Go to home
        </button>
      </div>
    );
  }
}

function App() {
  const loaded = useLoaded();
  const route = useRoute();
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        await store.load();
        const migrated = await migrateOldData().catch((e) => {
          console.error("migration failed", e);
          return 0;
        });
        if (migrated) {
          await store.load();
          toast(`Brought over ${migrated} meeting${migrated === 1 ? "" : "s"} from the previous version`);
        }
        await recoverInterruptedRecordings();
        transcriber.kick();
        botWatcher.kick();
        void requestPersistence();
      } catch (e: any) {
        toast("Storage could not be opened: " + (e?.message || e), "error");
      } finally {
        setBooted(true);
      }
    })();
    const onHide = () => (document.visibilityState === "hidden" ? flushSaves() : botWatcher.kick());
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flushSaves);
    window.addEventListener("online", () => transcriber.kick());
    const params = new URLSearchParams(location.search);
    if (params.get("action") === "new") {
      history.replaceState(null, "", location.pathname + "#/record");
    }
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);

  // Keep a live recording reachable: warn before closing the tab.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (recorder.active) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  if (!loaded || !booted)
    return (
      <div className="boot">
        <img src="/recapp-mark.png" alt="" />
      </div>
    );

  return (
    <div className={`shell route-${route.name}`}>
      <Rail route={route} />
      <main className="stage">
        <Boundary key={route.name + (route.name === "meeting" ? route.id : "")}>
          {route.name === "home" && <Home />}
          {route.name === "record" && <RecordScreen />}
          {route.name === "meeting" && <MeetingScreen id={route.id} tab={route.tab} />}
          {route.name === "ask" && <AskScreen />}
          {route.name === "settings" && <SettingsScreen />}
          {route.name === "tasks" && <TasksScreen />}
        </Boundary>
      </main>
      <Toasts />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

if ("serviceWorker" in navigator && location.hostname !== "localhost") {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
export { go };
