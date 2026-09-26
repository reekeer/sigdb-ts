const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

function hex(n: number, width: number): string {
  return n.toString(16).padStart(width, "0");
}

export function reprString(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (ch === quote || ch === "\\") {
      out += `\\${ch}`;
    } else if (ch === "\t") {
      out += "\\t";
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\r";
    } else if (c < 0x20 || c === 0x7f) {
      out += `\\x${hex(c, 2)}`;
    } else if (c < 0x7f || (c !== 0x20 && !NON_PRINTABLE.test(ch)) ) {
      out += ch;
    } else if (c <= 0xff) {
      out += `\\x${hex(c, 2)}`;
    } else if (c <= 0xffff) {
      out += `\\u${hex(c, 4)}`;
    } else {
      out += `\\U${hex(c, 8)}`;
    }
  }
  return out + quote;
}

export function repr(value: unknown): string {
  if (typeof value === "string") {
    return reprString(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(repr).join(", ")}]`;
  }
  if (value === null || value === undefined) {
    return "None";
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  return String(value);
}
