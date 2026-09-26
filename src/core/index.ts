import { findContains, findPrefix } from "../format/automaton.ts";
import { formatMapValue, htmlHeads, normalize, parseValues, specFromJson } from "../internal/groups.ts";
import { toPlain } from "../internal/json.ts";
import { isMapping, mappingEntries, mappingGet } from "../internal/mapping.ts";
import { compareCodePoints, lower, utf8Encode } from "../internal/text.ts";
import { FormatError } from "../types/exceptions.ts";
import type {
  Automaton,
  GroupSpec,
  Hit,
  Item,
  MatchResult,
  Occurrence,
  Pattern,
} from "../types/models.ts";
import type { SearchDefinition } from "../types/rules.ts";

export type AutomatonLoader = (group: string, patternCount: number) => Automaton | null;
export type MatchValues = string | Iterable<string> | Readonly<Record<string, string>> | ReadonlyMap<string, string>;

export interface MatchGroupOptions {
  name?: string | null;
}

function noMatch(head = ""): MatchResult {
  return { result: false, itemId: null, item: null, head, patternId: null };
}

function listAt<T>(list: readonly T[], i: number): T {
  const j = i < 0 ? list.length + i : i;
  if (!Number.isInteger(j) || j < 0 || j >= list.length) {
    throw new RangeError("list index out of range");
  }
  return list[j] as T;
}

export class Index {
  readonly name: string;
  readonly groups: ReadonlyMap<string, GroupSpec>;
  readonly items: readonly Item[];
  readonly #patterns: [string, string][] = [];
  readonly #patternItems: number[][] = [];
  readonly #loadAutomaton: AutomatonLoader;
  readonly #automata = new Map<string, Automaton | null>();
  readonly #exact = new Map<string, Map<string, number>>();
  readonly #groupCounts = new Map<string | null, number[]>();
  #lengths: number[] | null = null;
  #keyIds: Map<string, number> | null = null;
  #sortedKeys: [string, number][] | null = null;

