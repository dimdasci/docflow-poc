import { task, idempotencyKeys } from "@trigger.dev/sdk";
import {
  registerDocument,
  downloadAndPrepare,
  classifyDocument,
  storeFile,
  extractInvoiceData,
  extractStatementData,
  extractLetterData,
  storeMetadata,
} from "./tasks";
import type {
  WorkflowInput,
  WorkflowOutput,
  ClassificationResult,
} from "./types/domain";

type DocumentType = ClassificationResult["documentType"];

const DEFAULT_DOCUMENT_TYPE: DocumentType = "unknown";
const DEFAULT_CONFIDENCE = 0;
const DEFAULT_PDF_PATH = "";

type ExtractInvoiceResult = Awaited<
  ReturnType<typeof extractInvoiceData.triggerAndWait>
>;
type ExtractStatementResult = Awaited<
  ReturnType<typeof extractStatementData.triggerAndWait>
>;
type ExtractLetterResult = Awaited<
  ReturnType<typeof extractLetterData.triggerAndWait>
>;

type ExtractTaskResult =
  | ExtractInvoiceResult
  | ExtractStatementResult
  | ExtractLetterResult;

// ============================================================================
// ORCHESTRATOR TASK: PROCESS DOCUMENT WORKFLOW
// ============================================================================

const IDEMPOTENCY_KEY_TTL = "10m";

