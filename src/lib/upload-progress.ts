import type { UploadFile } from "@/hooks/use-upload";

/** Batch-level progress for a set of in-flight imports. */
export type UploadSummary = {
  /** Files in the batch, failures excluded — the percentage's denominator. */
  total: number;
  /** How many of them have finished uploading. */
  completed: number;
  /** Files still uploading (or queued, or cancelling). */
  active: number;
  /** Whole-batch progress, 0–100. */
  percent: number;
  /** Files that errored out; they sit outside the ratio entirely. */
  failed: number;
};

/**
 * Roll a folder's upload tiles up into one percentage.
 *
 * `retired` is the number of files that already finished and whose tiles have
 * since been dismissed: their tiles are gone from `files`, but they're still
 * part of the batch the user dropped, so they stay in both sides of the ratio.
 * Without them the percentage would slide backwards as tiles disappear.
 *
 * Failed files are excluded from the ratio — they'll never advance, so leaving
 * them in would peg the batch below 100% forever. They're counted separately
 * so callers can say so.
 */
export function summarizeUploads(
  files: UploadFile[],
  retired = 0
): UploadSummary {
  const inFlight = files.filter((f) => f.status !== "error");
  const failed = files.length - inFlight.length;
  const total = inFlight.length + retired;
  const completed =
    retired + inFlight.filter((f) => f.status === "done").length;
  const percent = total
    ? Math.round(
        (inFlight.reduce((sum, f) => sum + f.progress, 0) + retired * 100) /
          total
      )
    : 0;
  return { total, completed, active: total - completed, percent, failed };
}
