# Document Processing Workflow Design

## Overview

This document describes the complete workflow for automated document processing using Google Drive, Trigger.dev, Claude AI, and Supabase.

**Last Updated:** 2025-09-30
**Status:** Design Complete, Ready for Implementation

## Architecture Principles

1. **Task Decomposition**: Complex workflow broken into independent tasks with clear API boundaries
2. **Orchestrator Pattern**: Central task coordinates sequential execution using `triggerAndWait()`
3. **Failure Isolation**: Each API boundary has independent retry logic to avoid expensive re-computation
4. **Early Registration**: Documents registered immediately to prevent loss
5. **Idempotent Operations**: Storage operations use upserts for safe retries
6. **Stateless Tasks**: No large data (Buffers) passed in task outputs - all files stored in external storage immediately
7. **Inbox Pattern**: Files uploaded to inbox folder first, then moved to permanent location after classification
8. **POC Scope**: JSONB columns for nested data (line items, transactions) to simplify implementation

## High-Level Flow

```
Cron Job (Google Drive Watcher)
  └─> Detect new PDF files in INBOX folder
       └─> For each new file: trigger process-document-workflow

process-document-workflow (Orchestrator)
  ├─> 0. register-document        [Supabase DB] - Create registry entry
  ├─> 1. download-and-prepare     [Google Drive → Supabase inbox] - Download and upload to inbox/{docId}.pdf
  ├─> 2. classify-document        [Supabase Storage → Claude API] - Read from inbox, classify document type
  ├─> 3. store-file               [Supabase Storage + Google Drive] - Move to permanent location, delete from inboxes (SAFE POINT!)
  ├─> 4. extract-document-data    [Claude API] - Extract structured data (type-specific)
  └─> 5. store-metadata           [Supabase DB] - Save extracted data to database

Key Architecture Improvements:
- Step 1: File immediately uploaded to Supabase inbox (stateless tasks begin here)
- Step 2+: All tasks read from Supabase Storage, never pass Buffers in task outputs
- Step 3: Moves file from inbox/{docId}.pdf to {type}/{year}/{month}/{docId}.pdf
- After Step 3: Both Google Drive inbox AND Supabase inbox are cleaned
- File is safe once in permanent location (step 3 - SAFE POINT)
```

## Task Definitions

### Task 0: `register-document` (First Operation)

**Purpose:** Create registry entry immediately to ensure no document is lost

**API Dependencies:** Supabase Database

```typescript
Input:  {
  fileId: string,        // Google Drive file ID
  fileName: string,
  mimeType: string,
  createdTime: string
}

Actions:
  - Insert record to income_registry table
  - Set status: "new"
  - Record file metadata

Output: {
  registryId: string,
  docId: string
}

Retry:  3 attempts (database operations)
Failure: Critical - throw error to prevent document loss
```

**Status:** `new`

---

### Task 1: `download-and-prepare`

**Purpose:** Download file from Google Drive and upload to Supabase Storage inbox (stateless operation)

**API Dependencies:** Google Drive API, Supabase Storage (S3)

```typescript
Input:  {
  docId: string,
  fileId: string,
  fileName: string,
  mimeType: string
}

Actions:
  - Validate mimeType (must be "application/pdf")
  - Download file from Google Drive as Buffer
  - Upload file to Supabase Storage inbox folder: `inbox/{docId}.pdf`
  - Store original filename in object metadata
  - Update registry status: "downloading" before download, then "downloaded" on success

Output: {
  storagePath: string,      // inbox/{docId}.pdf
  storageUrl: string,       // Full S3 URL
  metadata: FileMetadata,
  md5Checksum: string       // From Google Drive
}

Retry:  5 attempts (Google API can be flaky)
Failure:
  - Update registry status: "download_failed"
  - Store error details
  - Stop workflow

Key Improvement:
  - No state held in task (no Buffer in output)
  - File immediately stored in external storage (Supabase S3)
  - Enables stateless retries - subsequent tasks read from storage
  - Inbox folder acts as staging area before classification
```

**Status Transitions:** `new` → `downloading` → `downloaded` | `download_failed`

---

### Task 2: `classify-document`

**Purpose:** Classify document type using Claude AI (stateless - reads from storage)

**API Dependencies:** Claude API (Anthropic), Supabase Storage (S3)

