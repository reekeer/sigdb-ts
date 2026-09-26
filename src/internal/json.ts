
export type JsonObjectMode = "map" | "object";

export class JsonDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonDecodeError";
  }
}

const MAX_DEPTH = 1000;

class Parser {
  readonly s: string;
  readonly mode: JsonObjectMode;
  pos = 0;
  depth = 0;

  constructor(s: string, mode: JsonObjectMode) {
    this.s = s;
    this.mode = mode;
  }

  fail(msg: string): never {
    throw new JsonDecodeError(`${msg}: char ${this.pos}`);
  }

  ws(): void {
    const s = this.s;
    let c = s.charCodeAt(this.pos);
    while (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
      c = s.charCodeAt(++this.pos);
    }
  }

  value(): unknown {
    const s = this.s;
    const c = s[this.pos];
    switch (c) {
      case '"':
        this.pos++;
        return this.string();
      case "{":
        return this.object();
      case "[":
        return this.array();
      case "n":
        return this.literal("null", null);
      case "t":
        return this.literal("true", true);
      case "f":
        return this.literal("false", false);
      case "N":
        return this.literal("NaN", Number.NaN);
      case "I":
        return this.literal("Infinity", Number.POSITIVE_INFINITY);
      case "-":
        if (s.startsWith("-Infinity", this.pos)) {
          this.pos += 9;
          return Number.NEGATIVE_INFINITY;
        }
        return this.number();
      default:
        if (c !== undefined && c >= "0" && c <= "9") {
          return this.number();
        }
        return this.fail("Expecting value");
    }
  }

  literal(text: string, v: unknown): unknown {
    if (!this.s.startsWith(text, this.pos)) {
      this.fail("Expecting value");
    }
    this.pos += text.length;
    return v;
  }

  number(): number | bigint {
    const re = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/y;
    re.lastIndex = this.pos;
    const m = re.exec(this.s);
    if (m === null) {
      return this.fail("Expecting value");
    }
    this.pos += m[0].length;
    const n = Number(m[0]);
    if (m[1] === undefined && m[2] === undefined && !Number.isSafeInteger(n)) {
      return BigInt(m[0]);
    }
    return n;
  }

  string(): string {
    const s = this.s;
    let out = "";
    let chunkStart = this.pos;
    while (true) {
      if (this.pos >= s.length) {
        this.pos = chunkStart - 1;
        this.fail("Unterminated string starting at");
      }
      const c = s.charCodeAt(this.pos);
      if (c === 0x22) {
        out += s.slice(chunkStart, this.pos);
        this.pos++;
        return out;
      }
      if (c < 0x20) {
        this.fail("Invalid control character at");
      }
      if (c !== 0x5c) {
        this.pos++;
        continue;
      }
      out += s.slice(chunkStart, this.pos);
      const esc = s[this.pos + 1];
      switch (esc) {
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "/":
          out += "/";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "u": {
          let cp = this.hex4(this.pos + 2);
          this.pos += 6;
          if (cp >= 0xd800 && cp <= 0xdbff && s[this.pos] === "\\" && s[this.pos + 1] === "u") {
            const lo = this.hex4(this.pos + 2);
            if (lo >= 0xdc00 && lo <= 0xdfff) {
              cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
              this.pos += 6;
            }
          }
          out += cp > 0xffff ? String.fromCodePoint(cp) : String.fromCharCode(cp);
          chunkStart = this.pos;
          continue;
        }
        default:
          this.fail("Invalid \\escape");
      }
      this.pos += 2;
      chunkStart = this.pos;
    }
  }

  hex4(at: number): number {
    const h = this.s.slice(at, at + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(h)) {
      this.pos = at;
      this.fail("Invalid \\uXXXX escape");
    }
    return Number.parseInt(h, 16);
  }

  enter(): void {
    if (++this.depth > MAX_DEPTH) {
      this.fail("Nesting too deep");
    }
  }

  object(): unknown {
    this.enter();
    this.pos++;
    const map = new Map<string, unknown>();
    this.ws();
    if (this.s[this.pos] === "}") {
      this.pos++;
      this.depth--;
      return this.finishObject(map);
    }
    while (true) {
      if (this.s[this.pos] !== '"') {
        this.fail("Expecting property name enclosed in double quotes");
      }
      this.pos++;
      const key = this.string();
      this.ws();
      if (this.s[this.pos] !== ":") {
        this.fail("Expecting ':' delimiter");
      }
      this.pos++;
      this.ws();
      map.set(key, this.value());
      this.ws();
      const c = this.s[this.pos];
      this.pos++;
      if (c === "}") {
        break;
      }
      if (c !== ",") {
        this.pos--;
        this.fail("Expecting ',' delimiter");
      }
      this.ws();
    }
    this.depth--;
    return this.finishObject(map);
  }

