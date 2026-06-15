const toSnakeCaseKey = (key: string): string =>
  key.replace(/([A-Z])/g, '_$1').replace(/^_/, '').toLowerCase();

export const serializeForApi = (value: unknown): unknown => {
  if (value == null) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializeForApi);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [
        toSnakeCaseKey(key),
        serializeForApi(val),
      ])
    );
  }
  return value;
};
