import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { load } from "../src/index.ts";
import { htmlHeads } from "../src/internal/groups.ts";
import { repr } from "../src/internal/repr.ts";
import { FIXTURES_DIR, GOLDEN_DIR, goldenCases, loadVectors, readPlain, runVector } from "./support.ts";

for (const caseName of goldenCases()) {
  test(`reference file: ${caseName}`, () => {
    const db = load(join(FIXTURES_DIR, `${caseName}.sigdb`), { lazy: false });
    assert.deepEqual(db.sectionDigests(), readPlain(join(GOLDEN_DIR, caseName, "sections.json")));
    loadVectors(caseName).forEach(({ input, expect }, i) => {
      assert.deepEqual(runVector(db, input), expect, `${caseName}[${i}]`);
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

test("repr matches reference output", () => {
  const cases = JSON.parse(readFileSync(join(FIXTURES_DIR, "repr.json"), "utf8")) as {
    value?: string;
    list?: string[];
    repr: string;
  }[];
  for (const c of cases) {
    assert.equal(repr(c.value ?? c.list), c.repr, JSON.stringify(c));
  }
});
