import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  FormatError,
  IntegrityError,
  Reader,
  buildSigdb,
  buildSigdbBytes,
  loadSigdb,
  loadSigdbBytes,
  readSigdbMetadata,
  validateSigdb,
} from "../src/index.ts";
import { withTempDir } from "./support.ts";

const metadata = {
  dataset: "Example",
  version: "1.0.0",
  author: "Validity Checker",
  contact: "validity@reekeer.hidden",
  license: "MIT",
  repository: "https://github.com/reekeer/sigdb-ts",
  homepage: "https://reekeer.com",
  description: "Example .sigdb dataset to test validity",
};

function isFormatError(pattern: RegExp) {
  return (e: unknown) => e instanceof FormatError && pattern.test(e.message);
}

function hashOffset(file: Uint8Array): number {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let pos = 5;
  for (let i = 0; i < 3; i++) {
    pos += 4 + view.getUint32(pos, false);
  }
  return pos;
}

test("trailing data after hash", () => {
  withTempDir((dir) => {
    const out = join(dir, "trailing.sigdb");
    const bad = join(dir, "trailing_extra.sigdb");
    buildSigdb({ rules: { nginx: { headers: { Server: "nginx" } } }, outputPath: out, metadata });
    writeFileSync(bad, Buffer.concat([readFileSync(out), Buffer.of(0)]));

    assert.throws(() => loadSigdb(bad), isFormatError(/trailing data after hash/));

    const v = validateSigdb(bad);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes("trailing data after hash")));
  });
});

test("build, validate, load", () => {
  withTempDir((dir) => {
    const out = join(dir, "validity.sigdb");
    const rules = {
      nginx: { headers: { Server: "nginx" } },
      cloudflare: { headers: { Server: "cloudflare" } },
    };
    const result = buildSigdb({ rules, outputPath: out, metadata });
    assert.equal(result.dataHashHex.length, 64);
    assert.equal(result.outputPath, out);

    const meta = readSigdbMetadata(out);
    for (const [k, v] of Object.entries(metadata)) {
      assert.equal(meta[k], v, `metadata ${k}`);
    }
    assert.equal(meta["format"], "SIGDB-TRIE");
    assert.equal(meta["items"], 2);
    assert.equal(meta["patterns"], 2);
    assert.equal(typeof meta["created"], "number");
    assert.match(String(meta["build"]), /^\d{4}-\d{2}-\d{2}$/);
    for (const k of ["certificate", "signature_algorithm", "public_key"]) {
      assert.ok(!(k in meta));
    }

    const v = validateSigdb(out);
    assert.equal(v.ok, true, v.errors.join(", "));
    assert.deepEqual(v.errors, []);
    assert.ok(v.storedHashHex !== null && v.computedHashHex !== null);
    assert.equal(v.storedHashHex, v.computedHashHex);
    assert.equal(v.storedHashHex, result.dataHashHex);

    const reader = new Reader(out);
    const db = reader.load();
    assert.deepEqual(db.items, [
      { key: "nginx", headers: new Map([["Server", "nginx"]]) },
      { key: "cloudflare", headers: new Map([["Server", "cloudflare"]]) },
    ]);
    assert.equal(reader.path, out);
    assert.equal(reader.metadata()["dataset"], "Example");
    assert.equal(reader.validate().ok, true);
    assert.equal(reader.loadCached(), reader.loadCached());
    assert.equal(reader.match("Server: cloudflare").item?.key, "cloudflare");

    assert.throws(
      () => buildSigdb({ rules: 123 as never, outputPath: out }),
      isFormatError(/rules must be a JSON object/),
    );
  });
});

test("magic and version checks", () => {
  withTempDir((dir) => {
    const bad = join(dir, "bad.sigdb");
    writeFileSync(bad, Buffer.concat([Buffer.from("NOPE"), Buffer.alloc(16)]));
    assert.throws(() => readSigdbMetadata(bad), isFormatError(/invalid magic/));

    writeFileSync(bad, Buffer.concat([Buffer.from("SIGT\x01"), Buffer.alloc(16)]));
    assert.throws(() => readSigdbMetadata(bad), isFormatError(/legacy signed format/));
    assert.throws(
      () => loadSigdb(bad),
      (e) =>
        e instanceof FormatError &&
        e.message === "unsupported sigdb version: 1 (legacy signed format); rebuild the database from rules",
    );

    writeFileSync(bad, Buffer.concat([Buffer.from("SIGT\x03"), Buffer.alloc(16)]));
    assert.throws(() => loadSigdb(bad), (e) => e instanceof FormatError && e.message === "unsupported sigdb version: 3");

    writeFileSync(bad, Buffer.from("SIG"));
    assert.throws(() => loadSigdb(bad), isFormatError(/^unexpected EOF$/));
  });
});

test("hash mismatch", () => {
  withTempDir((dir) => {
    const out = join(dir, "validity.sigdb");
    const corrupt = join(dir, "validity_corrupt.sigdb");
    buildSigdb({ rules: { nginx: { headers: { Server: "nginx" } } }, outputPath: out, metadata });

    const raw = new Uint8Array(readFileSync(out));
    const off = hashOffset(raw);
    assert.equal(off + 32, raw.length);
    raw[off] = (raw[off] as number) ^ 0x01;
    writeFileSync(corrupt, raw);

    assert.throws(
      () => loadSigdb(corrupt),
      (e) => e instanceof IntegrityError && e.message === "corrupted database (hash mismatch)",
    );
    loadSigdb(corrupt, { verifyHash: false });

    const v = validateSigdb(corrupt);
    assert.equal(v.ok, false);
    assert.deepEqual(v.errors, ["hash mismatch"]);
    assert.notEqual(v.storedHashHex, v.computedHashHex);
    assert.equal(validateSigdb(corrupt, { verifyHash: false }).ok, true);
  });
});

test("header limits and shape", () => {
  const header = (json: string, len = Buffer.byteLength(json)) => {
    const b = Buffer.alloc(9);
    b.write("SIGT");
    b[4] = 2;
    b.writeUInt32BE(len, 5);
    return Buffer.concat([b, Buffer.from(json)]);
  };
  assert.throws(() => loadSigdbBytes(header("", 65_537)), isFormatError(/^HEADER_DATA too large$/));
  assert.throws(() => loadSigdbBytes(header("{bad")), isFormatError(/^invalid HEADER_DATA json$/));
  assert.throws(() => loadSigdbBytes(header("[]")), isFormatError(/^HEADER_DATA must be an object$/));
  assert.throws(() => loadSigdbBytes(header("{}")), isFormatError(/^unexpected EOF$/));
  assert.throws(
    () => buildSigdbBytes({ rules: {}, metadata: { big: "x".repeat(70_000) } }),
    isFormatError(/^HEADER_DATA too large$/),
  );
});

test("validate reports missing files instead of throwing", () => {
  const v = validateSigdb("/nonexistent/path.sigdb");
  assert.equal(v.ok, false);
  assert.equal(v.errors.length, 1);
  assert.equal(v.metadata, null);
});

test("metadata defaults only fill missing keys", () => {
  const db = loadSigdbBytes(
    buildSigdbBytes({ rules: {}, metadata: { format: "custom", created: null, items: 99 } }),
  );
  assert.deepEqual(Object.keys(db.metadata), ["format", "created", "items", "version", "build", "patterns"]);
  assert.equal(db.metadata["format"], "custom");
  assert.equal(db.metadata["created"], null);
  assert.equal(db.metadata["items"], 99);
  assert.equal(db.metadata["patterns"], 0);
});
