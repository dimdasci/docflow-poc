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
