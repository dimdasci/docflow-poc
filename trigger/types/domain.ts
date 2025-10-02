// ============================================================================
// DOMAIN TYPE DEFINITIONS
// ============================================================================

export interface FileMetadata {
  fileName: string;
  mimeType: string;
  size?: number;
  createdTime: string;
}

export interface ClassificationResult {
  documentType: "invoice" | "bank_statement" | "government_letter" | "unknown";
  confidence: number;
  reasoning: string;
  possibleType: string;
  claudeFileId: string | null;
}

export interface InvoiceData {
  document_info: {
    invoice_number: string;
    invoice_date: string;
    due_date: string;
    currency: string;
    language: string;
  };
  vendor: {
    name: string;
    address: string;
    vat_number: string;
    tax_id: string;
    contact_email: string;
  };
  customer: {
    name: string;
    address: string;
    vat_number: string;
  };
  amounts: {
    subtotal: number;
    total_vat: number;
    total_amount: number;
    vat_rate: number;
  };
  line_items: Array<{
    description: string;
    quantity: number;
    unit_price: number;
    vat_rate: number;
    vat_amount: number;
    line_total: number;
  }>;
  payment: {
    terms: string;
    method: string;
    bank_details: string;
  };
}

export interface StatementData {
  document_info: {
    statement_type: "bank_statement";
    bank_name: string;
    document_title: string;
    period_start: string;
    period_end: string;
    currency: string;
    language: string;
  };
  account: {
    holder_name: string;
    account_number: string;
    iban: string;
    opening_balance: number;
    closing_balance: number;
  };
  transactions: Array<{
    date: string;
    description: string;
    amount: number;
    balance: number;
  }>;
}

export interface LetterData {
  reasoning_checklist: {
    has_due_date: boolean;
    due_date_field_name: string;
    due_date_value: string;
    has_money_amount: boolean;
    money_amount_quote: string;
  };
  document_info: {
    document_type: "official_letter";
    language: string;
    date: string;
  };
  letter_details: {
    subject: string;
    reference_number: string;
    due_date: string;
    amount_due: number;
    currency: string;
    letter_type:
      | "tax_notice"
      | "vat_reminder"
      | "audit_notice"
      | "compliance"
      | "other";
  };
  sender: {
    organization: string;
    address: string;
    country: string;
    contact_title: string;
    reference: string;
  };
  recipient: {
    organization: string;
    title: string;
    address: string;
    country: string;
  };
  content: {
    greeting: string;
    main_text: string;
    closing: string;
  };
}

/**
 * Workflow input payload
 */
export interface WorkflowInput {
  fileId: string; // Google Drive file ID
  fileName: string; // Original file name
  mimeType: string; // Must be "application/pdf"
  createdTime: string; // ISO 8601 timestamp from Google Drive
}

/**
 * Workflow output result
 */
export interface WorkflowOutput {
  status:
    | "processed"
    | "extraction_failed"
    | "rejected"
    | "download_failed"
    | "store_failed";
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
  | "new" // Just registered
  | "downloading" // Downloading from Drive
  | "downloaded" // Download complete
  | "download_failed" // Download failed (terminal)
  | "classifying" // Classifying document type
  | "classified" // Classification complete
  | "classification_failed" // Classification failed (continues as "unknown")
  | "storing" // Uploading to Supabase Storage
  | "stored" // File stored (SAFE POINT)
  | "store_failed" // Storage failed (terminal)
  | "extracting" // Extracting structured data
  | "extracted" // Extraction complete
  | "extraction_failed" // Extraction failed (continues to metadata)
  | "saving_metadata" // Saving metadata to database
  | "metadata_storage_failed" // Metadata storage failed (retries)
  | "processed" // Successfully completed with data
  | "rejected"; // Low confidence or unknown type (stored without extraction)
