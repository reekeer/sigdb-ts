import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { FormatError } from "../types/exceptions.ts";

export class ByteReader {
  readonly data: Uint8Array;
  pos = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  readExact(size: number): Uint8Array {
    if (this.data.length - this.pos < size) {
      throw new FormatError("unexpected EOF");
    }
    const out = this.data.subarray(this.pos, this.pos + size);
    this.pos += size;
    return out;
  }

  readU8(): number {
    return this.readExact(1)[0] as number;
  }

  readU32BE(): number {
    const b = this.readExact(4);
    return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, false);
  }

  atEnd(): boolean {
    return this.pos >= this.data.length;
  }
}

export function writeFileEnsuringDir(path: string, data: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}
