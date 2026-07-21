export function parseAppIdentity(value: string, fallbackCountry = 'kr') {
  const input = value.trim();
  const direct = /^\d{5,20}$/.exec(input)?.[0];
  const id = direct || input.match(/(?:\/id|\bid)(\d{5,20})(?:\b|[/?#])/i)?.[1] || null;
  const storefront = input.match(/apps\.apple\.com\/([a-z]{2})\//i)?.[1]?.toLowerCase();
  return id ? { appId: id, country: storefront || fallbackCountry.toLowerCase() } : null;
}

export function reportPath(appId: string, country = 'kr', tab = 'issues') {
  return `/apps/${country.toLowerCase()}/${appId}/${tab}`;
}
