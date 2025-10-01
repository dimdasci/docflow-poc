import { google } from "googleapis";
import type { drive_v3 } from "googleapis";

// Create a singleton Google Drive client
let driveClient: drive_v3.Drive | null = null;

export function getDriveClient() {
  if (!driveClient) {
    // Use the same authentication approach as cron package
    const auth = process.env.GOOGLE_APPLICATION_CREDENTIALS
      ? new google.auth.GoogleAuth({
          keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
          scopes: ["https://www.googleapis.com/auth/drive"],
        })
      : new google.auth.GoogleAuth({
          credentials: {
            type: "service_account",
            project_id: process.env.GOOGLE_PROJECT_ID,
            private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
            private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
            client_email: process.env.GOOGLE_CLIENT_EMAIL,
            client_id: process.env.GOOGLE_CLIENT_ID,
          },
          scopes: ["https://www.googleapis.com/auth/drive"],
        });

    driveClient = google.drive({ version: "v3", auth });
  }

  return driveClient;
}

/**
 * Download a file from Google Drive as a Buffer
 */
export async function downloadFileFromDrive(fileId: string): Promise<Buffer> {
  const drive = getDriveClient();

  const response = await drive.files.get(
    {
      fileId: fileId,
      alt: "media",
    },
    {
      responseType: "arraybuffer",
    }
  );

  return Buffer.from(response.data as ArrayBuffer);
}

/**
 * Get file metadata from Google Drive
 */
export async function getFileMetadata(fileId: string) {
  const drive = getDriveClient();

  const response = await drive.files.get({
    fileId: fileId,
    fields: "id, name, mimeType, size, createdTime, modifiedTime, md5Checksum",
  });

  return response.data;
}

/**
 * Delete a file from Google Drive
 */
export async function deleteFileFromDrive(fileId: string) {
  const drive = getDriveClient();

  await drive.files.delete({
    fileId: fileId,
  });

  return { fileId, deleted: true };
}
