import { FormatError } from "../types/exceptions.ts";
import type { GroupKind, GroupSpec, MatchMode } from "../types/models.ts";
import type { BuiltinGroupName } from "../types/rules.ts";
import { type Mapping, isMapping, isSequence, mappingEntries, mappingGet, mappingKeys } from "./mapping.ts";
import { repr } from "./repr.ts";
import { SPACE_CLASS, compareCodePoints, lower, strip } from "./text.ts";

export const BUILTIN_GROUPS: readonly BuiltinGroupName[] = Object.freeze([
  "headers",
  "js",
  "meta",
  "html",
  "script_src",
  "css",
  "url",
  "path",
  "file",
  "dns",
  "subdomain",
  "link",
  "json",
  "api",
  "tls",
  "server",
  "framework",
  "cms",
  "cdn",
] as const);

export const BUILTIN_MAP_GROUPS: ReadonlySet<string> = new Set(["headers", "meta"]);
export const RESERVED_RULE_KEYS: ReadonlySet<string> = new Set(["data"]);

const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const KINDS: readonly GroupKind[] = ["list", "map"];
const MODES: readonly MatchMode[] = ["prefix", "contains", "exact"];
const CONFIG_KEYS: ReadonlySet<string> = new Set(["kind", "match", "ignore_case", "trim"]);

const W = "\\p{L}\\p{N}_";
const S = SPACE_CLASS;
const B = `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))`;
const TAG_FIRST = "a-zA-Z\\u{130}\\u{131}\\u{17f}\\u{212a}";

const HTML_TAG_RE = new RegExp(`<[${S}]*([${TAG_FIRST}][${W}:\\-]*)${B}([^<>]*)>`, "gu");
const HTML_ATTR_RE = new RegExp(
  `([a-zA-Z_:][${W}:.\\-]*)(?:[${S}]*=[${S}]*(?:"([^"]*)"|'([^']*)'|([^${S}"'=<>\`]+)))?`,
  "gu",
);

export function checkName(name: unknown, what: string): string {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new FormatError(`invalid ${what} name: ${repr(name)}`);
  }
  return name;
}

export function builtinSpec(name: string): GroupSpec {
  return {
    name,
    kind: BUILTIN_MAP_GROUPS.has(name) ? "map" : "list",
    match: name === "headers" ? "contains" : "prefix",
    ignoreCase: true,
    trim: true,
  };
}

export function specToJson(spec: GroupSpec): Map<string, unknown> {
  return new Map<string, unknown>([
    ["kind", spec.kind],
    ["match", spec.match],
    ["ignore_case", spec.ignoreCase],
    ["trim", spec.trim],
  ]);
}

export function resolveGroups(config: unknown): Map<string, GroupSpec> {
  const specs = new Map<string, GroupSpec>(BUILTIN_GROUPS.map((name) => [name, builtinSpec(name)]));
  if (config === null || config === undefined) {
    return specs;
  }
  if (!isMapping(config)) {
    throw new FormatError("groups must be an object");
  }
  for (const [nameAny, cfgAny] of mappingEntries(config)) {
    const name = checkName(nameAny, "group");
    if (RESERVED_RULE_KEYS.has(name)) {
      throw new FormatError(`group name is reserved: ${name}`);
    }
    if (!isMapping(cfgAny)) {
      throw new FormatError(`group ${name} config must be an object`);
    }
    const cfgKeys = mappingKeys(cfgAny);
    const unknown = [...new Set(cfgKeys.filter((k) => typeof k !== "string" || !CONFIG_KEYS.has(k)))];
    if (unknown.length) {
      const sorted = (unknown as string[]).sort(compareCodePoints);
      throw new FormatError(`group ${name} has unknown config keys: ${repr(sorted)}`);
    }
    const base =
      specs.get(name) ?? { name, kind: "list", match: "exact", ignoreCase: false, trim: false };
    const merged = specToJson(base);
    for (const [k, v] of mappingEntries(cfgAny)) {
      merged.set(k as string, v);
    }
    specs.set(name, specFromJson(name, merged));
  }
  return specs;
}

export function specFromJson(name: string, raw: unknown): GroupSpec {
  if (!isMapping(raw)) {
    throw new FormatError(`group ${name} config must be an object`);
  }
  const kind = mappingGet(raw, "kind");
  const match = mappingGet(raw, "match");
  const ignoreCase = mappingGet(raw, "ignore_case");
  const trim = mappingGet(raw, "trim");
  if (!(KINDS as readonly unknown[]).includes(kind)) {
    throw new FormatError(`group ${name}: kind must be one of ${repr(KINDS)}`);
  }
  if (!(MODES as readonly unknown[]).includes(match)) {
    throw new FormatError(`group ${name}: match must be one of ${repr(MODES)}`);
  }
  if (typeof ignoreCase !== "boolean" || typeof trim !== "boolean") {
    throw new FormatError(`group ${name}: ignore_case and trim must be booleans`);
  }
  return { name, kind: kind as GroupKind, match: match as MatchMode, ignoreCase, trim };
}

