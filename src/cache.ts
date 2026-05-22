import crypto from "crypto";
import type { NormalizedOperation, NormalizedSchema } from "./ir/types.js";

export interface CacheMetadata {
  title: string;
  version: string;
  baseUrl: string;
  detectedAuthSchemes: import("./types.js").DetectedAuthScheme[];
}

interface CacheEntry {
  ir: NormalizedOperation[];
  namedSchemas: Record<string, NormalizedSchema>;
  metadata: CacheMetadata;
  parsedAt: number;
}

const irCache = new Map<string, CacheEntry>();

export function hashSpec(rawBytes: Buffer | string): string {
  return crypto
    .createHash("sha256")
    .update(Buffer.isBuffer(rawBytes) ? rawBytes : Buffer.from(rawBytes))
    .digest("hex");
}

export function getCachedIR(specHash: string): NormalizedOperation[] | null {
  return irCache.get(specHash)?.ir ?? null;
}

export function getCachedEntry(
  specHash: string
): { ir: NormalizedOperation[]; namedSchemas: Record<string, NormalizedSchema>; metadata: CacheMetadata } | null {
  const entry = irCache.get(specHash);
  if (!entry) return null;
  return { ir: entry.ir, namedSchemas: entry.namedSchemas, metadata: entry.metadata };
}

export function setCachedIR(
  specHash: string,
  ir: NormalizedOperation[],
  namedSchemas: Record<string, NormalizedSchema>,
  metadata: CacheMetadata
): void {
  irCache.set(specHash, { ir, namedSchemas, metadata, parsedAt: Date.now() });
}

export function clearCache(): void {
  irCache.clear();
}

export function getCacheSize(): number {
  return irCache.size;
}
