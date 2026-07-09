import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3, S3_BUCKET } from "@/lib/s3";

export async function GET(request: NextRequest) {
  const key = request.nextUrl.searchParams.get("key");

  if (!key) {
    return NextResponse.json({ error: "key is required" }, { status: 400 });
  }

  const command = new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
  });

  const url = await getSignedUrl(s3, command, { expiresIn: 3600 });

  // Let browsers cache the redirect (shorter than the presign expiry) so
  // repeat views don't re-hit this route for every thumbnail
  return NextResponse.redirect(url, {
    headers: { "Cache-Control": "private, max-age=3000" },
  });
}
