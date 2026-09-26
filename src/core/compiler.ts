import { readFileSync } from "node:fs";

import { type Metadata, buildContainer } from "../format/trie.ts";
import { JsonDecodeError, parseJsonBytes } from "../internal/json.ts";
import { writeFileEnsuringDir } from "../storage/fileio.ts";
import { FormatError } from "../types/exceptions.ts";
import type { BuildResult } from "../types/models.ts";
import type { Rules } from "../types/rules.ts";

export interface CompileSigdbJsonOptions {
  jsonPath: string;
  outputPath: string;
  metadata?: Metadata | null;
  zstdLevel?: number;
}

export function compileSigdbJson({
  jsonPath,
  outputPath,
  metadata,
  zstdLevel = 19,
}: CompileSigdbJsonOptions): BuildResult {
  let rulesAny: unknown;
  try {
    rulesAny = parseJsonBytes(readFileSync(jsonPath), "map");
  } catch (e) {
    if (e instanceof JsonDecodeError) {
      throw new FormatError("invalid rules json", { cause: e });
    }
    throw e;
  }

  const built = buildContainer({ rules: rulesAny as Rules, metadata: metadata ?? null, zstdLevel });
  writeFileEnsuringDir(outputPath, built.bytes);
  return { outputPath, dataHashHex: built.dataHashHex, metadata: built.metadata };
}
