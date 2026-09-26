import assert from "node:assert/strict";
import { test } from "node:test";

import { FormatError } from "../src/index.ts";
import { decodeVarint, encodeVarint } from "../src/utils/varint.ts";

test("varint roundtrip", () => {
  for (const value of [0, 1, 2, 10, 127, 128, 255, 300, 16_384, 2 ** 32, Number.MAX_SAFE_INTEGER]) {
    const encoded = encodeVarint(value);
    const decoded = decodeVarint(encoded, 0);
    assert.equal(decoded.value, value);
    assert.equal(decoded.offset, encoded.length);
  }
});

test("varint encoding is minimal", () => {
  assert.deepEqual([...encodeVarint(0)], [0x00]);
  assert.deepEqual([...encodeVarint(127)], [0x7f]);
  assert.deepEqual([...encodeVarint(128)], [0x80, 0x01]);
  assert.deepEqual([...encodeVarint(300)], [0xac, 0x02]);
  assert.deepEqual([...encodeVarint(Number.MAX_SAFE_INTEGER)], [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0f]);
});

test("varint decode accepts non-minimal forms", () => {
  assert.deepEqual(decodeVarint(Uint8Array.of(0x80, 0x00), 0), { value: 0, offset: 2 });
  assert.deepEqual(decodeVarint(Uint8Array.of(0x81, 0x80, 0x00), 0), { value: 1, offset: 3 });
});

test("varint errors", () => {
  assert.throws(() => encodeVarint(-1), { name: "RangeError", message: /negative/ });
  assert.throws(() => encodeVarint(2 ** 53), RangeError);
  assert.throws(() => encodeVarint(1.5), RangeError);
  assert.throws(() => decodeVarint(new Uint8Array(), 0), (e) => e instanceof FormatError && /truncated varint/.test(e.message));
  assert.throws(() => decodeVarint(Uint8Array.of(0x80), 0), (e) => e instanceof FormatError && /truncated varint/.test(e.message));
  assert.throws(() => decodeVarint(new Uint8Array(10).fill(0x80), 0), (e) => e instanceof FormatError && /varint too long/.test(e.message));
  assert.throws(() => decodeVarint(Uint8Array.of(0x00), -1), (e) => e instanceof FormatError && /negative offset/.test(e.message));
});

test("varint values above MAX_SAFE_INTEGER are rejected", () => {
  const twoPow53 = Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x10);
  assert.throws(() => decodeVarint(twoPow53, 0), FormatError);
  const int64Max = Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f);
  assert.throws(() => decodeVarint(int64Max, 0), FormatError);
});

test("varint decode respects offset", () => {
  const encoded = encodeVarint(300);
  assert.notEqual(decodeVarint(encoded, 1).value, 300);
});
