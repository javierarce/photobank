// HTTP Basic auth check, edge-runtime compatible (no node:crypto).

function safeEqual(a: string, b: string) {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/** Validate an `Authorization: Basic ...` header against expected credentials. */
export function isAuthorized(
  header: string | null,
  username: string,
  password: string
): boolean {
  if (!header?.startsWith("Basic ")) return false;

  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }

  const colon = decoded.indexOf(":");
  if (colon === -1) return false;

  const userOk = safeEqual(decoded.slice(0, colon), username);
  const passOk = safeEqual(decoded.slice(colon + 1), password);
  return userOk && passOk;
}
