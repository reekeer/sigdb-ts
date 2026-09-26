import assert from "node:assert/strict";
import { test } from "node:test";

import { builtinSpec, normalize, resolveGroups } from "../src/internal/groups.ts";
import { lower, strip } from "../src/internal/text.ts";

const SPACE = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002,
  0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
];

test("strip removes exactly the whitespace set", () => {
  const set = new Set(SPACE);
  for (let c = 0; c <= 0xffff; c++) {
    const ch = String.fromCharCode(c);
    assert.equal(strip(`${ch}x${ch}`), set.has(c) ? "x" : `${ch}x${ch}`, c.toString(16));
  }
  assert.equal(strip("\u{feff}a\u{feff}"), "\u{feff}a\u{feff}");
  assert.equal(strip("\u{200b}a"), "\u{200b}a");
  assert.equal(strip(" \u{1f600} "), "\u{1f600}");
  assert.equal(strip(""), "");
});

test("lower", () => {
  assert.equal(lower("\u{130}"), "i\u{307}");
  assert.equal(lower("ΟΔΥΣΣΕΥΣ"), "οδυσσευς");
  assert.equal(lower("cdn:\u{3a3}"), "cdn:\u{3c2}");
  assert.equal(lower("\u{3a3}"), "\u{3c3}");
  assert.equal(lower("\u{1e9e}"), "\u{df}");
  assert.equal(lower("\u{10400}"), "\u{10428}");
});

test("normalize", () => {
  assert.equal(normalize(builtinSpec("headers"), " Server :  NGINX "), "server:nginx");
  assert.equal(normalize(builtinSpec("meta"), "\u{3000}generator:WP\u{85}"), "generator:wp");
  assert.equal(normalize(builtinSpec("js"), "\x1cJQuery\x1f"), "jquery");
  assert.equal(normalize(builtinSpec("cms"), "\u{feff}Ghost"), "\u{feff}ghost");
  const custom = resolveGroups({ f: {} }).get("f");
  assert.ok(custom);
  assert.equal(normalize(custom, " A:B "), " A:B ");
  const mapped = resolveGroups({ m: { kind: "map", trim: true } }).get("m");
  assert.ok(mapped);
  assert.equal(normalize(mapped, " A : B "), "A:B");
});
