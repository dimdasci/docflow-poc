import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { getLangfuseClient } from "./langfuse";
import { startObservation } from "@langfuse/tracing";
import { randomBytes } from "node:crypto";

type LangfusePromptAttributes = {
  name: string;
  version: number;
  isFallback: boolean;
};

type ObservationOptions = {
  traceId?: string;
  parentSpanId?: string;
};

function toLangfusePromptAttributes(prompt: {
  name: string;
  version: number;
  isFallback?: boolean;
  labels?: string[];
}): LangfusePromptAttributes {
  const inferredFallback = Array.isArray(prompt.labels)
    ? prompt.labels.includes("fallback")
    : false;

  return {
    name: prompt.name,
    version: prompt.version,
    isFallback:
      typeof prompt.isFallback === "boolean"
        ? prompt.isFallback
        : inferredFallback,
  };
}

function randomSpanId() {
  return randomBytes(8).toString("hex");
}

function buildParentSpanContext(options?: ObservationOptions) {
  if (!options?.traceId) {
    return undefined;
  }

  return {
    traceId: options.traceId,
    spanId: options.parentSpanId ?? randomSpanId(),
    traceFlags: 1,
  };
}

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
export async function classifyDocument(
  fileId: string,
  fileName: string,
  options?: ObservationOptions
): Promise<{
  document_type: "invoice" | "bank_statement" | "government_letter" | "unknown";
  confidence: number;
  reasoning: string;
}> {
  const langfuse = getLangfuseClient();
  const client = getClaudeClient();

  // Fetch prompt from Langfuse
  const langfusePrompt = await langfuse.prompt.get("poc-3f/classify");
  const promptText = langfusePrompt.prompt;
  const config = langfusePrompt.config as
    | { model?: string; max_tokens?: number; temperature?: number }
    | undefined;

  const model = config?.model || "claude-3-5-haiku-20241022";
  const maxTokens = config?.max_tokens || 256;
  const temperature = config?.temperature || 0;

  const parentSpanContext = buildParentSpanContext(options);

  // Create generation observation
  const generation = startObservation(
    "classify-document",
    {
      model,
      input: promptText,
      modelParameters: { maxTokens, temperature },
      metadata: {
        promptName: "poc-3f/classify",
        promptVersion: langfusePrompt.version,
        fileName,
        fileId,
      },
      prompt: toLangfusePromptAttributes(langfusePrompt),
    },
    { asType: "generation", parentSpanContext }
  );

  try {
    // Call Claude with the file ID using beta header
    const response = await client.beta.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
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
              text: promptText,
            },
          ],
        },
      ],
      betas: ["files-api-2025-04-14"],
    });

    // Update generation with raw LLM response
    generation.update({
      output: response.content,
      usageDetails: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
      },
      metadata: {
        stopReason: response.stop_reason,
      },
    });

    generation.end();

    // Extract the text response for processing
    const textContent = response.content.find(block => block.type === "text");
    if (!textContent || textContent.type !== "text") {
      throw new Error("No text response from Claude");
    }

    const responseText = textContent.text;

    // Clean any markdown formatting
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
  } catch (error) {
    generation.update({
      level: "ERROR",
      statusMessage: error instanceof Error ? error.message : String(error),
    });
    generation.end();
    throw error;
  }
}

/**
 * Extract invoice data from a document using Claude API
 * Matches the n8n workflow "Analyze Invoice" node
 */
export async function extractInvoice(
  fileId: string,
  fileName: string,
  options?: ObservationOptions
): Promise<any> {
  const langfuse = getLangfuseClient();
  const client = getClaudeClient();

  // Fetch prompt from Langfuse
  const langfusePrompt = await langfuse.prompt.get("poc-3f/invoice");
  const promptText = langfusePrompt.prompt;
  const config = langfusePrompt.config as
    | { model?: string; max_tokens?: number; temperature?: number }
    | undefined;

  const model = config?.model || "claude-3-5-haiku-20241022";
  const maxTokens = config?.max_tokens || 2048;
  const temperature = config?.temperature || 0;

  const parentSpanContext = buildParentSpanContext(options);

  // Create generation observation
  const generation = startObservation(
    "extract-invoice",
    {
      model,
      input: promptText,
      modelParameters: { maxTokens, temperature },
      metadata: {
        promptName: "poc-3f/invoice",
        promptVersion: langfusePrompt.version,
        fileName,
        fileId,
      },
      prompt: toLangfusePromptAttributes(langfusePrompt),
    },
    { asType: "generation", parentSpanContext }
  );

  try {
    const response = await client.beta.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
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
              text: promptText,
            },
          ],
        },
      ],
      betas: ["files-api-2025-04-14"],
    });

    // Update generation with raw LLM response
    generation.update({
      output: response.content,
      usageDetails: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        cache_creation_input_tokens:
          response.usage.cache_creation_input_tokens || 0,
        cache_read_input_tokens: response.usage.cache_read_input_tokens || 0,
      },
      metadata: {
        stopReason: response.stop_reason,
      },
    });

    generation.end();

    const textContent = response.content.find(block => block.type === "text");
    if (!textContent || textContent.type !== "text") {
      throw new Error("No text response from Claude");
    }

    const responseText = textContent.text;
    const cleanText = responseText
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    const invoiceData = JSON.parse(cleanText);

    return invoiceData;
  } catch (error) {
    generation.update({
      level: "ERROR",
      statusMessage: error instanceof Error ? error.message : String(error),
    });
    generation.end();
    throw error;
  }
}

