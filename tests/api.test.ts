import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  Database,
  FormatError,
  Reader,
  build,
  buildBytes,
  compileDir,
  compileJson,
  load,
  loadBytes,
  readMetadata,
  readRules,
  validate,
} from "../src/index.ts";
import { compileIndex } from "../src/core/compiler.ts";
import { deserializeAutomaton } from "../src/format/automaton.ts";
import { dumpJsonBytes, writeContainer } from "../src/format/container.ts";
import { withTempDir } from "./support.ts";

const RULES = {
  "react@18/index.js": {
    data: { package: "react", entry: true },
    features: ["P:useState", "K:setState"],
  },
  "zustand@4/index.js": { data: { package: "zustand" }, features: ["P:useState"] },
  nginx: { headers: { Server: "nginx" } },
};
const GROUPS = { features: {} };

function throwsFormat(fn: () => unknown, text: string): void {
  assert.throws(fn, (e) => e instanceof FormatError && e.message.includes(text), text);
}

test("build, load, read", () => {
  withTempDir((tmp) => {
    const out = join(tmp, "a.sigdb");
    const result = build(RULES, out, { groups: GROUPS, metadata: { dataset: "x" } });
    assert.equal(result.size, statSync(out).size);
    assert.deepEqual(result.metadata, { dataset: "x", format: "SIGDB" });
    assert.deepEqual(readMetadata(out), result.metadata);
    assert.deepEqual(Object.keys(result.sections).sort(), Object.keys(load(out).sectionDigests()).sort());

    const first = readFileSync(out);
    build(RULES, out, { groups: GROUPS, metadata: { dataset: "x" } });
    assert.deepEqual(readFileSync(out), first, "rebuild is byte-identical");

    const meta = loadBytes(buildBytes(RULES, { groups: GROUPS, timestamp: 86_400 })).metadata;
    assert.deepEqual([meta["created"], meta["build"]], [86_400, "1970-01-02"]);
    assert.throws(() => buildBytes(RULES, { groups: GROUPS, timestamp: -1 }), FormatError);
    assert.throws(() => buildBytes(RULES, { groups: GROUPS, timestamp: 1.5 }), FormatError);

    const v = validate(out);
    assert.ok(v.ok, v.errors.join(", "));
    assert.deepEqual(v.sections, result.sections);

    const reader = new Reader(out);
    assert.deepEqual([...reader.matchTokens("features", ["P:useState"])], [[0, 1], [1, 1]]);
    assert.equal(reader.database(), reader.database());
    assert.equal(reader.item("nginx"), reader.index().items[2]);
    assert.equal(reader.path, out);
    assert.deepEqual(reader.metadata(), result.metadata);
    assert.ok(reader.validate().ok);

    const eager = load(out, { lazy: false });
    assert.equal(eager.match("Server: nginx").itemId, 2);

    const db = load(out);
    const clone = Database.fromRaw(db.metadata, db.rawSections());
    assert.deepEqual([...clone.matchTokens("features", ["K:setState"])], [[0, 1]]);
    assert.deepEqual(clone.sectionDigests(), db.sectionDigests());
    assert.deepEqual(db.item("react@18/index.js")?.data, { package: "react", entry: true });
  });
});

test("rules directories", () => {
  withTempDir((tmp) => {
    const rulesDir = join(tmp, "rules");
    mkdirSync(join(rulesDir, "b"), { recursive: true });
    writeFileSync(join(rulesDir, "a.json"), JSON.stringify({ x: { js: "x" } }));
    writeFileSync(join(rulesDir, "b", "c.json"), JSON.stringify({ y: { js: "y" } }));
    writeFileSync(join(rulesDir, "b", "ignored.txt"), "{");
    assert.deepEqual([...readRules(rulesDir).keys()], ["x", "y"]);
    const compiled = compileDir(rulesDir, join(tmp, "dir.sigdb"), { timestamp: 0 });
    assert.equal(compiled.metadata["build"], "1970-01-01");
    assert.deepEqual(load(join(tmp, "dir.sigdb")).items.map((i) => i.key), ["x", "y"]);
    compileJson(join(rulesDir, "a.json"), join(tmp, "file.sigdb"));
    throwsFormat(() => compileJson(rulesDir, join(tmp, "x.sigdb")), "not found");
    throwsFormat(() => compileDir(join(rulesDir, "a.json"), join(tmp, "x.sigdb")), "not found");
    throwsFormat(() => readRules(join(tmp, "missing")), "rules path not found");

    writeFileSync(join(rulesDir, "b", "dup.json"), JSON.stringify({ x: {} }));
    throwsFormat(() => readRules(rulesDir), "duplicate rule key 'x' in a.json and b/dup.json");
    writeFileSync(join(rulesDir, "b", "dup.json"), "{");
    throwsFormat(() => readRules(rulesDir), "invalid rules json");
  });
});

test("sort of rule files uses code points", () => {
  withTempDir((tmp) => {
    writeFileSync(join(tmp, "\u{ff21}.json"), JSON.stringify({ bmp: {} }));
    writeFileSync(join(tmp, "\u{1f600}.json"), JSON.stringify({ astral: {} }));
    writeFileSync(join(tmp, "Z.json"), JSON.stringify({ ascii: {} }));
    assert.deepEqual([...readRules(tmp).keys()], ["ascii", "bmp", "astral"]);
  });
});

