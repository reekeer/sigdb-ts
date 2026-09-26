import {
  SIGDB_GROUPS,
  SIGDB_GROUPS_MAP,
  formatListPattern,
  formatMapPattern,
  htmlHeads,
  parseGroupList,
  parseStringMap,
} from "../internal/groups.ts";
import { type Mapping, isMapping, mappingGet } from "../internal/mapping.ts";
import { lower, strip, utf8Encode } from "../internal/text.ts";
import { FormatError } from "../types/exceptions.ts";
import { Automaton, type Database, type Item, type MatchResult, type ValidationResult } from "../types/models.ts";
import type { GroupName, SearchDefinition } from "../types/rules.ts";
import { type LoadOptions, loadSigdb, readSigdbMetadata, validateSigdb } from "./api.ts";

export interface MatchGroupOptions {
  name?: string | null;
}

export interface VerifyOptions {
  verifyHash?: boolean;
}

function normalizeHead(head: string): string {
  const s = strip(head);
  const i = s.indexOf(":");
  if (i === -1) {
    return lower(s);
  }
  const name = lower(strip(s.slice(0, i)));
  const value = lower(strip(s.slice(i + 1)));
  return `${name}:${value}`;
}

function iterSearchHeads(search: SearchDefinition): string[] {
  const heads: string[] = [];
  if (!isMapping(search)) {
    throw new TypeError("search must be an object or Map");
  }
  const s: Mapping = search as Mapping;
  const headers = parseStringMap(mappingGet(s, "headers"), "headers");
  for (const [headerName, headerValue] of headers) {
    heads.push(formatMapPattern("headers", headerName, headerValue));
  }

  for (const group of SIGDB_GROUPS) {
    if (group === "headers") {
      continue;
    }
    if (SIGDB_GROUPS_MAP.has(group)) {
      const groupMap = parseStringMap(mappingGet(s, group), group);
      for (const [name, value] of groupMap) {
        heads.push(formatMapPattern(group, name, value));
      }
    } else {
      const groupValues = parseGroupList(mappingGet(s, group), group);
      for (const value of groupValues) {
        heads.push(formatListPattern(group, value));
      }
    }
  }
  return heads;
}

const NO_MATCH: MatchResult = Object.freeze({ result: false, itemId: null, item: null, head: "" });

export class Matcher {
  readonly #automaton: Automaton;
  readonly #items: readonly Item[];

  constructor(db: Database) {
    this.#automaton = db.automaton;
    this.#items = db.items;
  }

  match(head: string): MatchResult {
    const normalized = normalizeHead(head);
    const data = utf8Encode(normalized);

    const a = this.#automaton;
    const labels = a.labels;
    const childrenStart = a.childrenStart;
    const childrenCount = a.childrenCount;
    const nextState = a.nextState;
    const fail = a.fail;
    const outStart = a.outStart;
    const outCount = a.outCount;
    const outputs = a.outputs;

    let state = 0;
    for (const b of data) {
      while (true) {
        const start = childrenStart[state] as number;
        const count = childrenCount[state] as number;
        let nxt = -1;
        if (count) {
          let lo = 0;
          let hi = count;
          while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            const lb = labels[start + mid] as number;
            if (lb < b) {
              lo = mid + 1;
            } else if (lb > b) {
              hi = mid;
            } else {
              nxt = nextState[start + mid] as number;
              break;
            }
          }
        }

        if (nxt !== -1) {
          state = nxt;
          break;
        }
        if (state === 0) {
          break;
        }
        state = fail[state] as number;
      }

      const oc = outCount[state] as number;
      if (oc) {
        const ostart = outStart[state] as number;
        const itemId = outputs[ostart] as number;
        const item = this.#items[itemId] as Item;
        return { result: true, itemId, item, head: normalized };
      }
    }

