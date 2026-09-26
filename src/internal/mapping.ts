
export type Mapping = ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>;

export function isMapping(value: unknown): value is Mapping {
  if (value instanceof Map) {
    return true;
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function isSequence(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

export function mappingEntries(m: Mapping): [unknown, unknown][] {
  if (m instanceof Map) {
    return [...(m as ReadonlyMap<unknown, unknown>).entries()];
  }
  return Object.entries(m);
}

export function mappingKeys(m: Mapping): unknown[] {
  if (m instanceof Map) {
    return [...(m as ReadonlyMap<unknown, unknown>).keys()];
  }
  return Object.keys(m);
}

export function mappingGet(m: Mapping, key: string): unknown {
  if (m instanceof Map) {
    return (m as ReadonlyMap<unknown, unknown>).get(key) ?? null;
  }
  return Object.hasOwn(m, key) ? ((m as Record<string, unknown>)[key] ?? null) : null;
}
