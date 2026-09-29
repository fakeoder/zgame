/** 纯 JS base64（btoa/atob），不依赖 Buffer，Worker 与浏览器通用。 */

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  const chunk = 0x8000; // 避免 String.fromCharCode 展开参数栈
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    out += String.fromCharCode(...slice);
  }
  return btoa(out);
}

export function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
