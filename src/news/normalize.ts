import { createHash } from 'node:crypto';

/** Publisher links are identities only; this module never fetches them. */
export function canonicalUrl(input: string): string {
  const url = new URL(input);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new Error('NEWS_INVALID_URL');
  if (
    !url.hostname.includes('.') ||
    url.hostname.endsWith('.local') ||
    /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
      url.hostname,
    ) ||
    url.hostname.includes(':') ||
    /^\[/.test(url.hostname)
  )
    throw new Error('NEWS_INVALID_URL');
  url.hash = '';
  for (const key of [...url.searchParams.keys()])
    if (/^utm_/i.test(key) || /^(fbclid|gclid|msclkid)$/i.test(key)) url.searchParams.delete(key);
  return url.href;
}
export function publisherDomain(input: string): string {
  return new URL(canonicalUrl(input)).hostname.toLowerCase();
}
export function newsId(...parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** Explicit offsets only, with provider-specific UTC formats handled deliberately. */
export function utcTimestamp(
  input: string,
  format: 'rfc3339' | 'marketaux' | 'currents' | 'gdelt' = 'rfc3339',
): number {
  let value = input;
  if (format === 'marketaux' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(value)) value += 'Z';
  if (format === 'currents')
    value = value.replace(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)$/, '$1T$2$3:$4');
  if (format === 'gdelt')
    value = value.replace(/^(\d{4})(\d\d)(\d\d)T?(\d\d)(\d\d)(\d\d)Z?$/, '$1-$2-$3T$4:$5:$6Z');
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,9})?(Z|[+-]\d\d:\d\d)$/.exec(
    value,
  );
  if (!match) throw new Error('NEWS_INVALID_TIMESTAMP');
  const [, year, month, day, hour, minute, second, offset] = match;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (
    Number(month) < 1 ||
    Number(month) > 12 ||
    Number(day) < 1 ||
    Number(day) > days ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    (offset !== 'Z' && (Number(offset!.slice(1, 3)) > 23 || Number(offset!.slice(4)) > 59))
  )
    throw new Error('NEWS_INVALID_TIMESTAMP');
  const result = Date.parse(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('NEWS_INVALID_TIMESTAMP');
  return result;
}
