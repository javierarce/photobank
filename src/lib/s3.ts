import { S3Client } from "@aws-sdk/client-s3";

const s3Config: ConstructorParameters<typeof S3Client>[0] = {
  region: process.env.S3_REGION!,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  },
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
};

// Only set endpoint and forcePathStyle for non-AWS S3-compatible services
if (process.env.S3_ENDPOINT) {
  s3Config.endpoint = process.env.S3_ENDPOINT;
  s3Config.forcePathStyle = true;
}

export const s3 = new S3Client(s3Config);

export const S3_BUCKET = process.env.S3_BUCKET!;
