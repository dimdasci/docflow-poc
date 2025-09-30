import { google } from 'googleapis';
import fs from 'fs';

const TRIGGER_DEV_API_KEY = process.env.TRIGGER_DEV_API_KEY!;
const TRIGGER_DEV_ENDPOINT = process.env.TRIGGER_DEV_ENDPOINT!;

async function triggerWorkflow(fileId: string, fileName: string) {
  const response = await fetch(TRIGGER_DEV_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TRIGGER_DEV_API_KEY}`
    },
    body: JSON.stringify({
      fileId: fileId,
      fileName: fileName
    })
  });
  
  if (!response.ok) {
    throw new Error(`Failed to trigger workflow: ${response.statusText}`);
  }
  
  return response.json();
}

async function checkAndTrigger() {
  // Get last check time
  const lastCheckFile = './last-check.txt';
  let lastCheckedTime = new Date(0);
  
  if (fs.existsSync(lastCheckFile)) {
    lastCheckedTime = new Date(fs.readFileSync(lastCheckFile, 'utf-8'));
  }
  
  // Authenticate with Google Drive
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY!),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  
  const drive = google.drive({ version: 'v3', auth });
  
  // Get new files
  const folderId = process.env.DRIVE_FOLDER_ID!;
  const response = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: 'files(id, name, createdTime, mimeType)',
    orderBy: 'createdTime desc'
  });
  
  const files = response.data.files || [];
  const newFiles = files.filter(file => 
    new Date(file.createdTime!) > lastCheckedTime
  );
  
  console.log(`Found ${newFiles.length} new files`);
  
  // Trigger workflow for each new file
  for (const file of newFiles) {
    console.log(`Triggering workflow for: ${file.name}`);
    if (!file.id || !file.name) continue;
    await triggerWorkflow(file.id, file.name);
  }
  
  // Save current time
  fs.writeFileSync(lastCheckFile, new Date().toISOString());
  
  console.log('Done. Exiting.');
  process.exit(0);
}

checkAndTrigger().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});