// Who may see and change what: per user, per panel section, view / add / edit / delete.
// The «مدیر» role always has everything; other users carry their own permission list.

export type Action = 'view' | 'add' | 'edit' | 'delete';
export type Perms = Record<string, Action[]>;

export interface Section { key: string; label: string; group: string; actions: Action[]; hint?: Partial<Record<Action, string>> }

const ALL: Action[] = ['view', 'add', 'edit', 'delete'];
export const SECTIONS: Section[] = [
  { key: 'calls', label: 'لیست تماس‌ها و پرونده بیمار', group: 'مرکز تماس', actions: ['view', 'edit', 'delete'], hint: { edit: 'تماس با بیمار، یادداشت و پیگیری', delete: 'حذف دائمی تماس‌ها و ضبط‌ها' } },
  { key: 'inbound', label: 'تماس‌های ورودی', group: 'مرکز تماس', actions: ['view'] },
  { key: 'live', label: 'تماس‌های زنده', group: 'مرکز تماس', actions: ['view', 'edit'], hint: { edit: 'گوش دادن به مکالمه' } },
  { key: 'voice', label: 'پیام‌های صوتی', group: 'مرکز تماس', actions: ['view', 'edit'], hint: { edit: 'پیگیری و ارجاع' } },
  { key: 'unreached', label: 'پیگیری‌نشده‌ها', group: 'مرکز تماس', actions: ['view'] },
  { key: 'refer', label: 'ارجاع تماس', group: 'مرکز تماس', actions: ['view', 'add', 'edit'], hint: { add: 'ارجاع دادن تماس', edit: 'رسیدگی به ارجاع‌های داخلی خود' } },
  { key: 'referall', label: 'همه ارجاع‌ها و گزارش ارجاع', group: 'مرکز تماس', actions: ['view'] },
  { key: 'bookings', label: 'تماس‌های نوبت‌دهی', group: 'مرکز تماس', actions: ['view', 'edit'], hint: { edit: 'ثبت پیگیری بیمارانی که نوبت نگرفتند' } },
  { key: 'reports', label: 'گزارش‌ها', group: 'مرکز تماس', actions: ['view'] },
  { key: 'survey', label: 'نظرسنجی', group: 'مرکز تماس', actions: ['view'] },
  { key: 'ai', label: 'تحلیل هوش مصنوعی', group: 'هوش مصنوعی', actions: ['view', 'edit'], hint: { edit: 'تحلیل دستی یک تماس' } },
  { key: 'coach', label: 'ارزیابی عملکرد اپراتورها', group: 'هوش مصنوعی', actions: ['view'] },
  { key: 'aiconv', label: 'گفتگوهای دستیار', group: 'هوش مصنوعی', actions: ['view'] },
  { key: 'bsurvey', label: 'نظرسنجی نوبت‌دهی', group: 'هوش مصنوعی', actions: ['view', 'edit'], hint: { edit: 'تحلیل دوباره با هوش مصنوعی' } },
  { key: 'vext', label: 'داخلی‌ها', group: 'تنظیمات VoIP', actions: ALL },
  { key: 'vtrunk', label: 'ترانک‌ها', group: 'تنظیمات VoIP', actions: ALL },
  { key: 'vqueue', label: 'صف‌ها', group: 'تنظیمات VoIP', actions: ALL },
  { key: 'vivr', label: 'منوهای IVR', group: 'تنظیمات VoIP', actions: ALL },
  { key: 'vsound', label: 'صداها', group: 'تنظیمات VoIP', actions: ALL },
  { key: 'vroute', label: 'مسیرهای ورودی', group: 'تنظیمات VoIP', actions: ALL },
  { key: 'vout', label: 'مسیرهای خروجی', group: 'تنظیمات VoIP', actions: ALL },
  { key: 'vtime', label: 'شرایط و گروه‌های زمانی', group: 'تنظیمات VoIP', actions: ALL },
  { key: 'vring', label: 'گروه زنگ', group: 'تنظیمات VoIP', actions: ALL },
  { key: 'vfollow', label: 'دنبال‌کردن تماس', group: 'تنظیمات VoIP', actions: ALL },
  { key: 'vblack', label: 'لیست سیاه', group: 'تنظیمات VoIP', actions: ALL },
  { key: 'vsurvey', label: 'نظرسنجی بعد از تماس', group: 'تنظیمات VoIP', actions: ['view', 'edit'] },
  { key: 'vvm', label: 'صندوق پیام صوتی', group: 'تنظیمات VoIP', actions: ['view', 'edit'] },
  { key: 'vai', label: 'هوش مصنوعی (مدل و کلید)', group: 'تنظیمات سامانه', actions: ['view', 'edit'] },
  { key: 'vagent', label: 'دستیار هوشمند تلفنی', group: 'تنظیمات سامانه', actions: ['view', 'edit'] },
  { key: 'vbook', label: 'نوبت‌دهی تلفنی', group: 'تنظیمات سامانه', actions: ['view', 'edit'] },
  { key: 'vcrm', label: 'سامانه بیماران', group: 'تنظیمات سامانه', actions: ['view', 'edit'] },
  { key: 'vapi', label: 'ارسال رویدادهای تماس (API)', group: 'تنظیمات سامانه', actions: ['view', 'edit'] },
  { key: 'vsms', label: 'پیامک (پنل و قالب‌ها)', group: 'تنظیمات سامانه', actions: ['view', 'edit'] },
  { key: 'billing', label: 'شارژ دلاری (موجودی و شارژ)', group: 'تنظیمات سامانه', actions: ['view', 'add', 'edit'], hint: { add: 'شارژ حساب و رفتن به درگاه', edit: 'اتصال به سرور شارژ (آدرس و کلید)' } },
  { key: 'usage', label: 'مصرف توکن', group: 'تنظیمات سامانه', actions: ['view', 'edit'], hint: { edit: 'ویرایش جدول قیمت' } },
  { key: 'vbackup', label: 'بکاپ و بازیابی', group: 'تنظیمات سامانه', actions: ALL, hint: { add: 'گرفتن بکاپ', edit: 'بازیابی و زمان‌بندی' } },
  { key: 'sys', label: 'وضعیت سرور', group: 'تنظیمات سامانه', actions: ['view'] },
  { key: 'users', label: 'کاربران و دسترسی‌ها', group: 'تنظیمات سامانه', actions: ALL },
  { key: 'tenants', label: 'مستأجرها و تخصیص DID', group: 'تنظیمات سامانه', actions: ALL },
];
const KEYS = new Set(SECTIONS.map(s => s.key));

