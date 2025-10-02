import type { ClassificationResult } from "../types/domain";

export type DocumentType = ClassificationResult["documentType"];

const DOCUMENT_FOLDER_MAP: Record<DocumentType, string> = {
  invoice: "invoices",
  bank_statement: "statements",
  government_letter: "letters",
  unknown: "unknown",
};

export function getDocumentFolder(documentType: DocumentType): string {
  return DOCUMENT_FOLDER_MAP[documentType] ?? DOCUMENT_FOLDER_MAP.unknown;
}

export function buildDocumentStoragePath(options: {
  documentType: DocumentType;
  docId: string;
  extension: string;
  date?: Date;
}): string {
  const { documentType, docId, extension, date = new Date() } = options;

  const folder = getDocumentFolder(documentType);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");

  return `${folder}/${year}/${month}/${docId}.${extension}`;
}
