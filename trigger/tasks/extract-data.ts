import { task } from "@trigger.dev/sdk";
import {
  extractInvoice as claudeExtractInvoice,
  extractStatement as claudeExtractStatement,
  extractLetter as claudeExtractLetter,
} from "../utils/claude";
import type { InvoiceData, StatementData, LetterData } from "../types/domain";

// ============================================================================
// TASK 4a: EXTRACT INVOICE DATA (Hidden)
// ============================================================================

export const extractInvoiceData = task({
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

    if (!payload.claudeFileId) {
      throw new Error("Claude File ID is required for invoice extraction");
    }

    try {
      // Call Claude API for invoice extraction
      console.log(
        `[${taskId}] Calling Claude with invoice extraction prompt...`
      );
      console.log(`[${taskId}] Requesting structured invoice data...`);

      const invoiceData = await claudeExtractInvoice(payload.claudeFileId);

      console.log(`[${taskId}] ✓ Extraction completed successfully`);
      console.log(
        `[${taskId}] - Invoice Number: ${invoiceData.document_info.invoice_number}`
      );
      console.log(
        `[${taskId}] - Total Amount: ${invoiceData.amounts.total_amount} ${invoiceData.document_info.currency}`
      );
      console.log(`[${taskId}] - Line Items: ${invoiceData.line_items.length}`);

      console.log(`[${taskId}] Completed successfully`);

      return { invoiceData };
    } catch (error) {
      console.error(`[${taskId}] Extraction failed:`, error);
      throw new Error(
        `Failed to extract invoice data: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
});

// ============================================================================
// TASK 4b: EXTRACT STATEMENT DATA (Hidden)
// ============================================================================

export const extractStatementData = task({
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

    if (!payload.claudeFileId) {
      throw new Error("Claude File ID is required for statement extraction");
    }

    try {
      // Call Claude API for statement extraction
      console.log(
        `[${taskId}] Calling Claude with statement extraction prompt...`
      );
      console.log(`[${taskId}] Requesting structured bank statement data...`);

      const statementData = await claudeExtractStatement(payload.claudeFileId);

      console.log(`[${taskId}] ✓ Extraction completed successfully`);
      console.log(
        `[${taskId}] - Bank: ${statementData.document_info.bank_name}`
      );
      console.log(
        `[${taskId}] - Period: ${statementData.document_info.period_start} to ${statementData.document_info.period_end}`
      );
      console.log(
        `[${taskId}] - Transactions: ${statementData.transactions.length}`
      );
      console.log(
        `[${taskId}] - Opening Balance: ${statementData.account.opening_balance} ${statementData.document_info.currency}`
      );
      console.log(
        `[${taskId}] - Closing Balance: ${statementData.account.closing_balance} ${statementData.document_info.currency}`
      );

      console.log(`[${taskId}] Completed successfully`);

      return { statementData };
    } catch (error) {
      console.error(`[${taskId}] Extraction failed:`, error);
      throw new Error(
        `Failed to extract statement data: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
});

// ============================================================================
// TASK 4c: EXTRACT LETTER DATA (Hidden)
// ============================================================================

export const extractLetterData = task({
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

    if (!payload.claudeFileId) {
      throw new Error("Claude File ID is required for letter extraction");
    }

    try {
      // Call Claude API for letter extraction
      console.log(
        `[${taskId}] Calling Claude with letter extraction prompt...`
      );
      console.log(`[${taskId}] Requesting structured official letter data...`);

      const letterData = await claudeExtractLetter(payload.claudeFileId);

      console.log(`[${taskId}] ✓ Extraction completed successfully`);
      console.log(
        `[${taskId}] - Letter Type: ${letterData.letter_details.letter_type}`
      );
      console.log(
        `[${taskId}] - Subject: ${letterData.letter_details.subject}`
      );
      console.log(
        `[${taskId}] - Due Date: ${letterData.letter_details.due_date}`
      );
      console.log(
        `[${taskId}] - Amount Due: ${letterData.letter_details.amount_due} ${letterData.letter_details.currency}`
      );

      console.log(`[${taskId}] Completed successfully`);

      return { letterData };
    } catch (error) {
      console.error(`[${taskId}] Extraction failed:`, error);
      throw new Error(
        `Failed to extract letter data: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
});
