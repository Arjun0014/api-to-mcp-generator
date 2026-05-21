import crypto from "crypto";
import type { NormalizedOperation } from "./ir/types.js";

interface CacheEntry {
  ir: NormalizedOperation[];
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

export function setCachedIR(specHash: string, ir: NormalizedOperation[]): void {
  irCache.set(specHash, { ir, parsedAt: Date.now() });
}

export function clearCache(): void {
  irCache.clear();
}

export function getCacheSize(): number {
  return irCache.size;
}