export function normalize(spec: GroupSpec, value: string): string {
  if (spec.trim) {
    if (spec.kind === "map") {
      const i = value.indexOf(":");
      value = i === -1 ? strip(value) : `${strip(value.slice(0, i))}:${strip(value.slice(i + 1))}`;
    } else {
      value = strip(value);
    }
  }
  if (spec.ignoreCase) {
    value = lower(value);
  }
  return value;
}

export function formatMapValue(name: string, value: string): string {
  return `${name}:${value}`;
}

export function parseStringMap(value: unknown, group: string): Map<string, string> {
  if (value === null || value === undefined) {
    return new Map();
  }
  if (!isMapping(value)) {
    throw new FormatError(`${group} must be an object`);
  }
  const out = new Map<string, string>();
  for (const [k, v] of mappingEntries(value)) {
    if (typeof k !== "string" || typeof v !== "string") {
      throw new FormatError(`${group} keys/values must be strings`);
    }
    out.set(k, v);
  }
  return out;
}

export function parseStringList(value: unknown, group: string): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  if (isSequence(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (typeof item !== "string") {
        throw new FormatError(`${group} items must be strings`);
      }
      out.push(item);
    }
    return out;
  }
  throw new FormatError(`${group} must be a string or list of strings`);
}

export function parseHtmlList(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  if (isMapping(value)) {
    return [htmlSpecToValue(value)];
  }
  if (isSequence(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (typeof item === "string") {
        out.push(item);
      } else if (isMapping(item)) {
        out.push(htmlSpecToValue(item));
      } else {
        throw new FormatError("html items must be strings or objects");
      }
    }
    return out;
  }
  throw new FormatError("html must be a string, object, or list");
}

export function parseValues(spec: GroupSpec, value: unknown): string[] {
  if (spec.kind === "map") {
    return [...parseStringMap(value, spec.name)].map(([k, v]) => formatMapValue(k, v));
  }
  if (spec.name === "html") {
    return parseHtmlList(value);
  }
  return parseStringList(value, spec.name);
}

function htmlSpecToValue(spec: Mapping): string {
  const allowed = new Set(["tag", "attr", "value"]);
  for (const key of mappingKeys(spec)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new FormatError("html spec has invalid keys");
    }
  }

  const tag = mappingGet(spec, "tag");
  const attr = mappingGet(spec, "attr");
  const value = mappingGet(spec, "value");

  if (tag !== null && (typeof tag !== "string" || !tag)) {
    throw new FormatError("html tag must be a non-empty string");
  }
  if (attr !== null && (typeof attr !== "string" || !attr)) {
    throw new FormatError("html attr must be a non-empty string");
  }
  if (value !== null && typeof value !== "string") {
    throw new FormatError("html value must be a string");
  }
  if (value !== null && attr === null) {
    throw new FormatError("html value requires attr");
  }
  if (tag === null && attr === null && value === null) {
    throw new FormatError("html spec must include tag or attr");
  }

  const parts: string[] = [];
  if (tag !== null) {
    parts.push("tag", tag);
  }
  if (attr !== null) {
    parts.push("attr", attr);
  }
  if (value !== null) {
    parts.push("value", value);
  }
  return parts.join(":");
}

export function htmlHeads(html: string): string[] {
  const heads: string[] = [];
  const seen = new Set<string>();

  const add = (value: string): void => {
    if (!seen.has(value)) {
      seen.add(value);
      heads.push(value);
    }
  };

  for (const [tag, attrs] of iterHtmlTags(html)) {
    add(`tag:${tag}`);
    for (const [name, value] of attrs) {
      add(`tag:${tag}:attr:${name}`);
      if (value !== null) {
        add(`tag:${tag}:attr:${name}:value:${value}`);
      }
      add(`attr:${name}`);
      if (value !== null) {
        add(`attr:${name}:value:${value}`);
      }
    }
  }
  return heads;
}

function* iterHtmlTags(html: string): Generator<[string, [string, string | null][]]> {
  for (const match of html.matchAll(HTML_TAG_RE)) {
    const attrs: [string, string | null][] = [];
    for (const attr of (match[2] as string).matchAll(HTML_ATTR_RE)) {
      const raw = attr[2] || attr[3] || attr[4];
      attrs.push([attr[1] as string, raw ? strip(raw) : null]);
    }
    yield [match[1] as string, attrs];
  }
}
