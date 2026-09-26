import { FormatError } from "../types/exceptions.ts";

export const SPACE_CLASS =
  "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u{1680}\\u{2000}-\\u{200a}\\u{2028}\\u{2029}\\u{202f}\\u{205f}\\u{3000}";

const SPACE_RE = new RegExp(`^[${SPACE_CLASS}]$`, "u");
const SPACE = new Set<number>();
for (let c = 0; c <= 0xffff; c++) {
  if (SPACE_RE.test(String.fromCharCode(c))) {
    SPACE.add(c);
  }
}

export function strip(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && SPACE.has(s.charCodeAt(start))) {
    start++;
  }
  while (end > start && SPACE.has(s.charCodeAt(end - 1))) {
    end--;
  }
  return start === 0 && end === s.length ? s : s.slice(start, end);
}

export function lower(s: string): string {
  return s.toLowerCase();
}

const encoder = new TextEncoder();

export function utf8Encode(s: string): Uint8Array {
  if (!s.isWellFormed()) {
    throw new FormatError("string contains a lone surrogate");
  }
  return encoder.encode(s);
}
