import { FormatError } from "../types/exceptions.ts";
import type { DecodeResult } from "../types/models.ts";

export function encodeVarint(value: number): Uint8Array {
  if (value < 0) {
    throw new RangeError("varint cannot encode negative values");
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError("varint value must be a safe integer");
  }

  const out: number[] = [];
  let n = value;

  while (true) {
    const b = n % 128;
    n = Math.floor(n / 128);
    if (n) {
      out.push(b | 0x80);
    } else {
      out.push(b);
      break;
    }
  }

  return Uint8Array.from(out);
}

export function decodeVarint(data: Uint8Array, offset: number, maxBytes = 10): DecodeResult {
  if (offset < 0) {
    throw new FormatError("negative offset");
  }

  let shift = 0;
  let result = 0;
  const start = offset;

  while (true) {
    if (offset >= data.length) {
      throw new FormatError("truncated varint");
    }

    const b = data[offset] as number;
    offset += 1;

    result += (b & 0x7f) * 2 ** shift;

    if (!(b & 0x80)) {
      if (result > Number.MAX_SAFE_INTEGER) {
        throw new FormatError("varint value exceeds Number.MAX_SAFE_INTEGER");
      }
      return { value: result, offset };
    }

    shift += 7;
    if (offset - start >= maxBytes) {
      throw new FormatError("varint too long");
    }
  }
}
