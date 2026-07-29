export function normalizeDefaultCountry(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-z]{2}$/.test(normalized) ? normalized : 'kr';
}

export const DEFAULT_COUNTRY = normalizeDefaultCountry(import.meta.env.VITE_DEFAULT_COUNTRY);
