import assert from "node:assert/strict";
import { test } from "node:test";
import { constants, zstdCompressSync } from "node:zlib";

import { FormatError, IntegrityError, buildBytes, loadBytes } from "../src/index.ts";
import { parseContainer } from "../src/format/container.ts";

const RULES = { nginx: { headers: { Server: "nginx" } }, jquery: { js: "jquery" } };

function sectionsOffset(data: Uint8Array): number {
  return 9 + Buffer.from(data).readUInt32BE(5);
}

function table(data: Uint8Array): [string, number, number, number][] {
  const buf = Buffer.from(data);
  let pos = sectionsOffset(data);
  const count = buf.readUInt16BE(pos);
  pos += 2;
  const out: [string, number, number, number][] = [];
  for (let i = 0; i < count; i++) {
    const nameLen = buf[pos] as number;
    const name = buf.subarray(pos + 1, pos + 1 + nameLen).toString("utf8");
    pos += 1 + nameLen;
    out.push([name, buf.readUInt32BE(pos), buf.readUInt32BE(pos + 4), pos]);
    pos += 8 + 32;
  }
  return out;
}

function throwsFormat(fn: () => unknown, text: string): void {
  assert.throws(fn, (e) => e instanceof FormatError && e.message.includes(text), text);
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

test("container layout", () => {
  const data = buildBytes(RULES);
  assert.equal(Buffer.from(data.subarray(0, 4)).toString(), "SIGT");
  assert.equal(data[4], 3);
  assert.deepEqual(
    table(data).map((t) => t[0]),
    ["index/main", "automaton/main/headers", "automaton/main/js"],
  );
});

test("header and version errors", () => {
  const data = buildBytes(RULES);
  throwsFormat(() => loadBytes(Buffer.concat([Buffer.from("NOPE"), Buffer.alloc(16)])), "invalid magic");
  for (const [version, text] of [
    [1, "unsupported sigdb version: 1 (legacy signed format); rebuild the database from rules"],
    [2, "unsupported sigdb version: 2 (single-automaton format); rebuild the database from rules"],
  ] as const) {
    throwsFormat(() => loadBytes(Buffer.concat([Buffer.from("SIGT"), Buffer.of(version), Buffer.alloc(16)])), text);
  }
  throwsFormat(() => loadBytes(Buffer.concat([Buffer.from("SIGT\x04"), Buffer.alloc(16)])), "unsupported sigdb version: 4");
  throwsFormat(() => loadBytes(Buffer.concat([data, Buffer.of(0)])), "trailing data after last section");
  throwsFormat(() => loadBytes(data.subarray(0, -1)), "unexpected EOF");
  throwsFormat(() => loadBytes(data.subarray(0, 7)), "unexpected EOF");
});

test("hash verification is lazy and per section", () => {
  const data = buildBytes(RULES);
  const [name, , , pos] = table(data)[0] as [string, number, number, number];
  const corrupted = new Uint8Array(data);
  corrupted[pos + 8] = (corrupted[pos + 8] as number) ^ 0x01;
  const db = loadBytes(corrupted);
  assert.throws(
    () => db.index(),
    (e) => e instanceof IntegrityError && e.message === `corrupted database (hash mismatch in section ${name})`,
  );
  assert.equal(loadBytes(corrupted, { verifyHash: false }).index().items[0]?.key, "nginx");
  assert.equal(loadBytes(corrupted).metadata["format"], "SIGDB");
});

test("zstd frame size checks", () => {
  const data = buildBytes(RULES);
  const [, rawSize, , pos] = table(data)[0] as [string, number, number, number];
  const wrongSize = Buffer.from(data);
  wrongSize.writeUInt32BE(rawSize + 1, pos);
  throwsFormat(
    () => loadBytes(wrongSize).index(),
    "section index/main: zstd frame size does not match section size",
  );

  const bomb = zstdCompressSync(Buffer.alloc(10_000_000, 0x61), { params: { [constants.ZSTD_c_compressionLevel]: 1 } });
  const head = Buffer.concat([
    Buffer.from("SIGT\x03"),
    u32(2),
    Buffer.from("{}"),
    u16(1),
    Buffer.of(10),
    Buffer.from("index/main"),
    u32(100),
    u32(bomb.length),
    Buffer.alloc(32),
  ]);
  const container = parseContainer(Buffer.concat([head, bomb]));
  throwsFormat(() => container.raw("index/main"), "zstd frame size");
  throwsFormat(
    () => parseContainer(Buffer.concat([head, bomb]), { maxSectionSize: 10 }).raw("index/main"),
    "section index/main exceeds max_section_size",
  );
});

test("invalid section contents", () => {
  const body = zstdCompressSync(Buffer.of(0xff, 0xff));
  const garbage = Buffer.concat([
    Buffer.from("SIGT\x03"),
    u32(2),
    Buffer.from("{}"),
    u16(1),
    Buffer.of(10),
    Buffer.from("index/main"),
    u32(2),
    u32(body.length),
    Buffer.alloc(32),
    body,
  ]);
  throwsFormat(() => loadBytes(garbage, { verifyHash: false }).index(), "invalid index main json");

  const onlyHeader = Buffer.concat([Buffer.from("SIGT\x03"), u32(2), Buffer.from("{}"), u16(0)]);
  throwsFormat(() => loadBytes(onlyHeader), "database has no indexes");

  const notZstd = Buffer.concat([
    Buffer.from("SIGT\x03"),
    u32(2),
    Buffer.from("{}"),
    u16(1),
    Buffer.of(10),
    Buffer.from("index/main"),
    u32(2),
    u32(3),
    Buffer.alloc(32),
    Buffer.from("abc"),
  ]);
  throwsFormat(() => loadBytes(notZstd).index(), "section index/main: invalid zstd frame");
});

test("section table errors", () => {
  const entry = (name: Buffer) => Buffer.concat([Buffer.of(name.length), name, u32(0), u32(0), Buffer.alloc(32)]);
  const container = (...entries: Buffer[]) =>
    Buffer.concat([Buffer.from("SIGT\x03"), u32(2), Buffer.from("{}"), u16(entries.length), ...entries]);
  throwsFormat(() => loadBytes(container(entry(Buffer.of(0xff)))), "invalid section name");
  throwsFormat(() => loadBytes(container(entry(Buffer.alloc(0)))), "invalid or duplicate section name: ''");
  throwsFormat(
    () => loadBytes(container(entry(Buffer.from("json/a")), entry(Buffer.from("json/a")))),
    "invalid or duplicate section name: 'json/a'",
  );
  throwsFormat(() => loadBytes(container(entry(Buffer.from("weird/x")))), "unknown section: weird/x");
  throwsFormat(() => loadBytes(container(entry(Buffer.from("index/")))), "unknown section: index/");
  const big = Buffer.concat([Buffer.from("SIGT\x03"), u32(65_537)]);
  throwsFormat(() => loadBytes(big), "HEADER_DATA too large");
  throwsFormat(() => loadBytes(Buffer.concat([Buffer.from("SIGT\x03"), u32(2), Buffer.from("[]")])), "HEADER_DATA must be an object");
  throwsFormat(() => loadBytes(Buffer.concat([Buffer.from("SIGT\x03"), u32(2), Buffer.from("{x")])), "invalid HEADER_DATA json");
});
