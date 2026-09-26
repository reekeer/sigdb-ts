export {
  type BuildOptions,
  DEFAULT_INDEX,
  type Metadata,
  type SectionsInput,
  build,
  buildBytes,
  compileDir,
  compileJson,
  readRules,
} from "./core/compiler.ts";
export {
  Database,
  type LoadOptions,
  type RawSections,
  load,
  loadBytes,
  readMetadata,
  readMetadataBytes,
  validate,
  validateBytes,
} from "./core/database.ts";
export { Index, type MatchGroupOptions, type MatchValues } from "./core/index.ts";
export { Reader, type ReaderOptions } from "./core/reader.ts";
export { BaseError, FormatError, IntegrityError } from "./types/exceptions.ts";
export {
  Automaton,
  type BuildResult,
  type DecodeResult,
  type GroupKind,
  type GroupSpec,
  type Hit,
  type Item,
  type MatchMode,
  type MatchResult,
  type Occurrence,
  type Pattern,
  type ValidationResult,
} from "./types/models.ts";
export type {
  BuiltinGroupName,
  GroupConfig,
  GroupsConfig,
  HtmlList,
  HtmlPattern,
  HtmlSpec,
  IndexSpec,
  IndexesConfig,
  RuleDefinition,
  Rules,
  RulesInput,
  SearchDefinition,
  StringList,
  StringMap,
} from "./types/rules.ts";
export { BUILTIN_GROUPS } from "./internal/groups.ts";
