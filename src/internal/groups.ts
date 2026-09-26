import { FormatError } from "../types/exceptions.ts";
import type { GroupMapName, GroupName } from "../types/rules.ts";
import { type Mapping, isMapping, isSequence, mappingEntries, mappingGet, mappingKeys } from "./mapping.ts";
import { SPACE_CLASS, strip } from "./text.ts";

export const SIGDB_GROUPS: readonly GroupName[] = Object.freeze([
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

export const SIGDB_GROUPS_MAP: ReadonlySet<string> = new Set<GroupMapName>(["headers", "meta"]);

const W = "\\p{L}\\p{N}_";
const S = SPACE_CLASS;
const B = `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))`;
const TAG_FIRST = "a-zA-Z\\u{130}\\u{131}\\u{17f}\\u{212a}";

const HTML_TAG_RE = new RegExp(`<[${S}]*([${TAG_FIRST}][${W}:\\-]*)${B}([^<>]*)>`, "gu");
const HTML_ATTR_RE = new RegExp(
  `([a-zA-Z_:][${W}:.\\-]*)(?:[${S}]*=[${S}]*(?:"([^"]*)"|'([^']*)'|([^${S}"'=<>\`]+)))?`,
  "gu",
);

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

export function parseGroupList(value: unknown, group: string): string[] {
  if (group === "html") {
    return parseHtmlList(value);
  }
  return parseStringList(value, group);
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
        continue;
      }
      if (isMapping(item)) {
        out.push(htmlSpecToValue(item));
        continue;
      }
      throw new FormatError("html items must be strings or objects");
    }
    return out;
  }
  throw new FormatError("html must be a string, object, or list");
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
    if (seen.has(value)) {
      return;
    }
    seen.add(value);
    heads.push(value);
  };

  for (const [tag, attrs] of iterHtmlTags(html)) {
    add(formatListPattern("html", `tag:${tag}`));
    for (const [name, value] of attrs) {
      add(formatListPattern("html", `tag:${tag}:attr:${name}`));
      if (value !== null) {
        add(formatListPattern("html", `tag:${tag}:attr:${name}:value:${value}`));
      }
      add(formatListPattern("html", `attr:${name}`));
      if (value !== null) {
        add(formatListPattern("html", `attr:${name}:value:${value}`));
      }
    }
  }
  return heads;
}

function* iterHtmlTags(html: string): Generator<[string, [string, string | null][]]> {
  for (const match of html.matchAll(HTML_TAG_RE)) {
    const tag = match[1] as string;
    const attrsRaw = match[2] as string;
    const attrs: [string, string | null][] = [];
    for (const attr of attrsRaw.matchAll(HTML_ATTR_RE)) {
      const name = attr[1] as string;
      const raw = attr[2] || attr[3] || attr[4];
      attrs.push([name, raw ? strip(raw) : null]);
    }
    yield [tag, attrs];
  }
}

export function formatMapPattern(group: string, key: string, value: string): string {
  const keyS = strip(key);
  const valueS = strip(value);
  if (group === "headers") {
    return `${keyS}:${valueS}`;
  }
  return `${group}:${keyS}:${valueS}`;
}

export function formatListPattern(group: string, value: string): string {
  return `${group}:${strip(value)}`;
}
