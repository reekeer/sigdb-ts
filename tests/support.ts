import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BaseError, type BuildOptions, type Database, type Hit, type MatchResult, type RulesInput } from "../src/index.ts";
import { parseJsonBytes } from "../src/internal/json.ts";

export const TESTS_DIR = import.meta.dirname;
export const GOLDEN_DIR = join(TESTS_DIR, "golden");
export const EXTRA_DIR = join(TESTS_DIR, "golden-extra");
export const FIXTURES_DIR = join(TESTS_DIR, "fixtures");

export function readOrdered(path: string): unknown {
  return parseJsonBytes(readFileSync(path), "map");
}

export function readPlain(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function goldenCases(dir: string = GOLDEN_DIR): string[] {
  const isFile = (p: string) => statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
  return readdirSync(dir)
    .filter((name) => isFile(join(dir, name, "rules.json")) || isFile(join(dir, name, "build.json")))
    .sort();
}

export interface BuildArgs {
  rules: RulesInput | null;
  options: BuildOptions;
}

export function toBuildArgs(raw: Map<string, unknown>): BuildArgs {
  const sections = raw.get("sections");
  if (sections instanceof Map) {
    for (const [name, value] of sections) {
      if (value instanceof Map && value.size === 1 && value.has("hex")) {
        sections.set(name, Uint8Array.from(Buffer.from(value.get("hex") as string, "hex")));
      }
    }
  }
  return {
    rules: (raw.get("rules") ?? null) as RulesInput | null,
    options: {
      groups: raw.get("groups") as BuildOptions["groups"],
      indexes: raw.get("indexes") as BuildOptions["indexes"],
      sections: raw.get("sections") as BuildOptions["sections"],
      metadata: raw.get("metadata") as BuildOptions["metadata"],
      timestamp: raw.get("timestamp") as BuildOptions["timestamp"],
    },
  };
}

export function caseBuildArgs(caseName: string, dir: string = GOLDEN_DIR): BuildArgs {
  const buildPath = join(dir, caseName, "build.json");
  if (statSync(buildPath, { throwIfNoEntry: false })?.isFile()) {
    return toBuildArgs(readOrdered(buildPath) as Map<string, unknown>);
  }
  return toBuildArgs(new Map([["rules", readOrdered(join(dir, caseName, "rules.json"))]]));
}

export interface Vector {
  input: Map<string, unknown>;
  expect: unknown;
}

export function loadVectors(caseName: string, dir: string = GOLDEN_DIR): Vector[] {
  const path = join(dir, caseName, "vectors.json");
  const ordered = readOrdered(path) as Map<string, unknown>[];
  const plain = readPlain(path) as { expect: unknown }[];
  return ordered.map((input, i) => ({ input, expect: plain[i]?.expect }));
}

function result(r: MatchResult): Record<string, unknown> {
  return {
    result: r.result,
    item_id: r.itemId,
    key: r.item !== null ? r.item.key : null,
    head: r.head,
    pattern_id: r.patternId,
  };
}

function hits(list: Hit[]): unknown[] {
  return list.map((h) => [h.itemId, h.item.key, h.hits, [...h.patternIds]]);
}

export function runVector(db: Database, v: Map<string, unknown>): unknown {
  const call = v.get("call");
  const str = (k: string) => v.get(k) as string;
  try {
    const index = db.index((v.get("index") as string | undefined) ?? "main");
    switch (call) {
      case "match":
        return { ...result(index.match(str("head"))), all: hits(index.matchAll("headers", str("head"))) };
      case "match_group": {
        const group = str("group");
        const value = str("value");
        const name = (v.get("name") as string | undefined) ?? null;
        return {
          ...result(index.matchGroup(group, value, { name })),
          all: hits(index.matchAll(group, name ? new Map([[name, value]]) : [value])),
        };
      }
      case "match_html":
        return result(index.matchHtml(str("html")));
      case "match_search":
        return result(index.matchSearch(v.get("search") as Map<string, unknown>));
      case "match_all":
        return hits(index.matchAll(str("group"), v.get("values") as string[]));
      case "match_tokens":
        return [...index.matchTokens(str("group"), v.get("tokens") as string[])];
      case "scan":
        return index
          .scan(str("text"), str("group"))
          .map((o) => [o.patternId, o.start, o.end, index.pattern(o.patternId).text]);
      case "item": {
        const item = index.item(str("key"));
        return item === null ? null : [index.itemId(str("key")), item.data];
      }
      case "items_with_prefix":
        return index.itemsWithPrefix(str("prefix")).map((item) => item.key);
      case "pattern_count":
        return index.patternCount(v.get("item_id") as number, (v.get("group") as string | undefined) ?? null);
      case "section": {
        const value = db.section(str("name"));
        return value instanceof Uint8Array ? { hex: Buffer.from(value).toString("hex") } : value;
      }
    }
  } catch (e) {
    if (e instanceof BaseError) {
      return { error: e.name, message: e.message };
    }
    throw e;
  }
  throw new Error(`unknown call: ${String(call)}`);
}

export function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "sigdb-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
