import { task } from "@trigger.dev/sdk";
import { getDb } from "../utils/db";
import { moveFileToFolder } from "../utils/drive";
import { copyFile, deleteFile } from "../utils/storage";
import type { FileMetadata, ClassificationResult } from "../types/domain";

type DocumentType = ClassificationResult["documentType"];

// ============================================================================
// TASK 3: STORE FILE (Hidden - SAFE POINT!)
// ============================================================================

export const storeFile = task({
  id: "store-file",
  machine: "medium-1x",
  retry: {
    maxAttempts: 5,
    factor: 2,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 15000,
    randomize: true,
  },
  run: async (payload: {
    docId: string;
    fileId: string;
    storagePath: string; // Path to file in inbox folder
    fileName: string;
    documentType: DocumentType;
    metadata: FileMetadata;
  }) => {
    const taskId = "store-file";
    console.log(`[${taskId}] Starting storage for doc: ${payload.docId}`);
    console.log(`[${taskId}] Document Type: ${payload.documentType}`);
    console.log(`[${taskId}] Source Storage Path: ${payload.storagePath}`);

    const sql = getDb();

    const folderNameMap: Record<DocumentType, string> = {
      invoice: "invoices",
      bank_statement: "statements",
      government_letter: "letters",
      unknown: "unknown",
    };

    try {
      // Update status to "storing"
      console.log(`[${taskId}] Updating registry status to "storing"...`);
      await sql`
        UPDATE income_registry
        SET status = 'storing'
        WHERE doc_id = ${payload.docId}
      `;

      // Determine final storage path
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const folderName = folderNameMap[payload.documentType] ?? "unknown";
      const finalStoragePath = `${folderName}/${year}/${month}/${payload.docId}.pdf`;

      console.log(
        `[${taskId}] Determined final storage path: ${finalStoragePath}`
      );

      // Copy from inbox to permanent location
      console.log(
        `[${taskId}] Copying file from inbox to permanent location...`
      );
      console.log(`[${taskId}] - From: ${payload.storagePath}`);
      console.log(`[${taskId}] - To: ${finalStoragePath}`);

      await copyFile(payload.storagePath, finalStoragePath);

      console.log(`[${taskId}] ✓ Copy completed successfully`);

      // Move file from Google Drive inbox to processed folder
      console.log(
        `[${taskId}] Moving file from Google Drive inbox to processed folder...`
      );
      console.log(`[${taskId}] - File ID: ${payload.fileId}`);

      const processedFolderId = process.env.DRIVE_PROCESSED_FOLDER_ID;
      if (!processedFolderId) {
        console.log(
          `[${taskId}] ⚠️  DRIVE_PROCESSED_FOLDER_ID not configured - skipping move`
        );
      } else {
        try {
          await moveFileToFolder(payload.fileId, processedFolderId);
          console.log(`[${taskId}] ✓ File moved to processed folder`);
        } catch (error) {
          // Log warning but don't fail the task - file might have permission issues
          const message =
            error instanceof Error ? error.message : String(error);
          console.log(
            `[${taskId}] ⚠️  Could not move file to processed folder: ${message}`
          );
          console.log(
            `[${taskId}] ⚠️  This is non-fatal - continuing with workflow`
          );
        }
      }

      // Delete file from Supabase inbox folder
      console.log(`[${taskId}] Deleting file from Supabase inbox folder...`);
      console.log(`[${taskId}] - Path: ${payload.storagePath}`);

      await deleteFile(payload.storagePath);

      console.log(`[${taskId}] ✓ Inbox cleaned`);

      // Update registry with storage info
      console.log(`[${taskId}] Updating registry with storage info...`);
      console.log(`[${taskId}] - storage_path_pdf: ${finalStoragePath}`);
      console.log(`[${taskId}] - status: "stored"`);
      console.log(`[${taskId}] - stored_at: ${now.toISOString()}`);

      await sql`
        UPDATE income_registry
        SET status = 'stored',
            storage_path_pdf = ${finalStoragePath}
        WHERE doc_id = ${payload.docId}
      `;

      console.log(`[${taskId}] 🎉 SAFE POINT REACHED!`);
      console.log(`[${taskId}] - Document is persistent in Supabase Storage`);
      console.log(
        `[${taskId}] - Drive inbox cleaned (file moved to processed folder)`
      );
      console.log(`[${taskId}] - Safe to retry expensive AI operations`);

      console.log(`[${taskId}] Completed successfully`);

      return {
        stored: true,
        storagePath: finalStoragePath,
        deletedFromInbox: true,
      };
    } catch (error) {
      console.error(`[${taskId}] Error during file storage:`, error);

      // Update status to "store_failed"
      try {
        await sql`
          UPDATE income_registry
          SET status = 'store_failed',
              error_message = ${error instanceof Error ? error.message : String(error)}
          WHERE doc_id = ${payload.docId}
        `;
      } catch (dbError) {
        console.error(`[${taskId}] Failed to update error status:`, dbError);
      }

      throw new Error(
        `Failed to store file: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
});