```typescript
Input:  {
  docId: string,
  storagePath: string,       // inbox/{docId}.pdf
  metadata: FileMetadata
}

Actions:
  - Download file from Supabase Storage using storagePath
  - Upload file to Claude Files API
  - Call Claude with classification prompt:
    * Categories: invoice, bank_statement, government_letter, unknown
    * Request confidence score + reasoning
  - Parse JSON response
  - Apply confidence threshold (>= 0.8)
  - Update registry status: "classifying" before the call, then persist classification fields with status "classified" (or "classification_failed" on fallback)

Output: {
  documentType: "invoice" | "bank_statement" | "government_letter" | "unknown",
  confidence: number,        // 0.0 - 1.0
  reasoning: string,
  possibleType: string,      // Original prediction before threshold
  claudeFileId: string | null
}

Retry:  10 attempts (AI APIs need more tolerance)
Failure:
  - Default to documentType: "unknown"
  - Set confidence: 0.0 and claudeFileId: null
  - Update registry status: "classification_failed"
  - Continue workflow (still store the file)

Key Improvement:
  - Reads file from Supabase Storage (not from previous task output)
  - Fully stateless - can retry without re-downloading from Google Drive
  - File already safe in inbox folder
```

**Status Transitions:** `downloaded` → `classifying` → `classified` | `classification_failed`

**Decision Point:**
- If `documentType === "unknown"` OR `confidence < 0.8`: Skip extraction, go to storage

---

### Task 3: `store-file` (SAFE POINT)

**Purpose:** Move the PDF from the inbox staging area into its permanent location and clean up temporary copies

**API Dependencies:** Supabase Storage (S3), Google Drive API

```typescript
Input:  {
  docId: string,
  fileId: string,
  storagePath: string,       // inbox/{docId}.pdf
  fileName: string,
  documentType: "invoice" | "bank_statement" | "government_letter" | "unknown",
  metadata: FileMetadata
}

Actions:
  - Update registry status to "storing"
  - Derive final storage path: `{documentType}/{year}/{month}/{docId}.pdf`
  - Copy the file from `inbox/{docId}.pdf` to the final path in Supabase Storage
  - Move the Google Drive file into a processed folder when `DRIVE_PROCESSED_FOLDER_ID` is configured (best effort - non fatal)
  - Delete the Supabase inbox object to keep staging empty
  - Update registry with `storage_path_pdf` and status `stored`

Output: {
  stored: boolean,
  storagePath: string,
  deletedFromInbox: boolean
}

Retry:  5 attempts (copy + delete operations are idempotent)
Failure:
  - Update registry status: "store_failed"
  - Throw error (workflow cannot continue without a permanent copy)

Key Improvement:
  - Establishes the SAFE POINT — after this task the PDF exists only in its organized, permanent location and the inbox staging folder is clear
```

**Status Transitions:** `classified` → `storing` → `stored` | `store_failed`

**Why This Matters:**
- ✅ Document is persistent in the organized Supabase path (type/year/month/docId)
- ✅ Supabase inbox is cleared, so retries do not accumulate temporary copies
- ✅ Google Drive inbox entry is moved out of the watched folder, preventing reprocessing
- ✅ Expensive extraction steps can retry safely because the file no longer depends on Google Drive availability
- ✅ Operations are idempotent; re-running the task overwrites the same final path without duplication

---

### Task 4a: `extract-invoice-data` (Hidden Task)

**Purpose:** Extract structured invoice data for downstream storage

**API Dependencies:** Claude API (Anthropic)

```typescript
Input:  {
  docId: string,
  claudeFileId: string | null
}

Actions:
  - Require a valid Claude file id (throws if missing)
  - Call Claude with the invoice extraction prompt
  - Parse and validate the structured JSON response against the expected schema

Output: {
  invoiceData: InvoiceData
}

Retry:  10 attempts
Failure:
  - Throw error; the orchestrator records the message and continues to metadata storage without extracted data
```

**Example:** See `docs/invoice.json`

---

### Task 4b: `extract-statement-data` (Hidden Task)

**Purpose:** Extract structured bank statement data

**API Dependencies:** Claude API (Anthropic)

```typescript
Input:  {
  docId: string,
  claudeFileId: string | null
}

Actions:
  - Require a valid Claude file id (throws if missing)
  - Call Claude with the bank statement extraction prompt
  - Parse and validate the JSON response

Output: {
  statementData: StatementData
}

Retry:  10 attempts
Failure: Same handling as the invoice extractor (error bubbles up to orchestrator)
```

**Example:** See `docs/statement.json`

