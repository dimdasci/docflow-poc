# Supabase Object Storage

## Authentication

Using the generated S3 access keys, which are stored in environment variables:
- SUPABASE_STORAGE_ACCESS_POINT
- SUPABASE_STORAGE_REGION
- SUPABASE_STORAGE_ACCESS_KEY_ID
- SUPABASE_STORAGE_ACCESS_KEY
- SUPABASE_STORAGE_BUCKET

Example: 

```javascript
import { S3Client } from '@aws-sdk/client-s3';

const client = new S3Client({
  forcePathStyle: true,
  region: 'project_region',
  endpoint: 'https://project_ref.storage.supabase.co/storage/v1/s3',
  credentials: {
    accessKeyId: 'your_access_key_id',
    secretAccessKey: 'your_secret_access_key',
  }
})
```

Then we can use the S3 client to work with files using standard S3 commands.

