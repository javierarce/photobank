import { message } from "@tauri-apps/plugin-dialog";
import type { ExportReport } from "@/lib/api";

export async function showExportResult(report: ExportReport | null) {
  if (!report || (report.requested === 1 && !report.failures.length)) return;
  const detail = report.failures.map((f) => `${f.filename}: ${f.error}`).join("\n");
  await message(
    `Exported ${report.written} of ${report.requested} photos to ${report.path}.` +
      (detail ? `\n\nCould not export:\n${detail}` : ""),
    { title: "Export complete", kind: report.failures.length ? "warning" : "info" }
  );
}
