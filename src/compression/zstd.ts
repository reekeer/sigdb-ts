import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { FormatError } from "../types/exceptions.ts";

interface BunZstd {
  zstdCompressSync(data: Uint8Array, options?: { level?: number }): Uint8Array;
  zstdDecompressSync(data: Uint8Array): Uint8Array;
}

const bun = (globalThis as { Bun?: Partial<BunZstd> }).Bun;
const bunZstd: BunZstd | null =
  typeof bun?.zstdCompressSync === "function" && typeof bun.zstdDecompressSync === "function"
    ? (bun as BunZstd)
    : null;

export function quietly<T>(fn: () => T): T {
  const original = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]): void {
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    const name = warning instanceof Error ? warning.name : type;
    const text = warning instanceof Error ? warning.message : warning;
    if (name === "ExperimentalWarning" && /zstd/i.test(text)) {
      return;
    }
    return (original as (...args: unknown[]) => void).call(this, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return fn();
  } finally {
    process.emitWarning = original;
  }
}

function own(b: Uint8Array): Uint8Array {
  if (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength && b.buffer instanceof ArrayBuffer) {
    return new Uint8Array(b.buffer);
  }
  return new Uint8Array(b);
}

export function compressZstd(data: Uint8Array, level = 19): Uint8Array {
  if (bunZstd) {
    return own(bunZstd.zstdCompressSync(data, { level }));
  }
  return own(
    quietly(() =>
      zstdCompressSync(data, {
        params: {
          [constants.ZSTD_c_compressionLevel]: level,
          [constants.ZSTD_c_contentSizeFlag]: 1,
        },
      }),
    ),
  );
}

const ZSTD_MAGIC = 0xfd2fb528;

export function frameContentSize(data: Uint8Array): number {
  if (data.length < 4) {
    throw new FormatError("invalid zstd frame");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = view.getUint32(0, true);
  if ((magic & 0xfffffff0) === 0x184d2a50) {
    return 0;
  }
  if (magic !== ZSTD_MAGIC || data.length < 5) {
    throw new FormatError("invalid zstd frame");
  }
  const fhd = data[4] as number;
  if (fhd & 0x08) {
    throw new FormatError("invalid zstd frame");
  }
  const fcsFlag = fhd >> 6;
  const singleSegment = (fhd >> 5) & 1;
  const dictSize = [0, 1, 2, 4][fhd & 3] as number;
  const fcsSize = fcsFlag === 0 ? singleSegment : ([0, 2, 4, 8][fcsFlag] as number);
  const pos = 5 + (singleSegment ? 0 : 1) + dictSize;
  if (data.length < pos + fcsSize) {
    throw new FormatError("invalid zstd frame");
  }
  switch (fcsSize) {
    case 0:
      return -1;
    case 1:
      return data[pos] as number;
    case 2:
      return view.getUint16(pos, true) + 256;
    case 4:
      return view.getUint32(pos, true);
    default:
      return Number(view.getBigUint64(pos, true));
  }
}

export function decompressZstd(data: Uint8Array, expectedSize: number): Uint8Array {
  const declared = frameContentSize(data);
  if (declared !== -1 && declared !== expectedSize) {
    throw new FormatError("zstd frame size does not match section size");
  }
  let out: Uint8Array;
  try {
    out = bunZstd
      ? bunZstd.zstdDecompressSync(data)
      : quietly(() => zstdDecompressSync(data, { maxOutputLength: Math.max(expectedSize, 1) }));
  } catch (e) {
    throw new FormatError("zstd decompression failed", { cause: e });
  }
  if (out.length !== expectedSize) {
    throw new FormatError("zstd frame size does not match section size");
  }
  return own(out);
}
