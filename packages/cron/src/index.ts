import { google } from 'googleapis';

const TRIGGER_DEV_API_KEY = process.env.TRIGGER_DEV_API_KEY;
const TRIGGER_DEV_ENDPOINT = process.env.TRIGGER_DEV_ENDPOINT;

async function triggerWorkflow(fileId: string, fileName: string) {
  if (!TRIGGER_DEV_ENDPOINT || !TRIGGER_DEV_API_KEY) {
    console.log(`[SKIP] Trigger.dev not configured - would trigger workflow for file: ${fileName} (${fileId})`);
    return;
  }

  const response = await fetch(TRIGGER_DEV_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TRIGGER_DEV_API_KEY}`
    },
    body: JSON.stringify({
      fileId: fileId,
      fileName: fileName,
      idempotencyKey: fileId // Use fileId as idempotency key
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to trigger workflow: ${response.statusText}`);
  }

  return response.json();
}

async function checkAndTrigger() {
  // Authenticate with Google Drive using service account credentials from env vars
  // Falls back to JSON key file if GOOGLE_APPLICATION_CREDENTIALS is set
  const auth = process.env.GOOGLE_APPLICATION_CREDENTIALS
    ? new google.auth.GoogleAuth({
        keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      })
    : new google.auth.GoogleAuth({
        credentials: {
          type: 'service_account',
          project_id: process.env.GOOGLE_PROJECT_ID,
          private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
          private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
          client_email: process.env.GOOGLE_CLIENT_EMAIL,
          client_id: process.env.GOOGLE_CLIENT_ID
        },
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      });

  const drive = google.drive({ version: 'v3', auth });

  // Get all files in the folder
  const folderId = process.env.DRIVE_FOLDER_ID!;
  const response = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: 'files(id, name, createdTime, mimeType)',
    orderBy: 'createdTime desc'
  });

  const files = response.data.files || [];

  console.log(`Total files in folder: ${files.length}`);

  if (files.length > 0) {
    console.log('\nFiles in folder:');
    files.forEach(file => {
      console.log(`  - ${file.name} (${file.mimeType}) [${file.id}] created at ${file.createdTime}`);
    });
  }

  // Trigger workflow for each file with fileId as idempotency key
  // Trigger.dev will handle deduplication, workflow will delete/move file after processing
  for (const file of files) {
    if (!file.id || !file.name) continue;
    console.log(`Triggering workflow for: ${file.name}`);
    await triggerWorkflow(file.id, file.name);
  }

  console.log('Done. Exiting.');
  process.exit(0);
}

checkAndTrigger().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});