export const processDocumentWorkflow = task({
  id: "process-document-workflow",
  queue: {
    concurrencyLimit: 5, // Max 5 workflows running simultaneously
  },
  retry: {
    maxAttempts: 2, // Only retry on storage failures
    factor: 2,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 10000,
    randomize: false,
  },
  run: async (payload: WorkflowInput): Promise<WorkflowOutput> => {
    const orchestratorId = "process-document-workflow";
    console.log(`\n${"=".repeat(80)}`);
    console.log(`[${orchestratorId}] 🚀 STARTING DOCUMENT PROCESSING WORKFLOW`);
    console.log(`${"=".repeat(80)}`);
    console.log(`[${orchestratorId}] File: ${payload.fileName}`);
    console.log(`[${orchestratorId}] File ID: ${payload.fileId}`);
    console.log(`[${orchestratorId}] MIME Type: ${payload.mimeType}`);
    console.log(`[${orchestratorId}] Created: ${payload.createdTime}`);
    console.log(`${"=".repeat(80)}\n`);

    // Create GLOBAL idempotency key (same across all runs for this fileId)
    const idempotencyKey = await idempotencyKeys.create(payload.fileId, {
      scope: "global",
    });
    console.log(
      `[${orchestratorId}] 🔑 Global idempotency key created: ${idempotencyKey}\n`
    );

    // ========================================================================
    // STEP 0: Register document (prevent loss)
    // ========================================================================
    console.log(`[${orchestratorId}] 📝 STEP 0: Registering document...`);
    const register = await registerDocument.triggerAndWait(payload, {
      idempotencyKey,
      idempotencyKeyTTL: IDEMPOTENCY_KEY_TTL,
    });

    if (!register.ok) {
      console.log(
        `[${orchestratorId}] ❌ CRITICAL ERROR: Failed to register document`
      );
      throw new Error(`Failed to register document: ${register.error}`);
    }

    const { docId, registryId } = register.output;
    console.log(`[${orchestratorId}] ✅ Document registered successfully`);
    console.log(`[${orchestratorId}] - Registry ID: ${registryId}`);
    console.log(`[${orchestratorId}] - Doc ID: ${docId}\n`);

    // ========================================================================
    // STEP 1: Download file from Google Drive
    // ========================================================================
    console.log(`[${orchestratorId}] 📥 STEP 1: Downloading file...`);
    const download = await downloadAndPrepare.triggerAndWait(
      {
        docId,
        fileId: payload.fileId,
        fileName: payload.fileName,
        mimeType: payload.mimeType,
      },
      { idempotencyKey, idempotencyKeyTTL: IDEMPOTENCY_KEY_TTL }
    );

    if (!download.ok) {
      console.log(
        `[${orchestratorId}] ❌ Download failed (status: download_failed)`
      );
      console.log(`[${orchestratorId}] Error: ${download.error}`);
      console.log(`[${orchestratorId}] Workflow terminated.\n`);

      return {
        status: "download_failed",
        documentType: DEFAULT_DOCUMENT_TYPE,
        confidence: DEFAULT_CONFIDENCE,
        registryId,
        docId,
        pdfStoragePath: DEFAULT_PDF_PATH,
        jsonStoragePath: undefined,
        inboxCleaned: false,
        error: String(download.error),
      };
    }

    console.log(`[${orchestratorId}] ✅ File downloaded and uploaded to inbox`);
    console.log(
      `[${orchestratorId}] - Storage Path: ${download.output.storagePath}`
    );
    console.log(
      `[${orchestratorId}] - File size: ${download.output.metadata.size} bytes\n`
    );

    // ========================================================================
    // STEP 2: Classify document using Claude AI
    // ========================================================================
    console.log(`[${orchestratorId}] 🤖 STEP 2: Classifying document...`);
    const classify = await classifyDocument.triggerAndWait(
      {
        docId,
        storagePath: download.output.storagePath,
        metadata: download.output.metadata,
      },
      { idempotencyKey, idempotencyKeyTTL: IDEMPOTENCY_KEY_TTL }
    );

    // Classification failure is not fatal - default to "unknown"
    const classificationResult: ClassificationResult | null = classify.ok
      ? classify.output
      : null;

    const documentType: DocumentType =
      classificationResult?.documentType ?? DEFAULT_DOCUMENT_TYPE;
    const confidence = classificationResult?.confidence ?? DEFAULT_CONFIDENCE;
    const claudeFileId = classificationResult?.claudeFileId ?? null;

    if (!classify.ok) {
      console.log(
        `[${orchestratorId}] ⚠️  Classification failed, defaulting to "unknown"`
      );
    } else {
      console.log(`[${orchestratorId}] ✅ Classification completed`);
      console.log(`[${orchestratorId}] - Document Type: ${documentType}`);
      console.log(`[${orchestratorId}] - Confidence: ${confidence.toFixed(2)}`);
    }
    console.log();

    // ========================================================================
    // STEP 3: Store file to Supabase Storage (SAFE POINT!)
    // ========================================================================
    console.log(
      `[${orchestratorId}] 💾 STEP 3: Moving file to permanent location...`
    );
    console.log(
      `[${orchestratorId}] ⚠️  CRITICAL STEP: This is the SAFE POINT!`
    );
    const storeResult = await storeFile.triggerAndWait(
      {
        docId,
        fileId: payload.fileId,
        storagePath: download.output.storagePath,
        fileName: payload.fileName,
        documentType,
        metadata: download.output.metadata,
      },
      { idempotencyKey, idempotencyKeyTTL: IDEMPOTENCY_KEY_TTL }
    );

    if (!storeResult.ok) {
      console.log(`[${orchestratorId}] ❌ CRITICAL ERROR: File storage failed`);
      console.log(`[${orchestratorId}] Error: ${storeResult.error}`);
      console.log(
        `[${orchestratorId}] Cannot continue safely without file in permanent storage.`
      );
      console.log(`[${orchestratorId}] Workflow terminated.\n`);

      throw new Error(`File storage failed: ${storeResult.error}`);
    }

    console.log(`[${orchestratorId}] ✅ File stored successfully!`);
    console.log(`[${orchestratorId}] 🎉 SAFE POINT REACHED!`);
    console.log(
      `[${orchestratorId}] - Storage Path: ${storeResult.output.storagePath}`
    );
    console.log(
      `[${orchestratorId}] - Inbox Cleaned: ${storeResult.output.deletedFromInbox}`
    );
    console.log(`[${orchestratorId}] - Document is now persistent and safe`);
    console.log(
      `[${orchestratorId}] - Can safely retry extraction/metadata operations\n`
    );

    // ========================================================================
    // STEP 4: Extract data (type-specific, skip if unknown/low confidence)
    // ========================================================================
    let extractResult: ExtractTaskResult | null = null;
    let extractionError: string | null = null;

    if (documentType !== "unknown" && confidence >= 0.8) {
      console.log(
        `[${orchestratorId}] 🔍 STEP 4: Extracting structured data...`
      );
      console.log(`[${orchestratorId}] Document type: ${documentType}`);

      switch (documentType) {
        case "invoice":
          console.log(`[${orchestratorId}] Extracting invoice data...`);
          extractResult = await extractInvoiceData.triggerAndWait(
            {
              docId,
              claudeFileId,
            },
            { idempotencyKey, idempotencyKeyTTL: IDEMPOTENCY_KEY_TTL }
          );
          if (extractResult.ok) {
            console.log(
              `[${orchestratorId}] ✅ Invoice data extracted successfully`
            );
          } else {
            console.log(
              `[${orchestratorId}] ❌ Invoice extraction failed: ${extractResult.error}`
            );
            extractionError = String(extractResult.error);
          }
          break;

        case "bank_statement":
          console.log(`[${orchestratorId}] Extracting bank statement data...`);
          extractResult = await extractStatementData.triggerAndWait(
            {
              docId,
              claudeFileId,
            },
            { idempotencyKey, idempotencyKeyTTL: IDEMPOTENCY_KEY_TTL }
          );
          if (extractResult.ok) {
            console.log(
              `[${orchestratorId}] ✅ Statement data extracted successfully`
            );
          } else {
            console.log(
              `[${orchestratorId}] ❌ Statement extraction failed: ${extractResult.error}`
            );
            extractionError = String(extractResult.error);
          }
          break;

        case "government_letter":
          console.log(
            `[${orchestratorId}] Extracting government letter data...`
          );
          extractResult = await extractLetterData.triggerAndWait(
            {
              docId,
              claudeFileId,
            },
            { idempotencyKey, idempotencyKeyTTL: IDEMPOTENCY_KEY_TTL }
          );
          if (extractResult.ok) {
            console.log(
              `[${orchestratorId}] ✅ Letter data extracted successfully`
            );
          } else {
            console.log(
              `[${orchestratorId}] ❌ Letter extraction failed: ${extractResult.error}`
            );
            extractionError = String(extractResult.error);
          }
          break;
      }
      console.log();
    } else {
      console.log(`[${orchestratorId}] ⏭️  STEP 4: Skipping extraction`);
      console.log(
        `[${orchestratorId}] Reason: ${documentType === "unknown" ? "Unknown document type" : `Low confidence (${confidence.toFixed(2)} < 0.8)`}`
      );
      console.log();
    }

    // ========================================================================
    // STEP 5: Store metadata to Supabase
    // ========================================================================
    console.log(`[${orchestratorId}] 💿 STEP 5: Storing metadata...`);
    const metadataResult = await storeMetadata.triggerAndWait(
      {
        docId,
        documentType,
        classification: classificationResult,
        extractedData: extractResult?.ok ? extractResult.output : null,
        extractionError,
      },
      { idempotencyKey, idempotencyKeyTTL: IDEMPOTENCY_KEY_TTL }
    );

    if (!metadataResult.ok) {
      console.log(
        `[${orchestratorId}] ❌ CRITICAL ERROR: Metadata storage failed`
      );
      console.log(`[${orchestratorId}] Error: ${metadataResult.error}`);
      console.log(
        `[${orchestratorId}] Note: PDF file is already safe in storage at: ${storeResult.output.storagePath}`
      );
      console.log(
        `[${orchestratorId}] Throwing error to retry orchestrator from STEP 5...\n`
      );

      throw new Error(`Metadata storage failed: ${metadataResult.error}`);
    }

    console.log(`[${orchestratorId}] ✅ Metadata stored successfully`);
    console.log(
      `[${orchestratorId}] - Final Status: ${metadataResult.output.status}`
    );
    if (metadataResult.output.jsonStoragePath) {
      console.log(
        `[${orchestratorId}] - JSON Path: ${metadataResult.output.jsonStoragePath}`
      );
    }
    console.log();

    // ========================================================================
    // WORKFLOW COMPLETED
    // ========================================================================
    console.log(`${"=".repeat(80)}`);
    console.log(`[${orchestratorId}] ✅ WORKFLOW COMPLETED SUCCESSFULLY`);
    console.log(`${"=".repeat(80)}`);
    console.log(`[${orchestratorId}] Summary:`);
    console.log(
      `[${orchestratorId}] - Status: ${metadataResult.output.status}`
    );
    console.log(`[${orchestratorId}] - Document Type: ${documentType}`);
    console.log(`[${orchestratorId}] - Confidence: ${confidence.toFixed(2)}`);
    console.log(
      `[${orchestratorId}] - PDF Path: ${storeResult.output.storagePath}`
    );
    if (metadataResult.output.jsonStoragePath) {
      console.log(
        `[${orchestratorId}] - JSON Path: ${metadataResult.output.jsonStoragePath}`
      );
    }
    console.log(
      `[${orchestratorId}] - Inbox Cleaned: ${storeResult.output.deletedFromInbox}`
    );
    console.log(`${"=".repeat(80)}\n`);

    return {
      status: metadataResult.output.status,
      documentType,
      confidence,
      registryId,
      docId,
      pdfStoragePath: storeResult.output.storagePath ?? DEFAULT_PDF_PATH,
      jsonStoragePath: metadataResult.output.jsonStoragePath,
      inboxCleaned: storeResult.output.deletedFromInbox ?? false,
      error: undefined,
    };
  },
});
