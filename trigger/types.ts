/**
 * Shared type definitions for document processing workflow
 *
 * These types are exported from document-tasks.ts and can be imported
 * anywhere in the codebase for type safety.
 */

// Re-export all types from document-tasks
export type {
  FileMetadata,
  ClassificationResult,
  InvoiceData,
  StatementData,
  LetterData,
} from "./document-tasks";

/**
 * Workflow input payload
 */
export interface WorkflowInput {
  fileId: string;        // Google Drive file ID
  fileName: string;      // Original file name
  mimeType: string;      // Must be "application/pdf"
  createdTime: string;   // ISO 8601 timestamp from Google Drive
}

/**
 * Workflow output result
 */
export interface WorkflowOutput {
  status: "processed" | "extraction_failed" | "rejected" | "download_failed" | "store_failed";
  documentType: "invoice" | "bank_statement" | "government_letter" | "unknown";
  confidence: number;
  registryId: string;
  docId: string;
  pdfStoragePath: string;
  jsonStoragePath?: string;
  inboxCleaned: boolean;
  error?: string;
}

/**
 * Document status values in income_registry table
 */
export type DocumentStatus =
  | "new"                      // Just registered
  | "downloading"              // Downloading from Drive
  | "downloaded"               // Download complete
  | "download_failed"          // Download failed (terminal)
  | "classifying"              // Classifying document type
  | "classified"               // Classification complete
  | "classification_failed"    // Classification failed (continues as "unknown")
  | "storing"                  // Uploading to Supabase Storage
  | "stored"                   // File stored (SAFE POINT)
  | "store_failed"             // Storage failed (terminal)
  | "extracting"               // Extracting structured data
  | "extracted"                // Extraction complete
  | "extraction_failed"        // Extraction failed (continues to metadata)
  | "saving_metadata"          // Saving metadata to database
  | "metadata_storage_failed"  // Metadata storage failed (retries)
  | "processed"                // Successfully completed with data
  | "rejected";                // Low confidence or unknown type (stored without extraction)