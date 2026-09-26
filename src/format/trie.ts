import { createHash } from "node:crypto";

import { compressZstd, decompressZstd } from "../compression/zstd.ts";
import {
  SIGDB_GROUPS,
  SIGDB_GROUPS_MAP,
  formatListPattern,
  formatMapPattern,
  parseGroupList,
  parseStringMap,
} from "../internal/groups.ts";
import { JsonDecodeError, parseJsonBytes } from "../internal/json.ts";
import { type Mapping, isMapping, mappingEntries, mappingGet } from "../internal/mapping.ts";
import { lower, strip, utf8Encode } from "../internal/text.ts";
import { ByteReader } from "../storage/fileio.ts";
import { FormatError, IntegrityError } from "../types/exceptions.ts";
import { Automaton, type Database, type Item, type ValidationResult } from "../types/models.ts";
import type { Rules } from "../types/rules.ts";
import { decodeVarint, encodeVarint } from "../utils/varint.ts";

export const MAGIC: Uint8Array = Uint8Array.of(0x53, 0x49, 0x47, 0x54);
export const VERSION = 2;
export const LEGACY_SIGNED_VERSION = 1;

export const MAX_HEADER_BYTES = 65_536;
export const SHA256_SIZE = 32;

export const DEFAULT_MAX_ITEMS_JSON_SIZE = 256 * 1024 * 1024;
export const DEFAULT_MAX_AUTOMATON_SIZE = 512 * 1024 * 1024;

export type Metadata = Readonly<Record<string, unknown>> | ReadonlyMap<string, unknown>;

export interface BuildOptions {
  rules: Rules;
  metadata?: Metadata | null;
  zstdLevel?: number;
}

export interface LoadOptions {
  verifyHash?: boolean;
  maxItemsJsonSize?: number;
  maxAutomatonSize?: number;
}

export interface BuiltContainer {
  bytes: Uint8Array;
  dataHashHex: string;
  metadata: Record<string, unknown>;
}

function checkVersion(version: number): void {
  if (version === LEGACY_SIGNED_VERSION) {
    throw new FormatError(
      "unsupported sigdb version: 1 (legacy signed format); rebuild the database from rules",
    );
  }
  if (version !== VERSION) {
    throw new FormatError(`unsupported sigdb version: ${version}`);
  }
}

function toHex(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("hex");
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function dataHash(itemsRaw: Uint8Array, automatonRaw: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(itemsRaw).update(automatonRaw).digest());
}