---

### Task 4c: `extract-letter-data` (Hidden Task)

**Purpose:** Extract structured government-letter data

**API Dependencies:** Claude API (Anthropic)

```typescript
Input:  {
  docId: string,
  claudeFileId: string | null
}

Actions:
  - Require a valid Claude file id (throws if missing)
  - Call Claude with the official letter extraction prompt (includes reasoning checklist)
  - Parse and validate the JSON response

Output: {
  letterData: LetterData
}

Retry:  10 attempts
Failure: Same handling as other extractors (error returned to orchestrator)
```

**Examples:** See `docs/letter.json` and `docs/tax_letter.json`

---

### Task 5: `store-metadata`

**Purpose:** Persist classification, extraction results, and metadata to Supabase

**API Dependencies:** Supabase Database, Supabase Storage

```typescript
Input:  {
  docId: string,
  documentType: "invoice" | "bank_statement" | "government_letter" | "unknown",
  classification: ClassificationResult | null,
  extractedData?: {
    invoiceData?: InvoiceData;
    statementData?: StatementData;
    letterData?: LetterData;
  } | null,
  extractionError?: string | null
}

Actions:
  1. Update registry status to "saving_metadata"
  2. When extracted data exists, upload `{classification, extractedData, metadata}` JSON to Supabase Storage at `{documentType}/{year}/{month}/{docId}.json`
  3. Determine final status:
     - `extraction_failed` if `extractionError` is present
     - `rejected` when no extracted data or documentType is `"unknown"`
     - `processed` otherwise
  4. Update `income_registry` with status, storage path, confidence, reasoning, and error details
  5. Upsert into the type-specific table that matches the extracted payload (invoices/statements/letters)

Output: {
  registryId: string,
  status: DocumentStatus,
  jsonStoragePath?: string
}

Retry:  3 attempts (database operations and storage upload are idempotent)
Failure:
  - Update registry status to "metadata_storage_failed"
  - Throw error so the orchestrator retries from Step 5 (the PDF is already safe)
```

**Status Transitions:** `stored` → `saving_metadata` → `processed` | `extraction_failed` | `rejected`

**Status Values:**
- `processed`: Successfully stored with extracted data
- `extraction_failed`: Stored file + classification, but extraction failed
- `rejected`: Low confidence or unknown type (stored without extraction)


## Orchestrator Task: `process-document-workflow`

**Purpose:** Coordinate the entire document processing pipeline

**Execution outline:**

1. **Create global idempotency key** with `idempotencyKeys.create(payload.fileId, { scope: "global" })` and reuse it (TTL `60s`) for every `triggerAndWait` call.
2. **Register document (Step 0).** Trigger `registerDocument` with the original payload. Throw on failure. Capture `{ docId, registryId }` on success.
3. **Download & prepare (Step 1).** Trigger `downloadAndPrepare` with `{ docId, fileId, fileName, mimeType }`. On failure return early with a `WorkflowOutput` describing the `download_failed` status, `documentType: "unknown"`, `confidence: 0`, `pdfStoragePath: ""`, `inboxCleaned: false`, and the error message. On success capture the inbox storage path, metadata, and checksum.
4. **Classify (Step 2).** Trigger `classifyDocument`. When it succeeds, hold on to the `ClassificationResult`. When it fails, continue with a synthesized fallback (`documentType: "unknown"`, `confidence: 0`, `claudeFileId: null`).
5. **Store file (Step 3 / SAFE POINT).** Trigger `storeFile` with `{ docId, fileId, storagePath, fileName, documentType, metadata }`. Any failure throws. Success yields the permanent storage path and inbox cleanup indicator.
6. **Extract data (Step 4).** Only run extraction when `documentType !== "unknown"`, `confidence >= 0.8`, and `claudeFileId` is available. Trigger the matching extractor task. If the extractor fails, note the `extractionError`; otherwise capture the extracted payload.
7. **Store metadata (Step 5).** Trigger `storeMetadata` with the classification (possibly `null`), optional extracted data, and any `extractionError`. Failure throws so the orchestrator retries from this step while the PDF remains safe in storage.
8. **Return `WorkflowOutput`.** Merge the metadata status, document type, confidence, registry/document IDs, permanent storage path, optional JSON path, and `inboxCleaned` flag. Errors are only populated for early download failures.

## Registry Status Lifecycle

