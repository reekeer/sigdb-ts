
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

  number(): number {
    const re = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/y;
    re.lastIndex = this.pos;
    const m = re.exec(this.s);
    if (m === null) {
      return this.fail("Expecting value");
    }
    this.pos += m[0].length;
    return Number(m[0]);
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
      default:
        return decodeUtf32(b, false);
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