    return { result: false, itemId: null, item: null, head: normalized };
  }

  matchGroup(group: GroupName, value: string, options: MatchGroupOptions = {}): MatchResult {
    const name = options.name ?? null;
    if (!(SIGDB_GROUPS as readonly string[]).includes(group)) {
      throw new FormatError(`unknown group: ${group}`);
    }
    let head: string;
    if (name === null) {
      if (SIGDB_GROUPS_MAP.has(group)) {
        throw new FormatError(`group ${group} requires a name`);
      }
      head = formatListPattern(group, value);
    } else {
      if (!SIGDB_GROUPS_MAP.has(group)) {
        throw new FormatError(`group ${group} does not accept a name`);
      }
      head = formatMapPattern(group, name, value);
    }
    return this.match(head);
  }

  matchSearch(search: SearchDefinition): MatchResult {
    for (const head of iterSearchHeads(search)) {
      const result = this.match(head);
      if (result.result) {
        return result;
      }
    }
    return NO_MATCH;
  }

  matchHtml(html: string): MatchResult {
    for (const head of htmlHeads(html)) {
      const result = this.match(head);
      if (result.result) {
        return result;
      }
    }
    return NO_MATCH;
  }
}

export class Reader {
  readonly #path: string;
  #cacheDb: Database | null = null;
  #cacheVerifyHash: boolean | null = null;

  constructor(path: string) {
    this.#path = path;
  }

  get path(): string {
    return this.#path;
  }

  metadata(): Record<string, unknown> {
    return readSigdbMetadata(this.#path);
  }

  validate({ verifyHash = true }: VerifyOptions = {}): ValidationResult {
    return validateSigdb(this.#path, { verifyHash });
  }

  load({ verifyHash = true }: VerifyOptions = {}): Database {
    return loadSigdb(this.#path, { verifyHash });
  }

  loadCached({ verifyHash = true }: VerifyOptions = {}): Database {
    if (this.#cacheDb !== null && this.#cacheVerifyHash === verifyHash) {
      return this.#cacheDb;
    }
    this.#cacheDb = this.load({ verifyHash });
    this.#cacheVerifyHash = verifyHash;
    return this.#cacheDb;
  }

  matcher({ verifyHash = true }: VerifyOptions = {}): Matcher {
    return new Matcher(this.loadCached({ verifyHash }));
  }

  match(head: string): MatchResult {
    return this.matcher().match(head);
  }

  matchGroup(group: GroupName, value: string, options: MatchGroupOptions = {}): MatchResult {
    return this.matcher().matchGroup(group, value, options);
  }

  matchSearch(search: SearchDefinition): MatchResult {
    return this.matcher().matchSearch(search);
  }

  matchHtml(html: string): MatchResult {
    return this.matcher().matchHtml(html);
  }
}

export type MatchSource = Matcher | Database | Reader;

function isDatabase(src: unknown): src is Database {
  return (
    typeof src === "object" &&
    src !== null &&
    (src as Database).automaton instanceof Automaton &&
    Array.isArray((src as Database).items)
  );
}

function toMatcher(src: MatchSource): Matcher {
  if (src instanceof Matcher) {
    return src;
  }
  if (src instanceof Reader) {
    return src.matcher();
  }
  if (isDatabase(src)) {
    return new Matcher(src);
  }
  throw new TypeError("src must be Reader, Database, or Matcher");
}

export function match(head: string, src: MatchSource): MatchResult {
  return toMatcher(src).match(head);
}

export function matchGroup(
  group: GroupName,
  value: string,
  src: MatchSource,
  options: MatchGroupOptions = {},
): MatchResult {
  return toMatcher(src).matchGroup(group, value, options);
}

export function matchSearch(search: SearchDefinition, src: MatchSource): MatchResult {
  return toMatcher(src).matchSearch(search);
}

export function matchHtml(html: string, src: MatchSource): MatchResult {
  return toMatcher(src).matchHtml(html);
}

export type { LoadOptions };
