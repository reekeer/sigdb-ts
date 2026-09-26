import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { buildAutomaton, serializeAutomaton } from "../format/automaton.ts";
import { dumpJsonBytes, writeContainer } from "../format/container.ts";
import {
  RESERVED_RULE_KEYS,
  checkName,
  normalize,
  parseValues,
  resolveGroups,
  specToJson,
} from "../internal/groups.ts";
import { JsonDecodeError, parseJsonBytes } from "../internal/json.ts";
import { type Mapping, isMapping, isSequence, mappingEntries, mappingGet } from "../internal/mapping.ts";
import { repr } from "../internal/repr.ts";
import { compareCodePoints } from "../internal/text.ts";
import { FormatError } from "../types/exceptions.ts";
import type { BuildResult } from "../types/models.ts";
import type { GroupsConfig, IndexesConfig, RulesInput } from "../types/rules.ts";

export const DEFAULT_INDEX = "main";
export const FORMAT_NAME = "SIGDB";

export type Metadata = Readonly<Record<string, unknown>> | ReadonlyMap<string, unknown>;
export type SectionsInput = Readonly<Record<string, unknown>> | ReadonlyMap<string, unknown>;

export interface BuildOptions {
  groups?: GroupsConfig | null;
  indexes?: IndexesConfig | null;
  sections?: SectionsInput | null;
  metadata?: Metadata | null;
  timestamp?: number | null;
  zstdLevel?: number;
}

export type MergedRules = Map<string, Mapping>;

const encoder = new TextEncoder();

export function indexSection(index: string): string {
  return `index/${index}`;
}

export function automatonSection(index: string, group: string): string {
  return `automaton/${index}/${group}`;
}

export function mergeRules(rules: unknown): MergedRules {
  let parts: unknown[];
  if (isMapping(rules)) {
    parts = [rules];
  } else if (isSequence(rules)) {
    parts = [...rules];
  } else {
    throw new FormatError("rules must be a JSON object");
  }

  const merged: MergedRules = new Map();
  for (const part of parts) {
    if (!isMapping(part)) {
      throw new FormatError("rules must be a JSON object");
    }
    for (const [key, value] of mappingEntries(part)) {
      if (typeof key !== "string" || !key) {
        throw new FormatError("rule keys must be non-empty strings");
      }
      if (merged.has(key)) {
        throw new FormatError(`duplicate rule key: ${repr(key)}`);
      }
      if (!isMapping(value)) {
        throw new FormatError(`rule ${repr(key)} must be an object`);
      }
      merged.set(key, value);
    }
  }
  return merged;
}

export function compileIndex(name: string, rules: unknown, groups: unknown): [string, Uint8Array][] {
  const specs = resolveGroups(groups);
  const merged = mergeRules(rules);

  const items: unknown[][] = [];
  const patternIds = new Map<string, Map<string, number>>();
  const patterns: [string, string][] = [];
  const patternItems: number[][] = [];

  for (const [key, rule] of merged) {
    const itemId = items.length;
    const data = mappingGet(rule, "data");
    try {
      dumpJsonBytes(data);
    } catch (e) {
      if (e instanceof FormatError) {
        throw new FormatError(`rule ${repr(key)}: data is not serializable as JSON`, { cause: e });
      }
      throw e;
    }
    for (const [groupAny, raw] of mappingEntries(rule)) {
      const group = groupAny as string;
      if (RESERVED_RULE_KEYS.has(group)) {
        continue;
      }
      const spec = specs.get(group);
      if (spec === undefined) {
        throw new FormatError(`rule ${repr(key)}: unknown group: ${group}`);
      }
      for (const value of parseValues(spec, raw)) {
        const text = normalize(spec, value);
        if (!text) {
          throw new FormatError(`rule ${repr(key)}: empty pattern in group ${group}`);
        }
        if (spec.kind === "map" && text.startsWith(":")) {
          throw new FormatError(`rule ${repr(key)}: empty name in group ${group}`);
        }
        let byText = patternIds.get(group);
        if (byText === undefined) {
          byText = new Map();
          patternIds.set(group, byText);
        }
        let pid = byText.get(text);
        if (pid === undefined) {
          pid = patterns.length;
          byText.set(text, pid);
          patterns.push([group, text]);
          patternItems.push([]);
        }
        const ids = patternItems[pid] as number[];
        if (!ids.length || ids[ids.length - 1] !== itemId) {
          ids.push(itemId);
        }
      }
    }
    items.push([key, data]);
  }

  const payload = new Map<string, unknown>([
    ["groups", new Map([...specs].map(([g, spec]) => [g, specToJson(spec)]))],
    ["items", items],
    ["patterns", patterns],
    ["pattern_items", patternItems],
  ]);
  const sections: [string, Uint8Array][] = [[indexSection(name), dumpJsonBytes(payload)]];

  for (const [group, spec] of specs) {
    if (spec.match === "exact") {
      continue;
    }
    const entries: [Uint8Array, number][] = [];
    patterns.forEach(([g, text], pid) => {
      if (g === group) {
        entries.push([encoder.encode(text), pid]);
      }
    });
    if (entries.length) {
      sections.push([automatonSection(name, group), serializeAutomaton(buildAutomaton(entries))]);
    }
  }
  return sections;
}

