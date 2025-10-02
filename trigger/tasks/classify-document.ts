import { task } from "@trigger.dev/sdk";
import { getDb } from "../utils/db";
import { downloadFile } from "../utils/storage";
import {
  uploadFileToClaude,
  classifyDocument as claudeClassify,
} from "../utils/claude";
import type { FileMetadata, ClassificationResult } from "../types/domain";

// ============================================================================
// TASK 2: CLASSIFY DOCUMENT (Hidden)
// ============================================================================

export const classifyDocument = task({
  id: "classify-document",
  retry: {
    maxAttempts: 10,
    factor: 1.5,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 30000,
    randomize: true,
  },
  run: async (payload: {
    docId: string;
    storagePath: string;
    metadata: FileMetadata;
  }) => {
    const taskId = "classify-document";
    console.log(
      `[${taskId}] Starting classification for doc: ${payload.docId}`
    );
    console.log(
      `[${taskId}] File: ${payload.metadata.fileName} (${payload.metadata.size} bytes)`
    );
    console.log(`[${taskId}] Storage Path: ${payload.storagePath}`);

    const sql = getDb();

    try {
      // Update registry status to "classifying"
      console.log(`[${taskId}] Updating registry status to "classifying"...`);
      await sql`
        UPDATE income_registry
        SET status = 'classifying'
        WHERE doc_id = ${payload.docId}
      `;

      // Step 1: Download file from Supabase Storage inbox
      console.log(`[${taskId}] Downloading file from Supabase Storage...`);
      console.log(`[${taskId}] - Storage path: ${payload.storagePath}`);

      const fileBuffer = await downloadFile(payload.storagePath);

      console.log(`[${taskId}] ✓ File downloaded from storage`);
      console.log(
        `[${taskId}] - Downloaded size: ${(fileBuffer.length / 1024).toFixed(2)} KB`
      );

      // Step 2: Upload file to Claude Files API
      console.log(`[${taskId}] Uploading file to Claude Files API...`);
      console.log(`[${taskId}] - File name: ${payload.metadata.fileName}`);
      console.log(`[${taskId}] - MIME type: ${payload.metadata.mimeType}`);

      const uploadResult = await uploadFileToClaude(
        fileBuffer,
        payload.metadata.fileName,
        payload.metadata.mimeType
      );

      console.log(`[${taskId}] ✓ File uploaded to Claude`);
      console.log(`[${taskId}] - Claude File ID: ${uploadResult.id}`);

      // Step 3: Classify document using Claude API
      console.log(`[${taskId}] Calling Claude with classification prompt...`);
      console.log(`[${taskId}] - Model: claude-3-5-haiku-20241022`);
      console.log(`[${taskId}] Requesting classification into:`);
      console.log(`[${taskId}] - invoice`);
      console.log(`[${taskId}] - bank_statement`);
      console.log(`[${taskId}] - government_letter`);
      console.log(`[${taskId}] - unknown`);

      const classification = await claudeClassify(uploadResult.id);

      console.log(`[${taskId}] ✓ Classification completed`);
      console.log(
        `[${taskId}] - Document Type (raw): ${classification.document_type}`
      );
      console.log(
        `[${taskId}] - Confidence: ${classification.confidence.toFixed(2)}`
      );
      console.log(`[${taskId}] - Reasoning: ${classification.reasoning}`);

      // Step 4: Apply confidence threshold (matching n8n workflow)
      const finalType =
        classification.confidence >= 0.8
          ? classification.document_type
          : "unknown";

      if (finalType === "unknown" && classification.confidence < 0.8) {
        console.log(
          `[${taskId}] ⚠️  Confidence below threshold (0.8), defaulting to "unknown"`
        );
        console.log(
          `[${taskId}] - Original classification: ${classification.document_type}`
        );
        console.log(
          `[${taskId}] - Confidence: ${classification.confidence.toFixed(2)}`
        );
      }

      // Update registry status to "classified" with classification results
      console.log(`[${taskId}] Updating registry status to "classified"...`);
      await sql`
        UPDATE income_registry
        SET status = 'classified',
            classification = ${finalType},
            confidence = ${classification.confidence},
            reasoning = ${
              classification.confidence >= 0.8
                ? classification.reasoning
                : `Low confidence (${classification.confidence.toFixed(2)}). Original classification: ${classification.document_type}. ${classification.reasoning}`
            },
            possible_type = ${classification.document_type}
        WHERE doc_id = ${payload.docId}
      `;

      const result: ClassificationResult = {
        documentType: finalType,
        confidence: classification.confidence,
        reasoning:
          classification.confidence >= 0.8
            ? classification.reasoning
            : `Low confidence (${classification.confidence.toFixed(2)}). Original classification: ${classification.document_type}. ${classification.reasoning}`,
        possibleType: classification.document_type,
        claudeFileId: uploadResult.id,
      };

      console.log(`[${taskId}] Completed successfully`);
      console.log(`[${taskId}] - Final Document Type: ${result.documentType}`);

      return result;
    } catch (error) {
      console.error(`[${taskId}] Error during classification:`, error);

      // Default to "unknown" on error (non-fatal)
      console.log(
        `[${taskId}] ⚠️  Classification failed, defaulting to "unknown"`
      );

      // Update registry with classification failure
      try {
        await sql`
          UPDATE income_registry
          SET status = 'classification_failed',
              classification = 'unknown',
              confidence = 0.0,
              reasoning = ${`Classification failed: ${error instanceof Error ? error.message : String(error)}`},
              possible_type = 'unknown',
              error_message = ${error instanceof Error ? error.message : String(error)}
          WHERE doc_id = ${payload.docId}
        `;
      } catch (dbError) {
        console.error(`[${taskId}] Failed to update error status:`, dbError);
      }

      const fallbackResult: ClassificationResult = {
        documentType: "unknown",
        confidence: 0.0,
        reasoning: `Classification failed: ${error instanceof Error ? error.message : String(error)}`,
        possibleType: "unknown",
        claudeFileId: null,
      };

      return fallbackResult;
    }
  },
});
