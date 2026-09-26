# SignatureDB

[![npm](https://img.shields.io/npm/v/@reekeer/sigdb)](https://www.npmjs.com/package/@reekeer/sigdb)
[![Node](https://img.shields.io/badge/node-%3E%3D24-blue)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-green)](#license)
[![Format](https://img.shields.io/badge/format-SIGT%20v3-lightgrey)](#file-format)

Compiler and loader for `.sigdb` files: rules compiled into per-group Aho-Corasick indexes,
with arbitrary JSON per item and named data sections, packed into one zstd-compressed file.
Used for technology fingerprinting (headers, HTML, scripts) and for library fingerprinting
(feature tokens, source strings).

## Install

```sh
npm install @reekeer/sigdb
```

Requires Node.js 24+. No runtime dependencies: compression uses the zstd API of `node:zlib`
(or `Bun.zstdCompressSync` under Bun). Node marks that API as experimental; its
`ExperimentalWarning` is suppressed while sigdb calls it, other warnings are left alone.

## Usage

```ts
import { build, load } from "@reekeer/sigdb";

const rules = {
  nginx: { headers: { Server: "nginx" } },
  "react@18.2.0/index.js": {
    data: { package: "react", version: "18.2.0", entry: true },
    features: ["P:useState", "S:react.element"],
    strings: ["Minified React error #"],
  },
  "zustand@4.5.0/index.js": {
    data: { package: "zustand", version: "4.5.0" },
    features: ["P:useState", "K:subscribe"],
  },
};
const groups = {
  features: {},
  strings: { match: "contains" as const },
};

build(rules, "libs.sigdb", { groups, sections: { prints: { version: 1 } } });

const db = load("libs.sigdb");
console.log(db.match("Server: nginx/1.25.3").item?.key);
console.log(db.matchTokens("features", ["P:useState", "K:subscribe"]));
console.log(db.matchAll("features", ["P:useState"]).map((hit) => hit.item.key));
console.log(db.scan("throw Error('Minified React error #321')", "strings"));
console.log(db.item("react@18.2.0/index.js")?.data);
console.log(db.itemsWithPrefix("react@").map((item) => item.key));
console.log(db.section("prints"));
```

```
nginx
Map(2) { 2 => 2, 1 => 1 }
[ 'react@18.2.0/index.js', 'zustand@4.5.0/index.js' ]
[ { patternId: 3, start: 13, end: 35 } ]
{ package: 'react', version: '18.2.0', entry: true }
[ 'react@18.2.0/index.js' ]
{ version: 1 }
```

Other entry points: `buildBytes`, `loadBytes`, `compileJson`, `compileDir` (merges every
`*.json` under a directory), `readRules`, `readMetadata`, `validate`, `Reader`. Everything is
synchronous.

For workers, `db.rawSections()` returns one `Uint8Array` per section, each with its own
`ArrayBuffer`, ready for the `postMessage` transfer list. `Database.fromRaw(metadata, sections)`
rebuilds the database on the other side without touching zstd.

## Rules

A rule set is an object: item key to its groups. Keys are any non-empty strings
(`pkg@1.0.0/dist/a.js`, `/`, `@` and `\u0000` included). `data` holds any JSON for the item and
is never matched.

Every group has a config:

| field | values | meaning |
|---|---|---|
| `match` | `prefix`, `contains`, `exact` | value starts with / contains / equals the pattern |
| `ignore_case` | bool | lowercase patterns and queries |
| `trim` | bool | strip surrounding whitespace |
| `kind` | `list`, `map` | `map` groups take `{name: value}` and match `name:value` |

Built-in groups: `headers` (map, contains), `meta` (map, prefix), and `js`, `html`,
`script_src`, `css`, `url`, `path`, `file`, `dns`, `subdomain`, `link`, `json`, `api`, `tls`,
`server`, `framework`, `cms`, `cdn` (list, prefix). All built-ins ignore case and trim.
Custom groups are declared in `groups` and default to exact, case-sensitive, no trim.

A file can hold several indexes (`indexes: { functions: { rules, groups } }`, read with
`db.index("functions")`). Plain rules go to the `main` index.

Queries:

- `match`, `matchGroup`, `matchSearch`, `matchHtml` return the first hit: earliest match,
  then lowest item id.
- `matchAll` and `matchTokens` return every item with the number of distinct patterns hit.
- `scan` returns every occurrence with UTF-8 byte offsets (of the lowercased text when the
  group ignores case).
- `pattern(id)` and `patternCount(itemId, group)` give pattern text and totals for weighting.

Builds are reproducible: no timestamps unless `timestamp` is passed.

Key order matters: it decides item ids, pattern ids and the bytes of every section. Plain
objects move integer-like keys (`"10"`, `"2"`) to the front, so pass a `Map` where such keys
must keep their order. `compileJson`, `compileDir` and `readRules` keep the order of the files.
Loaded item data and JSON sections come back as plain objects.

Numbers: integers are written exactly (big ones as `bigint`). A JavaScript number cannot tell
`1` from `1.0`, so a whole-valued float is written as an integer; other floats use the shortest
round-trip form (`1e-07`, `1.5e+16`). `NaN` and `Infinity` are rejected.

## File format

```
"SIGT" | u8 version = 3 | u32 header length | header JSON
       | u16 section count | per section: u8 name length, name, u32 raw size,
         u32 stored size, SHA256(raw) | zstd section bodies
```

Integers are big-endian. Sections are `index/<name>` (JSON: groups, items, patterns,
pattern_items), `automaton/<index>/<group>`, `json/<name>` and `blob/<name>`. Each section
is decompressed and hash-checked on first use. Versions 1 and 2 are rejected; rebuild
them from rules. Specification: [reekeer/sigdb](https://github.com/reekeer/sigdb).

## Tests

```sh
npm ci
npm test
```

`tests/golden/` holds rule sets with expected results and section hashes, `tests/fixtures/`
holds reference `.sigdb` files built from the same rules.

## License

MIT
