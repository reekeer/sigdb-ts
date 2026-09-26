import type { GroupKind, MatchMode } from "./models.ts";

export type BuiltinGroupName =
  | "headers"
  | "js"
  | "meta"
  | "html"
  | "script_src"
  | "css"
  | "url"
  | "path"
  | "file"
  | "dns"
  | "subdomain"
  | "link"
  | "json"
  | "api"
  | "tls"
  | "server"
  | "framework"
  | "cms"
  | "cdn";

export type StringList = readonly string[] | string;
export type StringMap = Readonly<Record<string, string>> | ReadonlyMap<string, string>;

export interface HtmlSpec {
  tag?: string;
  attr?: string;
  value?: string;
}

export type HtmlPattern = HtmlSpec | string;
export type HtmlList = readonly HtmlPattern[] | HtmlPattern;

export interface GroupConfig {
  kind?: GroupKind;
  match?: MatchMode;
  ignore_case?: boolean;
  trim?: boolean;
}

export type GroupsConfig = Readonly<Record<string, GroupConfig>> | ReadonlyMap<string, GroupConfig>;

export interface RuleDefinition {
  data?: unknown;
  headers?: StringMap;
  js?: StringList;
  meta?: StringMap;
  html?: HtmlList;
  script_src?: StringList;
  css?: StringList;
  url?: StringList;
  path?: StringList;
  file?: StringList;
  dns?: StringList;
  subdomain?: StringList;
  link?: StringList;
  json?: StringList;
  api?: StringList;
  tls?: StringList;
  server?: StringList;
  framework?: StringList;
  cms?: StringList;
  cdn?: StringList;
  [group: string]: unknown;
}

export type Rules = Readonly<Record<string, RuleDefinition>> | ReadonlyMap<string, RuleDefinition | ReadonlyMap<string, unknown>>;
export type RulesInput = Rules | readonly Rules[];
export type SearchDefinition = Readonly<Record<string, unknown>> | ReadonlyMap<string, unknown>;

export interface IndexSpec {
  rules: RulesInput;
  groups?: GroupsConfig | null;
}

export type IndexesConfig = Readonly<Record<string, IndexSpec>> | ReadonlyMap<string, IndexSpec>;
