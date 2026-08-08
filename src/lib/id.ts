/**
 * Ids are generated on-device and are the primary key everywhere, including on the
 * remote. That is what lets a record be created offline, referenced by other records
 * immediately, and pushed later without a rewrite pass to fix up server-assigned keys.
 */
export function newId(): string {
  const globalCrypto = globalThis.crypto;
  if (globalCrypto?.randomUUID) return globalCrypto.randomUUID();
  // Older Safari and non-secure contexts expose getRandomValues but not randomUUID.
  const bytes = new Uint8Array(16);
  globalCrypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
