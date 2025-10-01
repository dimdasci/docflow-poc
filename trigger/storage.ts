import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

// Create a singleton S3 client for Supabase Storage
let s3Client: S3Client | null = null;

export function getStorageClient() {
  if (!s3Client) {
    const endpoint = process.env.SUPABASE_STORAGE_ACCESS_POINT;
    const region = process.env.SUPABASE_STORAGE_REGION;
    const accessKeyId = process.env.SUPABASE_STORAGE_ACCESS_KEY_ID;
    const secretAccessKey = process.env.SUPABASE_STORAGE_ACCESS_KEY;

    if (!endpoint || !region || !accessKeyId || !secretAccessKey) {
      throw new Error("Missing Supabase Storage environment variables");
    }

    s3Client = new S3Client({
      forcePathStyle: true,
      region: region,
      endpoint: endpoint,
      credentials: {
        accessKeyId: accessKeyId,
        secretAccessKey: secretAccessKey,
      },
    });
  }

  return s3Client;
}

export function getBucket() {
  const bucket = process.env.SUPABASE_STORAGE_BUCKET;
  if (!bucket) {
    throw new Error("SUPABASE_STORAGE_BUCKET environment variable is not set");
  }
  return bucket;
}

/**
 * Upload a file to Supabase Storage
 */
export async function uploadFile(
  key: string,
  buffer: Buffer,
  contentType: string,
  originalFilename?: string
) {
  const client = getStorageClient();
  const bucket = getBucket();

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    Metadata: originalFilename ? {
      'original-filename': originalFilename,
    } : undefined,
  });

  await client.send(command);

  return {
    bucket,
    key,
    url: `${process.env.SUPABASE_STORAGE_ACCESS_POINT}/${bucket}/${key}`,
  };
}

/**
 * Download a file from Supabase Storage
 */
export async function downloadFile(key: string): Promise<Buffer> {
  const client = getStorageClient();
  const bucket = getBucket();

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  const response = await client.send(command);

  if (!response.Body) {
    throw new Error(`File not found: ${key}`);
  }

  // Convert stream to buffer
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body as any) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

/**
 * Delete a file from Supabase Storage
 */
export async function deleteFile(key: string) {
  const client = getStorageClient();
  const bucket = getBucket();

  const command = new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  await client.send(command);

  return { bucket, key, deleted: true };
}
