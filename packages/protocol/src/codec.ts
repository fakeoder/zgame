/** 消息编解码：JSON + UTF-8，带版本字段 `v`。 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeMessage(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export function decodeMessage(data: Uint8Array): unknown {
  const text =
    data instanceof Uint8Array
      ? decoder.decode(data)
      : decoder.decode(new Uint8Array(data as ArrayBuffer));
  return JSON.parse(text) as unknown;
}

export function decodeMessageSafe(data: Uint8Array): unknown | null {
  try {
    return decodeMessage(data);
  } catch {
    return null;
  }
}

export function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
