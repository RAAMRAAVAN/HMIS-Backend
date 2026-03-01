export function normalizeDbTimestampToIso(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return value.toISOString();
  }

  const raw = String(value).trim();
  if (!raw) return null;

  const hasTimezoneInfo = /(?:z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const normalized = hasTimezoneInfo
    ? raw
    : `${raw.replace(" ", "T")}Z`;

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;

  return parsed.toISOString();
}