```
new
  ↓
downloading → download_failed [END]
  ↓
downloaded
  ↓
classifying → classification_failed (default to "unknown", continue)
  ↓
classified
  ↓
storing → store_failed [END - manual intervention needed]
  ↓
stored [SAFE POINT - File in Supabase, inbox cleaned]
  ↓
saving_metadata → metadata_storage_failed [RETRY from STEP 5]
  ↓
processed | extraction_failed | rejected [END]
```

**Key Insight:** Once status = `stored`, the file is safe in Supabase Storage and inbox is clean. All subsequent failures (extraction, metadata storage) can be retried without risk of:
- Losing the document
- Reprocessing it from inbox (file is deleted from Drive)
- Data loss (PDF is in permanent storage)

## Error Handling Strategy

| Failure Type | Action | Status | Continue Workflow? |
|--------------|--------|--------|-------------------|
| Registration failed | Throw error | - | ❌ No (critical) |
| Download failed | Update registry | `download_failed` | ❌ No |
| Classification failed | Default to "unknown" | `classification_failed` | ✅ Yes (store in unknown folder) |
| File storage failed | Update registry | `store_failed` | ❌ No (critical - can't continue) |
| Extraction failed | Record error, continue to metadata | `extraction_failed` (set in Step 5) | ✅ Yes (file already stored) |
| Metadata storage failed | Throw error | `metadata_storage_failed` | ❌ No (retry from STEP 5, PDF safe) |

## Supabase Schema Requirements

### Database Tables

> **POC Scope:** Using JSONB columns for line items and transactions instead of separate tables to simplify implementation.

```sql
-- Main document registry
CREATE TABLE income_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id TEXT UNIQUE NOT NULL,           -- Google Drive file ID
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,       -- Google Drive creation time

  -- Classification
  classification TEXT,                    -- invoice, bank_statement, government_letter, unknown
  confidence NUMERIC,
  reasoning TEXT,
  possible_type TEXT,                     -- Pre-threshold classification

  -- Storage paths
  storage_path_pdf TEXT,
  storage_path_json TEXT,

  -- Processing status
  status TEXT NOT NULL DEFAULT 'new',    -- See status lifecycle above
  error_message TEXT,

  -- Timestamps
  registered_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  cleanup_at TIMESTAMPTZ
);

-- Indexes for income_registry
CREATE INDEX idx_income_registry_status ON income_registry(status);
CREATE INDEX idx_income_registry_classification ON income_registry(classification);
CREATE INDEX idx_income_registry_created_at ON income_registry(created_at DESC);

-- Invoice details
CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id TEXT UNIQUE NOT NULL REFERENCES income_registry(doc_id) ON DELETE CASCADE,

  -- Document info
  invoice_number TEXT,
  invoice_date DATE,
  due_date DATE,
  currency TEXT,
  language TEXT,

  -- Vendor
  vendor_name TEXT,
  vendor_address TEXT,
  vendor_vat_number TEXT,
  vendor_tax_id TEXT,
  vendor_contact_email TEXT,

  -- Customer
  customer_name TEXT,
  customer_address TEXT,
  customer_vat_number TEXT,

  -- Amounts
  subtotal NUMERIC,
  total_vat NUMERIC,
  total_amount NUMERIC,
  vat_rate NUMERIC,

  -- Payment
  payment_terms TEXT,
  payment_method TEXT,
  bank_details TEXT,

  -- Line items as JSONB (POC scope)
  line_items JSONB,
  -- Example: [{"description": "...", "quantity": 10, "unit_price": 100, ...}]

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_invoices_invoice_date ON invoices(invoice_date DESC);
CREATE INDEX idx_invoices_doc_id ON invoices(doc_id);

-- Bank statements
CREATE TABLE statements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id TEXT UNIQUE NOT NULL REFERENCES income_registry(doc_id) ON DELETE CASCADE,

  -- Document info
  statement_type TEXT DEFAULT 'bank_statement',
  bank_name TEXT,
  document_title TEXT,
  period_start DATE,
  period_end DATE,
  currency TEXT,
  language TEXT,

  -- Account
  holder_name TEXT,
  account_number TEXT,
  iban TEXT,
  opening_balance NUMERIC,
  closing_balance NUMERIC,

  -- Transactions as JSONB (POC scope)
  transactions JSONB,
  -- Example: [{"date": "2025-01-15", "description": "...", "amount": -100, "balance": 900}]

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_statements_period_end ON statements(period_end DESC);
CREATE INDEX idx_statements_doc_id ON statements(doc_id);

-- Official letters
CREATE TABLE letters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id TEXT UNIQUE NOT NULL REFERENCES income_registry(doc_id) ON DELETE CASCADE,

  -- Document info
  letter_date DATE,
  language TEXT,

  -- Letter details
  subject TEXT,
  reference_number TEXT,
  due_date DATE,
  amount_due NUMERIC,
  currency TEXT,
  letter_type TEXT,  -- tax_notice, vat_reminder, audit_notice, compliance, other

  -- Sender
  sender_organization TEXT,
  sender_address TEXT,
  sender_country TEXT,
  sender_contact_title TEXT,
  sender_reference TEXT,

  -- Recipient
  recipient_organization TEXT,
  recipient_title TEXT,
  recipient_address TEXT,
  recipient_country TEXT,

  -- Content
  greeting TEXT,
  main_text TEXT,
  closing TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_letters_letter_date ON letters(letter_date DESC);
CREATE INDEX idx_letters_due_date ON letters(due_date);
CREATE INDEX idx_letters_doc_id ON letters(doc_id);
```

### JSONB Column Examples

**invoices.line_items:**
```json
[
  {
    "description": "Catering Services",
    "quantity": 21,
    "unit_price": 271.5,
    "vat_rate": 21,
    "vat_amount": 1200.32,
    "line_total": 6898.82
  }
]
```

**statements.transactions:**
```json
[
  {
    "date": "2025-08-21",
    "description": "Reisekosten",
    "amount": -2212.31,
    "balance": 13720.28
  }
]
```

### Storage Buckets

**Bucket: `documents`**

Structure:
```
documents/
  ├── inbox/                    [NEW: Staging area before classification]
  │   └── {docId}.pdf          [Temporary storage during processing]
  ├── invoice/
  │   ├── 2025/
  │   │   ├── 01/
  │   │   │   ├── {docId}.pdf  [Permanent location after classification]
  │   │   │   └── {docId}.json [Metadata/extracted data]
  │   │   └── 02/
  │   └── 2024/
  ├── bank_statement/
  ├── government_letter/
  └── unknown/
```

**Storage Flow:**
1. **Step 1** (`download-and-prepare`): Upload to `inbox/{docId}.pdf`
2. **Step 2** (`classify-document`): Read from inbox, classify type
3. **Step 3** (`store-file`): Move to `{type}/{year}/{month}/{docId}.pdf`, delete inbox file
4. **Step 5** (`store-metadata`): Upload JSON to `{type}/{year}/{month}/{docId}.json`

Storage Policies:
- Authenticated read/write for service role (S3 credentials)
- Public read disabled
- Max file size: 50 MB (configurable)
- Inbox files are temporary (cleaned up in Step 3)

## Cron Job Integration

**Location:** `packages/cron/src/index.ts`

```typescript
import { tasks } from "@trigger.dev/sdk";
import { google } from "googleapis";

const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;
const CHECK_INTERVAL = 60_000; // 1 minute

async function checkNewFiles() {
  const drive = google.drive({ version: 'v3', auth: serviceAccountAuth });

  // List files in inbox (filter: mimeType = application/pdf, not processed)
  const response = await drive.files.list({
    q: `'${DRIVE_FOLDER_ID}' in parents and mimeType='application/pdf' and trashed=false`,
    fields: 'files(id, name, mimeType, createdTime)',
    orderBy: 'createdTime desc',
  });

  const newFiles = response.data.files || [];

  if (newFiles.length === 0) {
    console.log('No new files found');
    return;
  }

  console.log(`Found ${newFiles.length} new files, triggering workflows...`);

  // Batch trigger workflows for all new files
  await tasks.batchTrigger("process-document-workflow",
    newFiles.map(file => ({
      payload: {
        fileId: file.id,
        fileName: file.name,
        mimeType: file.mimeType,
        createdTime: file.createdTime,
      }
    }))
  );
}

// Railway cron entry point
async function main() {
  await checkNewFiles();
  process.exit(0);
}

main().catch(console.error);
```

**Railway Configuration:**
- Schedule: `*/5 * * * *` (every 5 minutes)
- Timeout: 60 seconds
- Concurrency: 1 (prevent overlapping runs)

## Cost & Performance Considerations

### API Call Costs

**Per Document:**
- Google Drive: 2 calls (download + delete) - Free
- Claude API: 2-3 calls (classification + extraction) - ~$0.02-0.05
- Supabase: 4-6 DB operations + 2 storage uploads - Free tier

**Estimated Cost:** ~$0.03-0.07 per document

### Retry Strategy Impact

| Task | Max Attempts | Typical Retries | API Calls on Failure |
|------|-------------|-----------------|---------------------|
| Register | 3 | 0 | 3 DB ops |
| Download | 5 | 1 | 5 Drive API calls |
| Classify | 10 | 2 | 20 Claude calls (expensive!) |
| Move | 5 | 1 | 5 Drive API calls |
| Extract | 10 | 1 | 10 Claude calls |
| Store | 3 | 0 | 3 DB ops + 3 uploads |

**Optimization:**
- Classification and extraction failures are expensive, but necessary for reliability
- **Moving file early** protects against data loss and enables safe retries of expensive operations

### Parallelization Opportunities

**Current State:** All tasks run sequentially per document

**Future Optimization:**
- Multiple documents process in parallel (already supported via `batchTrigger`)
- Could parallelize download + classification if Claude supports URL-based file upload
- Extract tasks could run in parallel if we had multiple document types (not applicable here)

## POC Scope Decisions

1. ✅ **JSONB for nested data** - Invoices store `line_items` as JSONB, statements store `transactions` as JSONB
2. ✅ **No error notifications** - Rely on status field in registry
3. ✅ **Hidden extraction tasks** - Not exported, only called by orchestrator
4. ✅ **Early file organization** - Move to destination folder after classification (before extraction)
   - Creates safe checkpoint for retries
   - Matches n8n workflow pattern
   - Files never lost or duplicated

## Next Steps

1. ✅ Define workflow architecture
2. ✅ Define Supabase schema (simplified for POC)
3. ⏳ Set up Supabase project and create tables
4. ⏳ Implement worker tasks
5. ⏳ Implement orchestrator task
6. ⏳ Connect cron job to orchestrator
7. ⏳ Test end-to-end workflow
8. ⏳ Deploy to production

## Environment Variables Required

```bash
# Google Drive
DRIVE_FOLDER_ID=<inbox_folder_id>  # Only need inbox folder now!

# Google Service Account (existing)
GOOGLE_CLIENT_EMAIL=
GOOGLE_PRIVATE_KEY=
GOOGLE_PROJECT_ID=
GOOGLE_PRIVATE_KEY_ID=
GOOGLE_CLIENT_ID=
GOOGLE_AUTH_URL=
GOOGLE_TOKEN_URL=
GOOGLE_AUTH_PROVIDER_X509_CERT_URL=
GOOGLE_CLIENT_X509_CERT_URL=
GOOGLE_UNIVERSE_DOMAIN=

# Anthropic
ANTHROPIC_API_KEY=

# Supabase Database
SUPABASE_DB_STRING=         # Transaction Pooler connection string for Postgres

# Supabase Storage (S3-compatible)
SUPABASE_STORAGE_ACCESS_POINT=     # https://<project-ref>.supabase.co/storage/v1/s3
SUPABASE_STORAGE_REGION=           # Project region (e.g., us-east-1)
SUPABASE_STORAGE_ACCESS_KEY_ID=    # S3 access key ID
SUPABASE_STORAGE_ACCESS_KEY=       # S3 secret access key
SUPABASE_STORAGE_BUCKET=documents  # Storage bucket name

# Trigger.dev (existing)
TRIGGER_SECRET_KEY=
```

**Note:** We no longer need separate Drive folder IDs for invoices/statements/letters. Files are stored in Supabase with paths like:
- `invoice/2025/09/abc123.pdf`
- `bank_statement/2025/09/def456.pdf`
- `government_letter/2025/09/ghi789.pdf`
- `unknown/2025/09/jkl012.pdf`

---

**Version:** 1.4 (Stateless Task Architecture)
**Changes:**
- v1.0: Initial design
- v1.1: Simplified schema with JSONB columns for line items and transactions
- v1.2: Move file to destination folder after classification (before extraction) - creates safe checkpoint
- v1.3: **Corrected architecture** - Upload to Supabase Storage (not Google Drive folders), delete from inbox. Split into `store-file` and `store-metadata` tasks
- v1.4: **Stateless tasks** - Files uploaded to Supabase inbox immediately in Step 1, all subsequent tasks read from storage (no Buffers in task outputs). Inbox pattern: `inbox/{docId}.pdf` → `{type}/{year}/{month}/{docId}.pdf`
