import assert from "node:assert/strict";
import { zstdCompressSync } from "node:zlib";
import { test } from "node:test";

import {
  Automaton,
  BaseError,
  FormatError,
  IntegrityError,
  buildSigdbBytes,
  encodeVarint,
  loadSigdbBytes,
  match,
  matchGroup,
  matchHtml,
  matchSearch,
  sha256,
  validateSigdbBytes,
} from "../src/index.ts";

function container(itemsRaw: Uint8Array, autoRaw: Uint8Array): Uint8Array {
  const header = Buffer.from("{}");
  const items = zstdCompressSync(itemsRaw);
  const auto = zstdCompressSync(autoRaw);
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  return Buffer.concat([
    Buffer.from("SIGT\x02"),
    u32(header.length),
    header,
    u32(items.length),
    items,
    u32(auto.length),
    auto,
    sha256(Buffer.concat([itemsRaw, autoRaw])),
  ]);
}

function varints(...values: number[]): Uint8Array {
  return Buffer.concat(values.map((v) => encodeVarint(v)));
}

test("error classes", () => {
  const f = new FormatError("x");
  assert.ok(f instanceof BaseError && f instanceof Error);
  assert.equal(f.name, "FormatError");
  assert.equal(new IntegrityError("y").name, "IntegrityError");
  assert.equal(new BaseError("z").name, "BaseError");
});

test("container layout", () => {
  const bytes = buildSigdbBytes({ rules: { nginx: { headers: { Server: "nginx" } } }, metadata: { created: 0 } });
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString("latin1"), "SIGT\x02");
  const db = loadSigdbBytes(bytes);
  assert.equal(db.items.length, 1);
  assert.ok(db.automaton instanceof Automaton);
  assert.equal(match("Server: nginx/1.25", db).item?.key, "nginx");
});

test("items block errors", () => {
  const auto = varints(1, 0, 0, 0, 0, 0, 0, 0);
  const load = (items: string) => () => loadSigdbBytes(container(Buffer.from(items), auto));
  assert.throws(load("nope"), (e) => e instanceof FormatError && e.message === "invalid items json");
  assert.throws(load("{}"), (e) => e instanceof FormatError && e.message === "items block must be a JSON array");
  assert.throws(load("[1]"), (e) => e instanceof FormatError && e.message === "item must be [key, headers]");
  assert.throws(load('[["a"]]'), (e) => e instanceof FormatError && e.message === "item must be [key, headers]");
  assert.throws(load('[["",{}]]'), (e) => e instanceof FormatError && e.message === "item key must be a non-empty string");
  assert.throws(load('[["a",{"b":1}]]'), (e) => e instanceof FormatError && e.message === "headers keys/values must be strings");
  assert.equal(loadSigdbBytes(container(Buffer.from('[["a",null]]'), auto)).items[0]?.headers.size, 0);
});

test("automaton block errors", () => {
  const items = Buffer.from("[]");
  const load = (auto: Uint8Array) => () => loadSigdbBytes(container(items, auto));
  assert.throws(load(varints(1, 0, 0, 0, 0, 0, 0, 0, 7)), (e) => e instanceof FormatError && e.message === "automaton block has trailing bytes");
  assert.throws(load(varints(1, 0, 0, 0, 0, 0)), (e) => e instanceof FormatError && e.message === "truncated varint");
  assert.throws(load(varints(1_000_000, 0, 0)), (e) => e instanceof FormatError && e.message === "truncated varint");
  assert.throws(load(varints(0, 0, 0)), (e) => e instanceof FormatError && e.message === "invalid automaton structure");
  assert.throws(load(varints(2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0)), (e) => e instanceof FormatError && e.message === "invalid automaton structure");
  assert.throws(load(varints(1, 0, 1, 0, 0, 0, 0, 1, 0)), (e) => e instanceof FormatError && e.message === "invalid automaton structure");
});

