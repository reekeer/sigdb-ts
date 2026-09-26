import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { FormatError } from "../types/exceptions.ts";

export function compressZstd(data: Uint8Array, level = 19): Uint8Array {
  const out = zstdCompressSync(data, {
    params: {
      [constants.ZSTD_c_compressionLevel]: level,
      [constants.ZSTD_c_contentSizeFlag]: 1,
    },
  });
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

export function decompressZstd(data: Uint8Array, maxOutputSize: number): Uint8Array {
  if (data.length === 0) {
    throw new FormatError("zstd decompression failed: empty frame");
  }
  let out: Buffer;
  try {
    out = zstdDecompressSync(data, { maxOutputLength: maxOutputSize });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new FormatError(`zstd decompression failed: ${msg}`, { cause: e });
  }
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}
