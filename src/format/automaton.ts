import { FormatError } from "../types/exceptions.ts";
import { Automaton } from "../types/models.ts";
import { decodeVarint, encodeVarint } from "../utils/varint.ts";

export function buildAutomaton(patterns: readonly (readonly [Uint8Array, number])[]): Automaton {
  const trans: Map<number, number>[] = [new Map()];
  const out: number[][] = [[]];

  for (const [bytes, patternId] of patterns) {
    let state = 0;
    for (const b of bytes) {
      const t = trans[state] as Map<number, number>;
      let nxt = t.get(b);
      if (nxt === undefined) {
        nxt = trans.length;
        t.set(b, nxt);
        trans.push(new Map());
        out.push([]);
      }
      state = nxt;
    }
    (out[state] as number[]).push(patternId);
  }

  const sortedUnique = (ids: readonly number[]): number[] => [...new Set(ids)].sort((a, b) => a - b);

  for (let i = 0; i < out.length; i++) {
    if ((out[i] as number[]).length > 1) {
      out[i] = sortedUnique(out[i] as number[]);
    }
  }

  const fail = new Uint32Array(trans.length);
  const q: number[] = [...(trans[0] as Map<number, number>).values()];
  for (let qi = 0; qi < q.length; qi++) {
    const v = q[qi] as number;
    for (const [b, u] of trans[v] as Map<number, number>) {
      q.push(u);
      let f = fail[v] as number;
      while (f !== 0 && !(trans[f] as Map<number, number>).has(b)) {
        f = fail[f] as number;
      }
      fail[u] = (trans[f] as Map<number, number>).get(b) ?? 0;
      const failOut = out[fail[u] as number] as number[];
      if (failOut.length) {
        out[u] = sortedUnique((out[u] as number[]).concat(failOut));
      }
    }
  }

  const nodeCount = trans.length;
  const childrenStart = new Uint32Array(nodeCount);
  const childrenCount = new Uint32Array(nodeCount);
  const outStart = new Uint32Array(nodeCount);
  const outCount = new Uint32Array(nodeCount);
  let edgeTotal = 0;
  let outTotal = 0;
  for (let i = 0; i < nodeCount; i++) {
    edgeTotal += (trans[i] as Map<number, number>).size;
    outTotal += (out[i] as number[]).length;
  }
  const labels = new Uint8Array(edgeTotal);
  const nextState = new Uint32Array(edgeTotal);
  const outputs = new Uint32Array(outTotal);

  let edgeCursor = 0;
  let outCursor = 0;
  for (let i = 0; i < nodeCount; i++) {
    const edges = [...(trans[i] as Map<number, number>)].sort((x, y) => x[0] - y[0]);
    childrenStart[i] = edgeCursor;
    childrenCount[i] = edges.length;
    for (const [b, nxt] of edges) {
      labels[edgeCursor] = b;
      nextState[edgeCursor] = nxt;
      edgeCursor++;
    }
    const o = out[i] as number[];
    outStart[i] = outCursor;
    outCount[i] = o.length;
    outputs.set(o, outCursor);
    outCursor += o.length;
  }

  return new Automaton({ childrenStart, childrenCount, fail, outStart, outCount, labels, nextState, outputs });
}

class ByteWriter {
  buf = new Uint8Array(1024);
  len = 0;

  ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) {
      return;
    }
    let cap = this.buf.length * 2;
    while (cap < this.len + extra) {
      cap *= 2;
    }
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  varint(value: number): void {
    if (value < 0x80) {
      this.ensure(1);
      this.buf[this.len++] = value;
    } else {
      this.bytes(encodeVarint(value));
    }
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
}

export function serializeAutomaton(a: Automaton): Uint8Array {
  const w = new ByteWriter();
  const nodeCount = a.childrenStart.length;
  w.varint(nodeCount);
  w.varint(a.labels.length);
  w.varint(a.outputs.length);
  for (let i = 0; i < nodeCount; i++) {
    w.varint(a.childrenStart[i] as number);
    w.varint(a.childrenCount[i] as number);
    w.varint(a.fail[i] as number);
    w.varint(a.outStart[i] as number);
    w.varint(a.outCount[i] as number);
  }
  w.bytes(a.labels);
  for (const nxt of a.nextState) {
    w.varint(nxt);
  }
  for (const patternId of a.outputs) {
    w.varint(patternId);
  }
  return w.buf.slice(0, w.len);
}

