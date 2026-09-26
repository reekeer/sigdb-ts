import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { compileSigdbJson, htmlHeads, loadSigdb, readSigdbMetadata } from "../src/index.ts";
import { FIXTURES_DIR, GOLDEN_DIR, goldenCases, loadVectors, runVector, withTempDir } from "./support.ts";

function headerBytes(file: Uint8Array): Uint8Array {
  const len = new DataView(file.buffer, file.byteOffset + 5, 4).getUint32(0, false);
  return file.subarray(9, 9 + len);
}

for (const caseName of goldenCases()) {
  const fixture = join(FIXTURES_DIR, `${caseName}.sigdb`);

  test(`reference file loads and matches: ${caseName}`, () => {
    const db = loadSigdb(fixture);
    loadVectors(caseName).forEach(({ input, expect }, i) => {
      assert.deepEqual(runVector(db, input), expect, `${caseName}[${i}]`);
    });
  });

  test(`build reproduces reference data hash: ${caseName}`, () => {
    const ref = readFileSync(fixture);
    const refHash = Buffer.from(ref.subarray(ref.length - 32)).toString("hex");
    withTempDir((dir) => {
      const out = join(dir, `${caseName}.sigdb`);
      const built = compileSigdbJson({
        jsonPath: join(GOLDEN_DIR, caseName, "rules.json"),
        outputPath: out,
        metadata: readSigdbMetadata(fixture),
      });
      assert.equal(built.dataHashHex, refHash);
      assert.deepEqual(headerBytes(readFileSync(out)), headerBytes(ref));
    });
  });
}

test("htmlHeads matches reference output", () => {
  const cases = JSON.parse(readFileSync(join(FIXTURES_DIR, "html_heads.json"), "utf8")) as {
    html: string;
    heads: string[];
  }[];
  assert.ok(cases.length > 0);
  for (const { html, heads } of cases) {
    assert.deepEqual(htmlHeads(html), heads, JSON.stringify(html));
  }
});
