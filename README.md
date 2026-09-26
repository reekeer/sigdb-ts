# SignatureDB

[![npm](https://img.shields.io/npm/v/@reekeer/sigdb)](https://www.npmjs.com/package/@reekeer/sigdb)
[![Node](https://img.shields.io/badge/node-%3E%3D24-blue)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-green)](#license)
[![Format](https://img.shields.io/badge/format-SIGT%20v2-lightgrey)](#file-format)

Compiler and loader for `.sigdb` files: technology fingerprint rules compiled into a single
Aho-Corasick automaton for fast matching of HTTP headers, HTML, scripts and other signals.

## Install

```sh
npm install @reekeer/sigdb
```

Requires Node.js 24+. No runtime dependencies: compression uses the zstd API of `node:zlib`,
which Node still marks as experimental, so an `ExperimentalWarning` on stderr is expected.

## Usage

```ts
import { Reader, buildSigdb } from "@reekeer/sigdb";

const rules = {
  nginx: { headers: { Server: "nginx" } },
  wordpress: {
    meta: { generator: "WordPress" },
    html: { tag: "link", attr: "rel", value: "https://api.w.org/" },
  },
  jquery: { js: "jquery" },
};

buildSigdb({ rules, outputPath: "tech.sigdb", metadata: { dataset: "example" } });

const db = new Reader("tech.sigdb");
console.log(db.match("Server: nginx/1.25.3").item?.key);
console.log(db.matchGroup("meta", "WordPress 6.4", { name: "generator" }).item?.key);
console.log(db.matchHtml('<link rel="https://api.w.org/" href="/wp-json/">').item?.key);
console.log(db.matchSearch({ js: ["jquery-3.7.1.min.js"] }).item?.key);
```

```
nginx
wordpress
wordpress
jquery
```

Rules can also be compiled straight from a JSON file with `compileSigdbJson`, which keeps the
key order of the file. `buildSigdbBytes` and `loadSigdbBytes` work on `Uint8Array` without
touching the file system. Everything is synchronous.

## Rules

A rule set is an object: technology name to groups of patterns.

- Map groups (`name -> value`): `headers`, `meta`
- List groups (string or list of strings): `js`, `script_src`, `css`, `url`, `path`, `file`,
  `dns`, `subdomain`, `link`, `json`, `api`, `tls`, `server`, `framework`, `cms`, `cdn`
- `html`: string `tag:X:attr:Y:value:Z` or object `{ tag, attr, value }`, or a list of either

Matching:

- Case-insensitive, leading and trailing whitespace ignored.
- Patterns are literal strings. Regex and version capture are not supported in format v2.
- Inside a group, the value must start with the pattern (`js:jquery` matches `jquery.min.js`).
  `headers` patterns have no group prefix and match anywhere in `Name: value`.
- If several rules share a pattern, the one defined first wins.

Rule order decides item ids. Plain objects move integer-like keys (`"10"`, `"2"`) to the front,
so pass a `Map` when such keys must keep their order.

## File format

```
"SIGT" | version (u8 = 2) | u32 len + header JSON | u32 len + zstd(items JSON)
       | u32 len + zstd(automaton) | SHA256(items + automaton)
```

Lengths are big-endian. The hash is checked on load (`verifyHash: true` by default).
Version 1 files are rejected; rebuild them from the rules. Specification:
[reekeer/sigdb](https://github.com/reekeer/sigdb).

## Tests

```sh
npm ci
npm test
```

`tests/golden/` holds rule sets with expected match results, `tests/fixtures/` holds reference
`.sigdb` files built from the same rules.

## License

MIT