  finishObject(map: Map<string, unknown>): unknown {
    if (this.mode === "map") {
      return map;
    }
    const obj: Record<string, unknown> = {};
    for (const [k, v] of map) {
      Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
    }
    return obj;
  }

  array(): unknown[] {
    this.enter();
    this.pos++;
    const out: unknown[] = [];
    this.ws();
    if (this.s[this.pos] === "]") {
      this.pos++;
      this.depth--;
      return out;
    }
    while (true) {
      this.ws();
      out.push(this.value());
      this.ws();
      const c = this.s[this.pos];
      this.pos++;
      if (c === "]") {
        break;
      }
      if (c !== ",") {
        this.pos--;
        this.fail("Expecting ',' delimiter");
      }
    }
    this.depth--;
    return out;
  }
}

export function parseJson(text: string, mode: JsonObjectMode = "map"): unknown {
  const p = new Parser(text, mode);
  p.ws();
  const v = p.value();
  p.ws();
  if (p.pos !== text.length) {
    p.fail("Extra data");
  }
  return v;
}

export function decodeJsonBytes(b: Uint8Array): string {
  const enc = detectEncoding(b);
  try {
    switch (enc) {
      case "utf-8":
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b);
      case "utf-8-sig":
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b.subarray(3));
      case "utf-16":
        return decodeUtf16(b.subarray(2), b[0] === 0xff);
      case "utf-16-le":
        return decodeUtf16(b, true);
      case "utf-16-be":
        return decodeUtf16(b, false);
      case "utf-32":
        return decodeUtf32(b.subarray(4), b[0] === 0xff);
      case "utf-32-le":
        return decodeUtf32(b, true);
      case "utf-32-be":
        return decodeUtf32(b, false);
      default:
        throw new JsonDecodeError(`unknown encoding ${enc}`);
    }
  } catch (e) {
    if (e instanceof JsonDecodeError) {
      throw e;
    }
    throw new JsonDecodeError(`cannot decode JSON bytes as ${enc}`);
  }
}

function detectEncoding(b: Uint8Array): string {
  const starts = (...prefix: number[]) => prefix.every((v, i) => b[i] === v);
  if (starts(0x00, 0x00, 0xfe, 0xff) || starts(0xff, 0xfe, 0x00, 0x00)) {
    return "utf-32";
  }
  if (starts(0xfe, 0xff) || starts(0xff, 0xfe)) {
    return "utf-16";
  }
  if (starts(0xef, 0xbb, 0xbf)) {
    return "utf-8-sig";
  }
  if (b.length >= 4) {
    if (!b[0]) {
      return b[1] ? "utf-16-be" : "utf-32-be";
    }
    if (!b[1]) {
      return b[2] || b[3] ? "utf-16-le" : "utf-32-le";
    }
  } else if (b.length === 2) {
    if (!b[0]) {
      return "utf-16-be";
    }
    if (!b[1]) {
      return "utf-16-le";
    }
  }
  return "utf-8";
}

function decodeUtf16(b: Uint8Array, le: boolean): string {
  return new TextDecoder(le ? "utf-16le" : "utf-16be", { fatal: true, ignoreBOM: true }).decode(b);
}

function decodeUtf32(b: Uint8Array, le: boolean): string {
  if (b.length % 4 !== 0) {
    throw new JsonDecodeError("truncated utf-32 data");
  }
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let out = "";
  for (let i = 0; i < b.length; i += 4) {
    const cp = view.getUint32(i, le);
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      throw new JsonDecodeError("invalid utf-32 code point");
    }
    out += String.fromCodePoint(cp);
  }
  return out;
}

export function parseJsonBytes(b: Uint8Array, mode: JsonObjectMode = "map"): unknown {
  return parseJson(decodeJsonBytes(b), mode);
}

export class JsonEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonEncodeError";
  }
}

