import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { Routes, Route, useNavigate } from "react-router-dom";
import { Header } from "@/components/header";
import { CommandPalette } from "@/components/command-palette";
import { SelectionProvider } from "@/hooks/selection-provider";
import { getSettings } from "@/lib/api";
import { checkForUpdates } from "@/lib/updater";
import HomePage from "@/routes/home";
import FolderPage from "@/routes/folder";
import SearchPage from "@/routes/search";
import SettingsPage from "@/routes/settings";

export default function App() {
  const navigate = useNavigate();

  // First run: land on Settings until S3 is configured.
  useEffect(() => {
    getSettings()
      .then((info) => {
        if (!info.configured) navigate("/settings", { replace: true });
      })
      .catch(() => {});
    if (import.meta.env.PROD) checkForUpdates();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  // The native "Settings…" menu item (Cmd+,) emits this event; open the route.
  useEffect(() => {
    const unlisten = listen("menu://settings", () => navigate("/settings"));
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [navigate]);

  return (
    <SelectionProvider>
      <Header />
      <CommandPalette />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/folders/:folder" element={<FolderPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </SelectionProvider>
  );
}
