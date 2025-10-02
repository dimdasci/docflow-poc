# Database Schema Verification Checklist

Run this checklist after executing `docs/database_schema.sql`

## ✅ Step 1: Verify Tables Created

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('income_registry', 'invoices', 'statements', 'letters')
ORDER BY table_name;
```

**Expected**: 4 rows
- [ ] income_registry
- [ ] invoices  
- [ ] letters
- [ ] statements

## ✅ Step 2: Verify Column Counts

```sql
SELECT 
  table_name,
  COUNT(*) as column_count
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('income_registry', 'invoices', 'statements', 'letters')
GROUP BY table_name
ORDER BY table_name;
```

**Expected**:
- [ ] income_registry: 13 columns
- [ ] invoices: 22 columns
- [ ] letters: 22 columns
- [ ] statements: 14 columns

## ✅ Step 3: Verify Critical Columns

### income_registry
```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'income_registry'
  AND column_name IN ('doc_id', 'status', 'classification', 'storage_path_pdf', 'storage_path_json')
ORDER BY column_name;
```

- [ ] doc_id (text)
- [ ] status (text)
- [ ] classification (text)
- [ ] storage_path_pdf (text)
- [ ] storage_path_json (text)

### invoices
```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'invoices'
  AND column_name IN ('doc_id', 'payment_bank_details', 'line_items')
ORDER BY column_name;
```

- [ ] doc_id (text)
- [ ] payment_bank_details (text) ← **CRITICAL: Not "bank_details"**
- [ ] line_items (jsonb)

### statements
```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'statements'
  AND column_name IN ('doc_id', 'transactions')
ORDER BY column_name;
```

- [ ] doc_id (text)
- [ ] transactions (jsonb)

### letters
```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'letters'
  AND column_name IN ('doc_id', 'content_greeting', 'content_main_text', 'content_closing')
ORDER BY column_name;
```

- [ ] doc_id (text)
- [ ] content_greeting (text) ← **CRITICAL: Not "greeting"**
- [ ] content_main_text (text) ← **CRITICAL: Not "main_text"**
- [ ] content_closing (text) ← **CRITICAL: Not "closing"**

## ✅ Step 4: Verify Indexes

```sql
SELECT 
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('income_registry', 'invoices', 'statements', 'letters')
ORDER BY tablename, indexname;
```

**Expected**: 10 indexes
- [ ] idx_income_registry_classification
- [ ] idx_income_registry_created_at
- [ ] idx_income_registry_status
- [ ] idx_invoices_doc_id
- [ ] idx_invoices_invoice_date
- [ ] idx_letters_doc_id
- [ ] idx_letters_due_date
- [ ] idx_letters_letter_date
- [ ] idx_statements_doc_id
- [ ] idx_statements_period_end

## ✅ Step 5: Verify Foreign Keys

```sql
SELECT
  tc.table_name,
  kcu.column_name,
  ccu.table_name AS foreign_table_name,
  ccu.column_name AS foreign_column_name,
  rc.delete_rule
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
  ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage AS ccu
  ON ccu.constraint_name = tc.constraint_name
JOIN information_schema.referential_constraints AS rc
  ON tc.constraint_name = rc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_name IN ('invoices', 'statements', 'letters')
ORDER BY tc.table_name;
```

**Expected**: 3 foreign keys, all with CASCADE delete
- [ ] invoices.doc_id → income_registry.doc_id (CASCADE)
- [ ] letters.doc_id → income_registry.doc_id (CASCADE)
- [ ] statements.doc_id → income_registry.doc_id (CASCADE)

## ✅ Step 6: Test Insert & Cascade Delete

```sql
-- Insert test record
INSERT INTO income_registry (doc_id, file_name, mime_type, created_at, status)
VALUES ('test-cascade-123', 'test.pdf', 'application/pdf', NOW(), 'new');

-- Insert related invoice
INSERT INTO invoices (doc_id, invoice_number, currency)
VALUES ('test-cascade-123', 'TEST-001', 'EUR');

-- Verify both exist
SELECT 'income_registry' as table_name, COUNT(*) as count
FROM income_registry WHERE doc_id = 'test-cascade-123'
UNION ALL
SELECT 'invoices', COUNT(*)
FROM invoices WHERE doc_id = 'test-cascade-123';

-- Test cascade delete
DELETE FROM income_registry WHERE doc_id = 'test-cascade-123';

-- Verify cascade worked (should return 0 rows)
SELECT COUNT(*) FROM invoices WHERE doc_id = 'test-cascade-123';
```

- [ ] Test record inserted successfully
- [ ] Both records exist before delete
- [ ] Invoice automatically deleted after deleting income_registry record

## ✅ All Checks Passed

If all checks pass, your database is ready for production use! ✅

The schema matches the implementation in `trigger/document-tasks.ts` exactly.
