import { task } from "@trigger.dev/sdk";
import { getDb } from "../utils/db";
import type { WorkflowInput, DocumentStatus } from "../types/domain";

// ============================================================================
// TASK 0: REGISTER DOCUMENT (Hidden - First Operation)
// ============================================================================

export const registerDocument = task({
  id: "register-document",
  retry: {
    maxAttempts: 3,
    factor: 1.8,
    minTimeoutInMs: 500,
    maxTimeoutInMs: 5000,
    randomize: false,
  },
  run: async (payload: WorkflowInput) => {
    const taskId = "register-document";
    console.log(
      `[${taskId}] Starting with payload:`,
      JSON.stringify(payload, null, 2)
    );

    const sql = getDb();
    const initialStatus: DocumentStatus = "new";

    try {
      // Insert record to income_registry table
      console.log(`[${taskId}] Inserting record to income_registry table...`);
      console.log(`[${taskId}] - File ID: ${payload.fileId}`);
      console.log(`[${taskId}] - File Name: ${payload.fileName}`);
      console.log(`[${taskId}] - MIME Type: ${payload.mimeType}`);
      console.log(`[${taskId}] - Created Time: ${payload.createdTime}`);
      console.log(`[${taskId}] - Status: "new"`);

      const [result] = await sql`
        INSERT INTO income_registry (
          doc_id,
          file_name,
          mime_type,
          created_at,
          status,
          registered_at
        ) VALUES (
          ${payload.fileId},
          ${payload.fileName},
          ${payload.mimeType},
          ${payload.createdTime},
          ${initialStatus},
          NOW()
        )
        RETURNING id, doc_id
      `;

      console.log(`[${taskId}] Successfully registered document`);
      console.log(`[${taskId}] - Registry ID: ${result.id}`);
      console.log(`[${taskId}] - Doc ID: ${result.doc_id}`);

      return {
        registryId: result.id,
        docId: result.doc_id,
      };
    } catch (error) {
      console.error(`[${taskId}] Database error:`, error);
      throw new Error(
        `Failed to register document: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
});