function setProp(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

export function readHeader(r: ByteReader): Record<string, unknown> {
  const magic = r.readExact(4);
  if (!bytesEqual(magic, MAGIC)) {
    throw new FormatError("invalid magic");
  }

  checkVersion(r.readU8());

  const headerLen = r.readU32BE();
  if (headerLen > MAX_HEADER_BYTES) {
    throw new FormatError("HEADER_DATA too large");
  }

  const headerRaw = r.readExact(headerLen);
  let headerAny: unknown;
  try {
    headerAny = parseJsonBytes(headerRaw, "object");
  } catch (e) {
    if (e instanceof JsonDecodeError) {
      throw new FormatError("invalid HEADER_DATA json", { cause: e });
    }
    throw e;
  }
  if (!isMapping(headerAny)) {
    throw new FormatError("HEADER_DATA must be an object");
  }
  return headerAny as Record<string, unknown>;
}

interface Container {
  header: Record<string, unknown>;
  itemsCompressed: Uint8Array;
  autoCompressed: Uint8Array;
  storedHash: Uint8Array;
}

function readContainer(data: Uint8Array): Container {
  const r = new ByteReader(data);
  const header = readHeader(r);

  const itemsLen = r.readU32BE();
  const itemsCompressed = r.readExact(itemsLen);

  const autoLen = r.readU32BE();
  const autoCompressed = r.readExact(autoLen);

  const storedHash = r.readExact(SHA256_SIZE);

  if (!r.atEnd()) {
    throw new FormatError("trailing data after hash");
  }

  return { header, itemsCompressed, autoCompressed, storedHash };
}

export function readSigdbMetadataBytes(data: Uint8Array): Record<string, unknown> {
  return readHeader(new ByteReader(data));
}

function localIsoDate(d: Date): string {
  const y = String(d.getFullYear()).padStart(4, "0");
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function headerJson(meta: Record<string, unknown>): string {
  return JSON.stringify(meta, (key, value: unknown) => {
    if (!key.isWellFormed() || (typeof value === "string" && !value.isWellFormed())) {
      throw new FormatError("string contains a lone surrogate");
    }
    return value;
  });
}

export function buildContainer({ rules, metadata, zstdLevel = 19 }: BuildOptions): BuiltContainer {
  const [items, patterns] = compileRules(rules);
  const automaton = buildAutomaton(patterns);

  const headerMeta: Record<string, unknown> = {};
  if (metadata) {
    const entries = metadata instanceof Map ? metadata.entries() : Object.entries(metadata);
    for (const [k, v] of entries) {
      setProp(headerMeta, String(k), v);
    }
  }
  const setDefault = (key: string, value: unknown): void => {
    if (!Object.hasOwn(headerMeta, key)) {
      setProp(headerMeta, key, value);
    }
  };
  const now = new Date();
  setDefault("format", "SIGDB-TRIE");
  setDefault("version", VERSION);
  setDefault("created", Math.floor(now.getTime() / 1000));
  setDefault("build", localIsoDate(now));
  setDefault("items", items.length);
  setDefault("patterns", patterns.size);

  const headerData = utf8Encode(headerJson(headerMeta));
  if (headerData.length > MAX_HEADER_BYTES) {
    throw new FormatError("HEADER_DATA too large");
  }

  const itemsRaw = serializeItems(items);
  const automatonRaw = serializeAutomaton(automaton);
  const hash = dataHash(itemsRaw, automatonRaw);

  const itemsData = compressZstd(itemsRaw, zstdLevel);
  const automatonData = compressZstd(automatonRaw, zstdLevel);

  if (itemsData.length > 0xffffffff || automatonData.length > 0xffffffff) {
    throw new FormatError("compressed block too large for 32-bit length");
  }

  const total =
    MAGIC.length + 1 + 4 + headerData.length + 4 + itemsData.length + 4 + automatonData.length + SHA256_SIZE;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let pos = 0;
  const put = (b: Uint8Array): void => {
    out.set(b, pos);
    pos += b.length;
  };
  const putU32 = (n: number): void => {
    view.setUint32(pos, n, false);
    pos += 4;
  };

  put(MAGIC);
  out[pos++] = VERSION;
  putU32(headerData.length);
  put(headerData);
  putU32(itemsData.length);
  put(itemsData);
  putU32(automatonData.length);
  put(automatonData);
  put(hash);

  return { bytes: out, dataHashHex: toHex(hash), metadata: headerMeta };
}

export function loadDatabase(data: Uint8Array, options: LoadOptions = {}): Database {
  const {
    verifyHash = true,
    maxItemsJsonSize = DEFAULT_MAX_ITEMS_JSON_SIZE,
    maxAutomatonSize = DEFAULT_MAX_AUTOMATON_SIZE,
  } = options;
  const c = readContainer(data);

  const itemsRaw = decompressZstd(c.itemsCompressed, maxItemsJsonSize);
  const autoRaw = decompressZstd(c.autoCompressed, maxAutomatonSize);

  if (verifyHash) {
    const computed = dataHash(itemsRaw, autoRaw);
    if (!bytesEqual(computed, c.storedHash)) {
      throw new IntegrityError("corrupted database (hash mismatch)");
    }
  }

  const items = parseItems(itemsRaw);
  const automaton = deserializeAutomaton(autoRaw);
  checkOutputs(automaton, items.length);
  return { metadata: c.header, items, automaton };
}

export function validateContainer(data: () => Uint8Array, options: LoadOptions = {}): ValidationResult {
  const {
    verifyHash = true,
    maxItemsJsonSize = DEFAULT_MAX_ITEMS_JSON_SIZE,
    maxAutomatonSize = DEFAULT_MAX_AUTOMATON_SIZE,
  } = options;
  const errors: string[] = [];
  let header: Record<string, unknown> | null = null;
  let storedHash: Uint8Array | null = null;
  let computedHash: Uint8Array | null = null;

  try {
    const c = readContainer(data());
    header = c.header;
    storedHash = c.storedHash;

    const itemsRaw = decompressZstd(c.itemsCompressed, maxItemsJsonSize);
    const autoRaw = decompressZstd(c.autoCompressed, maxAutomatonSize);

    if (verifyHash) {
      computedHash = dataHash(itemsRaw, autoRaw);
      if (!bytesEqual(computedHash, storedHash)) {
        errors.push("hash mismatch");
      }
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  return {
    ok: errors.length === 0,
    errors,
    metadata: header,
    storedHashHex: storedHash ? toHex(storedHash) : null,
    computedHashHex: computedHash ? toHex(computedHash) : null,
  };
}

interface Pattern {
  bytes: Uint8Array;
  ids: number[];
}

function compileRules(rules: unknown): [Item[], Map<string, Pattern>] {
  if (!isMapping(rules)) {
    throw new FormatError("rules must be a JSON object");
  }

  const items: Item[] = [];
  const patterns = new Map<string, Pattern>();
  for (const [keyAny, valueAny] of mappingEntries(rules)) {
    if (typeof keyAny !== "string" || !keyAny) {
      throw new FormatError("rule keys must be non-empty strings");
    }
    if (!isMapping(valueAny)) {
      throw new FormatError("rule value must be an object");
    }
    const key = keyAny;
    const value: Mapping = valueAny;
    const headers = parseStringMap(mappingGet(value, "headers"), "headers");
    const itemId = items.length;
    items.push({ key, headers });

    addMapPatterns(patterns, "headers", headers, itemId);
    for (const group of SIGDB_GROUPS) {
      if (group === "headers") {
        continue;
      }
      if (SIGDB_GROUPS_MAP.has(group)) {
        const groupMap = parseStringMap(mappingGet(value, group), group);
        addMapPatterns(patterns, group, groupMap, itemId);
      } else {
        const groupValues = parseGroupList(mappingGet(value, group), group);
        addListPatterns(patterns, group, groupValues, itemId);
      }
    }
  }

  for (const p of patterns.values()) {
    if (p.ids.length > 1) {
      p.ids = sortedUnique(p.ids);
    }
  }

  return [items, patterns];
}

function sortedUnique(ids: readonly number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

function addPattern(patterns: Map<string, Pattern>, pattern: string, itemId: number): void {
  const normalized = lower(strip(pattern));
  const existing = patterns.get(normalized);
  if (existing) {
    existing.ids.push(itemId);
  } else {
    patterns.set(normalized, { bytes: utf8Encode(normalized), ids: [itemId] });
  }
}

function addMapPatterns(
  patterns: Map<string, Pattern>,
  group: string,
  values: ReadonlyMap<string, string>,
  itemId: number,
): void {
  for (const [key, needle] of values) {
    addPattern(patterns, formatMapPattern(group, key, needle), itemId);
  }
}

function addListPatterns(
  patterns: Map<string, Pattern>,
  group: string,
  values: readonly string[],
  itemId: number,
): void {
  for (const needle of values) {
    addPattern(patterns, formatListPattern(group, needle), itemId);
  }
}

function jsonString(s: string): string {
  if (!s.isWellFormed()) {
    throw new FormatError("string contains a lone surrogate");
  }
  return JSON.stringify(s);
}

export function serializeItems(items: readonly Item[]): Uint8Array {
  const parts: string[] = [];
  for (const item of items) {
    const headers: string[] = [];
    for (const [k, v] of item.headers) {
      headers.push(`${jsonString(k)}:${jsonString(v)}`);
    }
    parts.push(`[${jsonString(item.key)},{${headers.join(",")}}]`);
  }
  return utf8Encode(`[${parts.join(",")}]`);
}

function parseItems(data: Uint8Array): Item[] {
  let decodedAny: unknown;
  try {
    decodedAny = parseJsonBytes(data, "map");
  } catch (e) {
    if (e instanceof JsonDecodeError) {
      throw new FormatError("invalid items json", { cause: e });
    }
    throw e;
  }
  if (!Array.isArray(decodedAny)) {
    throw new FormatError("items block must be a JSON array");
  }

  const items: Item[] = [];
  for (const entry of decodedAny as unknown[]) {
    if (!Array.isArray(entry)) {
      throw new FormatError("item must be [key, headers]");
    }
    const entryList = entry as unknown[];
    if (entryList.length !== 2) {
      throw new FormatError("item must be [key, headers]");
    }
    const [keyAny, headersAny] = entryList;
    if (typeof keyAny !== "string" || !keyAny) {
      throw new FormatError("item key must be a non-empty string");
    }
    const headers = parseStringMap(headersAny, "headers");
    items.push({ key: keyAny, headers });
  }
  return items;
}

class ByteWriter {
  buf = new Uint8Array(1024);
  len = 0;

  ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) {
      return;
    }
    let cap = this.buf.length * 2;
    while (cap < this.len + extra) {
      cap *= 2;
    }
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  varint(value: number): void {
    if (value < 0x80) {
      this.ensure(1);
      this.buf[this.len++] = value;
      return;
    }
    const b = encodeVarint(value);
    this.bytes(b);
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  result(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export function serializeAutomaton(a: Automaton): Uint8Array {
  const w = new ByteWriter();

  const nodeCount = a.childrenStart.length;
  const edgeCount = a.labels.length;
  const outputTotal = a.outputs.length;

  w.varint(nodeCount);
  w.varint(edgeCount);
  w.varint(outputTotal);

  for (let i = 0; i < nodeCount; i++) {
    w.varint(a.childrenStart[i] as number);
    w.varint(a.childrenCount[i] as number);
    w.varint(a.fail[i] as number);
    w.varint(a.outStart[i] as number);
    w.varint(a.outCount[i] as number);
  }

  w.bytes(a.labels);
  for (const nxt of a.nextState) {
    w.varint(nxt);
  }
  for (const outId of a.outputs) {
    w.varint(outId);
  }

  return w.result();
}

const U32_MAX = 0xffffffff;

function invalidAutomaton(): never {
  throw new FormatError("invalid automaton structure");
}

export function deserializeAutomaton(data: Uint8Array): Automaton {
  let pos = 0;
  const read = (): number => {
    const r = decodeVarint(data, pos);
    pos = r.offset;
    return r.value;
  };

  const nodeCount = read();
  const edgeCount = read();
  const outputTotal = read();

  if (nodeCount * 5 + edgeCount * 2 + outputTotal > data.length - pos) {
    throw new FormatError("truncated varint");
  }

  const childrenStart = new Float64Array(nodeCount);
  const childrenCount = new Float64Array(nodeCount);
  const fail = new Float64Array(nodeCount);
  const outStart = new Float64Array(nodeCount);
  const outCount = new Float64Array(nodeCount);

  for (let i = 0; i < nodeCount; i++) {
    childrenStart[i] = read();
    childrenCount[i] = read();
    fail[i] = read();
    outStart[i] = read();
    outCount[i] = read();
  }

  const labels = data.slice(pos, pos + edgeCount);
  pos += edgeCount;

  const nextState = new Float64Array(edgeCount);
  for (let i = 0; i < edgeCount; i++) {
    nextState[i] = read();
  }

  const outputs = new Float64Array(outputTotal);
  for (let i = 0; i < outputTotal; i++) {
    outputs[i] = read();
  }

  if (pos !== data.length) {
    throw new FormatError("automaton block has trailing bytes");
  }

  const toU32 = (a: Float64Array): Uint32Array => {
    for (const v of a) {
      if (v > U32_MAX) {
        invalidAutomaton();
      }
    }
    return Uint32Array.from(a);
  };

  const automaton = new Automaton({
    childrenStart: toU32(childrenStart),
    childrenCount: toU32(childrenCount),
    fail: toU32(fail),
    outStart: toU32(outStart),
    outCount: toU32(outCount),
    labels,
    nextState: toU32(nextState),
    outputs: toU32(outputs),
  });
  checkStructure(automaton);
  return automaton;
}

function checkStructure(a: Automaton): void {
  const nodeCount = a.childrenStart.length;
  const edgeCount = a.labels.length;
  const outputTotal = a.outputs.length;
  if (nodeCount === 0) {
    invalidAutomaton();
  }

  for (let i = 0; i < nodeCount; i++) {
    if (
      (a.childrenStart[i] as number) + (a.childrenCount[i] as number) > edgeCount ||
      (a.outStart[i] as number) + (a.outCount[i] as number) > outputTotal ||
      (a.fail[i] as number) >= nodeCount
    ) {
      invalidAutomaton();
    }
  }

  const depth = new Int32Array(nodeCount).fill(-1);
  depth[0] = 0;
  const queue = new Uint32Array(nodeCount);
  let head = 0;
  let tail = 1;
  while (head < tail) {
    const v = queue[head++] as number;
    const start = a.childrenStart[v] as number;
    const end = start + (a.childrenCount[v] as number);
    for (let e = start; e < end; e++) {
      const u = a.nextState[e] as number;
      if (u >= nodeCount || depth[u] !== -1) {
        invalidAutomaton();
      }
      depth[u] = (depth[v] as number) + 1;
      queue[tail++] = u;
    }
  }
  if (tail !== nodeCount) {
    invalidAutomaton();
  }

  for (let v = 1; v < nodeCount; v++) {
    if ((depth[a.fail[v] as number] as number) >= (depth[v] as number)) {
      invalidAutomaton();
    }
  }
}

function checkOutputs(a: Automaton, itemCount: number): void {
  for (const id of a.outputs) {
    if (id >= itemCount) {
      invalidAutomaton();
    }
  }
}

export function buildAutomaton(patterns: ReadonlyMap<string, Pattern>): Automaton {
  const trans: Map<number, number>[] = [new Map()];
  const out: number[][] = [[]];

  for (const { bytes, ids } of patterns.values()) {
    let state = 0;
    for (const b of bytes) {
      const t = trans[state] as Map<number, number>;
      let nxt = t.get(b);
      if (nxt === undefined) {
        nxt = trans.length;
        t.set(b, nxt);
        trans.push(new Map());
        out.push([]);
      }
      state = nxt;
    }
    const o = out[state] as number[];
    for (const id of ids) {
      o.push(id);
    }
  }

  for (let i = 0; i < out.length; i++) {
    if ((out[i] as number[]).length > 1) {
      out[i] = sortedUnique(out[i] as number[]);
    }
  }

  const fail = new Uint32Array(trans.length);
  const q: number[] = [...(trans[0] as Map<number, number>).values()];
  let qi = 0;

  while (qi < q.length) {
    const v = q[qi++] as number;
    for (const [b, u] of trans[v] as Map<number, number>) {
      q.push(u);
      let f = fail[v] as number;
      while (f !== 0 && !(trans[f] as Map<number, number>).has(b)) {
        f = fail[f] as number;
      }
      fail[u] = (trans[f] as Map<number, number>).get(b) ?? 0;
      const failOut = out[fail[u] as number] as number[];
      if (failOut.length) {
        out[u] = sortedUnique((out[u] as number[]).concat(failOut));
      }
    }
  }

  const nodeCount = trans.length;
  const childrenStart = new Uint32Array(nodeCount);
  const childrenCount = new Uint32Array(nodeCount);
  const outStart = new Uint32Array(nodeCount);
  const outCount = new Uint32Array(nodeCount);

  let edgeTotal = 0;
  let outTotal = 0;
  for (let i = 0; i < nodeCount; i++) {
    edgeTotal += (trans[i] as Map<number, number>).size;
    outTotal += (out[i] as number[]).length;
  }
  const labels = new Uint8Array(edgeTotal);
  const nextState = new Uint32Array(edgeTotal);
  const outputs = new Uint32Array(outTotal);

  let edgeCursor = 0;
  let outCursor = 0;
  for (let i = 0; i < nodeCount; i++) {
    const edges = [...(trans[i] as Map<number, number>)].sort((x, y) => x[0] - y[0]);
    childrenStart[i] = edgeCursor;
    childrenCount[i] = edges.length;
    for (const [b, nxt] of edges) {
      labels[edgeCursor] = b;
      nextState[edgeCursor] = nxt;
      edgeCursor++;
    }

    const o = out[i] as number[];
    outStart[i] = outCursor;
    outCount[i] = o.length;
    outputs.set(o, outCursor);
    outCursor += o.length;
  }

  return new Automaton({
    childrenStart,
    childrenCount,
    fail,
    outStart,
    outCount,
    labels,
    nextState,
    outputs,
  });
}
