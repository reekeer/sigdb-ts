import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { compileSigdbJson, loadSigdb } from "../src/index.ts";
import { GOLDEN_DIR, goldenCases, loadVectors, ruleKeys, runVector, withTempDir } from "./support.ts";

test("golden cases exist", () => {
  assert.ok(goldenCases().length > 0);
});

for (const caseName of goldenCases()) {
  test(`golden: ${caseName}`, () => {
    withTempDir((dir) => {
      const out = join(dir, `${caseName}.sigdb`);
      compileSigdbJson({ jsonPath: join(GOLDEN_DIR, caseName, "rules.json"), outputPath: out });
      const db = loadSigdb(out);

      assert.deepEqual(
        db.items.map((item) => item.key),
        ruleKeys(caseName),
        "item ids follow rule definition order",
      );

      loadVectors(caseName).forEach(({ input, expect }, i) => {
        assert.deepEqual(runVector(db, input), expect, `${caseName}[${i}] ${JSON.stringify(Object.fromEntries(input))}`);
      });
    });
  });
}