/**
 * Extract bank statement data from a document using Claude API
 * Matches the n8n workflow "Analyze Statement" node
 */
export async function extractStatement(
  fileId: string,
  fileName: string,
  options?: ObservationOptions
): Promise<any> {
  const langfuse = getLangfuseClient();
  const client = getClaudeClient();

  const langfusePrompt = await langfuse.prompt.get("poc-3f/statement");
  const promptText = langfusePrompt.prompt;
  const config = langfusePrompt.config as
    | { model?: string; max_tokens?: number; temperature?: number }
    | undefined;

  const model = config?.model || "claude-3-5-haiku-20241022";
  const maxTokens = config?.max_tokens || 2048;
  const temperature = config?.temperature || 0;

  const parentSpanContext = buildParentSpanContext(options);

  // Create generation observation
  const generation = startObservation(
    "extract-statement",
    {
      model,
      input: promptText,
      modelParameters: { maxTokens, temperature },
      metadata: {
        promptName: "poc-3f/statement",
        promptVersion: langfusePrompt.version,
        fileName,
        fileId,
      },
      prompt: toLangfusePromptAttributes(langfusePrompt),
    },
    { asType: "generation", parentSpanContext }
  );

  try {
    const response = await client.beta.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
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
              text: promptText,
            },
          ],
        },
      ],
      betas: ["files-api-2025-04-14"],
    });

    // Update generation with raw LLM response
    generation.update({
      output: response.content,
      usageDetails: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        cache_creation_input_tokens:
          response.usage.cache_creation_input_tokens || 0,
        cache_read_input_tokens: response.usage.cache_read_input_tokens || 0,
      },
      metadata: {
        stopReason: response.stop_reason,
      },
    });

    generation.end();

    const textContent = response.content.find(block => block.type === "text");
    if (!textContent || textContent.type !== "text") {
      throw new Error("No text response from Claude");
    }

    const responseText = textContent.text;
    const cleanText = responseText
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    const statementData = JSON.parse(cleanText);

    return statementData;
  } catch (error) {
    generation.update({
      level: "ERROR",
      statusMessage: error instanceof Error ? error.message : String(error),
    });
    generation.end();
    throw error;
  }
}

/**
 * Extract letter data from a document using Claude API
 * Matches the n8n workflow "Analyze Letter" node
 */
export async function extractLetter(
  fileId: string,
  fileName: string,
  options?: ObservationOptions
): Promise<any> {
  const langfuse = getLangfuseClient();
  const client = getClaudeClient();

  const langfusePrompt = await langfuse.prompt.get("poc-3f/letters");
  const promptText = langfusePrompt.prompt;
  const config = langfusePrompt.config as
    | { model?: string; max_tokens?: number; temperature?: number }
    | undefined;

  const model = config?.model || "claude-3-5-haiku-20241022";
  const maxTokens = config?.max_tokens || 2048;
  const temperature = config?.temperature || 0;

  const parentSpanContext = buildParentSpanContext(options);

  // Create generation observation
  const generation = startObservation(
    "extract-letter",
    {
      model,
      input: promptText,
      modelParameters: { maxTokens, temperature },
      metadata: {
        promptName: "poc-3f/letters",
        promptVersion: langfusePrompt.version,
        fileName,
        fileId,
      },
      prompt: toLangfusePromptAttributes(langfusePrompt),
    },
    { asType: "generation", parentSpanContext }
  );

  try {
    const response = await client.beta.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
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
              text: promptText,
            },
          ],
        },
      ],
      betas: ["files-api-2025-04-14"],
    });

    // Update generation with raw LLM response
    generation.update({
      output: response.content,
      usageDetails: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        cache_creation_input_tokens:
          response.usage.cache_creation_input_tokens || 0,
        cache_read_input_tokens: response.usage.cache_read_input_tokens || 0,
      },
      metadata: {
        stopReason: response.stop_reason,
      },
    });

    generation.end();

    const textContent = response.content.find(block => block.type === "text");
    if (!textContent || textContent.type !== "text") {
      throw new Error("No text response from Claude");
    }

    const responseText = textContent.text;
    const cleanText = responseText
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    const letterData = JSON.parse(cleanText);

    return letterData;
  } catch (error) {
    generation.update({
      level: "ERROR",
      statusMessage: error instanceof Error ? error.message : String(error),
    });
    generation.end();
    throw error;
  }
}