function setProp(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function makeHeader(metadata: unknown, timestamp: unknown): Map<unknown, unknown> {
  if (metadata !== null && metadata !== undefined && !isMapping(metadata)) {
    throw new FormatError("metadata must be an object");
  }
  const header = new Map<unknown, unknown>(metadata ? mappingEntries(metadata as Mapping) : []);
  const setDefault = (key: string, value: unknown): void => {
    if (!header.has(key)) {
      header.set(key, value);
    }
  };
  setDefault("format", FORMAT_NAME);
  if (timestamp !== null && timestamp !== undefined) {
    if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new FormatError("timestamp must be a non-negative integer");
    }
    setDefault("created", timestamp);
    setDefault("build", new Date(timestamp * 1000).toISOString().slice(0, 10));
  }
  return header;
}

function isBytes(value: unknown): value is Uint8Array | ArrayBuffer | DataView {
  return value instanceof Uint8Array || value instanceof ArrayBuffer || value instanceof DataView;
}

function toBytes(value: Uint8Array | ArrayBuffer | DataView): Uint8Array {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function collectSections(
  rules: unknown,
  groups: unknown,
  indexes: unknown,
  sections: unknown,
): [string, Uint8Array][] {
  const specs = new Map<string, Mapping>();
  if (rules !== null && rules !== undefined) {
    specs.set(DEFAULT_INDEX, new Map<string, unknown>([["rules", rules], ["groups", groups ?? new Map()]]));
  } else if (groups !== null && groups !== undefined) {
    throw new FormatError("groups requires rules");
  }
  if (indexes !== null && indexes !== undefined) {
    if (!isMapping(indexes)) {
      throw new FormatError("indexes must be an object");
    }
    for (const [nameAny, spec] of mappingEntries(indexes)) {
      const name = checkName(nameAny, "index");
      if (specs.has(name)) {
        throw new FormatError(`duplicate index: ${name}`);
      }
      if (!isMapping(spec) || mappingGet(spec, "rules") === null) {
        throw new FormatError(`index ${name} must have rules`);
      }
      specs.set(name, spec);
    }
  }
  if (!specs.size) {
    throw new FormatError("at least one index is required");
  }

  const out: [string, Uint8Array][] = [];
  for (const [name, spec] of specs) {
    out.push(...compileIndex(name, mappingGet(spec, "rules"), mappingGet(spec, "groups")));
  }
  if (sections !== null && sections !== undefined) {
    if (!isMapping(sections)) {
      throw new FormatError("sections must be an object");
    }
    for (const [nameAny, value] of mappingEntries(sections)) {
      const name = checkName(nameAny, "section");
      if (isBytes(value)) {
        out.push([`blob/${name}`, toBytes(value)]);
      } else {
        out.push([`json/${name}`, dumpJsonBytes(value)]);
      }
    }
  }
  return out;
}

function buildInternal(
  rules: RulesInput | null | undefined,
  options: BuildOptions,
): [Uint8Array, Record<string, unknown>, Record<string, string>] {
  const header = makeHeader(options.metadata, options.timestamp);
  const collected = collectSections(rules, options.groups, options.indexes, options.sections);
  const [data, hashes] = writeContainer(header, collected, options.zstdLevel ?? 19);
  const plain: Record<string, unknown> = {};
  for (const [k, v] of header) {
    setProp(plain, String(k), v);
  }
  return [data, plain, hashes];
}

export function buildBytes(rules?: RulesInput | null, options: BuildOptions = {}): Uint8Array {
  return buildInternal(rules, options)[0];
}

export function build(
  rules: RulesInput | null | undefined,
  outputPath: string | null | undefined,
  options: BuildOptions = {},
): BuildResult {
  if (outputPath === null || outputPath === undefined) {
    throw new FormatError("output_path is required");
  }
  const [data, header, hashes] = buildInternal(rules, options);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, data);
  return { outputPath, size: data.length, metadata: header, sections: hashes };
}

