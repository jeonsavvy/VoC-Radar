export interface AppSelection {
  appId: string;
  country: string;
}

const STORAGE_KEY = 'voc-radar.selection.v1';

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
  if (typeof window === 'undefined') {
    return defaultSelection;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return defaultSelection;
    }

    const parsed = JSON.parse(raw) as Partial<AppSelection>;
    const appId = parsed.appId && isValidAppId(parsed.appId) ? parsed.appId : defaultSelection.appId;
    const country = parsed.country ? normalizeCountry(parsed.country) : defaultSelection.country;

    return { appId, country };
  } catch {
    return defaultSelection;
  }
}

export function persistSelection(selection: AppSelection) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      appId: selection.appId,
      country: selection.country,
    }),
  );
}
