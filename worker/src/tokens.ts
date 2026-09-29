/** Room ID：无歧义字符集（去掉 0/O/1/I），6 位 ≈ 8.9 亿空间。 */
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateRoomId(length = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ROOM_ALPHABET[bytes[i]! % ROOM_ALPHABET.length];
  }
  return out;
}

/** 随机不可预测 Token（base64url，32 字节）。 */
export function generateToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return base64Url(buf);
}

export function base64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Token 仅以哈希形式入库。 */
export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function timingSafeEqualHex(a: string, b: string): Promise<boolean> {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Join URL 形如 `/join/A8F3K9-<token>`：Room ID 用于展示，
 * Token 承担鉴权（设计文档 §35）。
 */
export function buildJoinPath(roomId: string, joinToken: string): string {
  return `/join/${roomId}-${joinToken}`;
}

export function parseJoinPath(raw: string): { roomId: string; token: string } | null {
  const idx = raw.indexOf("-");
  if (idx <= 0 || idx === raw.length - 1) return null;
  const roomId = raw.slice(0, idx);
  const token = raw.slice(idx + 1);
  if (!/^[A-Z0-9]{4,12}$/.test(roomId) || token.length < 8) return null;
  return { roomId, token };
}
