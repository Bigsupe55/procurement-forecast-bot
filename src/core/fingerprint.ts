import { createHash } from "node:crypto";

// Content fingerprint for dedup (ported from the TLaaS indexer's fingerprint.js
// approach: normalize, join, hash). Two records with the same identifying parts
// produce the same short hash, so we can tell "already alerted" from "new".
export function fingerprint(parts: Array<string | number | undefined | null>): string {
  const normalized = parts
    .map((p) => (p ?? "").toString().trim().toLowerCase().replace(/\s+/g, " "))
    .join("|");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
