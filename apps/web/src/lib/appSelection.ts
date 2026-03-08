export interface AppSelection {
  appId: string;
  country: string;
}

// 기본 선택 앱은 예시값이다.
// 운영 환경에서는 VITE_DEFAULT_APP_ID로 원하는 초기 앱을 지정할 수 있다.
const fallbackAppId = import.meta.env.VITE_DEFAULT_APP_ID || '1234567890';
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

// 현재 구현은 최근 선택값을 브라우저에 저장하지 않는다.
// 새로고침 후에도 고정된 시작값으로 진입하도록 단순화했다.
export function readSelection(): AppSelection {
  return defaultSelection;
}
