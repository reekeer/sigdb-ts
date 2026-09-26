export type MatchMode = "prefix" | "contains" | "exact";
export type GroupKind = "list" | "map";

export interface DecodeResult {
  readonly value: number;
  readonly offset: number;
}

export interface Item {
  readonly key: string;
  readonly data: unknown;
}

export interface GroupSpec {
  readonly name: string;
  readonly kind: GroupKind;
  readonly match: MatchMode;
  readonly ignoreCase: boolean;
  readonly trim: boolean;
}

export interface Pattern {
  readonly id: number;
  readonly group: string;
  readonly text: string;
  readonly itemIds: readonly number[];
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
    const start = this.childrenStart[state] as number;
    const count = this.childrenCount[state] as number;
    let lo = 0;
    let hi = count;
    const labels = this.labels;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const lb = labels[start + mid] as number;
      if (lb < b) {
        lo = mid + 1;
      } else if (lb > b) {
        hi = mid;
      } else {
        return this.nextState[start + mid] as number;
      }
    }
    return -1;
  }

  outputsOf(state: number): Uint32Array {
    const start = this.outStart[state] as number;
    return this.outputs.subarray(start, start + (this.outCount[state] as number));
  }
}

export interface MatchResult {
  readonly result: boolean;
  readonly itemId: number | null;
  readonly item: Item | null;
  readonly head: string;
  readonly patternId: number | null;
}

export interface Hit {
  readonly itemId: number;
  readonly item: Item;
  readonly hits: number;
  readonly patternIds: readonly number[];
}

export interface Occurrence {
  readonly patternId: number;
  readonly start: number;
  readonly end: number;
}

export interface BuildResult {
  readonly outputPath: string;
  readonly size: number;
  readonly metadata: Record<string, unknown>;
  readonly sections: Record<string, string>;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: string[];
  readonly metadata: Record<string, unknown> | null;
  readonly sections: Record<string, string> | null;
}
