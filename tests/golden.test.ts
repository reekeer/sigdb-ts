import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { BaseError, buildBytes, loadBytes } from "../src/index.ts";
import {
  EXTRA_DIR,
  GOLDEN_DIR,
  caseBuildArgs,
  goldenCases,
  loadVectors,
  readOrdered,
  readPlain,
  runVector,
  toBuildArgs,
} from "./support.ts";

test("golden cases exist", () => {
  assert.ok(goldenCases().length > 0);
});

for (const [label, dir] of [["golden", GOLDEN_DIR], ["golden-extra", EXTRA_DIR]] as const) {
  for (const caseName of goldenCases(dir)) {
    test(`${label}: ${caseName}`, () => {
      const first = caseBuildArgs(caseName, dir);
      const data = buildBytes(first.rules, first.options);
      const second = caseBuildArgs(caseName, dir);
      assert.deepEqual(buildBytes(second.rules, second.options), data, "build is reproducible");

      const db = loadBytes(data);
      assert.deepEqual(db.sectionDigests(), readPlain(join(dir, caseName, "sections.json")));

      loadVectors(caseName, dir).forEach(({ input, expect }, i) => {
        assert.deepEqual(runVector(db, input), expect, `${caseName}[${i}] ${JSON.stringify(Object.fromEntries(input))}`);
      });
    });
  }
}

test("golden: build errors", () => {
  const path = join(GOLDEN_DIR, "build_errors.json");
  const ordered = readOrdered(path) as Map<string, unknown>[];
  const expected = readPlain(path) as { expect: unknown }[];
  ordered.forEach((c, i) => {
    const args = toBuildArgs(c.get("build") as Map<string, unknown>);
    let actual: unknown = null;
    try {
      buildBytes(args.rules, args.options);
    } catch (e) {
      if (!(e instanceof BaseError)) {
        throw e;
      }
      actual = { error: e.name, message: e.message };
    }
    assert.deepEqual(actual, expected[i]?.expect, `build_errors[${i}]`);
  });
});
