import { LangfuseClient } from "@langfuse/client";

// Create singleton client for both prompt management and tracing
let langfuseClient: LangfuseClient | null = null;

/**
 * Get Langfuse client for prompt management and manual tracing
 */
export function getLangfuseClient() {
  if (!langfuseClient) {
    const secretKey = process.env.LANGFUSE_SECRET_KEY;
    const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
    const baseUrl = process.env.LANGFUSE_BASE_URL;

    if (!secretKey || !publicKey || !baseUrl) {
      throw new Error(
        "LANGFUSE_SECRET_KEY, LANGFUSE_PUBLIC_KEY, and LANGFUSE_BASE_URL environment variables must be set"
      );
    }

    langfuseClient = new LangfuseClient({
      secretKey,
      publicKey,
      baseUrl,
    });
  }

  return langfuseClient;
}
