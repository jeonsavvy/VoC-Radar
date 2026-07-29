import { DEFAULT_COUNTRY } from '@/lib/config';

export function parseAppIdentity(value: string, fallbackCountry = DEFAULT_COUNTRY) {
  const input = value.trim();
  const direct = /^\d{5,20}$/.exec(input)?.[0];
  const id = direct || input.match(/(?:\/id|\bid)(\d{5,20})(?:\b|[/?#])/i)?.[1] || null;
  const storefront = input.match(/apps\.apple\.com\/([a-z]{2})\//i)?.[1]?.toLowerCase();
  return id ? { appId: id, country: storefront || fallbackCountry.toLowerCase() } : null;
}

export function reportPath(appId: string, country = DEFAULT_COUNTRY, tab = 'overview') {
  return `/apps/${country.toLowerCase()}/${appId}/${tab}`;
}
