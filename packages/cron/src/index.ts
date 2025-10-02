import { google } from "googleapis";
import { tasks } from "@trigger.dev/sdk/v3";

async function checkAndTrigger() {
  // Validate required environment variables
  const folderId = process.env.DRIVE_INBOX_FOLDER_ID;
  if (!folderId) {
    throw new Error("DRIVE_INBOX_FOLDER_ID environment variable is required");
  }

  // Authenticate with Google Drive using service account credentials from env vars
  // Falls back to JSON key file if GOOGLE_APPLICATION_CREDENTIALS is set
  const auth = process.env.GOOGLE_APPLICATION_CREDENTIALS
    ? new google.auth.GoogleAuth({
        keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      })
    : new google.auth.JWT({
        email: process.env.GOOGLE_CLIENT_EMAIL,
        key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
        keyId: process.env.GOOGLE_PRIVATE_KEY_ID,
      });

  const drive = google.drive({ version: "v3", auth });

  // Get all files in the folder
  const response = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: "files(id, name, createdTime, mimeType)",
    orderBy: "createdTime desc",
  });

  const files = response.data.files || [];

  console.log(`Total files in folder: ${files.length}`);

  if (files.length > 0) {
    console.log("\nFiles in folder:");
    files.forEach(file => {
      console.log(
        `  - ${file.name} (${file.mimeType}) [${file.id}] created at ${file.createdTime}`
      );
    });
  }

  // Check for TRIGGER_SECRET_KEY
  const secretKey = process.env.TRIGGER_SECRET_KEY;
  if (!secretKey) {
    console.log(
      `[SKIP] TRIGGER_SECRET_KEY not configured - skipping workflow triggers`
    );
    console.log("Done. Exiting.");
    process.exit(0);
  }

  // Trigger workflow for each file with fileId as idempotency key
  // Trigger.dev will handle deduplication, workflow will delete/move file after processing
  if (false && files.length > 0) {
    console.log(`\nTriggering workflows for ${files.length} files...`);

    const validFiles = files.filter(
      (
        file
      ): file is typeof file & {
        id: string;
        name: string;
        mimeType: string;
        createdTime: string;
      } => !!(file.id && file.name && file.mimeType && file.createdTime)
    );

    const batchPayloads = validFiles.map(file => ({
      payload: {
        fileId: file.id,
        fileName: file.name,
        mimeType: file.mimeType,
        createdTime: file.createdTime,
      },
    }));

    const batchHandle = await tasks.batchTrigger(
      "process-document-workflow",
      batchPayloads
    );

    console.log(`✓ Successfully triggered ${batchPayloads.length} workflows`);
    console.log(`  Batch ID: ${batchHandle.batchId}`);
  } else {
    console.log("\nNo files to process.");
  }

  console.log("Done. Exiting.");
  process.exit(0);
}

checkAndTrigger().catch(error => {
  console.error("Error:", error);
  process.exit(1);
});
