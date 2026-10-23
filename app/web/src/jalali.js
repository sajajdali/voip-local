import { toJalaali, toGregorian, jalaaliMonthLength } from 'jalaali-js';

export const pad = n => String(n).padStart(2, '0');
export const MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
export const WD_NAMES = ['شنبه', 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه'];
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
export const faNum = s => String(s).replace(/\d/g, d => FA_DIGITS[d]);

export const jStr = d => { const j = toJalaali(d); return j.jy + '/' + pad(j.jm) + '/' + pad(j.jd); };
export const jToDate = s => { const [y, m, d] = s.split('/').map(Number); const g = toGregorian(y, m, d); return new Date(g.gy, g.gm - 1, g.gd); };
// 0 = Saturday … 6 = Friday (Iranian week)
export const jWeekday = d => (d.getDay() + 1) % 7;
export const jAdd = (days, from = new Date()) => { const d = new Date(from); d.setDate(d.getDate() + days); return jStr(d); };
export const jLong = d => { const j = toJalaali(d); return WD_NAMES[jWeekday(d)] + ' ' + faNum(j.jd) + ' ' + MONTHS[j.jm - 1] + ' ' + faNum(j.jy); };
export const monthLen = (y, m) => jalaaliMonthLength(y, m);
export const weekdayOf = (y, m, d) => jWeekday(jToDate(y + '/' + pad(m) + '/' + pad(d)));

export const TODAY = jStr(new Date());
export const MONTH_START = TODAY.slice(0, 8) + '01';
