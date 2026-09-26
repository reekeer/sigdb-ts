import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { TESTS_DIR, withTempDir } from "./support.ts";

test("README usage example", () => {
  const readme = readFileSync(join(TESTS_DIR, "..", "README.md"), "utf8");
  const blocks = [...readme.matchAll(/```(\w*)\n([\s\S]*?)```/g)];
  const usage = blocks.findIndex(([, lang]) => lang === "ts");
  assert.notEqual(usage, -1);
  const code = (blocks[usage]?.[2] ?? "").replace(
    '"@reekeer/sigdb"',
    JSON.stringify(pathToFileURL(join(TESTS_DIR, "..", "src", "index.ts")).href),
  );
  const expected = blocks[usage + 1]?.[2] ?? "";

  withTempDir((dir) => {
    const file = join(dir, "example.ts");
    writeFileSync(file, code);
    const out = execFileSync(process.execPath, [file], { cwd: dir, encoding: "utf8" });
    assert.equal(out, expected);
  });
});