test("unserializable data", () => {
  throwsFormat(() => buildBytes({ a: { data: Number.NaN } }), "rule 'a': data is not serializable as JSON");
  throwsFormat(() => buildBytes({ a: { data: { x: new Date(0) } } }), "data is not serializable");
  throwsFormat(() => buildBytes({ a: { data: "\u{d800}" } }), "data is not serializable");
  throwsFormat(() => build(RULES, undefined), "output_path is required");
  throwsFormat(
    () => buildBytes({}, { sections: { s: Number.POSITIVE_INFINITY } }),
    "value is not serializable as JSON: Out of range float values are not JSON compliant",
  );
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  throwsFormat(() => buildBytes({}, { metadata: { a: cyclic } }), "value is not serializable as JSON: Circular reference detected");
  throwsFormat(
    () => buildBytes({ a: { js: "x\u{d800}" } }),
    "value is not serializable as JSON: 'utf-8' codec can't encode character '\\ud800' in position",
  );
  throwsFormat(() => buildBytes({}, { metadata: [] as never }), "metadata must be an object");
});

test("automaton and index payload validation", () => {
  const sections = new Map(compileIndex("main", { a: { js: "abc" } }, null));
  const automaton = sections.get("automaton/main/js") as Uint8Array;
  throwsFormat(() => deserializeAutomaton(automaton, 0), "unknown pattern");
  throwsFormat(() => deserializeAutomaton(Uint8Array.of(0xff, 0xff, 0xff, 0x01, 0x00, 0x00), 1), "exceed");

  const payload = JSON.parse(Buffer.from(sections.get("index/main") as Uint8Array).toString("utf8")) as Record<string, unknown>;
  const mutations: [(p: Record<string, any>) => void, string][] = [
    [(p) => (p["pattern_items"] = [[5]]), "unknown item"],
    [(p) => (p["pattern_items"] = [[]]), "non-empty array"],
    [(p) => (p["patterns"] = [["nope", "x"]]), "unknown group"],
    [(p) => (p["items"] = [["a"]]), "[key, data]"],
    [(p) => (p["groups"]["js"]["match"] = "regex"), "match must be"],
  ];
  for (const [mutate, text] of mutations) {
    const bad = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    mutate(bad);
    const [data] = writeContainer({}, [["index/main", dumpJsonBytes(bad)]], 1);
    throwsFormat(() => loadBytes(data).index(), text);
  }

  withTempDir((tmp) => {
    const [stray] = writeContainer(
      {},
      [
        ["index/main", sections.get("index/main") as Uint8Array],
        ["automaton/other/js", automaton],
      ],
      1,
    );
    writeFileSync(join(tmp, "stray.sigdb"), stray);
    const v = validate(join(tmp, "stray.sigdb"));
    assert.ok(!v.ok && (v.errors[0] ?? "").includes("unknown index"), v.errors.join(", "));
  });

  const [unknown] = writeContainer({}, [["weird/x", new Uint8Array()]], 1);
  throwsFormat(() => loadBytes(unknown), "unknown section");
});

test("looping fail links are rejected", () => {
  const bytes = [2, 1, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0x61, 1];
  throwsFormat(() => deserializeAutomaton(Uint8Array.from(bytes), 1), "fail links do not terminate");
});

test("index API", () => {
  const db = loadBytes(
    buildBytes(
      new Map<string, Record<string, unknown>>([
        ["10", { features: ["a", "b"], data: new Map([["10", 1], ["2", 2]]) }],
        ["2", { features: ["b"], strings: "needle" }],
      ]),
      { groups: { features: {}, strings: { match: "contains" } }, sections: { blob: Uint8Array.of(1, 2), meta: { k: [1, 0.5] } } },
    ),
  );
  const index = db.index();
  assert.deepEqual(db.indexNames, ["main"]);
  assert.deepEqual(db.sectionNames, ["blob", "meta"]);
  assert.deepEqual(db.section("blob"), Uint8Array.of(1, 2));
  assert.deepEqual(db.section("meta"), { k: [1, 0.5] });
  assert.deepEqual(db.items.map((i) => i.key), ["10", "2"]);
  assert.equal(index.patternTotal, 3);
  assert.deepEqual(index.pattern(1), { id: 1, group: "features", text: "b", itemIds: [0, 1] });
  assert.equal(index.itemId("2"), 1);
  assert.equal(index.patternCount(0), 2);
  assert.equal(index.patternCount(-1), 2);
  assert.equal(index.patternCount(1, "strings"), 1);
  assert.equal(index.spec("strings").match, "contains");
  assert.throws(() => index.spec("nope"), FormatError);
  assert.deepEqual(index.hitsFor([1, 0, 1]).map((h) => [h.itemId, h.hits]), [[0, 2], [1, 1]]);
  assert.throws(() => index.hitsFor([9]), (e) => e instanceof FormatError && e.message === "unknown pattern id: 9");
  assert.deepEqual(index.scan("xx NEEDLE", "strings"), []);
  assert.deepEqual(index.scan("xx needle", "strings"), [{ patternId: 2, start: 3, end: 9 }]);
  assert.deepEqual(db.matchAll("features", new Set(["a", "b"])).map((h) => h.itemId), [0, 1]);
  assert.throws(() => db.matchTokens("features", "a"), FormatError);
  assert.throws(() => db.matchAll("features", 5 as never), FormatError);
  index.preload();
});