test("zstd errors are FormatError", () => {
  const good = buildSigdbBytes({ rules: {} });
  const view = new DataView(good.buffer, good.byteOffset);
  const itemsAt = 9 + view.getUint32(5) + 4;
  const bad = new Uint8Array(good);
  bad[itemsAt] = 0;
  assert.throws(() => loadSigdbBytes(bad), FormatError);
  const v = validateSigdbBytes(bad);
  assert.equal(v.ok, false);
  assert.match(v.errors[0] ?? "", /zstd/);
  assert.throws(() => loadSigdbBytes(good, { maxItemsJsonSize: 1 }), FormatError);
});

test("rule validation errors", () => {
  const build = (rules: unknown) => () => buildSigdbBytes({ rules: rules as never });
  const cases: [unknown, string][] = [
    [[], "rules must be a JSON object"],
    [null, "rules must be a JSON object"],
    [{ "": {} }, "rule keys must be non-empty strings"],
    [{ a: "x" }, "rule value must be an object"],
    [{ a: { headers: "x" } }, "headers must be an object"],
    [{ a: { headers: { b: 1 } } }, "headers keys/values must be strings"],
    [{ a: { js: 1 } }, "js must be a string or list of strings"],
    [{ a: { js: [1] } }, "js items must be strings"],
    [{ a: { meta: [] } }, "meta must be an object"],
    [{ a: { html: 1 } }, "html must be a string, object, or list"],
    [{ a: { html: [1] } }, "html items must be strings or objects"],
    [{ a: { html: { x: 1 } } }, "html spec has invalid keys"],
    [{ a: { html: { tag: "" } } }, "html tag must be a non-empty string"],
    [{ a: { html: { attr: 1 } } }, "html attr must be a non-empty string"],
    [{ a: { html: { attr: "a", value: 1 } } }, "html value must be a string"],
    [{ a: { html: { value: "v" } } }, "html value requires attr"],
    [{ a: { html: {} } }, "html spec must include tag or attr"],
  ];
  for (const [rules, message] of cases) {
    assert.throws(build(rules), (e) => e instanceof FormatError && e.message === message, message);
  }
});

test("lone surrogates are rejected", () => {
  assert.throws(() => buildSigdbBytes({ rules: { a: { js: "x\u{d800}" } } }), FormatError);
  assert.throws(() => buildSigdbBytes({ rules: { ["\u{dc00}"]: {} } }), FormatError);
  assert.throws(() => buildSigdbBytes({ rules: {}, metadata: { note: "\u{d800}" } }), FormatError);
  const db = loadSigdbBytes(buildSigdbBytes({ rules: { a: { js: "x" } } }));
  assert.throws(() => match("js:\u{d800}", db), FormatError);
});

test("Map rules keep integer-like key order", () => {
  const rules = new Map([
    ["10", { js: "lib" }],
    ["2", { js: "lib", headers: new Map([["20", "x"], ["3", "x"]]) }],
  ]);
  const db = loadSigdbBytes(buildSigdbBytes({ rules }));
  assert.deepEqual(db.items.map((i) => i.key), ["10", "2"]);
  assert.deepEqual([...(db.items[1]?.headers.keys() ?? [])], ["20", "3"]);
  assert.equal(match("js:lib", db).item?.key, "10");
});

test("free functions accept Matcher, Database and Reader-like sources", () => {
  const db = loadSigdbBytes(
    buildSigdbBytes({
      rules: {
        wp: { meta: { generator: "WordPress" }, html: { tag: "link", attr: "rel", value: "https://api.w.org/" } },
        jq: { js: "jquery" },
      },
    }),
  );
  assert.equal(matchGroup("meta", "WordPress 6.4", db, { name: "generator" }).item?.key, "wp");
  assert.equal(matchHtml('<link rel="https://api.w.org/" href="/wp-json/">', db).item?.key, "wp");
  assert.equal(matchSearch({ js: ["jquery-3.7.1.min.js"] }, db).item?.key, "jq");
  assert.deepEqual(matchSearch({}, db), { result: false, itemId: null, item: null, head: "" });
  assert.throws(() => match("x", {} as never), TypeError);
});