export function deserializeAutomaton(data: Uint8Array, patternCount: number): Automaton {
  let pos = 0;
  const read = (): number => {
    const r = decodeVarint(data, pos);
    pos = r.offset;
    return r.value;
  };

  const nodeCount = read();
  const edgeCount = read();
  const outputTotal = read();
  if (nodeCount < 1 || nodeCount * 5 + edgeCount * 2 + outputTotal > data.length) {
    throw new FormatError("automaton counts exceed block size");
  }

  const childrenStart = new Float64Array(nodeCount);
  const childrenCount = new Float64Array(nodeCount);
  const fail = new Float64Array(nodeCount);
  const outStart = new Float64Array(nodeCount);
  const outCount = new Float64Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    childrenStart[i] = read();
    childrenCount[i] = read();
    fail[i] = read();
    outStart[i] = read();
    outCount[i] = read();
  }

  if (pos + edgeCount > data.length) {
    throw new FormatError("truncated automaton labels");
  }
  const labels = data.slice(pos, pos + edgeCount);
  pos += edgeCount;
  const nextState = new Float64Array(edgeCount);
  for (let i = 0; i < edgeCount; i++) {
    nextState[i] = read();
  }
  const outputs = new Float64Array(outputTotal);
  for (let i = 0; i < outputTotal; i++) {
    outputs[i] = read();
  }

  if (pos !== data.length) {
    throw new FormatError("automaton block has trailing bytes");
  }

  for (let i = 0; i < nodeCount; i++) {
    if ((childrenStart[i] as number) + (childrenCount[i] as number) > edgeCount) {
      throw new FormatError("automaton edge range out of bounds");
    }
    if ((outStart[i] as number) + (outCount[i] as number) > outputTotal) {
      throw new FormatError("automaton output range out of bounds");
    }
    if ((fail[i] as number) >= nodeCount) {
      throw new FormatError("automaton fail link out of bounds");
    }
  }
  if (nextState.some((n) => n >= nodeCount || n === 0)) {
    throw new FormatError("automaton transition out of bounds");
  }
  if (outputs.some((p) => p >= patternCount)) {
    throw new FormatError("automaton output references unknown pattern");
  }

  const automaton = new Automaton({
    childrenStart: Uint32Array.from(childrenStart),
    childrenCount: Uint32Array.from(childrenCount),
    fail: Uint32Array.from(fail),
    outStart: Uint32Array.from(outStart),
    outCount: Uint32Array.from(outCount),
    labels,
    nextState: Uint32Array.from(nextState),
    outputs: Uint32Array.from(outputs),
  });
  checkFailLinks(automaton);
  return automaton;
}

function checkFailLinks(a: Automaton): void {
  const nodeCount = a.childrenStart.length;
  const depth = new Int32Array(nodeCount).fill(-1);
  depth[0] = 0;
  const queue = [0];
  for (let qi = 0; qi < queue.length; qi++) {
    const v = queue[qi] as number;
    const start = a.childrenStart[v] as number;
    const end = start + (a.childrenCount[v] as number);
    for (let e = start; e < end; e++) {
      const u = a.nextState[e] as number;
      if (depth[u] === -1) {
        depth[u] = (depth[v] as number) + 1;
        queue.push(u);
      }
    }
  }
  for (const v of queue) {
    if (v !== 0 && (depth[a.fail[v] as number] as number) >= (depth[v] as number)) {
      throw new FormatError("automaton fail links do not terminate");
    }
  }
}

export function findContains(a: Automaton, data: Uint8Array): [number, number][] {
  const found: [number, number][] = [];
  let state = 0;
  for (let i = 0; i < data.length; i++) {
    const b = data[i] as number;
    while (true) {
      const nxt = a.transition(state, b);
      if (nxt !== -1) {
        state = nxt;
        break;
      }
      if (state === 0) {
        break;
      }
      state = a.fail[state] as number;
    }
    if (a.outCount[state]) {
      for (const patternId of a.outputsOf(state)) {
        found.push([i + 1, patternId]);
      }
    }
  }
  return found;
}

export function findPrefix(a: Automaton, data: Uint8Array, lengths: readonly number[]): [number, number][] {
  const found: [number, number][] = [];
  let state = 0;
  for (let i = 0; i < data.length; i++) {
    state = a.transition(state, data[i] as number);
    if (state === -1) {
      break;
    }
    const depth = i + 1;
    if (a.outCount[state]) {
      for (const patternId of a.outputsOf(state)) {
        if (lengths[patternId] === depth) {
          found.push([depth, patternId]);
        }
      }
    }
  }
  return found;
}