function escapeString(s: string): string {
  let out = '"';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let esc: string | null = null;
    if (c === 0x22) {
      esc = '\\"';
    } else if (c === 0x5c) {
      esc = "\\\\";
    } else if (c < 0x20) {
      switch (c) {
        case 0x0a:
          esc = "\\n";
          break;
        case 0x0d:
          esc = "\\r";
          break;
        case 0x09:
          esc = "\\t";
          break;
        case 0x08:
          esc = "\\b";
          break;
        case 0x0c:
          esc = "\\f";
          break;
        default:
          esc = `\\u${c.toString(16).padStart(4, "0")}`;
      }
    }
    if (esc !== null) {
      out += s.slice(start, i) + esc;
      start = i + 1;
    }
  }
  return `${out}${s.slice(start)}"`;
}

export function floatRepr(x: number): string {
  if (Object.is(x, -0)) {
    return "-0.0";
  }
  const [mantissa = "", expPart = "0"] = x.toExponential().split("e");
  const exp = Number(expPart);
  const negative = mantissa.startsWith("-");
  const digits = mantissa.replace("-", "").replace(".", "");
  const sign = negative ? "-" : "";
  if (exp < -4 || exp >= 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const e = Math.abs(exp).toString().padStart(2, "0");
    return `${sign}${m}e${exp < 0 ? "-" : "+"}${e}`;
  }
  if (exp < 0) {
    return `${sign}0.${"0".repeat(-exp - 1)}${digits}`;
  }
  const intLen = exp + 1;
  if (digits.length <= intLen) {
    return `${sign}${digits}${"0".repeat(intLen - digits.length)}.0`;
  }
  return `${sign}${digits.slice(0, intLen)}.${digits.slice(intLen)}`;
}

function typeName(value: unknown): string {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return "bytes";
  }
  if (typeof value === "object" && value !== null) {
    return (value.constructor as { name?: string } | undefined)?.name ?? "object";
  }
  return typeof value;
}

function numberJson(n: number): string {
  if (!Number.isFinite(n)) {
    throw new JsonEncodeError("Out of range float values are not JSON compliant");
  }
  if (Number.isInteger(n)) {
    return Number.isSafeInteger(n) ? String(n) : BigInt(n).toString();
  }
  return floatRepr(n);
}

function keyJson(key: unknown): string {
  if (typeof key === "string") {
    return escapeString(key);
  }
  if (typeof key === "number") {
    return escapeString(numberJson(key));
  }
  if (typeof key === "bigint") {
    return escapeString(key.toString());
  }
  if (typeof key === "boolean") {
    return escapeString(key ? "true" : "false");
  }
  if (key === null) {
    return '"null"';
  }
  throw new JsonEncodeError(`keys must be str, int, float, bool or None, not ${typeName(key)}`);
}

export function dumpJson(value: unknown): string {
  const stack = new Set<object>();
  const parts: string[] = [];

  const enter = (o: object): void => {
    if (stack.has(o)) {
      throw new JsonEncodeError("Circular reference detected");
    }
    stack.add(o);
  };

  const walk = (v: unknown): void => {
    if (v === null) {
      parts.push("null");
    } else if (v === true) {
      parts.push("true");
    } else if (v === false) {
      parts.push("false");
    } else if (typeof v === "string") {
      parts.push(escapeString(v));
    } else if (typeof v === "number") {
      parts.push(numberJson(v));
    } else if (typeof v === "bigint") {
      parts.push(v.toString());
    } else if (Array.isArray(v)) {
      enter(v);
      parts.push("[");
      v.forEach((x, i) => {
        if (i) {
          parts.push(",");
        }
        walk(x);
      });
      parts.push("]");
      stack.delete(v);
    } else if (v instanceof Map) {
      enter(v);
      parts.push("{");
      let first = true;
      for (const [k, x] of v as Map<unknown, unknown>) {
        parts.push(first ? "" : ",", keyJson(k), ":");
        first = false;
        walk(x);
      }
      parts.push("}");
      stack.delete(v);
    } else if (typeof v === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(v))) {
      enter(v);
      parts.push("{");
      let first = true;
      for (const [k, x] of Object.entries(v)) {
        parts.push(first ? "" : ",", keyJson(k), ":");
        first = false;
        walk(x);
      }
      parts.push("}");
      stack.delete(v);
    } else {
      throw new JsonEncodeError(`Object of type ${typeName(v)} is not JSON serializable`);
    }
  };

  walk(value);
  return parts.join("");
}

export function toPlain(value: unknown): unknown {
  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of value as Map<string, unknown>) {
      Object.defineProperty(obj, k, { value: toPlain(v), enumerable: true, writable: true, configurable: true });
    }
    return obj;
  }
  if (Array.isArray(value)) {
    return value.map(toPlain);
  }
  return value;
}
