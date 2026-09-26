import { readFileSync } from "node:fs";

import { deserializeAutomaton } from "../format/automaton.ts";
import {
  DEFAULT_MAX_SECTION_SIZE,
  type SectionStore,
  parseContainer,
  parseJson,
  readHeaderBytes,
  readHeaderFile,
} from "../format/container.ts";
import { FormatError } from "../types/exceptions.ts";
import type { Hit, Item, MatchResult, Occurrence, ValidationResult } from "../types/models.ts";
import type { SearchDefinition } from "../types/rules.ts";
import { sha256 } from "../utils/hashing.ts";
import { DEFAULT_INDEX, automatonSection, indexSection } from "./compiler.ts";
import { Index, type MatchGroupOptions, type MatchValues } from "./index.ts";

export interface LoadOptions {
  verifyHash?: boolean;
  lazy?: boolean;
  maxSectionSize?: number;
}

export type RawSections = Readonly<Record<string, Uint8Array>> | ReadonlyMap<string, Uint8Array>;

function setProp(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function partition(name: string): [string, string] {
  const i = name.indexOf("/");
  return i === -1 ? [name, ""] : [name.slice(0, i), name.slice(i + 1)];
}

class MemorySections implements SectionStore {
  readonly #raw: Map<string, Uint8Array>;

  constructor(raw: RawSections) {
    const entries = raw instanceof Map ? [...raw.entries()] : Object.entries(raw);
    this.#raw = new Map(entries);
  }

  get names(): string[] {
    return [...this.#raw.keys()];
  }

  digests(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, raw] of this.#raw) {
      setProp(out, name, Buffer.from(sha256(raw)).toString("hex"));
    }
    return out;
  }

  has(name: string): boolean {
    return this.#raw.has(name);
  }

  raw(name: string): Uint8Array {
    const raw = this.#raw.get(name);
    if (raw === undefined) {
      throw new FormatError(`missing section: ${name}`);
    }
    return raw;
  }
}

export class Database {
  readonly metadata: Record<string, unknown>;
  readonly #store: SectionStore;
  readonly #indexes = new Map<string, Index>();
  readonly #sections = new Map<string, unknown>();

  constructor(metadata: Record<string, unknown>, store: SectionStore) {
    this.metadata = metadata;
    this.#store = store;
    for (const name of store.names) {
      const [kind, rest] = partition(name);
      if (!["index", "automaton", "json", "blob"].includes(kind) || !rest) {
        throw new FormatError(`unknown section: ${name}`);
      }
    }
    if (!this.indexNames.length) {
      throw new FormatError("database has no indexes");
    }
  }

  static fromRaw(metadata: Readonly<Record<string, unknown>>, sections: RawSections): Database {
    return new Database({ ...metadata }, new MemorySections(sections));
  }

  rawSections(): Record<string, Uint8Array> {
    const out: Record<string, Uint8Array> = {};
    for (const name of this.#store.names) {
      setProp(out, name, new Uint8Array(this.#store.raw(name)));
    }
    return out;
  }

  sectionDigests(): Record<string, string> {
    return this.#store.digests();
  }

  get indexNames(): string[] {
    return this.#store.names.filter((n) => n.startsWith("index/")).map((n) => partition(n)[1]);
  }

  get sectionNames(): string[] {
    return this.#store.names
      .filter((n) => n.startsWith("json/") || n.startsWith("blob/"))
      .map((n) => partition(n)[1]);
  }

  section(name: string): unknown {
    if (this.#sections.has(name)) {
      return this.#sections.get(name);
    }
    let value: unknown;
    if (this.#store.has(`json/${name}`)) {
      value = parseJson(this.#store.raw(`json/${name}`), `section ${name}`);
    } else if (this.#store.has(`blob/${name}`)) {
      value = this.#store.raw(`blob/${name}`);
    } else {
      throw new FormatError(`missing section: ${name}`);
    }
    this.#sections.set(name, value);
    return value;
  }

  index(name: string = DEFAULT_INDEX): Index {
    const cached = this.#indexes.get(name);
    if (cached !== undefined) {
      return cached;
    }
    const section = indexSection(name);
    if (!this.#store.has(section)) {
      throw new FormatError(`missing index: ${name}`);
    }
    const payload = parseJson(this.#store.raw(section), `index ${name}`, "map");
    const index = new Index(name, payload, (group, patternCount) => {
      const sec = automatonSection(name, group);
      if (!this.#store.has(sec)) {
        return null;
      }
      return deserializeAutomaton(this.#store.raw(sec), patternCount);
    });
    this.#indexes.set(name, index);
    return index;
  }

  get items(): readonly Item[] {
    return this.index().items;
  }

  item(key: string): Item | null {
    return this.index().item(key);
  }

  itemsWithPrefix(prefix: string): Item[] {
    return this.index().itemsWithPrefix(prefix);
  }

  match(head: string): MatchResult {
    return this.index().match(head);
  }

  matchGroup(group: string, value: string, options: MatchGroupOptions = {}): MatchResult {
    return this.index().matchGroup(group, value, options);
  }

  matchSearch(search: SearchDefinition): MatchResult {
    return this.index().matchSearch(search);
  }

  matchHtml(html: string): MatchResult {
    return this.index().matchHtml(html);
  }

  matchAll(group: string, values: MatchValues): Hit[] {
    return this.index().matchAll(group, values);
  }

  matchTokens(group: string, tokens: Iterable<string>): Map<number, number> {
    return this.index().matchTokens(group, tokens);
  }

  scan(text: string, group: string): Occurrence[] {
    return this.index().scan(text, group);
  }
}

export function loadBytes(data: Uint8Array, options: LoadOptions = {}): Database {
  const container = parseContainer(data, options);
  const db = new Database(container.header, container);
  if (options.lazy === false) {
    loadAll(db);
  }
  return db;
}

export function load(path: string, options: LoadOptions = {}): Database {
  return loadBytes(readFileSync(path), options);
}

function loadAll(db: Database): void {
  for (const name of db.indexNames) {
    db.index(name).preload();
  }
  for (const name of db.sectionNames) {
    db.section(name);
  }
}

export function readMetadata(path: string): Record<string, unknown> {
  return readHeaderFile(path);
}

export function readMetadataBytes(data: Uint8Array): Record<string, unknown> {
  return readHeaderBytes(data);
}

function validateWith(read: () => Uint8Array, options: LoadOptions): ValidationResult {
  const errors: string[] = [];
  let metadata: Record<string, unknown> | null = null;
  let digests: Record<string, string> | null = null;
  try {
    const db = loadBytes(read(), { verifyHash: options.verifyHash ?? true, maxSectionSize: options.maxSectionSize ?? DEFAULT_MAX_SECTION_SIZE });
    metadata = db.metadata;
    digests = db.sectionDigests();
    db.rawSections();
    loadAll(db);
    for (const section of Object.keys(digests)) {
      const [kind, rest] = partition(section);
      if (kind !== "automaton") {
        continue;
      }
      const [indexName, group] = partition(rest);
      if (!db.indexNames.includes(indexName)) {
        errors.push(`automaton section for unknown index: ${section}`);
        continue;
      }
      const spec = db.index(indexName).groups.get(group);
      if (spec === undefined || spec.match === "exact") {
        errors.push(`unexpected automaton section: ${section}`);
      }
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  return { ok: !errors.length, errors, metadata, sections: digests };
}

export function validate(path: string, options: LoadOptions = {}): ValidationResult {
  return validateWith(() => readFileSync(path), options);
}

export function validateBytes(data: Uint8Array, options: LoadOptions = {}): ValidationResult {
  return validateWith(() => data, options);
}