  constructor(name: string, payload: unknown, loadAutomaton: AutomatonLoader) {
    if (!isMapping(payload)) {
      throw new FormatError(`index ${name}: payload must be an object`);
    }

    const groupsRaw = mappingGet(payload, "groups");
    if (!isMapping(groupsRaw)) {
      throw new FormatError(`index ${name}: groups must be an object`);
    }
    const groups = new Map<string, GroupSpec>();
    for (const [g, cfg] of mappingEntries(groupsRaw)) {
      groups.set(String(g), specFromJson(String(g), cfg));
    }
    this.groups = groups;

    const itemsRaw = mappingGet(payload, "items");
    if (!Array.isArray(itemsRaw)) {
      throw new FormatError(`index ${name}: items must be an array`);
    }
    const items: Item[] = [];
    for (const entry of itemsRaw as unknown[]) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw new FormatError(`index ${name}: item must be [key, data]`);
      }
      const [key, value] = entry as unknown[];
      if (typeof key !== "string" || !key) {
        throw new FormatError(`index ${name}: item key must be a non-empty string`);
      }
      items.push({ key, data: toPlain(value) });
    }
    this.items = items;

    const patternsRaw = mappingGet(payload, "patterns");
    const patternItemsRaw = mappingGet(payload, "pattern_items");
    if (!Array.isArray(patternsRaw) || !Array.isArray(patternItemsRaw)) {
      throw new FormatError(`index ${name}: patterns and pattern_items must be arrays`);
    }
    if (patternsRaw.length !== patternItemsRaw.length) {
      throw new FormatError(`index ${name}: patterns and pattern_items differ in length`);
    }

    const itemCount = items.length;
    patternsRaw.forEach((p: unknown, i: number) => {
      const ids: unknown = patternItemsRaw[i];
      if (!Array.isArray(p) || p.length !== 2 || !p.every((x) => typeof x === "string")) {
        throw new FormatError(`index ${name}: pattern must be [group, text]`);
      }
      const [group, text] = p as [string, string];
      if (!groups.has(group)) {
        throw new FormatError(`index ${name}: pattern references unknown group: ${group}`);
      }
      if (!Array.isArray(ids) || !ids.length) {
        throw new FormatError(`index ${name}: pattern_items entry must be a non-empty array`);
      }
      const idList = ids as unknown[];
      if (!idList.every((x) => typeof x === "number" && Number.isInteger(x) && x >= 0 && x < itemCount)) {
        throw new FormatError(`index ${name}: pattern_items references unknown item`);
      }
      const nums = idList as number[];
      if (!nums.every((x, j) => j === 0 || x > (nums[j - 1] as number))) {
        throw new FormatError(`index ${name}: pattern_items entry must be sorted and unique`);
      }
      this.#patterns.push([group, text]);
      this.#patternItems.push(nums);
    });

    this.name = name;
    this.#loadAutomaton = loadAutomaton;
  }

  get patternTotal(): number {
    return this.#patterns.length;
  }

  pattern(patternId: number): Pattern {
    const [group, text] = listAt(this.#patterns, patternId);
    const id = patternId < 0 ? this.#patterns.length + patternId : patternId;
    return { id: patternId, group, text, itemIds: [...(this.#patternItems[id] as number[])] };
  }

  item(key: string): Item | null {
    const itemId = this.itemId(key);
    return itemId === null ? null : (this.items[itemId] as Item);
  }

  itemId(key: string): number | null {
    if (this.#keyIds === null) {
      this.#keyIds = new Map(this.items.map((item, i) => [item.key, i]));
    }
    return this.#keyIds.get(key) ?? null;
  }

  itemsWithPrefix(prefix: string): Item[] {
    if (this.#sortedKeys === null) {
      this.#sortedKeys = this.items
        .map((item, i): [string, number] => [item.key, i])
        .sort((a, b) => compareCodePoints(a[0], b[0]) || a[1] - b[1]);
    }
    const keys = this.#sortedKeys;
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareCodePoints((keys[mid] as [string, number])[0], prefix) < 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    const out: Item[] = [];
    for (let i = lo; i < keys.length; i++) {
      const [key, itemId] = keys[i] as [string, number];
      if (!key.startsWith(prefix)) {
        break;
      }
      out.push(this.items[itemId] as Item);
    }
    return out;
  }

  patternCount(itemId: number, group: string | null = null): number {
    let counts = this.#groupCounts.get(group);
    if (counts === undefined) {
      counts = new Array<number>(this.items.length).fill(0);
      this.#patterns.forEach(([g], pid) => {
        if (group === null || g === group) {
          for (const i of this.#patternItems[pid] as number[]) {
            (counts as number[])[i] = ((counts as number[])[i] as number) + 1;
          }
        }
      });
      this.#groupCounts.set(group, counts);
    }
    return listAt(counts, itemId);
  }

  preload(): void {
    for (const [group, spec] of this.groups) {
      if (spec.match === "exact") {
        this.#exactMap(group);
      } else {
        this.#automaton(group);
      }
    }
    this.#patternLengths();
  }

  spec(group: string): GroupSpec {
    const spec = this.groups.get(group);
    if (spec === undefined) {
      throw new FormatError(`unknown group: ${group}`);
    }
    return spec;
  }

  #automaton(group: string): Automaton | null {
    if (!this.#automata.has(group)) {
      this.#automata.set(group, this.#loadAutomaton(group, this.#patterns.length));
    }
    return this.#automata.get(group) as Automaton | null;
  }

  #patternLengths(): number[] {
    if (this.#lengths === null) {
      this.#lengths = this.#patterns.map(([, text]) => utf8Encode(text).length);
    }
    return this.#lengths;
  }

  #exactMap(group: string): Map<string, number> {
    let table = this.#exact.get(group);
    if (table === undefined) {
      table = new Map();
      this.#patterns.forEach(([g, text], pid) => {
        if (g === group) {
          (table as Map<string, number>).set(text, pid);
        }
      });
      this.#exact.set(group, table);
    }
    return table;
  }

  #find(spec: GroupSpec, head: string): [number, number][] {
    if (spec.match === "exact") {
      const pid = this.#exactMap(spec.name).get(head);
      return pid === undefined ? [] : [[utf8Encode(head).length, pid]];
    }
    const automaton = this.#automaton(spec.name);
    if (automaton === null) {
      return [];
    }
    const data = utf8Encode(head);
    if (spec.match === "prefix") {
      return findPrefix(automaton, data, this.#patternLengths());
    }
    return findContains(automaton, data);
  }

  #first(spec: GroupSpec, head: string): MatchResult {
    const found = this.#find(spec, head);
    if (!found.length) {
      return noMatch(head);
    }
    let end = Infinity;
    for (const [e] of found) {
      end = Math.min(end, e);
    }
    let bestItem = -1;
    let bestPid = -1;
    for (const [e, pid] of found) {
      if (e !== end) {
        continue;
      }
      const itemId = (this.#patternItems[pid] as number[])[0] as number;
      if (bestItem === -1 || itemId < bestItem || (itemId === bestItem && pid < bestPid)) {
        bestItem = itemId;
        bestPid = pid;
      }
    }
    return { result: true, itemId: bestItem, item: this.items[bestItem] as Item, head, patternId: bestPid };
  }

  #heads(spec: GroupSpec, values: unknown, name: string | null = null): string[] {
    if (typeof values === "string") {
      let value = values;
      if (spec.kind === "map") {
        if (name === null) {
          throw new FormatError(`group ${spec.name} requires a name`);
        }
        value = formatMapValue(name, value);
      } else if (name !== null) {
        throw new FormatError(`group ${spec.name} does not accept a name`);
      }
      return [normalize(spec, value)];
    }
    if (name !== null) {
      throw new FormatError("name is only accepted with a single value");
    }
    let raw: string[] = [];
    if (isMapping(values)) {
      if (spec.kind !== "map") {
        throw new FormatError(`group ${spec.name} does not accept a name`);
      }
      raw = parseValues(spec, values);
    } else if (typeof values === "object" && values !== null && Symbol.iterator in values) {
      for (const v of values as Iterable<unknown>) {
        if (typeof v !== "string") {
          throw new FormatError(`${spec.name} values must be strings`);
        }
        raw.push(v);
      }
    } else {
      throw new FormatError(`${spec.name} values must be a string, list, or object`);
    }
    return raw.map((v) => normalize(spec, v));
  }

  match(head: string): MatchResult {
    const spec = this.spec("headers");
    return this.#first(spec, normalize(spec, head));
  }

  matchGroup(group: string, value: string, options: MatchGroupOptions = {}): MatchResult {
    const spec = this.spec(group);
    return this.#first(spec, listAt(this.#heads(spec, value, options.name ?? null), 0));
  }

  matchSearch(search: SearchDefinition): MatchResult {
    if (!isMapping(search)) {
      throw new FormatError("search must be an object");
    }
    for (const [group, values] of mappingEntries(search)) {
      const spec = this.spec(group as string);
      for (const value of parseValues(spec, values)) {
        const result = this.#first(spec, normalize(spec, value));
        if (result.result) {
          return result;
        }
      }
    }
    return noMatch();
  }

  matchHtml(html: string): MatchResult {
    const spec = this.spec("html");
    for (const head of htmlHeads(html)) {
      const result = this.#first(spec, normalize(spec, head));
      if (result.result) {
        return result;
      }
    }
    return noMatch();
  }

  matchAll(group: string, values: MatchValues): Hit[] {
    const spec = this.spec(group);
    const heads = typeof values === "string" ? [normalize(spec, values)] : this.#heads(spec, values);
    const patternIds = new Set<number>();
    for (const head of heads) {
      for (const [, pid] of this.#find(spec, head)) {
        patternIds.add(pid);
      }
    }
    return this.hitsFor(patternIds);
  }

  matchTokens(group: string, tokens: Iterable<string>): Map<number, number> {
    if (typeof tokens === "string") {
      throw new FormatError("tokens must be a list of strings");
    }
    return new Map(this.matchAll(group, tokens).map((hit) => [hit.itemId, hit.hits]));
  }

  scan(text: string, group: string): Occurrence[] {
    const spec = this.spec(group);
    if (spec.match === "exact") {
      throw new FormatError(`group ${group} uses exact match and cannot be scanned`);
    }
    const automaton = this.#automaton(group);
    if (automaton === null) {
      return [];
    }
    const data = utf8Encode(spec.ignoreCase ? lower(text) : text);
    const lengths = this.#patternLengths();
    return findContains(automaton, data).map(([end, patternId]) => ({
      patternId,
      start: end - (lengths[patternId] as number),
      end,
    }));
  }

  hitsFor(patternIds: Iterable<number>): Hit[] {
    const perItem = new Map<number, number[]>();
    for (const pid of [...new Set(patternIds)].sort((a, b) => a - b)) {
      if (!Number.isInteger(pid) || pid < 0 || pid >= this.#patterns.length) {
        throw new FormatError(`unknown pattern id: ${pid}`);
      }
      for (const itemId of this.#patternItems[pid] as number[]) {
        let list = perItem.get(itemId);
        if (list === undefined) {
          list = [];
          perItem.set(itemId, list);
        }
        list.push(pid);
      }
    }
    const hits: Hit[] = [...perItem].map(([itemId, pids]) => ({
      itemId,
      item: this.items[itemId] as Item,
      hits: pids.length,
      patternIds: pids,
    }));
    hits.sort((a, b) => b.hits - a.hits || a.itemId - b.itemId);
    return hits;
  }
}
