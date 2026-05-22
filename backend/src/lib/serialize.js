const toSnakeCaseKey = (key) =>
  key.replace(/([A-Z])/g, '_$1').replace(/^_/, '').toLowerCase();

const serializeForApi = (value) => {
  if (value == null) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializeForApi);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [toSnakeCaseKey(key), serializeForApi(val)])
    );
  }
  return value;
};

module.exports = { serializeForApi };
