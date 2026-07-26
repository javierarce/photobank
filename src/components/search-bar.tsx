import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { SearchField } from "@/components/search-field";

export function SearchBar() {
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get("q") || "");
  const navigate = useNavigate();

  return (
    <SearchField
      value={query}
      onChange={setQuery}
      onSubmit={(value) => {
        const trimmed = value.trim();
        if (trimmed) navigate(`/search?q=${encodeURIComponent(trimmed)}`);
      }}
      placeholder="Search — try tag:sunset, camera:fuji, iso:>=800"
      submitLabel="Search"
    />
  );
}
