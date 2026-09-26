export type GroupName =
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

export type GroupMapName = "headers" | "meta";

export type GroupListName =
  | "js"
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

export interface RuleDefinition {
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
}

export type Rules = Readonly<Record<string, RuleDefinition>> | ReadonlyMap<string, RuleDefinition>;
export type SearchDefinition = RuleDefinition;
