export interface AppSelection {
  appId: string;
  country: string;
}

const fallbackAppId = import.meta.env.VITE_DEFAULT_APP_ID || '1018769995';
const fallbackCountry = (import.meta.env.VITE_DEFAULT_COUNTRY || 'kr').toLowerCase();

export const defaultSelection: AppSelection = {
  appId: fallbackAppId,
  country: fallbackCountry,
};

export function isValidAppId(value: string) {
  return /^\d{5,20}$/.test(value.trim());
}

export function normalizeCountry(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(normalized)) {
    return defaultSelection.country;
  }
  return normalized;
}

export function readSelection(): AppSelection {
  return defaultSelection;
}

export function persistSelection(_selection: AppSelection) {}
