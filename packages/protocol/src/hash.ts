/** FNV-1a 32 位哈希，用于状态对账（M3）。短、快、跨端一致。 */

const OFFSET = 0x811c9dc5;
const PRIME = 0x01000193;

export function hashBytes(bytes: Uint8Array): string {
  let h = OFFSET;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i] ?? 0;
    h = Math.imul(h, PRIME);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function hashText(text: string): string {
  return hashBytes(new TextEncoder().encode(text));
}
