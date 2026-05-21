import path from "path";
import os from "os";

export const RAW_SPEC_SIZE_LIMIT = 10 * 1024 * 1024; // 10MB
export const DEREF_SPEC_SIZE_LIMIT = 25 * 1024 * 1024; // 25MB

// ─── URL validation ──────────────────────────────────────────────────────────

const BLOCKED_IPV4_PREFIXES = [
  "169.254.", // link-local / AWS metadata
  "10.",      // RFC1918
  "192.168.", // RFC1918
  "127.",     // loopback
  "0.",       // unspecified
];

const BLOCKED_IPV4_RANGES_172 = [
  16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
];

const BLOCKED_IPV6_PREFIXES = [
  "::1",              // loopback
  "::ffff:169.254",   // IPv4-mapped link-local (dotted-decimal form)
  "::ffff:a9fe:",     // IPv4-mapped 169.254.x.x (hex form, Node normalizes to this)
  "::ffff:10.",       // IPv4-mapped RFC1918
  "::ffff:a00:",      // IPv4-mapped 10.x.x.x (hex)
  "::ffff:192.168.",  // IPv4-mapped RFC1918
  "::ffff:c0a8:",     // IPv4-mapped 192.168.x.x (hex)
  "::ffff:127.",      // IPv4-mapped loopback
  "::ffff:7f00:",     // IPv4-mapped 127.x.x.x (hex)
  "fe80:",            // link-local
  "fc",               // unique local
  "fd",               // unique local
];

function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();

  // Localhost
  if (h === "localhost" || h === "localhost.") return true;

  // IPv6 bracketed: [::1]
  if (h.startsWith("[") && h.endsWith("]")) {
    const inner = h.slice(1, -1);
    for (const prefix of BLOCKED_IPV6_PREFIXES) {
      if (inner.startsWith(prefix)) return true;
    }
    return false;
  }

  // IPv4 prefix checks
  for (const prefix of BLOCKED_IPV4_PREFIXES) {
    if (h.startsWith(prefix)) return true;
  }

  // 172.16-31.x.x
  if (h.startsWith("172.")) {
    const second = parseInt(h.split(".")[1] ?? "", 10);
    if (BLOCKED_IPV4_RANGES_172.includes(second)) return true;
  }

  return false;
}

export function validateSourceUrl(urlString: string): void {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error(
      `Only https:// URLs are accepted for spec sources (got: ${parsed.protocol})`
    );
  }

  if (isBlockedHostname(parsed.hostname)) {
    throw new Error(
      `Blocked URL — SSRF protection: ${parsed.hostname} is a private/reserved address`
    );
  }
}

// ─── File path validation ────────────────────────────────────────────────────

const BLOCKED_UNIX_PATHS = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/root",
  "/private",
  "/sys",
  "/proc",
  "/boot",
  "/lib",
];

const BLOCKED_WINDOWS_PATHS = [
  "c:\\windows",
  "c:\\program files",
  "c:\\program files (x86)",
  "c:\\system32",
  "c:\\syswow64",
  "c:\\programdata",
];

function isBlockedPath(resolved: string): boolean {
  if (process.platform === "win32") {
    const lower = resolved.toLowerCase();
    for (const blocked of BLOCKED_WINDOWS_PATHS) {
      if (lower.startsWith(blocked)) return true;
    }
    // Block AppData\Roaming for any user
    if (lower.includes("appdata\\roaming")) return true;
    return false;
  }

  for (const blocked of BLOCKED_UNIX_PATHS) {
    if (resolved.startsWith(blocked + "/") || resolved === blocked) return true;
  }
  return false;
}

export function validateFilePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  if (isBlockedPath(resolved)) {
    throw new Error(`Blocked file path — path traversal protection: ${resolved}`);
  }
  return resolved;
}

export function validateOutputDir(outputDir: string): string {
  const resolved = path.resolve(outputDir);

  if (isBlockedPath(resolved)) {
    throw new Error(`Unsafe output directory: ${resolved}`);
  }

  // Require the output path to be within the user's home directory or cwd.
  // This is the second layer after the explicit blocklist above.
  const home = os.homedir();
  const cwd = process.cwd();
  if (!resolved.startsWith(home) && !resolved.startsWith(cwd)) {
    throw new Error(
      `Output directory must be within your home directory or current working directory. ` +
        `Got: ${resolved}`
    );
  }

  return resolved;
}

// ─── Size validation ─────────────────────────────────────────────────────────

export function checkRawSize(bytes: Buffer | string, label = "Spec"): void {
  const size = Buffer.isBuffer(bytes) ? bytes.length : Buffer.byteLength(bytes);
  if (size > RAW_SPEC_SIZE_LIMIT) {
    const mb = (size / 1024 / 1024).toFixed(1);
    throw new Error(`${label} exceeds 10MB limit (actual: ${mb}MB)`);
  }
}

export function checkDereferencedSize(doc: unknown): void {
  let size: number;
  try {
    const serialized = JSON.stringify(doc);
    size = Buffer.byteLength(serialized);
  } catch {
    // JSON.stringify throws on circular references (swagger-parser may leave them).
    // Treat a circular doc as oversized — it will cause infinite recursion in the normalizer.
    throw new Error(
      "Dereferenced spec contains circular references that cannot be serialized. " +
        "The spec may use unsupported circular $ref patterns."
    );
  }
  if (size > DEREF_SPEC_SIZE_LIMIT) {
    const mb = (size / 1024 / 1024).toFixed(1);
    throw new Error(
      `Dereferenced spec too large: ${mb}MB (limit: 25MB). This spec has heavy $ref expansion.`
    );
  }
}
