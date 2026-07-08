import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/auth";

// HTTP Basic auth for the whole app (pages + API). Enabled by setting
// AUTH_PASSWORD; when unset (e.g. local dev), everything stays open.
export default function proxy(request: NextRequest) {
  const password = process.env.AUTH_PASSWORD;
  if (!password) return NextResponse.next();

  const username = process.env.AUTH_USERNAME || "admin";
  const header = request.headers.get("authorization");

  if (isAuthorized(header, username, password)) {
    return NextResponse.next();
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Photobank"' },
  });
}

export const config = {
  // Everything except Next.js internals and the favicon
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
