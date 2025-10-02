import Anthropic, { toFile } from "@anthropic-ai/sdk";

// Create a singleton Anthropic client
let claudeClient: Anthropic | null = null;

export function getClaudeClient() {
  if (!claudeClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY environment variable is not set");
    }

    claudeClient = new Anthropic({
      apiKey: apiKey,
    });
  }

  return claudeClient;
}

/**
 * Upload a file to Claude Files API
 * Returns the file ID for subsequent API calls
 */
export async function uploadFileToClaude(
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string
): Promise<{ id: string }> {
  const client = getClaudeClient();

  // Convert Buffer to File using toFile helper
  const file = await toFile(fileBuffer, fileName, { type: mimeType });

  // Upload to Claude Files API (beta)
  const uploadedFile = await client.beta.files.upload({
    file: file,
    betas: ["files-api-2025-04-14"],
  });

  return {
    id: uploadedFile.id,
  };
}

/**
 * Classify a document using Claude API
 * Matches the n8n workflow implementation
 */
export async function classifyDocument(fileId: string): Promise<{
  document_type: "invoice" | "bank_statement" | "government_letter" | "unknown";
  confidence: number;
  reasoning: string;
}> {
  const client = getClaudeClient();

  const prompt = `Analyze this document and classify it into ONE category:

Categories:
- invoice
- bank_statement
- government_letter
- unknown

Respond with ONLY a JSON object:
{
  "reasoning": "brief explanation",
  "document_type": "category_name",
  "confidence": 0.95
}`;

  // Call Claude with the file ID using beta header
  // Type assertion needed as SDK types don't yet include Files API beta
  const response = await client.beta.messages.create({
    model: "claude-3-5-haiku-20241022",
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "file",
              file_id: fileId,
            },
          },
          {
            type: "text",
            text: prompt,
          },
        ],
      },
    ],
    betas: ["files-api-2025-04-14"],
  });

  // Extract the text response
  const textContent = response.content.find((block) => block.type === "text");
  if (!textContent || textContent.type !== "text") {
    throw new Error("No text response from Claude");
  }

  const responseText = textContent.text;

  // Clean any markdown formatting (matching n8n implementation)
  const cleanText = responseText
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();

  // Parse JSON response
  const classification = JSON.parse(cleanText);

  return {
    document_type: classification.document_type,
    confidence: classification.confidence,
    reasoning: classification.reasoning,
  };
}

/**
 * Extract invoice data from a document using Claude API
 * Matches the n8n workflow "Analyze Invoice" node
 */
export async function extractInvoice(fileId: string): Promise<any> {
  const client = getClaudeClient();

  const prompt = `Extract complete invoice data from this document. Return ONLY valid JSON:

{
  "document_info": {
    "invoice_number": "string",
    "invoice_date": "YYYY-MM-DD",
    "due_date": "YYYY-MM-DD",
    "currency": "EUR|USD|GBP|etc",
    "language": "en|de|fr|etc"
  },
  "vendor": {
    "name": "string",
    "address": "string",
    "vat_number": "string",
    "tax_id": "string",
    "contact_email": "string"
  },
  "customer": {
    "name": "string",
    "address": "string",
    "vat_number": "string"
  },
  "amounts": {
    "subtotal": 12345.67,
    "total_vat": 1234.56,
    "total_amount": 13580.23,
    "vat_rate": 21.0
  },
  "line_items": [
    {
      "description": "string",
      "quantity": 12,
      "unit_price": 123.45,
      "vat_rate": 21.0,
      "vat_amount": 123.45,
      "line_total": 1357.95
    }
  ],
  "payment": {
    "terms": "string",
    "method": "string",
    "bank_details": "string"
  }
}

Use null for missing fields. Extract ALL line items. Preserve original currency and VAT rates.`;

  const response = await client.beta.messages.create({
    model: "claude-3-5-haiku-20241022",
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "file",
              file_id: fileId,
            },
          },
          {
            type: "text",
            text: prompt,
          },
        ],
      },
    ],
    betas: ["files-api-2025-04-14"],
  });

  const textContent = response.content.find((block) => block.type === "text");
  if (!textContent || textContent.type !== "text") {
    throw new Error("No text response from Claude");
  }

  const responseText = textContent.text;
  const cleanText = responseText
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();

  return JSON.parse(cleanText);
}

/**
 * Extract bank statement data from a document using Claude API
 * Matches the n8n workflow "Analyze Statement" node
 */
