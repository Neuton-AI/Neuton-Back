import { z } from 'zod';
export const downloadSchema = z.object({
  path: z.string().trim().min(1).max(500),
});
export interface SignedSourceDto {
  sourceId: string;
  storagePath: string;
  contentType: string;
  originalFilename: string | null;
  byteSize: number;
  uploadUrl: string;
}
export interface PresignedDocumentDto {
  uploadId: string;
  receiptId: string | null;
  recipeId: string | null;
  sources: SignedSourceDto[];
  method: string;
  expiresIn: number;
}
export interface CompletedDocumentDto {
  uploadId: string;
  receiptId: string | null;
  recipeId: string | null;
  queued: boolean;
  jobId: string | null;
  reason?: string;
}
