# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a proof-of-concept for document flow automation, structured as a pnpm monorepo with TypeScript.

The project implements a cron/scheduling package to watch a Google Drive folder for new documents and trigger the processing flow using trigger.dev tasks. 

Project uses Google Service Account for authentication and the Folder to watch in environment variables.

When new documents are detected (the job of cron), they are processed in a following order (the job of trigger.dev tasks):
- download document and retrieve metadata (name, mimetype, size, created time)
- classify document type (invoice, statement, letter, unsupported) by:
  - validating if the document mimetype is supported (PDF, DOCX, JPG, PNG),
  - classifying document type using an LLM model (e.g. Claude, GPT-4) 
- upload document to Supabase storage bucket into a folder based on document type, add a record to Supabase income registry table with metadata, storage path, and processing status (e.g. uploaded, classified, rejected, processed, error)
- Based on document type, run data extraction using an LLM model (e.g. Claude, GPT-4) to 
  - extract structured data (e.g. invoice details and line items),
  - save the extracted data to a corresponding Supabase table (e.g. invoices) and Supabase object metadata too,
  - update the income registry record with processing status (e.g. processed, error)

## Project Structure

```
doc-flow-poc/
├── trigger/
│   └── ...               # Trigger.dev tasks definitions
├── packages/
│   └── cron/             # Cron/scheduling package (@repo/cron)
│       ├── src/
│       │   └── index.ts  # Main source file
│       └── package.json  # Package definition for @repo/cron
├── package.json          # Root workspace package
├── pnpm-lock.yaml
└── tsconfig.json         # Root TypeScript configuration
```

## Package Management

- **Package Manager**: pnpm (v10.13.1)
- **Workspace**: Monorepo structure with packages in `packages/` directory and tasks definitions in `trigger/`
- Install dependencies: `pnpm install`

## TypeScript Configuration

- **Target**: ES2022
- **Module**: ESNext with bundler resolution
- **Output**: `./dist`
- **Source**: `./src`
- Strict mode enabled

## Available Packages

### @repo/cron (packages/cron)

A cron/scheduling package for the document flow system.

**Commands**:
- `pnpm dev` - Run in development mode with watch (using tsx)
- `pnpm build` - Compile TypeScript to JavaScript
- `pnpm start` - Run compiled JavaScript from dist/

## Development Workflow

1. The project uses `tsx` for TypeScript execution without pre-compilation during development
2. Each package has its own TypeScript configuration and build output
3. The `cron` package is currently empty/scaffolded but configured for development


## Deployment

Cron service must be deployed to a Railway service as a github integration. The service setup and integration is done manually. Service implementation must satisfy Railway requirements to cron services (see Railway documentation).


## Environment Variables

- DRIVE_FOLDER_ID -- ID of the Google Drive folder to monitor
- GOOGLE_AUTH_PROVIDER_X509_CERT_URL -- URL for Google auth provider certs
- GOOGLE_AUTH_URL -- Google OAuth2 auth URL
- GOOGLE_CLIENT_EMAIL -- Service account email
- GOOGLE_CLIENT_ID -- Service account client ID
- GOOGLE_CLIENT_X509_CERT_URL -- Service account X.509 cert URL
- GOOGLE_PRIVATE_KEY -- Service account private key (handle newlines properly)
- GOOGLE_PRIVATE_KEY_ID -- Service account private key ID
- GOOGLE_PROJECT_ID -- Project ID
- GOOGLE_TOKEN_URL -- Google auth token URL
- GOOGLE_UNIVERSE_DOMAIN -- Google universe domain
- TRIGGER_DEV_API_KEY -- Trigger.dev API key
- TRIGGER_DEV_ENDPOINT -- Trigger.dev API endpoint

## References 

- [Trigger.dev Documentation](https://trigger.dev/docs/introduction)
- [Google Drive API](https://developers.google.com/drive/api)
- [Railway Cron Jobs Reference](https://docs.railway.com/reference/cron-jobs)
- [Railway Cron Jobs Guide](https://docs.railway.com/guides/cron-jobs)
