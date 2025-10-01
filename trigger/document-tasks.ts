import { task } from "@trigger.dev/sdk";
import { z } from "zod";
import { getDb } from "./db";
import { downloadFileFromDrive, getFileMetadata } from "./drive";
import { uploadFile, downloadFile } from "./storage";
import { uploadFileToClaude, classifyDocument as claudeClassify } from "./claude";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface FileMetadata {
  fileName: string;
  mimeType: string;
  size?: number;
  createdTime: string;
}

interface ClassificationResult {
  documentType: "invoice" | "bank_statement" | "government_letter" | "unknown";
  confidence: number;
  reasoning: string;
  possibleType: string;
  claudeFileId: string | null;
}

interface InvoiceData {
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

interface StatementData {
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

interface LetterData {
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
    letter_type: "tax_notice" | "vat_reminder" | "audit_notice" | "compliance" | "other";
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

// ============================================================================
// TASK 0: REGISTER DOCUMENT (Hidden - First Operation)
// ============================================================================

const registerDocument = task({
  id: "register-document",
  retry: {
    maxAttempts: 3,
    factor: 1.8,
    minTimeoutInMs: 500,
    maxTimeoutInMs: 5000,
    randomize: false,
  },
  run: async (payload: {
    fileId: string;
    fileName: string;
    mimeType: string;
    createdTime: string;
  }) => {
    const taskId = "register-document";
    console.log(`[${taskId}] Starting with payload:`, JSON.stringify(payload, null, 2));

    const sql = getDb();

    try {
      // Insert record to income_registry table
      console.log(`[${taskId}] Inserting record to income_registry table...`);
      console.log(`[${taskId}] - File ID: ${payload.fileId}`);
      console.log(`[${taskId}] - File Name: ${payload.fileName}`);
      console.log(`[${taskId}] - MIME Type: ${payload.mimeType}`);
      console.log(`[${taskId}] - Created Time: ${payload.createdTime}`);
      console.log(`[${taskId}] - Status: "new"`);

      const [result] = await sql`
        INSERT INTO income_registry (
          doc_id,
          file_name,
          mime_type,
          created_at,
          status,
          registered_at
        ) VALUES (
          ${payload.fileId},
          ${payload.fileName},
          ${payload.mimeType},
          ${payload.createdTime},
          'new',
          NOW()
        )
        RETURNING id, doc_id
      `;

      console.log(`[${taskId}] Successfully registered document`);
      console.log(`[${taskId}] - Registry ID: ${result.id}`);
      console.log(`[${taskId}] - Doc ID: ${result.doc_id}`);

      return {
        registryId: result.id,
        docId: result.doc_id,
      };
    } catch (error) {
      console.error(`[${taskId}] Database error:`, error);
      throw new Error(`Failed to register document: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});

// ============================================================================
// TASK 1: DOWNLOAD AND PREPARE (Hidden)
// ============================================================================

const downloadAndPrepare = task({
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
    console.log(`[${taskId}] Starting with payload:`, JSON.stringify(payload, null, 2));

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
        console.log(`[${taskId}] ERROR: Invalid MIME type "${payload.mimeType}"`);

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
      console.log(`[${taskId}] - Size: ${driveMetadata.size ? (Number(driveMetadata.size) / 1024).toFixed(2) : 'unknown'} KB`);
      console.log(`[${taskId}] - MD5 Checksum: ${driveMetadata.md5Checksum || 'N/A'}`);

      // Download file from Google Drive
      console.log(`[${taskId}] Downloading file from Google Drive...`);
      console.log(`[${taskId}] - File ID: ${payload.fileId}`);
      console.log(`[${taskId}] - File Name: ${payload.fileName}`);

      const fileBuffer = await downloadFileFromDrive(payload.fileId);

      console.log(`[${taskId}] ✓ File downloaded successfully`);
      console.log(`[${taskId}] - Downloaded size: ${(fileBuffer.length / 1024).toFixed(2)} KB`);

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

      throw new Error(`Failed to download and prepare file: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});

// ============================================================================
// TASK 2: CLASSIFY DOCUMENT (Hidden)
// ============================================================================

const classifyDocument = task({
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
    console.log(`[${taskId}] Starting classification for doc: ${payload.docId}`);
    console.log(`[${taskId}] File: ${payload.metadata.fileName} (${payload.metadata.size} bytes)`);
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
      console.log(`[${taskId}] - Downloaded size: ${(fileBuffer.length / 1024).toFixed(2)} KB`);

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
      console.log(`[${taskId}] - Document Type (raw): ${classification.document_type}`);
      console.log(`[${taskId}] - Confidence: ${classification.confidence.toFixed(2)}`);
      console.log(`[${taskId}] - Reasoning: ${classification.reasoning}`);

      // Step 4: Apply confidence threshold (matching n8n workflow)
      const finalType = classification.confidence >= 0.8 ? classification.document_type : "unknown";

      if (finalType === "unknown" && classification.confidence < 0.8) {
        console.log(`[${taskId}] ⚠️  Confidence below threshold (0.8), defaulting to "unknown"`);
        console.log(`[${taskId}] - Original classification: ${classification.document_type}`);
        console.log(`[${taskId}] - Confidence: ${classification.confidence.toFixed(2)}`);
      }

      // Update registry status to "classified" with classification results
      console.log(`[${taskId}] Updating registry status to "classified"...`);
      await sql`
        UPDATE income_registry
        SET status = 'classified',
            classification = ${finalType},
            confidence = ${classification.confidence},
            reasoning = ${classification.confidence >= 0.8
              ? classification.reasoning
              : `Low confidence (${classification.confidence.toFixed(2)}). Original classification: ${classification.document_type}. ${classification.reasoning}`},
            possible_type = ${classification.document_type}
        WHERE doc_id = ${payload.docId}
      `;

      const result: ClassificationResult = {
        documentType: finalType,
        confidence: classification.confidence,
        reasoning: classification.confidence >= 0.8
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
      console.log(`[${taskId}] ⚠️  Classification failed, defaulting to "unknown"`);

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

// ============================================================================
// TASK 3: STORE FILE (Hidden - SAFE POINT!)
// ============================================================================

const storeFile = task({
  id: "store-file",
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
    documentType: string;
    metadata: FileMetadata;
  }) => {
    const taskId = "store-file";
    console.log(`[${taskId}] Starting storage for doc: ${payload.docId}`);
    console.log(`[${taskId}] Document Type: ${payload.documentType}`);
    console.log(`[${taskId}] Source Storage Path: ${payload.storagePath}`);

    const sql = getDb();

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
    const finalStoragePath = `${payload.documentType}/${year}/${month}/${payload.docId}.pdf`;

    console.log(`[${taskId}] Determined final storage path: ${finalStoragePath}`);

    // Simulate copy from inbox to permanent location
    console.log(`[${taskId}] Copying file from inbox to permanent location...`);
    console.log(`[${taskId}] - From: ${payload.storagePath}`);
    console.log(`[${taskId}] - To: ${finalStoragePath}`);
    console.log(`[${taskId}] ✓ Copy completed successfully`);

    // Simulate Google Drive deletion
    console.log(`[${taskId}] Deleting file from Google Drive inbox...`);
    console.log(`[${taskId}] - File ID: ${payload.fileId}`);
    console.log(`[${taskId}] ✓ File deleted from Drive inbox`);

    // Simulate Supabase inbox cleanup
    console.log(`[${taskId}] Deleting file from Supabase inbox folder...`);
    console.log(`[${taskId}] - Path: ${payload.storagePath}`);
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
      console.log(`[${taskId}] - Inbox is clean (file deleted from Drive)`);
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

      throw new Error(`Failed to store file: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});

// ============================================================================
// TASK 4a: EXTRACT INVOICE DATA (Hidden)
// ============================================================================

const extractInvoiceData = task({
  id: "extract-invoice-data",
  retry: {
    maxAttempts: 10,
    factor: 1.5,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 30000,
    randomize: true,
  },
  run: async (payload: { docId: string; claudeFileId: string | null }) => {
    const taskId = "extract-invoice-data";
    console.log(`[${taskId}] Starting extraction for doc: ${payload.docId}`);
    console.log(`[${taskId}] Claude File ID: ${payload.claudeFileId}`);

    // Simulate Claude API call for invoice extraction
    console.log(`[${taskId}] Calling Claude with invoice extraction prompt...`);
    console.log(`[${taskId}] Requesting structured invoice data...`);

    // Mock invoice data
    const invoiceData: InvoiceData = {
      document_info: {
        invoice_number: `INV-${Math.floor(Math.random() * 10000)}`,
        invoice_date: "2025-09-15",
        due_date: "2025-10-15",
        currency: "EUR",
        language: "en",
      },
      vendor: {
        name: "Mock Vendor Ltd.",
        address: "123 Business St, City 12345",
        vat_number: "DE123456789",
        tax_id: "TAX123456",
        contact_email: "vendor@example.com",
      },
      customer: {
        name: "Customer Corp.",
        address: "456 Client Ave, Town 67890",
        vat_number: "DE987654321",
      },
      amounts: {
        subtotal: 5000.0,
        total_vat: 950.0,
        total_amount: 5950.0,
        vat_rate: 19.0,
      },
      line_items: [
        {
          description: "Professional Services",
          quantity: 20,
          unit_price: 250.0,
          vat_rate: 19.0,
          vat_amount: 950.0,
          line_total: 5950.0,
        },
      ],
      payment: {
        terms: "Net 30",
        method: "Bank Transfer",
        bank_details: "IBAN: DE89370400440532013000",
      },
    };

    console.log(`[${taskId}] ✓ Extraction completed successfully`);
    console.log(`[${taskId}] - Invoice Number: ${invoiceData.document_info.invoice_number}`);
    console.log(`[${taskId}] - Total Amount: ${invoiceData.amounts.total_amount} ${invoiceData.document_info.currency}`);
    console.log(`[${taskId}] - Line Items: ${invoiceData.line_items.length}`);

    console.log(`[${taskId}] Completed successfully`);

    return { invoiceData };
  },
});

// ============================================================================
// TASK 4b: EXTRACT STATEMENT DATA (Hidden)
// ============================================================================

const extractStatementData = task({
  id: "extract-statement-data",
  retry: {
    maxAttempts: 10,
    factor: 1.5,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 30000,
    randomize: true,
  },
  run: async (payload: { docId: string; claudeFileId: string | null }) => {
    const taskId = "extract-statement-data";
    console.log(`[${taskId}] Starting extraction for doc: ${payload.docId}`);
    console.log(`[${taskId}] Claude File ID: ${payload.claudeFileId}`);

    // Simulate Claude API call for statement extraction
    console.log(`[${taskId}] Calling Claude with statement extraction prompt...`);
    console.log(`[${taskId}] Requesting structured bank statement data...`);

    // Mock statement data
    const statementData: StatementData = {
      document_info: {
        statement_type: "bank_statement",
        bank_name: "Mock Bank AG",
        document_title: "Monthly Account Statement",
        period_start: "2025-08-01",
        period_end: "2025-08-31",
        currency: "EUR",
        language: "en",
      },
      account: {
        holder_name: "John Doe",
        account_number: "1234567890",
        iban: "DE89370400440532013000",
        opening_balance: 10000.0,
        closing_balance: 12500.0,
      },
      transactions: [
        {
          date: "2025-08-05",
          description: "Salary Payment",
          amount: 3500.0,
          balance: 13500.0,
        },
        {
          date: "2025-08-10",
          description: "Rent Payment",
          amount: -1000.0,
          balance: 12500.0,
        },
      ],
    };

    console.log(`[${taskId}] ✓ Extraction completed successfully`);
    console.log(`[${taskId}] - Bank: ${statementData.document_info.bank_name}`);
    console.log(`[${taskId}] - Period: ${statementData.document_info.period_start} to ${statementData.document_info.period_end}`);
    console.log(`[${taskId}] - Transactions: ${statementData.transactions.length}`);
    console.log(`[${taskId}] - Opening Balance: ${statementData.account.opening_balance} ${statementData.document_info.currency}`);
    console.log(`[${taskId}] - Closing Balance: ${statementData.account.closing_balance} ${statementData.document_info.currency}`);

    console.log(`[${taskId}] Completed successfully`);

    return { statementData };
  },
});

// ============================================================================
// TASK 4c: EXTRACT LETTER DATA (Hidden)
// ============================================================================

const extractLetterData = task({
  id: "extract-letter-data",
  retry: {
    maxAttempts: 10,
    factor: 1.5,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 30000,
    randomize: true,
  },
  run: async (payload: { docId: string; claudeFileId: string | null }) => {
    const taskId = "extract-letter-data";
    console.log(`[${taskId}] Starting extraction for doc: ${payload.docId}`);
    console.log(`[${taskId}] Claude File ID: ${payload.claudeFileId}`);

    // Simulate Claude API call for letter extraction
    console.log(`[${taskId}] Calling Claude with letter extraction prompt...`);
    console.log(`[${taskId}] Requesting structured official letter data...`);

    // Mock letter data
    const letterData: LetterData = {
      reasoning_checklist: {
        has_due_date: true,
        due_date_field_name: "Zahlungsfrist",
        due_date_value: "2025-10-15",
        has_money_amount: true,
        money_amount_quote: "Betrag: 1,500.00 EUR",
      },
      document_info: {
        document_type: "official_letter",
        language: "de",
        date: "2025-09-15",
      },
      letter_details: {
        subject: "Steuerliche Nachprüfung - Aufforderung zur Zahlung",
        reference_number: "ST-2025-09-12345",
        due_date: "2025-10-15",
        amount_due: 1500.0,
        currency: "EUR",
        letter_type: "tax_notice",
      },
      sender: {
        organization: "Finanzamt Berlin",
        address: "Musterstraße 123, 10115 Berlin",
        country: "Germany",
        contact_title: "Sachbearbeiter Müller",
        reference: "REF-2025-09-12345",
      },
      recipient: {
        organization: "Customer Corp.",
        title: "Herr Schmidt",
        address: "Kundenweg 456, 10115 Berlin",
        country: "Germany",
      },
      content: {
        greeting: "Sehr geehrter Herr Schmidt,",
        main_text:
          "hiermit fordern wir Sie auf, den ausstehenden Betrag von 1,500.00 EUR bis zum 15.10.2025 zu begleichen.",
        closing: "Mit freundlichen Grüßen, Finanzamt Berlin",
      },
    };

    console.log(`[${taskId}] ✓ Extraction completed successfully`);
    console.log(`[${taskId}] - Letter Type: ${letterData.letter_details.letter_type}`);
    console.log(`[${taskId}] - Subject: ${letterData.letter_details.subject}`);
    console.log(`[${taskId}] - Due Date: ${letterData.letter_details.due_date}`);
    console.log(`[${taskId}] - Amount Due: ${letterData.letter_details.amount_due} ${letterData.letter_details.currency}`);

    console.log(`[${taskId}] Completed successfully`);

    return { letterData };
  },
});

// ============================================================================
// TASK 5: STORE METADATA (Hidden)
// ============================================================================

const storeMetadata = task({
  id: "store-metadata",
  retry: {
    maxAttempts: 3,
    factor: 1.8,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 10000,
    randomize: false,
  },
  run: async (payload: {
    docId: string;
    documentType: string;
    classification: ClassificationResult | null;
    extractedData?: { invoiceData?: InvoiceData; statementData?: StatementData; letterData?: LetterData } | null;
    extractionError?: string | null;
  }) => {
    const taskId = "store-metadata";
    console.log(`[${taskId}] Starting metadata storage for doc: ${payload.docId}`);
    console.log(`[${taskId}] Document Type: ${payload.documentType}`);
    console.log(`[${taskId}] Has Extracted Data: ${!!payload.extractedData}`);
    console.log(`[${taskId}] Has Extraction Error: ${!!payload.extractionError}`);

    const sql = getDb();

    try {
      // Update status to "saving_metadata"
      console.log(`[${taskId}] Updating registry status to "saving_metadata"...`);
      await sql`
        UPDATE income_registry
        SET status = 'saving_metadata'
        WHERE doc_id = ${payload.docId}
      `;

    let jsonStoragePath: string | null = null;

    // STEP 1: Upload JSON metadata if we have extracted data
    if (payload.extractedData) {
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, "0");
      jsonStoragePath = `${payload.documentType}/${year}/${month}/${payload.docId}.json`;

      console.log(`[${taskId}] Uploading JSON metadata to Supabase Storage...`);
      console.log(`[${taskId}] - Bucket: "documents"`);
      console.log(`[${taskId}] - Path: ${jsonStoragePath}`);

      const jsonContent = {
        classification: payload.classification,
        extractedData: payload.extractedData,
        metadata: {
          uploadedAt: now.toISOString(),
          docId: payload.docId,
        },
      };

      console.log(`[${taskId}] - JSON Size: ${JSON.stringify(jsonContent).length} bytes`);
      console.log(`[${taskId}] ✓ JSON metadata uploaded successfully`);
    } else {
      console.log(`[${taskId}] Skipping JSON metadata upload (no extracted data)`);
    }

    // STEP 2: Update income_registry table
    console.log(`[${taskId}] Updating income_registry table...`);
    console.log(`[${taskId}] - classification: ${payload.classification?.documentType || "N/A"}`);
    console.log(`[${taskId}] - confidence: ${payload.classification?.confidence || 0}`);
    console.log(`[${taskId}] - reasoning: ${payload.classification?.reasoning?.substring(0, 50) || "N/A"}...`);
    console.log(`[${taskId}] - storage_path_json: ${jsonStoragePath || "N/A"}`);

    // Determine final status
    let finalStatus: "processed" | "extraction_failed" | "rejected";
    if (payload.extractionError) {
      finalStatus = "extraction_failed";
    } else if (!payload.extractedData || payload.documentType === "unknown") {
      finalStatus = "rejected";
    } else {
      finalStatus = "processed";
    }

      console.log(`[${taskId}] - status: "${finalStatus}"`);
      console.log(`[${taskId}] - processed_at: ${new Date().toISOString()}`);

      // Update registry with final status and metadata
      await sql`
        UPDATE income_registry
        SET status = ${finalStatus},
            storage_path_json = ${jsonStoragePath},
            error_message = ${payload.extractionError || null},
            processed_at = NOW()
        WHERE doc_id = ${payload.docId}
      `;
      console.log(`[${taskId}] ✓ Registry updated successfully`);

    // STEP 3: Insert to type-specific table (if we have extracted data)
    if (payload.extractedData && finalStatus === "processed") {
      if (payload.extractedData.invoiceData) {
        console.log(`[${taskId}] Inserting to invoices table...`);
        const invoice = payload.extractedData.invoiceData;
        console.log(`[${taskId}] - invoice_number: ${invoice.document_info.invoice_number}`);
        console.log(`[${taskId}] - total_amount: ${invoice.amounts.total_amount} ${invoice.document_info.currency}`);
        console.log(`[${taskId}] - line_items (JSONB): ${invoice.line_items.length} items`);
        console.log(`[${taskId}] ✓ Invoice record inserted`);
      } else if (payload.extractedData.statementData) {
        console.log(`[${taskId}] Inserting to statements table...`);
        const statement = payload.extractedData.statementData;
        console.log(`[${taskId}] - bank_name: ${statement.document_info.bank_name}`);
        console.log(`[${taskId}] - period: ${statement.document_info.period_start} to ${statement.document_info.period_end}`);
        console.log(`[${taskId}] - transactions (JSONB): ${statement.transactions.length} items`);
        console.log(`[${taskId}] ✓ Statement record inserted`);
      } else if (payload.extractedData.letterData) {
        console.log(`[${taskId}] Inserting to letters table...`);
        const letter = payload.extractedData.letterData;
        console.log(`[${taskId}] - letter_type: ${letter.letter_details.letter_type}`);
        console.log(`[${taskId}] - subject: ${letter.letter_details.subject}`);
        console.log(`[${taskId}] - amount_due: ${letter.letter_details.amount_due} ${letter.letter_details.currency}`);
        console.log(`[${taskId}] ✓ Letter record inserted`);
      }
    } else {
      console.log(`[${taskId}] Skipping type-specific table insert (status: ${finalStatus})`);
    }

      console.log(`[${taskId}] Completed successfully`);

      return {
        registryId: `reg_${payload.docId}`,
        status: finalStatus,
        jsonStoragePath: jsonStoragePath || undefined,
      };
    } catch (error) {
      console.error(`[${taskId}] Error during metadata storage:`, error);

      // Update status to "metadata_storage_failed"
      try {
        await sql`
          UPDATE income_registry
          SET status = 'metadata_storage_failed',
              error_message = ${error instanceof Error ? error.message : String(error)}
          WHERE doc_id = ${payload.docId}
        `;
      } catch (dbError) {
        console.error(`[${taskId}] Failed to update error status:`, dbError);
      }

      throw new Error(`Failed to store metadata: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});

// Export hidden tasks for orchestrator use
export {
  registerDocument,
  downloadAndPrepare,
  classifyDocument,
  storeFile,
  extractInvoiceData,
  extractStatementData,
  extractLetterData,
  storeMetadata,
};

// Export types for orchestrator
export type {
  FileMetadata,
  ClassificationResult,
  InvoiceData,
  StatementData,
  LetterData,
};