export async function extractStatement(fileId: string): Promise<any> {
  const client = getClaudeClient();

  const prompt = `Extract complete bank statement data from this document. Return ONLY valid JSON without markdown formatting:

{
  "document_info": {
    "statement_type": "bank_statement",
    "bank_name": "string",
    "document_title": "string",
    "period_start": "YYYY-MM-DD",
    "period_end": "YYYY-MM-DD",
    "currency": "EUR|USD|GBP|etc",
    "language": "en|de|fr|etc"
  },
  "account": {
    "holder_name": "string",
    "account_number": "string",
    "iban": "string",
    "opening_balance": 12345.67,
    "closing_balance": 13580.23
  },
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "description": "string",
      "amount": -1234.56,
      "balance": 11111.11
    }
  ]
}

RULES:
- Use null for missing fields
- Extract ALL transactions exactly as shown
- Copy amounts with exact signs and decimals from document
- Do NOT calculate, interpret, or modify any values
- Extract data only - no computations`;

  const response = await client.beta.messages.create({
    model: "claude-3-5-haiku-20241022",
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "file",
              file_id: fileId,
            },
          },
          {
            type: "text",
            text: prompt,
          },
        ],
      },
    ],
    betas: ["files-api-2025-04-14"],
  });

  const textContent = response.content.find((block) => block.type === "text");
  if (!textContent || textContent.type !== "text") {
    throw new Error("No text response from Claude");
  }

  const responseText = textContent.text;
  const cleanText = responseText
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();

  return JSON.parse(cleanText);
}

/**
 * Extract letter data from a document using Claude API
 * Matches the n8n workflow "Analyze Letter" node
 */
export async function extractLetter(fileId: string): Promise<any> {
  const client = getClaudeClient();

  const prompt = `Extract complete official letter data from this document. Return ONLY valid JSON without markdown formatting.

IMPORTANT: Start with reasoning_checklist to identify key elements, then use ONLY these identified elements for extraction.

{
  "reasoning_checklist": {
    "has_due_date": true,
    "due_date_field_name": "string",
    "due_date_value": "string",
    "has_money_amount": true,
    "money_amount_quote": "string"
  },
  "document_info": {
    "document_type": "official_letter",
    "language": "en|de|fr|etc",
    "date": "YYYY-MM-DD"
  },
  "letter_details": {
    "subject": "string",
    "reference_number": "string",
    "due_date": "YYYY-MM-DD",
    "amount_due": 12345.67,
    "currency": "EUR|USD|GBP|etc",
    "letter_type": "tax_notice|vat_reminder|audit_notice|compliance|other"
  },
  "sender": {
    "organization": "string",
    "address": "string",
    "country": "string",
    "contact_title": "string",
    "reference": "string"
  },
  "recipient": {
    "organization": "string",
    "title": "string",
    "address": "string",
    "country": "string"
  },
  "content": {
    "greeting": "string",
    "main_text": "string",
    "closing": "string"
  }
}

CRITICAL: Extract currency ONLY from money_amount_quote in checklist. Do NOT assume currency based on country or organization.

CHECKLIST RULES:
- has_due_date: true if any deadline/due date mentioned, false otherwise
- due_date_field_name: exact field label from document (e.g. "Due Date:", "Fälligkeitsdatum:")
- due_date_value: exact date value as written in document (e.g. "03/11/2025", "16.09.2025")
- has_money_amount: true if any monetary value present, false otherwise
- money_amount_quote: exact text fragment with currency symbol (e.g. "€2870.12", "Amount Due: €2870.12")

EXTRACTION RULES:
- currency: extract ONLY from money_amount_quote (€=EUR, $=USD, £=GBP)
- amount_due: extract number from money_amount_quote
- due_date: convert due_date_value to YYYY-MM-DD format
- Use null for missing fields
- Do NOT make assumptions about currency based on sender country
- Do NOT translate or interpret content
- Preserve exact text and formatting`;

  const response = await client.beta.messages.create({
    model: "claude-3-5-haiku-20241022",
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "file",
              file_id: fileId,
            },
          },
          {
            type: "text",
            text: prompt,
          },
        ],
      },
    ],
    betas: ["files-api-2025-04-14"],
  });

  const textContent = response.content.find((block) => block.type === "text");
  if (!textContent || textContent.type !== "text") {
    throw new Error("No text response from Claude");
  }

  const responseText = textContent.text;
  const cleanText = responseText
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();

  return JSON.parse(cleanText);
}
