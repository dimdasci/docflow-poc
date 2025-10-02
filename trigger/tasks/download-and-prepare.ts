import { task } from "@trigger.dev/sdk";
import { getDb } from "../utils/db";
import { downloadFileFromDrive, getFileMetadata } from "../utils/drive";
import { uploadFile } from "../utils/storage";
import type { FileMetadata } from "../types/domain";

// ============================================================================
// TASK 1: DOWNLOAD AND PREPARE (Hidden)
// ============================================================================

export const downloadAndPrepare = task({
  id: "download-and-prepare",
  retry: {
    maxAttempts: 5,
    factor: 2,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 10000,
    randomize: true,
  },
  run: async (payload: {
    docId: string;
    fileId: string;
    fileName: string;
    mimeType: string;
  }) => {
    const taskId = "download-and-prepare";
    console.log(
      `[${taskId}] Starting with payload:`,
      JSON.stringify(payload, null, 2)
    );

    const sql = getDb();

    try {
      // Update status to "downloading"
      console.log(`[${taskId}] Updating status to "downloading"...`);
      await sql`
        UPDATE income_registry
        SET status = 'downloading'
        WHERE doc_id = ${payload.docId}
      `;

      // Validate MIME type
      console.log(`[${taskId}] Validating MIME type...`);
      if (payload.mimeType !== "application/pdf") {
        console.log(
          `[${taskId}] ERROR: Invalid MIME type "${payload.mimeType}"`
        );

        // Update status to "download_failed"
        await sql`
          UPDATE income_registry
          SET status = 'download_failed',
              error_message = ${`Unsupported MIME type: ${payload.mimeType}`}
          WHERE doc_id = ${payload.docId}
        `;

        throw new Error(`Unsupported MIME type: ${payload.mimeType}`);
      }
      console.log(`[${taskId}] ✓ MIME type validated: application/pdf`);

      // Get file metadata from Google Drive
      console.log(`[${taskId}] Fetching file metadata from Google Drive...`);
      const driveMetadata = await getFileMetadata(payload.fileId);
      console.log(`[${taskId}] ✓ Metadata fetched`);
      console.log(
        `[${taskId}] - Size: ${driveMetadata.size ? (Number(driveMetadata.size) / 1024).toFixed(2) : "unknown"} KB`
      );
      console.log(
        `[${taskId}] - MD5 Checksum: ${driveMetadata.md5Checksum || "N/A"}`
      );

      // Download file from Google Drive
      console.log(`[${taskId}] Downloading file from Google Drive...`);
      console.log(`[${taskId}] - File ID: ${payload.fileId}`);
      console.log(`[${taskId}] - File Name: ${payload.fileName}`);

      const fileBuffer = await downloadFileFromDrive(payload.fileId);

      console.log(`[${taskId}] ✓ File downloaded successfully`);
      console.log(
        `[${taskId}] - Downloaded size: ${(fileBuffer.length / 1024).toFixed(2)} KB`
      );

      // Upload to Supabase Storage inbox folder
      console.log(`[${taskId}] Uploading file to Supabase Storage inbox...`);
      const storageKey = `inbox/${payload.docId}.pdf`;

      const uploadResult = await uploadFile(
        storageKey,
        fileBuffer,
        payload.mimeType,
        payload.fileName // Pass original filename to metadata
      );

      console.log(`[${taskId}] ✓ File uploaded to Supabase Storage`);
      console.log(`[${taskId}] - Storage Key: ${uploadResult.key}`);
      console.log(`[${taskId}] - Storage URL: ${uploadResult.url}`);

      const metadata: FileMetadata = {
        fileName: payload.fileName,
        mimeType: payload.mimeType,
        size: fileBuffer.length,
        createdTime: driveMetadata.createdTime || new Date().toISOString(),
      };

      // Update status to "downloaded"
      console.log(`[${taskId}] Updating status to "downloaded"...`);
      await sql`
        UPDATE income_registry
        SET status = 'downloaded'
        WHERE doc_id = ${payload.docId}
      `;

      console.log(`[${taskId}] Completed successfully`);

      // Return storage path instead of buffer to keep tasks stateless
      return {
        storagePath: storageKey,
        storageUrl: uploadResult.url,
        metadata,
        md5Checksum: driveMetadata.md5Checksum,
      };
    } catch (error) {
      console.error(`[${taskId}] Error:`, error);

      // Update status to "download_failed"
      try {
        await sql`
          UPDATE income_registry
          SET status = 'download_failed',
              error_message = ${error instanceof Error ? error.message : String(error)}
          WHERE doc_id = ${payload.docId}
        `;
      } catch (dbError) {
        console.error(`[${taskId}] Failed to update error status:`, dbError);
      }

      throw new Error(
        `Failed to download and prepare file: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
});
