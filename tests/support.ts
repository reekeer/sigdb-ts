import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BaseError,
  type Database,
  type GroupName,
  type MatchResult,
  Matcher,
  type SearchDefinition,
} from "../src/index.ts";
import { parseJsonBytes } from "../src/internal/json.ts";

export const TESTS_DIR = import.meta.dirname;
export const GOLDEN_DIR = join(TESTS_DIR, "golden");
export const FIXTURES_DIR = join(TESTS_DIR, "fixtures");

export function goldenCases(): string[] {
  return readdirSync(GOLDEN_DIR)
    .filter((name) => statSync(join(GOLDEN_DIR, name, "rules.json"), { throwIfNoEntry: false })?.isFile())
    .sort();
}

export interface Vector {
  input: Map<string, unknown>;
  expect: unknown;
}

export function loadVectors(caseName: string): Vector[] {
  const raw = readFileSync(join(GOLDEN_DIR, caseName, "vectors.json"));
  const ordered = parseJsonBytes(raw, "map") as Map<string, unknown>[];
  const plain = JSON.parse(raw.toString("utf8")) as { expect: unknown }[];
  return ordered.map((input, i) => ({ input, expect: plain[i]?.expect }));
}

export function ruleKeys(caseName: string): string[] {
  const rules = parseJsonBytes(readFileSync(join(GOLDEN_DIR, caseName, "rules.json")), "map");
  return [...(rules as Map<string, unknown>).keys()];
}

function allIds(db: Database, head: string): number[] {
  const a = db.automaton;
  const seen: number[] = [];
  let state = 0;
  for (const b of new TextEncoder().encode(head)) {
    while (true) {
      const nxt = a.transition(state, b);
      if (nxt !== -1) {
        state = nxt;
        break;
      }
      if (state === 0) {
        break;
      }
      state = a.fail[state] as number;
    }
    const start = a.outStart[state] as number;
    for (const id of a.outputs.subarray(start, start + (a.outCount[state] as number))) {
      if (!seen.includes(id)) {
        seen.push(id);
      }
    }
  }
  return seen;
}

function result(db: Database, r: MatchResult, withAllIds: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {
    result: r.result,
    item_id: r.itemId,
    key: r.item !== null ? r.item.key : null,
    head: r.head,
  };
  if (withAllIds) {
    out["all_ids"] = allIds(db, r.head);
  }
  return out;
}

export function runVector(db: Database, v: Map<string, unknown>): Record<string, unknown> {
  const m = new Matcher(db);
  const call = v.get("call");
  try {
    switch (call) {
      case "match":
        return result(db, m.match(v.get("head") as string), true);
      case "match_group": {
        const r = m.matchGroup(v.get("group") as GroupName, v.get("value") as string, {
          name: (v.get("name") as string | undefined) ?? null,
        });
        return result(db, r, true);
      }
      case "match_html":
        return result(db, m.matchHtml(v.get("html") as string), false);
      case "match_search":
        return result(db, m.matchSearch(v.get("search") as SearchDefinition), false);
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
