import assert from "node:assert/strict";
import { test } from "node:test";

import { compressZstd, decompressZstd, frameContentSize, quietly } from "../src/compression/zstd.ts";
import { FormatError } from "../src/index.ts";

test("zstd roundtrip keeps content size in the frame", () => {
  for (const size of [0, 1, 255, 256, 300, 70_000]) {
    const raw = new Uint8Array(size).map((_, i) => i % 7);
    const frame = compressZstd(raw);
    assert.equal(frameContentSize(frame), size);
    assert.deepEqual(decompressZstd(frame, size), raw);
    assert.equal(decompressZstd(frame, size).byteOffset, 0);
  }
  assert.throws(() => decompressZstd(compressZstd(new Uint8Array(10)), 11), FormatError);
  assert.throws(() => frameContentSize(Uint8Array.of(1, 2, 3)), FormatError);
});

test("only the zstd ExperimentalWarning is suppressed, and only during the call", () => {
  const original = process.emitWarning;
  const seen: string[] = [];
  process.emitWarning = ((warning: string | Error, type?: string) => {
    seen.push(`${type ?? ""}:${String(warning)}`);
  }) as typeof process.emitWarning;
  try {
    const patched = process.emitWarning;
    quietly(() => {
      process.emitWarning("zstd is an experimental feature", "ExperimentalWarning");
      const err = new Error("zstd experimental");
      err.name = "ExperimentalWarning";
      process.emitWarning(err);
      process.emitWarning("fetch is experimental", "ExperimentalWarning");
      process.emitWarning("zstd deprecated", "DeprecationWarning");
    });
    compressZstd(Uint8Array.of(1, 2, 3));
    assert.equal(process.emitWarning, patched);
    process.emitWarning("zstd is experimental", "ExperimentalWarning");
    process.emitWarning("something else", "Warning");
    assert.deepEqual(seen, [
      "ExperimentalWarning:fetch is experimental",
      "DeprecationWarning:zstd deprecated",
      "ExperimentalWarning:zstd is experimental",
      "Warning:something else",
    ]);
  } finally {
    process.emitWarning = original;
  }
});
