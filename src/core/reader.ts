import type { Hit, Item, MatchResult, Occurrence, ValidationResult } from "../types/models.ts";
import type { SearchDefinition } from "../types/rules.ts";
import { DEFAULT_INDEX } from "./compiler.ts";
import { Database, load, readMetadata, validate } from "./database.ts";
import type { Index, MatchGroupOptions, MatchValues } from "./index.ts";

export interface ReaderOptions {
  verifyHash?: boolean;
}

export class Reader {
  readonly #path: string;
  readonly #verifyHash: boolean;
  #db: Database | null = null;

  constructor(path: string, { verifyHash = true }: ReaderOptions = {}) {
    this.#path = path;
    this.#verifyHash = verifyHash;
  }

  get path(): string {
    return this.#path;
  }

  metadata(): Record<string, unknown> {
    return readMetadata(this.#path);
  }

  validate(): ValidationResult {
    return validate(this.#path, { verifyHash: this.#verifyHash });
  }

  load(): Database {
    return load(this.#path, { verifyHash: this.#verifyHash });
  }

  database(): Database {
    if (this.#db === null) {
      this.#db = this.load();
    }
    return this.#db;
  }

  index(name: string = DEFAULT_INDEX): Index {
    return this.database().index(name);
  }

  section(name: string): unknown {
    return this.database().section(name);
  }

  item(key: string): Item | null {
    return this.database().item(key);
  }

  itemsWithPrefix(prefix: string): Item[] {
    return this.database().itemsWithPrefix(prefix);
  }

  match(head: string): MatchResult {
    return this.database().match(head);
  }

  matchGroup(group: string, value: string, options: MatchGroupOptions = {}): MatchResult {
    return this.database().matchGroup(group, value, options);
  }

  matchSearch(search: SearchDefinition): MatchResult {
    return this.database().matchSearch(search);
  }

  matchHtml(html: string): MatchResult {
    return this.database().matchHtml(html);
  }

  matchAll(group: string, values: MatchValues): Hit[] {
    return this.database().matchAll(group, values);
  }

  matchTokens(group: string, tokens: Iterable<string>): Map<number, number> {
    return this.database().matchTokens(group, tokens);
  }

  scan(text: string, group: string): Occurrence[] {
    return this.database().scan(text, group);
  }
}
