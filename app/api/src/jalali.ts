import { toJalaali, toGregorian } from 'jalaali-js';

const pad = (n: number) => String(n).padStart(2, '0');
export const TZ = process.env.TZ_REGION || 'Asia/Tehran';

/** Wall-clock parts in the clinic's time zone (the server may run in UTC). */
export function localParts(d: Date) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hh: p.hour === '24' ? '00' : p.hour, mm: p.minute };
}

export function jalaliDate(d: Date) {
  const l = localParts(d);
  const j = toJalaali(l.y, l.m, l.d);
  return `${j.jy}/${pad(j.jm)}/${pad(j.jd)}`;
}

export function hhmm(d: Date) { const l = localParts(d); return `${l.hh}:${l.mm}`; }

export function jalaliToDate(s: string) {
  const [y, m, d] = s.split('/').map(Number);
  const g = toGregorian(y, m, d);
  return new Date(Date.UTC(g.gy, g.gm - 1, g.gd));
}

/** 1405/07/26 -> "20261018" (AstDB key used by the holiday check in the dialplan). */
export function jalaliToGregorianCompact(s: string) {
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(s || '')) return '';
  const [y, m, d] = s.split('/').map(Number);
  const g = toGregorian(y, m, d);
  return `${g.gy}${pad(g.gm)}${pad(g.gd)}`;
}

export const todayJ = () => jalaliDate(new Date());
export const jAddDays = (n: number, from = new Date()) => jalaliDate(new Date(from.getTime() + n * 86400000));
