import { FolderList } from "@/components/folder-list";

export default function HomePage() {
  return (
    <div className="relative min-h-screen font-sans">
      <main className="mx-auto max-w-[1600px] px-6 py-8">
        <section>
          <h2 className="mb-4 text-lg font-semibold text-foreground">
            Folders
          </h2>
          <FolderList />
        </section>
      </main>
    </div>
  );
}
