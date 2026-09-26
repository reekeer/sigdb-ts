import { closeSync, openSync, readSync } from "node:fs";

import { compressZstd, decompressZstd } from "../compression/zstd.ts";
import { JsonDecodeError, JsonEncodeError, dumpJson, parseJsonBytes } from "../internal/json.ts";
import { isMapping } from "../internal/mapping.ts";
import { repr } from "../internal/repr.ts";
import { FormatError, IntegrityError } from "../types/exceptions.ts";
import { sha256 } from "../utils/hashing.ts";

export const MAGIC: Uint8Array = Uint8Array.of(0x53, 0x49, 0x47, 0x54);
export const VERSION = 3;

export const MAX_HEADER_BYTES = 65_536;
export const MAX_SECTIONS = 65_535;
export const MAX_SECTION_NAME_BYTES = 255;
export const SHA256_SIZE = 32;
export const DEFAULT_MAX_SECTION_SIZE = 512 * 1024 * 1024;

const LEGACY_VERSIONS = new Map<number, string>([
  [1, "legacy signed format"],
  [2, "single-automaton format"],
]);

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function checkVersion(version: number): void {
  const legacy = LEGACY_VERSIONS.get(version);
  if (legacy !== undefined) {
    throw new FormatError(
      `unsupported sigdb version: ${version} (${legacy}); rebuild the database from rules`,
    );
  }
  if (version !== VERSION) {
    throw new FormatError(`unsupported sigdb version: ${version}`);
  }
}

export function dumpJsonBytes(value: unknown): Uint8Array {
  let text: string;
  try {
    text = dumpJson(value);
  } catch (e) {
    if (e instanceof JsonEncodeError) {
      throw new FormatError(`value is not serializable as JSON: ${e.message}`, { cause: e });
    }
    throw e;
  }
  if (!text.isWellFormed()) {
    let position = 0;
    for (const ch of text) {
      const c = ch.codePointAt(0) as number;
      if (c >= 0xd800 && c <= 0xdfff) {
        throw new FormatError(
          `value is not serializable as JSON: 'utf-8' codec can't encode character ${repr(ch)} ` +
            `in position ${position}: surrogates not allowed`,
        );
      }
      position++;
    }
  }
  return encoder.encode(text);
}

export function parseJson(data: Uint8Array, what: string, mode: "map" | "object" = "object"): unknown {
  try {
    return parseJsonBytes(data, mode);
  } catch (e) {
    if (e instanceof JsonDecodeError) {
      throw new FormatError(`invalid ${what} json`, { cause: e });
    }
    throw e;
  }
}

function parseHeader(raw: Uint8Array): Record<string, unknown> {
  const header = parseJson(raw, "HEADER_DATA");
  if (!isMapping(header)) {
    throw new FormatError("HEADER_DATA must be an object");
  }
  return header as Record<string, unknown>;
}

