import { TagList } from "@/components/tag-list";

export default function TagsPage() {
  return (
    <div className="relative min-h-screen font-sans">
      <main className="mx-auto max-w-5xl px-6 py-8">
        <section>
          <h2 className="mb-4 text-lg font-semibold text-foreground">Tags</h2>
          <TagList />
        </section>
      </main>
    </div>
  );
}
