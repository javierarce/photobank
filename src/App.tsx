import { useEffect } from "react";
import { Routes, Route, useNavigate } from "react-router-dom";
import { Header } from "@/components/header";
import { getSettings } from "@/lib/api";
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  return (
    <>
      <Header />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/folders/:folder" element={<FolderPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </>
  );
}