export function writeContainer(
  header: unknown,
  sections: readonly (readonly [string, Uint8Array])[],
  zstdLevel: number,
): [Uint8Array, Record<string, string>] {
  const headerRaw = dumpJsonBytes(header);
  if (headerRaw.length > MAX_HEADER_BYTES) {
    throw new FormatError("HEADER_DATA too large");
  }
  if (sections.length > MAX_SECTIONS) {
    throw new FormatError("too many sections");
  }

  const table: Uint8Array[] = [];
  const bodies: Uint8Array[] = [];
  const hashes: Record<string, string> = {};
  for (const [name, raw] of sections) {
    const nameRaw = encoder.encode(name);
    if (!name.isWellFormed() || !nameRaw.length || nameRaw.length > MAX_SECTION_NAME_BYTES) {
      throw new FormatError(`invalid section name: ${repr(name)}`);
    }
    if (Object.hasOwn(hashes, name)) {
      throw new FormatError(`duplicate section: ${name}`);
    }
    const body = compressZstd(raw, zstdLevel);
    if (raw.length > 0xffffffff || body.length > 0xffffffff) {
      throw new FormatError(`section ${name} too large for 32-bit length`);
    }
    const digest = sha256(raw);
    Object.defineProperty(hashes, name, {
      value: Buffer.from(digest).toString("hex"),
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const entry = new Uint8Array(1 + nameRaw.length + 8 + SHA256_SIZE);
    const view = new DataView(entry.buffer);
    entry[0] = nameRaw.length;
    entry.set(nameRaw, 1);
    view.setUint32(1 + nameRaw.length, raw.length, false);
    view.setUint32(5 + nameRaw.length, body.length, false);
    entry.set(digest, 9 + nameRaw.length);
    table.push(entry);
    bodies.push(body);
  }

  const prefix = new Uint8Array(4 + 1 + 4);
  prefix.set(MAGIC);
  prefix[4] = VERSION;
  new DataView(prefix.buffer).setUint32(5, headerRaw.length, false);
  const count = new Uint8Array(2);
  new DataView(count.buffer).setUint16(0, sections.length, false);

  const parts = [prefix, headerRaw, count, ...table, ...bodies];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return [out, hashes];
}

export interface SectionStore {
  readonly names: string[];
  digests(): Record<string, string>;
  has(name: string): boolean;
  raw(name: string): Uint8Array;
}

interface SectionEntry {
  name: string;
  rawSize: number;
  digest: Uint8Array;
  body: Uint8Array;
}

function toHex(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("hex");
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export class Container implements SectionStore {
  readonly header: Record<string, unknown>;
  readonly #entries: Map<string, SectionEntry>;
  readonly #verifyHash: boolean;
  readonly #maxSectionSize: number;
  readonly #cache = new Map<string, Uint8Array>();

  constructor(
    header: Record<string, unknown>,
    entries: Map<string, SectionEntry>,
    verifyHash: boolean,
    maxSectionSize: number,
  ) {
    this.header = header;
    this.#entries = entries;
    this.#verifyHash = verifyHash;
    this.#maxSectionSize = maxSectionSize;
  }

  get names(): string[] {
    return [...this.#entries.keys()];
  }

  digests(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, e] of this.#entries) {
      Object.defineProperty(out, name, { value: toHex(e.digest), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }

  has(name: string): boolean {
    return this.#entries.has(name);
  }

  raw(name: string): Uint8Array {
    const cached = this.#cache.get(name);
    if (cached !== undefined) {
      return cached;
    }
    const entry = this.#entries.get(name);
    if (entry === undefined) {
      throw new FormatError(`missing section: ${name}`);
    }
    if (entry.rawSize > this.#maxSectionSize) {
      throw new FormatError(`section ${name} exceeds max_section_size`);
    }
    let raw: Uint8Array;
    try {
      raw = decompressZstd(entry.body, entry.rawSize);
    } catch (e) {
      if (e instanceof FormatError) {
        throw new FormatError(`section ${name}: ${e.message}`, { cause: e });
      }
      throw e;
    }
    if (this.#verifyHash && !bytesEqual(sha256(raw), entry.digest)) {
      throw new IntegrityError(`corrupted database (hash mismatch in section ${name})`);
    }
    this.#cache.set(name, raw);
    return raw;
  }
}

class Cursor {
  readonly data: Uint8Array;
  readonly view: DataView;
  pos = 0;

  constructor(data: Uint8Array) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  take(n: number): Uint8Array {
    if (this.pos + n > this.data.length) {
      throw new FormatError("unexpected EOF");
    }
    const chunk = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return chunk;
  }

  u8(): number {
    return this.take(1)[0] as number;
  }

  u16(): number {
    const at = this.pos;
    this.take(2);
    return this.view.getUint16(at, false);
  }

  u32(): number {
    const at = this.pos;
    this.take(4);
    return this.view.getUint32(at, false);
  }
}

function readHeader(c: Cursor): Record<string, unknown> {
  if (!bytesEqual(c.take(4), MAGIC)) {
    throw new FormatError("invalid magic");
  }
  checkVersion(c.u8());
  const headerLen = c.u32();
  if (headerLen > MAX_HEADER_BYTES) {
    throw new FormatError("HEADER_DATA too large");
  }
  return parseHeader(c.take(headerLen));
}

export interface ParseOptions {
  verifyHash?: boolean;
  maxSectionSize?: number;
}

export function parseContainer(data: Uint8Array, options: ParseOptions = {}): Container {
  const { verifyHash = true, maxSectionSize = DEFAULT_MAX_SECTION_SIZE } = options;
  const c = new Cursor(data);
  const header = readHeader(c);

  const count = c.u16();
  const table: [string, number, number, Uint8Array][] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    const nameLen = c.u8();
    let name: string;
    try {
      name = strictDecoder.decode(c.take(nameLen));
    } catch (e) {
      if (e instanceof FormatError) {
        throw e;
      }
      throw new FormatError("invalid section name", { cause: e });
    }
    if (!name || seen.has(name)) {
      throw new FormatError(`invalid or duplicate section name: ${repr(name)}`);
    }
    seen.add(name);
    const rawSize = c.u32();
    const bodySize = c.u32();
    table.push([name, rawSize, bodySize, c.take(SHA256_SIZE)]);
  }

  const entries = new Map<string, SectionEntry>();
  for (const [name, rawSize, bodySize, digest] of table) {
    entries.set(name, { name, rawSize, digest, body: c.take(bodySize) });
  }

  if (c.pos !== data.length) {
    throw new FormatError("trailing data after last section");
  }

  return new Container(header, entries, verifyHash, maxSectionSize);
}

export function readHeaderBytes(data: Uint8Array): Record<string, unknown> {
  return readHeader(new Cursor(data));
}

export function readHeaderFile(path: string): Record<string, unknown> {
  const fd = openSync(path, "r");
  try {
    const buf = new Uint8Array(9 + MAX_HEADER_BYTES);
    let len = 0;
    while (len < buf.length) {
      const n = readSync(fd, buf, len, buf.length - len, null);
      if (n === 0) {
        break;
      }
      len += n;
    }
    return readHeaderBytes(buf.subarray(0, len));
  } finally {
    closeSync(fd);
  }
}
