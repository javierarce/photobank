export function formatShutterSpeed(exposureTime: number): string {
  if (exposureTime >= 1) return `${exposureTime}s`;
  return `1/${Math.round(1 / exposureTime)}s`;
}

/**
 * EXIF stores GPS coordinates as [degrees, minutes, seconds] plus a
 * hemisphere ref ("N"/"S"/"E"/"W"). Convert to a signed decimal.
 */
export function gpsToDecimal(coord: unknown, ref: unknown): number | null {
  if (!Array.isArray(coord) || coord.length !== 3) return null;
  const [deg, min, sec] = coord as number[];
  if (![deg, min, sec].every((n) => typeof n === "number" && Number.isFinite(n))) {
    return null;
  }
  const decimal = deg + min / 60 + sec / 3600;
  return ref === "S" || ref === "W" ? -decimal : decimal;
}
