import { task } from "@trigger.dev/sdk";
import { getDb } from "../utils/db";
import { uploadFile } from "../utils/storage";
import type {
  ClassificationResult,
  InvoiceData,
  StatementData,
  LetterData,
  DocumentStatus,
} from "../types/domain";

type DocumentType = ClassificationResult["documentType"];

// ============================================================================
// TASK 5: STORE METADATA (Hidden)
// ============================================================================

export const storeMetadata = task({
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
    documentType: DocumentType;
    classification: ClassificationResult | null;
    extractedData?: {
      invoiceData?: InvoiceData;
      statementData?: StatementData;
      letterData?: LetterData;
    } | null;
    extractionError?: string | null;
  }) => {
    const taskId = "store-metadata";
    console.log(
      `[${taskId}] Starting metadata storage for doc: ${payload.docId}`
    );
    console.log(`[${taskId}] Document Type: ${payload.documentType}`);
    console.log(`[${taskId}] Has Extracted Data: ${!!payload.extractedData}`);
    console.log(
      `[${taskId}] Has Extraction Error: ${!!payload.extractionError}`
    );

    const sql = getDb();

    try {
      // Update status to "saving_metadata"
      console.log(
        `[${taskId}] Updating registry status to "saving_metadata"...`
      );
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

        console.log(
          `[${taskId}] Uploading JSON metadata to Supabase Storage...`
        );
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

        const jsonBuffer = Buffer.from(
          JSON.stringify(jsonContent, null, 2),
          "utf-8"
        );
        console.log(`[${taskId}] - JSON Size: ${jsonBuffer.length} bytes`);

        await uploadFile(
          jsonStoragePath,
          jsonBuffer,
          "application/json",
          `${payload.docId}.json`
        );

        console.log(`[${taskId}] ✓ JSON metadata uploaded successfully`);
      } else {
        console.log(
          `[${taskId}] Skipping JSON metadata upload (no extracted data)`
        );
      }

      // STEP 2: Update income_registry table
      console.log(`[${taskId}] Updating income_registry table...`);
      console.log(
        `[${taskId}] - classification: ${payload.classification?.documentType || "N/A"}`
      );
      console.log(
        `[${taskId}] - confidence: ${payload.classification?.confidence || 0}`
      );
      console.log(
        `[${taskId}] - reasoning: ${payload.classification?.reasoning?.substring(0, 50) || "N/A"}...`
      );
      console.log(
        `[${taskId}] - storage_path_json: ${jsonStoragePath || "N/A"}`
      );

      // Determine final status
      let finalStatus: DocumentStatus;
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
          const inv = payload.extractedData.invoiceData;
          console.log(
            `[${taskId}] - invoice_number: ${inv.document_info.invoice_number}`
          );
          console.log(
            `[${taskId}] - total_amount: ${inv.amounts.total_amount} ${inv.document_info.currency}`
          );
          console.log(
            `[${taskId}] - line_items (JSONB): ${inv.line_items.length} items`
          );

          await sql`
          INSERT INTO invoices (
            doc_id,
            invoice_number,
            invoice_date,
            due_date,
            currency,
            language,
            vendor_name,
            vendor_address,
            vendor_vat_number,
            vendor_tax_id,
            vendor_contact_email,
            customer_name,
            customer_address,
            customer_vat_number,
            subtotal,
            total_vat,
            total_amount,
            vat_rate,
            line_items,
            payment_terms,
            payment_method,
            payment_bank_details
          ) VALUES (
            ${payload.docId},
            ${inv.document_info.invoice_number},
            ${inv.document_info.invoice_date},
            ${inv.document_info.due_date},
            ${inv.document_info.currency},
            ${inv.document_info.language},
            ${inv.vendor.name},
            ${inv.vendor.address},
            ${inv.vendor.vat_number},
            ${inv.vendor.tax_id},
            ${inv.vendor.contact_email},
            ${inv.customer.name},
            ${inv.customer.address},
            ${inv.customer.vat_number},
            ${inv.amounts.subtotal},
            ${inv.amounts.total_vat},
            ${inv.amounts.total_amount},
            ${inv.amounts.vat_rate},
            ${JSON.stringify(inv.line_items)}::jsonb,
            ${inv.payment.terms},
            ${inv.payment.method},
            ${inv.payment.bank_details}
          )
          ON CONFLICT (doc_id) DO UPDATE SET
            invoice_number = EXCLUDED.invoice_number,
            invoice_date = EXCLUDED.invoice_date,
            due_date = EXCLUDED.due_date,
            currency = EXCLUDED.currency,
            language = EXCLUDED.language,
            vendor_name = EXCLUDED.vendor_name,
            vendor_address = EXCLUDED.vendor_address,
            vendor_vat_number = EXCLUDED.vendor_vat_number,
            vendor_tax_id = EXCLUDED.vendor_tax_id,
            vendor_contact_email = EXCLUDED.vendor_contact_email,
            customer_name = EXCLUDED.customer_name,
            customer_address = EXCLUDED.customer_address,
            customer_vat_number = EXCLUDED.customer_vat_number,
            subtotal = EXCLUDED.subtotal,
            total_vat = EXCLUDED.total_vat,
            total_amount = EXCLUDED.total_amount,
            vat_rate = EXCLUDED.vat_rate,
            line_items = EXCLUDED.line_items,
            payment_terms = EXCLUDED.payment_terms,
            payment_method = EXCLUDED.payment_method,
            payment_bank_details = EXCLUDED.payment_bank_details
        `;

          console.log(`[${taskId}] ✓ Invoice record inserted`);
        } else if (payload.extractedData.statementData) {
          console.log(`[${taskId}] Inserting to statements table...`);
          const stmt = payload.extractedData.statementData;
          console.log(
            `[${taskId}] - bank_name: ${stmt.document_info.bank_name}`
          );
          console.log(
            `[${taskId}] - period: ${stmt.document_info.period_start} to ${stmt.document_info.period_end}`
          );
          console.log(
            `[${taskId}] - transactions (JSONB): ${stmt.transactions.length} items`
          );

          await sql`
          INSERT INTO statements (
            doc_id,
            bank_name,
            document_title,
            period_start,
            period_end,
            currency,
            language,
            holder_name,
            account_number,
            iban,
            opening_balance,
            closing_balance,
            transactions
          ) VALUES (
            ${payload.docId},
            ${stmt.document_info.bank_name},
            ${stmt.document_info.document_title},
            ${stmt.document_info.period_start},
            ${stmt.document_info.period_end},
            ${stmt.document_info.currency},
            ${stmt.document_info.language},
            ${stmt.account.holder_name},
            ${stmt.account.account_number},
            ${stmt.account.iban},
            ${stmt.account.opening_balance},
            ${stmt.account.closing_balance},
            ${JSON.stringify(stmt.transactions)}::jsonb
          )
          ON CONFLICT (doc_id) DO UPDATE SET
            bank_name = EXCLUDED.bank_name,
            document_title = EXCLUDED.document_title,
            period_start = EXCLUDED.period_start,
            period_end = EXCLUDED.period_end,
            currency = EXCLUDED.currency,
            language = EXCLUDED.language,
            holder_name = EXCLUDED.holder_name,
            account_number = EXCLUDED.account_number,
            iban = EXCLUDED.iban,
            opening_balance = EXCLUDED.opening_balance,
            closing_balance = EXCLUDED.closing_balance,
            transactions = EXCLUDED.transactions
        `;

          console.log(`[${taskId}] ✓ Statement record inserted`);
        } else if (payload.extractedData.letterData) {
          console.log(`[${taskId}] Inserting to letters table...`);
          const letter = payload.extractedData.letterData;
          console.log(
            `[${taskId}] - letter_type: ${letter.letter_details.letter_type}`
          );
          console.log(
            `[${taskId}] - subject: ${letter.letter_details.subject}`
          );
          console.log(
            `[${taskId}] - amount_due: ${letter.letter_details.amount_due} ${letter.letter_details.currency}`
          );

          await sql`
          INSERT INTO letters (
            doc_id,
            letter_type,
            language,
            letter_date,
            subject,
            reference_number,
            due_date,
            amount_due,
            currency,
            sender_organization,
            sender_address,
            sender_country,
            sender_contact_title,
            sender_reference,
            recipient_organization,
            recipient_title,
            recipient_address,
            recipient_country,
            content_greeting,
            content_main_text,
            content_closing
          ) VALUES (
            ${payload.docId},
            ${letter.letter_details.letter_type},
            ${letter.document_info.language},
            ${letter.document_info.date},
            ${letter.letter_details.subject},
            ${letter.letter_details.reference_number},
            ${letter.letter_details.due_date},
            ${letter.letter_details.amount_due},
            ${letter.letter_details.currency},
            ${letter.sender.organization},
            ${letter.sender.address},
            ${letter.sender.country},
            ${letter.sender.contact_title},
            ${letter.sender.reference},
            ${letter.recipient.organization},
            ${letter.recipient.title},
            ${letter.recipient.address},
            ${letter.recipient.country},
            ${letter.content.greeting},
            ${letter.content.main_text},
            ${letter.content.closing}
          )
          ON CONFLICT (doc_id) DO UPDATE SET
            letter_type = EXCLUDED.letter_type,
            language = EXCLUDED.language,
            letter_date = EXCLUDED.letter_date,
            subject = EXCLUDED.subject,
            reference_number = EXCLUDED.reference_number,
            due_date = EXCLUDED.due_date,
            amount_due = EXCLUDED.amount_due,
            currency = EXCLUDED.currency,
            sender_organization = EXCLUDED.sender_organization,
            sender_address = EXCLUDED.sender_address,
            sender_country = EXCLUDED.sender_country,
            sender_contact_title = EXCLUDED.sender_contact_title,
            sender_reference = EXCLUDED.sender_reference,
            recipient_organization = EXCLUDED.recipient_organization,
            recipient_title = EXCLUDED.recipient_title,
            recipient_address = EXCLUDED.recipient_address,
            recipient_country = EXCLUDED.recipient_country,
            content_greeting = EXCLUDED.content_greeting,
            content_main_text = EXCLUDED.content_main_text,
            content_closing = EXCLUDED.content_closing
        `;

          console.log(`[${taskId}] ✓ Letter record inserted`);
        }
      } else {
        console.log(
          `[${taskId}] Skipping type-specific table insert (status: ${finalStatus})`
        );
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

      throw new Error(
        `Failed to store metadata: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
});