/** Super-admin only — never granted to tenant users (even with role admin). */
export const PLATFORM_SECTIONS = new Set(['vtrunk', 'tenants', 'vbackup', 'billing', 'usage', 'sys']);

/** Starting points for the «قالب» buttons and for users created before permissions existed. */
export function rolePerms(role: string): Perms {
  const all: Perms = Object.fromEntries(SECTIONS.map(s => [s.key, [...s.actions]]));
  const pick = (keys: string[], extra: Record<string, Action[]> = {}) => ({ ...Object.fromEntries(keys.map(k => [k, ['view'] as Action[]])), ...extra });
  if (role === 'admin') return all;
  if (role === 'supervisor') return pick(['calls', 'inbound', 'live', 'voice', 'unreached', 'reports', 'survey', 'ai', 'coach', 'aiconv', 'referall'], { calls: ['view', 'edit'], voice: ['view', 'edit'], live: ['view', 'edit'], refer: ['view', 'add', 'edit'] });
  return pick(['calls', 'inbound', 'voice', 'unreached'], { calls: ['view', 'edit'], voice: ['view', 'edit'], refer: ['view', 'add', 'edit'] });
}

/** Keep only known sections and the actions each one supports; «view» is implied by any other action. */
export function cleanPerms(p: any): Perms {
  const out: Perms = {};
  if (!p || typeof p !== 'object') return out;
  for (const s of SECTIONS) {
    const list = Array.isArray(p[s.key]) ? (p[s.key] as string[]).filter(a => (s.actions as string[]).includes(a)) as Action[] : [];
    if (list.length && !list.includes('view')) list.unshift('view');
    if (list.length) out[s.key] = [...new Set(list)];
  }
  return out;
}

export function permsOf(u: { role: string; perms?: any; tenantId?: string | null }): Perms {
  if (u.role === 'admin' && !u.tenantId) return rolePerms('admin');
  const base = u.perms ? cleanPerms(u.perms) : rolePerms(u.role === 'admin' && u.tenantId ? 'supervisor' : u.role);
  if (!u.tenantId) return base;
  const out: Perms = { ...base };
  for (const k of PLATFORM_SECTIONS) delete out[k];
  return out;
}

export function can(u: { role: string; perms?: Perms; tenantId?: string | null } | null | undefined, section: string, action: Action = 'view') {
  if (!u) return false;
  if (u.tenantId && PLATFORM_SECTIONS.has(section)) return false;
  if (u.role === 'admin' && !u.tenantId) return true;
  if (!KEYS.has(section)) return false;
  const pp = u.perms || permsOf(u);
  return !!(pp[section] && pp[section].includes(action));
}

/** VoIP collections → the section that owns them. */
export const CONFIG_SECTION: Record<string, string> = {
  exts: 'vext', trunks: 'vtrunk', vqs: 'vqueue', ivrs: 'vivr', snds: 'vsound', routes: 'vroute', oroutes: 'vout',
  tgroups: 'vtime', tconds: 'vtime', holidays: 'vtime', rgroups: 'vring', fmes: 'vfollow', blist: 'vblack', bset: 'vblack', survey: 'vsurvey', vmbox: 'vvm',
};
