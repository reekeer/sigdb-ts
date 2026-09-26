import { closeSync, openSync, readFileSync, readSync } from "node:fs";

import {
  type LoadOptions,
  MAX_HEADER_BYTES,
  type Metadata,
  buildContainer,
  loadDatabase,
  readSigdbMetadataBytes,
  validateContainer,
} from "../format/trie.ts";
import { writeFileEnsuringDir } from "../storage/fileio.ts";
import type { BuildResult, Database, ValidationResult } from "../types/models.ts";
import type { Rules } from "../types/rules.ts";

export type { LoadOptions, Metadata } from "../format/trie.ts";

export interface BuildSigdbOptions {
  rules: Rules;
  outputPath: string;
  metadata?: Metadata | null;
  zstdLevel?: number;
}

export interface BuildSigdbBytesOptions {
  rules: Rules;
  metadata?: Metadata | null;
  zstdLevel?: number;
}

export function buildSigdbBytes({ rules, metadata, zstdLevel = 19 }: BuildSigdbBytesOptions): Uint8Array {
  return buildContainer({ rules, metadata: metadata ?? null, zstdLevel }).bytes;
}

export function loadSigdbBytes(bytes: Uint8Array, options: LoadOptions = {}): Database {
  return loadDatabase(bytes, options);
}

export function buildSigdb({ rules, outputPath, metadata, zstdLevel = 19 }: BuildSigdbOptions): BuildResult {
  const built = buildContainer({ rules, metadata: metadata ?? null, zstdLevel });
  writeFileEnsuringDir(outputPath, built.bytes);
  return { outputPath, dataHashHex: built.dataHashHex, metadata: built.metadata };
}

export function loadSigdb(path: string, options: LoadOptions = {}): Database {
  return loadDatabase(readFileSync(path), options);
}

export function readSigdbMetadata(path: string): Record<string, unknown> {
  const fd = openSync(path, "r");
  try {
    const buf = new Uint8Array(4 + 1 + 4 + MAX_HEADER_BYTES);
    let len = 0;
    while (len < buf.length) {
      const n = readSync(fd, buf, len, buf.length - len, null);
      if (n === 0) {
        break;
      }
      len += n;
    }
    return readSigdbMetadataBytes(buf.subarray(0, len));
  } finally {
    closeSync(fd);
  }
}

export function validateSigdb(path: string, options: LoadOptions = {}): ValidationResult {
  return validateContainer(() => readFileSync(path), options);
}

export function validateSigdbBytes(bytes: Uint8Array, options: LoadOptions = {}): ValidationResult {
  return validateContainer(() => bytes, options);
}

export { readSigdbMetadataBytes };

export { type CompileSigdbJsonOptions, compileSigdbJson } from "./compiler.ts";