export function displayPath(path: string): string {
  const absolute = path.startsWith("/");
  const parts = path.split("/").filter((p) => p !== "" && p !== ".");
  const joined = parts.join("/");
  return absolute ? `/${joined}` : joined || ".";
}

function statOf(path: string): ReturnType<typeof statSync> | undefined {
  return statSync(path, { throwIfNoEntry: false });
}

function readJsonRules(path: string): unknown {
  let bytes: Uint8Array;
  bytes = readFileSync(path);
  try {
    return parseJsonBytes(bytes, "map");
  } catch (e) {
    if (e instanceof JsonDecodeError) {
      throw new FormatError(`invalid rules json: ${displayPath(path)}`, { cause: e });
    }
    throw e;
  }
}

function listJsonFiles(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(rel ? `${root}/${rel}` : root, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    const full = `${root}/${relPath}`;
    const st = statOf(full);
    if (st?.isDirectory()) {
      if (!entry.isSymbolicLink()) {
        out.push(...listJsonFiles(root, relPath));
      }
    } else if (st?.isFile() && entry.name.endsWith(".json")) {
      out.push(relPath);
    }
  }
  return out;
}

export function readRules(path: string): MergedRules {
  const st = statOf(path);
  if (st?.isFile()) {
    return mergeRules(readJsonRules(path));
  }
  if (!st?.isDirectory()) {
    throw new FormatError(`rules path not found: ${displayPath(path)}`);
  }

  const merged: MergedRules = new Map();
  const origin = new Map<string, string>();
  const files = listJsonFiles(path).sort(compareCodePoints);
  for (const rel of files) {
    for (const [key, value] of mergeRules(readJsonRules(`${path}/${rel}`))) {
      const seen = origin.get(key);
      if (seen !== undefined) {
        throw new FormatError(`duplicate rule key ${repr(key)} in ${seen} and ${rel}`);
      }
      merged.set(key, value);
      origin.set(key, rel);
    }
  }
  return merged;
}

export function compileJson(jsonPath: string, outputPath: string, options: BuildOptions = {}): BuildResult {
  if (!statOf(jsonPath)?.isFile()) {
    throw new FormatError(`rules file not found: ${displayPath(jsonPath)}`);
  }
  return build(readRules(jsonPath), outputPath, options);
}

export function compileDir(dirPath: string, outputPath: string, options: BuildOptions = {}): BuildResult {
  if (!statOf(dirPath)?.isDirectory()) {
    throw new FormatError(`rules directory not found: ${displayPath(dirPath)}`);
  }
  return build(readRules(dirPath), outputPath, options);
}
