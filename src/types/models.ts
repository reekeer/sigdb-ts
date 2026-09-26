export interface DecodeResult {
  readonly value: number;
  readonly offset: number;
}

export interface Item {
  readonly key: string;
  readonly headers: ReadonlyMap<string, string>;
}

export interface BuildResult {
  readonly outputPath: string;
  readonly dataHashHex: string;
  readonly metadata: Record<string, unknown>;
}

export class Automaton {
  readonly childrenStart: Uint32Array;
  readonly childrenCount: Uint32Array;
  readonly fail: Uint32Array;
  readonly outStart: Uint32Array;
  readonly outCount: Uint32Array;
  readonly labels: Uint8Array;
  readonly nextState: Uint32Array;
  readonly outputs: Uint32Array;

  constructor(fields: {
    childrenStart: Uint32Array;
    childrenCount: Uint32Array;
    fail: Uint32Array;
    outStart: Uint32Array;
    outCount: Uint32Array;
    labels: Uint8Array;
    nextState: Uint32Array;
    outputs: Uint32Array;
  }) {
    this.childrenStart = fields.childrenStart;
    this.childrenCount = fields.childrenCount;
    this.fail = fields.fail;
    this.outStart = fields.outStart;
    this.outCount = fields.outCount;
    this.labels = fields.labels;
    this.nextState = fields.nextState;
    this.outputs = fields.outputs;
  }

  transition(state: number, b: number): number {
    const start = this.childrenStart[state] ?? 0;
    const count = this.childrenCount[state] ?? 0;
    if (count === 0) {
      return -1;
    }

    let lo = 0;
    let hi = count;
    const labels = this.labels;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const lb = labels[start + mid] ?? 0;
      if (lb < b) {
        lo = mid + 1;
      } else if (lb > b) {
        hi = mid;
      } else {
        return this.nextState[start + mid] ?? -1;
      }
    }
    return -1;
  }
}

export interface Database {
  readonly metadata: Record<string, unknown>;
  readonly items: readonly Item[];
  readonly automaton: Automaton;
}

export interface MatchResult {
  readonly result: boolean;
  readonly itemId: number | null;
  readonly item: Item | null;
  readonly head: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: string[];
  readonly metadata: Record<string, unknown> | null;
  readonly storedHashHex: string | null;
  readonly computedHashHex: string | null;
}
