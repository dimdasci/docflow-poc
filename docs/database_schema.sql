-- ============================================================================
-- DOCUMENT PROCESSING WORKFLOW - DATABASE SCHEMA
-- ============================================================================
-- This schema matches the actual implementation in trigger/document-tasks.ts
-- Created: 2025-10-01
-- ============================================================================

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
  status TEXT NOT NULL DEFAULT 'new',    -- See status lifecycle in WORKFLOW_DESIGN.md
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

-- ============================================================================
-- Invoice details
-- ============================================================================
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
  payment_bank_details TEXT,  -- ⚠️ CORRECTED: was "bank_details" in old schema

  -- Line items as JSONB (POC scope)
  line_items JSONB,
  -- Example: [{"description": "...", "quantity": 10, "unit_price": 100, "vat_rate": 19, "vat_amount": 190, "line_total": 1190}]

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_invoices_invoice_date ON invoices(invoice_date DESC);
CREATE INDEX idx_invoices_doc_id ON invoices(doc_id);

-- ============================================================================
-- Bank statements
-- ============================================================================
CREATE TABLE statements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id TEXT UNIQUE NOT NULL REFERENCES income_registry(doc_id) ON DELETE CASCADE,

  -- Document info
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

-- ============================================================================
-- Official letters (government, tax notices, etc.)
-- ============================================================================
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

  -- Content (⚠️ CORRECTED: prefixed with "content_" to match implementation)
  content_greeting TEXT,
  content_main_text TEXT,
  content_closing TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_letters_letter_date ON letters(letter_date DESC);
CREATE INDEX idx_letters_due_date ON letters(due_date);
CREATE INDEX idx_letters_doc_id ON letters(doc_id);

-- ============================================================================
-- JSONB Column Examples
-- ============================================================================

-- invoices.line_items example:
-- [
--   {
--     "description": "Professional Services",
--     "quantity": 20,
--     "unit_price": 250.00,
--     "vat_rate": 19.0,
--     "vat_amount": 950.00,
--     "line_total": 5950.00
--   }
-- ]

-- statements.transactions example:
-- [
--   {
--     "date": "2025-08-05",
--     "description": "Salary Payment",
--     "amount": 3500.00,
--     "balance": 13500.00
--   },
--   {
--     "date": "2025-08-10",
--     "description": "Rent Payment",
--     "amount": -1000.00,
--     "balance": 12500.00
--   }
-- ]

-- ============================================================================
-- Document Status Lifecycle
-- ============================================================================
-- new → downloading → downloaded → classifying → classified → storing → stored
--   → extracting → extracted → saving_metadata → processed
--
-- Error states: download_failed, classification_failed, store_failed,
--               extraction_failed, metadata_storage_failed, rejected
--
-- See WORKFLOW_DESIGN.md for complete status documentation
