import { google } from "googleapis";
import type { drive_v3 } from "googleapis";

/**
 * Create a new Google Drive client instance
 * Note: Not using singleton to avoid memory accumulation in long-running tasks
 */
export function getDriveClient(): drive_v3.Drive {
  // Use GoogleAuth with keyFile or JWT constructor for service account credentials
  const auth = process.env.GOOGLE_APPLICATION_CREDENTIALS
    ? new google.auth.GoogleAuth({
        keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
        scopes: ["https://www.googleapis.com/auth/drive"],
      })
    : new google.auth.JWT({
        email: process.env.GOOGLE_CLIENT_EMAIL,
        key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
        scopes: ["https://www.googleapis.com/auth/drive"],
        keyId: process.env.GOOGLE_PRIVATE_KEY_ID,
      });

  return google.drive({ version: "v3", auth });
}

/**
 * Download a file from Google Drive as a Buffer
 */
export async function downloadFileFromDrive(fileId: string): Promise<Buffer> {
  const drive = getDriveClient();

  try {
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
  } catch (error) {
    // Simplify error to prevent stack trace explosion with googleapis
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to download file ${fileId}: ${message}`);
  }
}

/**
 * Get file metadata from Google Drive
 */
export async function getFileMetadata(fileId: string) {
  const drive = getDriveClient();

  try {
    const response = await drive.files.get({
      fileId: fileId,
      fields: "id, name, mimeType, size, createdTime, modifiedTime, md5Checksum",
    });

    return response.data;
  } catch (error) {
    // Simplify error to prevent stack trace explosion with googleapis
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to get metadata for file ${fileId}: ${message}`);
  }
}

/**
 * Move a file to a different folder in Google Drive
 */
export async function moveFileToFolder(fileId: string, targetFolderId: string) {
  const drive = getDriveClient();

  try {
    // Get current parents
    const file = await drive.files.get({
      fileId: fileId,
      fields: 'parents',
    });

    const previousParents = file.data.parents?.join(',') || '';

    // Move the file by removing from current parents and adding to new parent
    await drive.files.update({
      fileId: fileId,
      addParents: targetFolderId,
      removeParents: previousParents,
      fields: 'id, parents',
    });

    return { fileId, moved: true, targetFolderId };
  } catch (error) {
    // Simplify error to prevent stack trace explosion with googleapis
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to move file ${fileId} to folder ${targetFolderId}: ${message}`);
  }
}

/**
 * Delete a file from Google Drive
 * @deprecated Use moveFileToFolder instead for better traceability
 */
export async function deleteFileFromDrive(fileId: string) {
  const drive = getDriveClient();

  try {
    await drive.files.delete({
      fileId: fileId,
    });

    return { fileId, deleted: true };
  } catch (error) {
    // Simplify error to prevent stack trace explosion with googleapis
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to delete file ${fileId}: ${message}`);
  }
}
