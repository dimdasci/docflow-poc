# Document Processing Triggers

This directory contains Trigger.dev v4 tasks for automated document processing workflow.

## Architecture

The workflow follows an **orchestrator pattern** with isolated, independently retriable tasks:

- **Orchestrator**: `processDocumentWorkflow` (exported)
- **Worker Tasks**: 7 hidden tasks that handle specific operations

## Task Structure

### Orchestrator Task

**`processDocumentWorkflow`** (`workflow.ts`)
- **ID**: `process-document-workflow`
- **Purpose**: Coordinates the entire document processing pipeline
- **Retry**: 2 attempts (only retries on storage failures)
- **Exported**: ✅ Yes (trigger from cron or API)

### Worker Tasks (Hidden)

All worker tasks are defined in `document-tasks.ts` and are NOT exported for external use:

1. **`registerDocument`**
   - Creates initial registry entry to prevent document loss
   - Retry: 3 attempts
   - Critical: Throws error if fails

2. **`downloadAndPrepare`**
   - Downloads file from Google Drive
   - Validates MIME type (must be PDF)
   - Retry: 5 attempts
   - Returns: File buffer + metadata

3. **`classifyDocument`**
   - Classifies document using Claude AI
   - Types: invoice, bank_statement, government_letter, unknown
   - Retry: 10 attempts (AI API needs tolerance)
   - Non-fatal: Defaults to "unknown" on failure

4. **`storeFile`** ⭐ **SAFE POINT**
   - Uploads PDF to Supabase Storage
   - Deletes file from Google Drive inbox
   - Retry: 5 attempts (idempotent)
   - Critical: Once this succeeds, document is safe

5. **`extractInvoiceData`**
   - Extracts structured invoice data
   - Retry: 10 attempts
   - Non-fatal: Workflow continues without data

6. **`extractStatementData`**
   - Extracts structured bank statement data
   - Retry: 10 attempts
   - Non-fatal: Workflow continues without data

7. **`extractLetterData`**
   - Extracts structured government letter data
   - Retry: 10 attempts
   - Non-fatal: Workflow continues without data

8. **`storeMetadata`**
   - Saves extracted data and metadata to Supabase
   - Updates registry with final status
   - Inserts to type-specific tables
   - Retry: 3 attempts
   - Critical: Throws error to retry orchestrator

## Workflow Sequence

```
1. Register Document         → Creates registry entry (status: "new")
2. Download & Prepare        → Downloads from Drive (status: "downloading" → "downloaded")
3. Classify Document         → Classifies type using AI (status: "classifying" → "classified")
4. Store File ⭐             → Uploads to Supabase, deletes from inbox (status: "storing" → "stored")
   ┗━━━━ SAFE POINT REACHED
5. Extract Data (optional)   → Type-specific extraction (status: "extracting")
6. Store Metadata            → Saves to database (status: "saving_metadata" → "processed")
```

## Safe Point Behavior

Once **Step 4 (Store File)** succeeds:

- ✅ Document is persistent in Supabase Storage
- ✅ Inbox is clean (won't be reprocessed)
- ✅ Can safely retry expensive AI operations (Steps 5-6)
- ✅ Manual recovery possible if needed

## Status Values

Final registry statuses:

- `processed` - Successfully stored with extracted data
- `extraction_failed` - File stored, but extraction failed
- `rejected` - Low confidence or unknown type (stored without extraction)
- `download_failed` - Could not download from Drive
- `store_failed` - Could not upload to Supabase (manual intervention needed)

## Error Handling

| Failure Type | Action | Continue? |
|--------------|--------|-----------|
| Registration failed | Throw error | ❌ No (critical) |
| Download failed | Update registry | ❌ No |
| Classification failed | Default to "unknown" | ✅ Yes |
| File storage failed | Update registry | ❌ No (critical) |
| Extraction failed | Continue to metadata | ✅ Yes (file already safe) |
| Metadata storage failed | Throw error | ❌ No (retry from Step 5) |

## Triggering the Workflow

### From Cron Job (packages/cron)

```typescript
import { tasks } from "@trigger.dev/sdk";
import type { processDocumentWorkflow } from "./trigger/workflow";

// Single file
const handle = await tasks.trigger<typeof processDocumentWorkflow>(
  "process-document-workflow",
  {
    fileId: "1a2b3c4d5e6f",
    fileName: "invoice-2025-09.pdf",
    mimeType: "application/pdf",
    createdTime: "2025-09-30T10:30:00Z"
  }
);

// Multiple files
const batchHandle = await tasks.batchTrigger<typeof processDocumentWorkflow>(
  "process-document-workflow",
  files.map(file => ({
    payload: {
      fileId: file.id,
      fileName: file.name,
      mimeType: file.mimeType,
      createdTime: file.createdTime
    }
  }))
);
```

### Testing Locally

1. Start Trigger.dev dev server:
   ```bash
   pnpm dlx trigger.dev@latest dev
   ```

2. Trigger from Trigger.dev dashboard or use test script

3. View logs in real-time to see workflow execution

## Current Implementation Status

**✅ COMPLETED** - POC Implementation with Happy Path Logging

This is a **proof-of-concept implementation** with:

- ✅ All task structures defined
- ✅ Correct orchestrator pattern with `triggerAndWait()`
- ✅ Proper retry configurations per design
- ✅ Happy path logging (simulated operations)
- ✅ Mock outputs for all tasks
- ❌ No actual API integrations (Google Drive, Claude, Supabase)

### Next Steps for Production

1. Implement Google Drive API client
2. Implement Claude API client for classification/extraction
3. Implement Supabase database operations
4. Implement Supabase Storage uploads
5. Add comprehensive error handling
6. Add telemetry and monitoring
7. Test end-to-end workflow

## Files

- `workflow.ts` - Orchestrator task (exported)
- `document-tasks.ts` - All worker tasks (hidden)
- `example-trigger.ts` - Usage examples
- `README.md` - This file

## References

- Design Document: `../docs/WORKFLOW_DESIGN.md`
- Implementation Summary: `../docs/IMPLEMENTATION_SUMMARY.md`
- Trigger.dev v4 Docs: https://trigger.dev/docs
- Project CLAUDE.md: `../CLAUDE.md`