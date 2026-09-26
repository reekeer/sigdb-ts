import assert from "node:assert/strict";
import { test } from "node:test";

import { JsonDecodeError, parseJson, parseJsonBytes } from "../src/internal/json.ts";

test("objects keep key order and last duplicate wins", () => {
  const v = parseJson('{"10":1,"2":2,"a":3,"2":4}') as Map<string, unknown>;
  assert.deepEqual([...v.entries()], [["10", 1], ["2", 4], ["a", 3]]);
  const o = parseJson('{"__proto__":1,"10":2,"2":3}', "object") as Record<string, unknown>;
  assert.equal(Object.hasOwn(o, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(o), Object.prototype);
});

test("NaN and Infinity literals", () => {
  assert.deepEqual(parseJson("[NaN,Infinity,-Infinity,-0,1e2,0.5]"), [NaN, Infinity, -Infinity, -0, 100, 0.5]);
});

test("strings", () => {
  assert.equal(parseJson('"\\ud83d\\ude00"'), "\u{1f600}");
  assert.equal(parseJson('"\\ud800x"'), "\u{d800}x");
  assert.equal(parseJson('"\\/\\b\\f\\n\\r\\t\\"\\\\"'), '/\b\f\n\r\t"\\');
});

test("invalid documents", () => {
  for (const text of ["", " ", "{", "[1,]", '{"a":1,}', "{'a':1}", '"\x01"', '"\\x"', '"\\u12G4"', "01", "1.", "tru", "[] []", "\u{feff}[]", "+1"]) {
    assert.throws(() => parseJson(text), JsonDecodeError, JSON.stringify(text));
  }
  assert.throws(() => parseJson("[".repeat(2000) + "]".repeat(2000)), JsonDecodeError);
});

test("byte encodings", () => {
  const doc = '{"k":"\u{e9}"}';
  const expected = new Map([["k", "\u{e9}"]]);
  assert.deepEqual(parseJsonBytes(Buffer.from(doc)), expected);
  assert.deepEqual(parseJsonBytes(Buffer.concat([Buffer.of(0xef, 0xbb, 0xbf), Buffer.from(doc)])), expected);
  assert.deepEqual(parseJsonBytes(Buffer.from(doc, "utf16le")), expected);
  assert.deepEqual(parseJsonBytes(Buffer.concat([Buffer.of(0xff, 0xfe), Buffer.from(doc, "utf16le")])), expected);
  assert.deepEqual(parseJsonBytes(Buffer.from(doc, "utf16le").swap16()), expected);
  const u32 = Buffer.alloc(doc.length * 4);
  [...doc].forEach((c, i) => u32.writeUInt32LE(c.codePointAt(0) as number, i * 4));
  assert.deepEqual(parseJsonBytes(u32), expected);
  assert.throws(() => parseJsonBytes(Buffer.of(0x22, 0xff, 0x22)), JsonDecodeError);
});
