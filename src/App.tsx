import { Routes, Route } from "react-router-dom";
import { Header } from "@/components/header";
import HomePage from "@/routes/home";
import FolderPage from "@/routes/folder";
import SearchPage from "@/routes/search";

export default function App() {
  return (
    <>
      <Header />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/folders/:folder" element={<FolderPage />} />
        <Route path="/search" element={<SearchPage />} />
      </Routes>
    </>
  );
}
