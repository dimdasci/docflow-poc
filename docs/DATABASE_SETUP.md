# Database Setup Instructions

**Date**: 2025-10-01
**Status**: ✅ Ready for Production

## Overview

This document provides the SQL schema for creating the database tables required by the document processing workflow. The schema has been verified against the actual implementation in `trigger/document-tasks.ts`.

## Prerequisites

- PostgreSQL database (Supabase recommended)
- Database connection with CREATE TABLE permissions
- Connection string available in `SUPABASE_DB_STRING` environment variable

## Schema File

The complete, production-ready SQL schema is located at:

```
docs/database_schema.sql
```

## Quick Setup

### Option 1: Using Supabase Dashboard

1. Log into your Supabase project dashboard
2. Navigate to **SQL Editor**
3. Copy the entire contents of `docs/database_schema.sql`
4. Paste into the SQL editor
5. Click **Run** to execute

### Option 2: Using psql Command Line

```bash
# Connect to your database
psql "postgresql://postgres:[PASSWORD]@[HOST]:5432/postgres?sslmode=require"

# Execute the schema file
\i docs/database_schema.sql
```

### Option 3: Using Connection Pooler

```bash
# Using the transaction pooler connection string
psql "$SUPABASE_DB_STRING" -f docs/database_schema.sql
```

## Schema Overview

The schema creates **4 tables** with proper relationships and indexes:

### 1. `income_registry` (Main Registry)
- Tracks all documents entering the system
- Stores classification results and processing status
- Contains storage paths for PDF and JSON files
- **Primary Key**: `doc_id` (Google Drive file ID)

### 2. `invoices` (Invoice Details)
- Stores structured invoice data
- JSONB column for `line_items` (flexible nested data)
- **Foreign Key**: `doc_id` → `income_registry.doc_id`

### 3. `statements` (Bank Statement Details)
- Stores bank statement and account data
- JSONB column for `transactions` (flexible transaction list)
- **Foreign Key**: `doc_id` → `income_registry.doc_id`

### 4. `letters` (Government Letter Details)
- Stores official letter data (tax notices, VAT reminders, etc.)
- Includes sender, recipient, and content fields
- **Foreign Key**: `doc_id` → `income_registry.doc_id`

## Important Notes

### ✅ Schema Verification

The schema in `database_schema.sql` has been **verified** against the actual code implementation and includes:

- **Corrected column names** that match the INSERT statements in code
- All required indexes for performance
- Proper foreign key relationships with CASCADE DELETE
- JSONB columns for nested data structures

### ⚠️ Schema Changes from Original Design

The following columns were renamed to match the implementation:

**invoices table:**
- `bank_details` → `payment_bank_details` ✅

**letters table:**
- `greeting` → `content_greeting` ✅
- `main_text` → `content_main_text` ✅
- `closing` → `content_closing` ✅

**statements table:**
- Removed `statement_type` column (not used in implementation) ✅

### Database Cascade Behavior

All type-specific tables (`invoices`, `statements`, `letters`) use:

```sql
REFERENCES income_registry(doc_id) ON DELETE CASCADE
```

This means:
- Deleting a record from `income_registry` automatically deletes related records
- Ensures referential integrity
- Simplifies cleanup operations

## Post-Setup Verification

After running the schema, verify the tables were created:

```sql
-- Check tables exist
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('income_registry', 'invoices', 'statements', 'letters');

-- Check indexes
SELECT tablename, indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('income_registry', 'invoices', 'statements', 'letters');

-- Verify foreign keys
SELECT
  tc.table_name,
  kcu.column_name,
  ccu.table_name AS foreign_table_name,
  ccu.column_name AS foreign_column_name
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
  ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage AS ccu
  ON ccu.constraint_name = tc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_name IN ('invoices', 'statements', 'letters');
```

Expected output:
- **4 tables**: income_registry, invoices, statements, letters
- **10 indexes**: 3 on income_registry, 2 on invoices, 2 on statements, 3 on letters
- **3 foreign keys**: All pointing to `income_registry(doc_id)`

## Status Values Reference

The `income_registry.status` field tracks document processing state:

### Normal Flow
```
new → downloading → downloaded → classifying → classified
  → storing → stored → extracting → extracted
  → saving_metadata → processed
```

### Error States
- `download_failed` - Cannot download from Google Drive (terminal)
- `classification_failed` - Classification failed (continues as "unknown")
- `store_failed` - Storage failed (terminal, retryable)
- `extraction_failed` - Data extraction failed (continues to metadata)
- `metadata_storage_failed` - Database insert failed (retryable)
- `rejected` - Low confidence or unknown type (stored without extraction)

See `docs/WORKFLOW_DESIGN.md` for complete status documentation.

## Testing the Schema

After setup, you can test with a sample insert:

```sql
-- Insert a test document
INSERT INTO income_registry (
  doc_id,
  file_name,
  mime_type,
  created_at,
  status
) VALUES (
  'test-doc-123',
  'test-invoice.pdf',
  'application/pdf',
  NOW(),
  'new'
);

-- Verify it was created
SELECT * FROM income_registry WHERE doc_id = 'test-doc-123';

-- Clean up test data
DELETE FROM income_registry WHERE doc_id = 'test-doc-123';
```

## Next Steps

After database setup:

1. ✅ Verify all 4 tables exist
2. ✅ Verify all 10 indexes exist
3. ✅ Verify foreign key constraints
4. Configure environment variables (see `docs/WORKFLOW_DESIGN.md`)
5. Deploy trigger.dev tasks
6. Deploy cron service to Railway
7. Test with a real PDF document

## Troubleshooting

### Issue: Foreign key constraint violation

**Cause**: Trying to insert into `invoices`/`statements`/`letters` before `income_registry`

**Solution**: The workflow always inserts to `income_registry` first (Step 0), so this shouldn't happen in production. If testing manually, ensure the `doc_id` exists in `income_registry` first.

### Issue: JSONB parse error

**Cause**: Invalid JSON in `line_items` or `transactions` columns

**Solution**: The workflow uses `JSON.stringify()` and `::jsonb` cast to ensure valid JSON. If inserting manually, validate JSON first.

### Issue: Date format error

**Cause**: Invalid date format for DATE columns

**Solution**: Use `YYYY-MM-DD` format (ISO 8601). The Claude API is prompted to return dates in this exact format.

## Support

For issues or questions:
- Review `docs/WORKFLOW_DESIGN.md` for architecture details
- Review `docs/IMPLEMENTATION_SUMMARY.md` for implementation details
- Check trigger.dev task logs for runtime errors
