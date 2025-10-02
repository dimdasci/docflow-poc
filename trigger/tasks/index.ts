// ============================================================================
// TASK EXPORTS
// ============================================================================

// Individual task exports
export { registerDocument } from "./register-document";
export { downloadAndPrepare } from "./download-and-prepare";
export { classifyDocument } from "./classify-document";
export { storeFile } from "./store-file";
export {
  extractInvoiceData,
  extractStatementData,
  extractLetterData,
} from "./extract-data";
export { storeMetadata } from "./store-metadata";

// ============================================================================
// TYPE EXPORTS
// ============================================================================

// Re-export domain types for convenience
export type {
  FileMetadata,
  ClassificationResult,
  InvoiceData,
  StatementData,
  LetterData,
} from "../types/domain";
