// «نوبت‌دهی تلفنی»: Dr. Amiri's phone booking line, moved from the Issabel PHP IVR (/var/saman/ivr/amiri/voip,
// Voip.php) to the panel. Asterisk reaches it over FastAGI; the booking system is the mata-app VoIP API.
// Scripts (agi://127.0.0.1:4573/<script>):
//   booking       main-menu key 2 (amiri_visit): Mata link for returning patients, or the first free time,
//                 national code, mobile, booking, tracking code read back, satisfaction survey
//   track         main-menu key 3 (tracking_appointment): national code + tracking code, time read back, cancel
//   remind        reminder call the day before (call_fire): 1 confirms, 5 cancels
//   cancelnotice  call telling the patient an appointment was cancelled (call_fire_cancel)
import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response as ExpressResponse } from 'express';
import { randomBytes } from 'crypto';
import { toJalaali } from 'jalaali-js';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { CurrentUser, Me, Perm, Public } from './auth';
import { AiService, BOOKING_SURVEY_CATS } from './ai';
import { ConfigStore } from './config';
import { env } from './env';
import { AgiChan, AgiChannel, AgiHangup, startFastAgi } from './fastagi';
import { TZ, hhmm, jAddDays, jalaliDate, jalaliToDate, todayJ } from './jalali';
import { PrismaService } from './prisma.service';
import { C, al, fill, font, headerRow, sheetBase, titleBlock } from './reports';
import * as ExcelJS from 'exceljs';

export const BOOKING_PORT = 4573;
export const BOOKING_SOUNDS = process.env.BOOKING_SOUNDS_DIR || '/var/lib/asterisk/sounds/booking';
const OUTGOING = process.env.ASTERISK_OUTGOING_DIR || '/var/spool/asterisk/outgoing';

export interface BookingSettings {
  enabled: boolean; code: string; trackCode: string;
  baseUrl: string; user: string; pass: string; apiTimeout: number;
  doctorId: string; placeId: string; kind: string;
  askTreated: boolean; allowCancel: boolean; survey: boolean; surveyMaxSec: number;
  digitTimeout: number; retries: number;
  backDest: string; fallback: string;
  reminders: boolean; remindToken: string; remindRetries: number; remindRetryMin: number; remindRing: number;
}
// the old IVR's values: doctor 4 asked for (the API picks the doctor), place 1, kind 1, 6 s per answer, 3 tries
export const BOOKING_DEFAULTS: BookingSettings = {
  enabled: false, code: '*643', trackCode: '*644',
  baseUrl: 'https://app.mata-app.com/api/v1/voip', user: '', pass: '', apiTimeout: 12,
  doctorId: '4', placeId: '1', kind: '1',
  askTreated: true, allowCancel: true, survey: true, surveyMaxSec: 30,
  digitTimeout: 6, retries: 3,
  backDest: '', fallback: '',
  reminders: false, remindToken: '', remindRetries: 2, remindRetryMin: 60, remindRing: 60,
};

const clamp = (v: any, min: number, max: number, d: number) => { const n = Math.round(+v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const word = (v: any) => String(v ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '');

// ---------------------------------------------------------------- prompts and speech

/** The old IVR's recordings, by the names its code used (files under BOOKING_SOUNDS). */
export const MSG = {
  arezoo: 'int/s4-2-arezoye-salamati', noInput: 'pay/no_number_entered', wrongNumber: 'int/n-invalid-number',
  treated: 'mata/amiri_check', mataOffer: 'mata/amiri_full', mataSent: 'mata/mata_sendBTsms',
  firstVisit: 'mata/amiri_first_visit', noTimes: 'mata/amiri_full_appNotFound',
  firstTime: 'int/2-1-daryaft-nobat', saate: 'int/n-daryaft-nobat-dar-saate', chooseTime: 'int/2-2-select-roz',
  codeMeli: 'int/n-enter-cod-meli', wrongCodeMeli: 'int/n-invalid-col-meli',
  mobileAuto: 'int/n-mobile-shomare-mobile-tamas-gerefte-shode', mobileIs: 'int/n-mobile-number-is-',
  mobileConfirm: 'int/n-mobile-shomare-mobile-tamas-gerefte-shode-mibashad', enterMobile: 'int/n-mobile-insert-mobile-number',
  wrongMobile: 'int/n-mobile-invalid-phone-number',
  yourCode: 'int/n-store-sabt-nobat-shomare-peygiri', forDay: 'int/n-store-baraye-roze', stored: 'int/n-store-sabt-shod',
  duplicate: 'int/nobate-tekrari', notFound: 'int/23-nobati-yaft-nashof', mibashad: 'int/s2-3-mibashad-',
  survey: 'int/n-naza-sanji-nobat-dehi', surveyWrong: 'int/n-nazar-sanji-invalid-number', surveyRecord: 'int/n-nazar-sangi-voice-mail', surveyBye: 'int/n-nazar-sangi-bye',
  trackingCode: 'int/s1-3-shomare-peygiri', trackNotFound: 'int/30-hivh-nobati-yaft-nashod',
  askCancel: 'int/cancel_appointment', cancelled: 'int/successfully_cancel',
  remindStart: 'pay/amiri_start_at', remindEnd: 'pay/amiri_end_at',
  cancelNoticeStart: 'int/reminder_cancel_start', cancelNoticeEnd: 'int/reminder_cancel_end',
};

/** Wall clock in the clinic's time zone, with the weekday (the server runs in UTC). */
function tehran(at: Date) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(at).map(x => [x.type, x.value]));
  return { wd: p.weekday, y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute };
}

const DAY: Record<string, string> = { Sat: 'extra/shanbeh', Sun: 'extra/1shanbeh', Mon: 'extra/2shanbeh', Tue: 'extra/3shanbeh', Wed: 'extra/4shanbeh', Thu: 'extra/5shanbeh', Fri: 'extra/jomeh' };
const MONTH = ['farvardin', 'ordibehesht', 'khordad', 'tir', 'mordad', 'shahrivar', 'mehr', 'aban', 'azar', 'dey-mah', 'bahman', 'esfand'];

/** A Persian number up to 999 from the digit prompts: 25 -> «بیست و» «پنج», 120 -> «صد و» «بیست». */
export function numberFa(n: number): string[] {
  n = Math.max(0, Math.floor(n));
  if (n <= 20) return ['digits/' + n];
  if (n < 100) { const t = Math.floor(n / 10) * 10, u = n % 10; return u ? [`digits/${t}-o`, 'digits/' + u] : ['digits/' + t]; }
  if (n < 1000) {
    const h = Math.floor(n / 100), r = n % 100;
    const name = h === 1 ? 'hundred' : String(h * 100);
    return r ? [`digits/${name}-o`, ...numberFa(r)] : ['digits/' + name];
  }
  return String(n).split('').map(d => 'digits/' + d);
}

/** «در ساعت ده و سی دقیقه»: the hour, then «و … دقیقه» only when there are minutes. */
export function sayTime(h: number, mi: number, lead = MSG.saate): string[] {
  return [lead, ...numberFa(h), ...(mi > 0 ? ['extra/va', ...numberFa(mi), 'digits/daghigheh'] : [])];
}

/** «شنبه دهمِ آبان در ساعت …» as the old IVR said it (weekday, day of month, month, time). */
export function sayDate(at: Date): string[] {
  const p = tehran(at);
  const j = toJalaali(p.y, p.m, p.d);
  return [DAY[p.wd], `digits/${j.jd}-me`, 'digits/' + MONTH[j.jm - 1], ...sayTime(p.h, p.mi)];
}

/** Tracking code in groups of three from the left, each read as a number (85504499 -> 855 / 44 / 99). */
export function sayCode(code: string): string[] {
  const s = String(code).replace(/\D/g, '');
  const out: string[] = [];
  for (let i = 0; i < s.length; i += 3) out.push(...numberFa(parseInt(s.slice(i, i + 3), 10)));
  return out;
}

/** 0912 345 67 89 as «صفر» «نهصد و دوازده» …; leading zeros of a group are read one by one. */
export function sayMobile(m: string): string[] {
  const group = (g: string): string[] => (!g ? [] : g[0] === '0' ? ['digits/0', ...group(g.slice(1))] : numberFa(parseInt(g, 10)));
  return ['digits/0', ...group(m.slice(1, 4)), ...group(m.slice(4, 7)), ...group(m.slice(7, 9)), ...group(m.slice(9, 11))];
}

/** 09xxxxxxxxx from a caller ID or keyed digits (98…, +98…, 0098…, 9…), or null. */
export function normalizeMobile(d: string): string | null {
  let m = String(d || '').replace(/[^\d+]/g, '');
  if (m.startsWith('+98')) m = '0' + m.slice(3);
  else if (m.startsWith('0098')) m = '0' + m.slice(4);
  else if (m.startsWith('98')) m = '0' + m.slice(2);
  else if (m.startsWith('9')) m = '0' + m;
  return /^09\d{9}$/.test(m) ? m : null;
}

/** Iranian national code checksum (the old IVR's checkNationalCode). */
export function validNationalCode(code: string): boolean {
  if (!/^\d{10}$/.test(code)) return false;
  const d = code.split('').map(Number);
  const sum = d.slice(0, 9).reduce((a, x, i) => a + x * (10 - i), 0);
  let mod = sum % 11;
  if (mod >= 2) mod = 11 - mod;
  return mod === d[9];
}

// ---------------------------------------------------------------- booking system API (mata-app /api/v1/voip)

export class BookingApiError extends Error {
  constructor(msg: string, public status = 0) { super(msg); }
}

export interface FreeTimes { doctor: string; settingId: string; days: number[][] }
export interface Tracked { found: boolean; id: string; ts: number; active: boolean; canCancel: boolean }
export interface Answer { ok: boolean; code?: string; errorCode?: number; message?: string }

/** list_days answer -> doctor and free times per day ({empty_times: {day1: {times: [{timestamp}]}, …}}). */
export function parseDays(b: any): FreeTimes | null {
  if (!b || typeof b !== 'object' || !b.doctor_selected || !b.appointment_setting_id) return null;
  const et = b.empty_times && typeof b.empty_times === 'object' ? b.empty_times : {};
  const keys = Object.keys(et).sort((a, c) => (+a.replace(/\D/g, '') || 0) - (+c.replace(/\D/g, '') || 0));
  const days = keys.map(k => (Array.isArray(et[k]?.times) ? et[k].times : []).map((t: any) => +t.timestamp).filter((n: number) => n > 1e9).sort((a: number, c: number) => a - c))
    .filter((d: number[]) => d.length);
  return { doctor: String(b.doctor_selected), settingId: String(b.appointment_setting_id), days };
}

export interface BookingApiLike {
  freeTimes(): Promise<FreeTimes | null>;
  store(mobile: string, doctorId: string, ts: number, nationalCode: string): Promise<Answer>;
  track(code: string, nationalCode: string): Promise<Tracked>;
  cancel(code: string, id: string): Promise<Answer>;
  approve(code: string, id: string): Promise<Answer>;
  sendMataLink(mobile: string): Promise<Answer>;
}

export class BookingApi implements BookingApiLike {
  constructor(private s: BookingSettings) {}

  /** 2xx and 406 are answers (406 = the API's «not found / invalid» replies); anything else is a failure. */
  private async req(method: 'GET' | 'POST', p: string, params: Record<string, string>) {
    if (!this.s.baseUrl) throw new BookingApiError('آدرس API نوبت‌دهی تنظیم نشده است');
    const qs = new URLSearchParams(params).toString();
    const url = this.s.baseUrl.replace(/\/+$/, '') + '/' + p + (method === 'GET' && qs ? '?' + qs : '');
    const headers: Record<string, string> = { Accept: 'application/json', 'Cache-Control': 'no-cache', 'Content-Type': 'application/x-www-form-urlencoded' };
    if (this.s.user || this.s.pass) headers.Authorization = 'Basic ' + Buffer.from(`${this.s.user}:${this.s.pass}`).toString('base64');
    let r: Response;
    try {
      r = await fetch(url, { method, headers, body: method === 'POST' ? qs : undefined, signal: AbortSignal.timeout(this.s.apiTimeout * 1000) });
    } catch (e: any) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new BookingApiError(`سامانه نوبت‌دهی در ${this.s.apiTimeout} ثانیه جواب نداد`);
      throw new BookingApiError('اتصال به سامانه نوبت‌دهی برقرار نشد: ' + (e?.cause?.code || e?.cause?.message || e?.message || e));
    }
    const text = await r.text();
    if (r.status === 401) throw new BookingApiError('نام کاربری یا رمز API نوبت‌دهی پذیرفته نشد (401)', 401);
    if (!r.ok && r.status !== 406) throw new BookingApiError(`HTTP ${r.status}` + (text && !text.startsWith('<') ? ': ' + text.slice(0, 160) : ''), r.status);
    try { return JSON.parse(text); } catch { throw new BookingApiError(`جواب سامانه نوبت‌دهی JSON نیست (HTTP ${r.status})`, r.status); }
  }

  private answer(b: any): Answer {
    return { ok: b?.status === true, code: b?.appointmentCode != null ? String(b.appointmentCode) : undefined, errorCode: b?.errorCode != null ? +b.errorCode : undefined, message: b?.message };
  }

  async freeTimes() { return parseDays(await this.req('GET', 'list_days', { doctor_id: this.s.doctorId, kind: this.s.kind })); }

  async store(mobile: string, doctorId: string, ts: number, nationalCode: string) {
    return this.answer(await this.req('POST', 'appointment/store', { user_mobile: mobile, place_id: this.s.placeId, doctor_id: doctorId, visit_date: String(ts), national_code: nationalCode }));
  }

  async track(code: string, nationalCode: string): Promise<Tracked> {
    const b = await this.req('POST', 'appointment/tracking', { appointment_code: code, national_code: nationalCode });
    return { found: b?.status === true, id: String(b?.appointment_id ?? ''), ts: +b?.time_stamp || 0, active: String(b?.appointment_status) === '1', canCancel: b?.can_cancel !== false };
  }

  async cancel(code: string, id: string) { return this.answer(await this.req('POST', 'appointment/cancel', { appointment_code: code, appointment_user_id: id })); }
  async approve(code: string, id: string) { return this.answer(await this.req('POST', 'appointment/approve', { appointment_code: code, appointment_user_id: id })); }
  async sendMataLink(mobile: string) { return this.answer(await this.req('POST', 'send_mata_link', { mobile })); }
}

// ---------------------------------------------------------------- the calls

export type BookingKind = 'book' | 'mata' | 'follow' | 'remind' | 'cancelnotice' | 'none';
export type BookingResult = 'booked' | 'duplicate' | 'not_booked' | 'link_sent' | 'found' | 'inactive' | 'not_found' | 'cancelled'
  | 'confirmed' | 'notified' | 'no_slots' | 'invalid' | 'back' | 'hangup' | 'error' | 'disabled';
export interface FlowState {
  kind: BookingKind; result: BookingResult; offered: number;
  doctor?: string; slotAt?: Date; mobile?: string; natMasked?: string; nationalCode?: string; code?: string; apptId?: string;
  survey?: number; surveyRec?: string; error?: string;
  /** The call's path for the timeline: step, keys pressed, a value (time offered, API outcome …), ms from the start. */
  steps: BookingStep[]; t0?: number;
}
export interface BookingStep { s: string; k?: string; v?: string; t?: number }
const maskNat = (d: string) => (/^\d{10}$/.test(d) ? '******' + d.slice(6) : d);
/** What a reminder / cancellation call was started with (call-file variables). */
export interface CallInfo { time?: string; ts?: number; code?: string; id?: string; mobile?: string }

/** The script ends here (the old IVR's done(): «با آرزوی سلامتی» and hang up). */
class Done extends Error {}
/** «*»: back to the main menu (the old back_to_avr). */
class Back extends Error {}

/** An API answer as one timeline value («ok 85504499», «fail #1: …»). */
const ans = (r: Answer) => (r.ok ? 'ok' + (r.code ? ' ' + r.code : '') : 'fail' + (r.errorCode != null ? ' #' + r.errorCode : '') + (r.message ? ': ' + r.message.trim() : ''));

export interface FlowCtx { ch: AgiChan; s: BookingSettings; api: BookingApiLike; st: FlowState; dir?: string; recDir?: string }

function tools({ ch, s, st, dir = BOOKING_SOUNDS }: FlowCtx) {
  const file = (f: string) => path.posix.join(dir, f);
  const play = async (...files: string[]) => { for (const f of files) await ch.streamFile(file(f)); };
  const step = (name: string, k?: string, v?: string) => {
    const x: BookingStep = { s: name, t: Date.now() - (st.t0 || Date.now()) };
    if (k !== undefined) x.k = k;
    if (v !== undefined) x.v = v;
    st.steps.push(x);
  };
  /** The old whileAction: silence -> «عددی وارد نشد» and the question again, up to `retries` times, then goodbye. */
  const ask = async (name: string, prompt: string, max: number, timeoutMs = s.digitTimeout * 1000) => {
    let d = await ch.getData(file(prompt), timeoutMs, max);
    for (let i = 0; !d && i < s.retries; i++) { await play(MSG.noInput); d = await ch.getData(file(prompt), timeoutMs, max); }
    step(name, d);
    if (!d) throw new Done();
    return d;
  };
  /** Waits on the booking system with music on hold (the old set_music(true)); the outcome goes on the timeline. */
  const call = async <T>(name: string, fn: () => Promise<T>, note: (r: T) => string): Promise<T> => {
    await ch.setMusic(true).catch(() => {});
    try { const r = await fn(); step(name, undefined, note(r)); return r; }
    catch (e) { step(name, undefined, 'error: ' + ((e as Error).message || e)); throw e; }
    finally { await ch.setMusic(false).catch(() => {}); }
  };
  return { play, step, ask, call };
}

async function finish(ctx: FlowCtx, run: () => Promise<void>) {
  const { play } = tools(ctx);
  try { await run(); }
  catch (e) {
    if (e instanceof Done) {
      // ended without an outcome of its own: silence or wrong keys until the tries ran out
      if (ctx.st.result === 'hangup') ctx.st.result = 'invalid';
      await play(MSG.arezoo);
      return;
    }
    if (e instanceof Back) { ctx.st.result = 'back'; return; }
    if (e instanceof BookingApiError) {
      ctx.st.result = 'error'; ctx.st.error = e.message;
      // the old IVR had no «system error» prompt: «نوبتی یافت نشد», then the fallback (operators) or goodbye
      await play(MSG.notFound);
      if (!ctx.s.fallback) await play(MSG.arezoo);
      return;
    }
    throw e;
  }
}

/** Main-menu key 2. */
export async function runBooking(ctx: FlowCtx) {
  const { s, api, st, ch } = ctx;
  const { play, step, ask, call } = tools(ctx);
  const callerMobile = normalizeMobile(ch.vars.callerid || '') || normalizeMobile(ch.vars.calleridname || '');

  await finish(ctx, async () => {
    st.kind = 'book';
    // «قبلاً توسط دکتر درمان شده‌اید؟» 1 = yes: the Mata app link by SMS, 2 = no: book a first visit
    if (s.askTreated) {
      let d = '';
      for (let i = 0; ; i++) {
        d = await ask('treated', MSG.treated, 1);
        if (d === '1' || d === '2') break;
        await play(MSG.wrongNumber);
        if (i + 1 >= s.retries) throw new Done();
      }
      if (d === '1') return mataLink();
    }
    return book();
  });

  async function mataLink() {
    st.kind = 'mata';
    let mobile = callerMobile;
    for (let i = 0; !mobile; i++) {
      mobile = normalizeMobile(await ask('mataMobile', MSG.enterMobile, 11));
      if (!mobile) { await play(MSG.wrongMobile); if (i + 1 >= s.retries) throw new Done(); }
    }
    st.mobile = mobile;
    for (let i = 0; ; i++) {
      const d = await ask('mataOffer', MSG.mataOffer, 1);
      if (d === '1') break;
      await play(MSG.wrongNumber);
      if (i + 1 >= s.retries) throw new Done();
    }
    const r = await call('apiMata', () => api.sendMataLink(mobile!), ans);
    if (!r.ok) { st.result = 'error'; st.error = r.message || 'send_mata_link'; await play(MSG.wrongNumber); throw new Done(); }
    st.result = 'link_sent';
    await play(MSG.mataSent);
  }

  async function book(): Promise<void> {
    const ft = await call('apiTimes', () => api.freeTimes(), r => (r ? r.days.reduce((a, d) => a + d.length, 0) + ' times · doctor ' + r.doctor : 'no schedule'));
    if (!ft || !ft.days.length) { st.result = 'no_slots'; await play(MSG.noTimes); return; }
    st.doctor = ft.doctor;
    await play(MSG.firstVisit);
    // the first free time; 2 = the next time (on to the next day after the last), 3 = the next day, * = main menu
    let day = 0, idx = 0, bad = 0;
    for (;;) {
      const ts = ft.days[day][idx];
      st.offered++;
      await play(MSG.firstTime, ...sayDate(new Date(ts * 1000)));
      const d = await ch.getData(path.posix.join(ctx.dir || BOOKING_SOUNDS, MSG.chooseTime), s.digitTimeout * 1000, 1);
      step('chooseTime', d, String(ts));
      if (d === '1') { st.slotAt = new Date(ts * 1000); break; }
      if (d === '*') throw new Back();
      if (d === '2') { if (++idx >= ft.days[day].length) { idx = 0; day = (day + 1) % ft.days.length; } continue; }
      if (d === '3') { idx = 0; day = (day + 1) % ft.days.length; continue; }
      await play(MSG.wrongNumber);
      if (++bad >= s.retries) throw new Done();
    }
    const nat = await nationalCode();
    if (nat === null) return book();
    return confirmMobile(callerMobile, nat, true);
  }

  /** null = «*» (choose the time again). */
  async function nationalCode(): Promise<string | null> {
    for (let i = 0; ; i++) {
      const d = await ask('codeMeli', MSG.codeMeli, 10, 5000);
      if (d === '*') return null;
      if (validNationalCode(d)) { st.natMasked = maskNat(d); st.nationalCode = d; return d; }
      await play(MSG.wrongCodeMeli);
      if (i + 1 >= s.retries) throw new Done();
    }
  }

  async function confirmMobile(mobile: string | null, nat: string, fromCaller: boolean): Promise<void> {
    for (let bad = 0; ;) {
      if (!mobile) {
        const typed = await ask('enterMobile', MSG.enterMobile, 11);
        if (typed === '*') { const n = await nationalCode(); if (n === null) return book(); nat = n; continue; }
        mobile = normalizeMobile(typed);
        fromCaller = false;
        if (!mobile) { await play(MSG.wrongMobile); if (++bad >= s.retries) throw new Done(); continue; }
      }
      // «شماره موبایل تماس‌گرفته‌شده … می‌باشد» 1 = confirm, 2 = another number, * = national code again
      await play(fromCaller ? MSG.mobileAuto : MSG.mobileIs, ...sayMobile(mobile));
      const d = await ask('mobileConfirm', MSG.mobileConfirm, 1, 4000);
      if (d === '1') return store(mobile, nat);
      if (d === '*') { const n = await nationalCode(); if (n === null) return book(); nat = n; continue; }
      if (d !== '2') await play(MSG.wrongMobile);
      mobile = null;
    }
  }

  async function store(mobile: string, nat: string) {
    st.mobile = mobile;
    step('mobile', undefined, mobile);
    const ts = Math.round(st.slotAt!.getTime() / 1000);
    const r = await call('apiStore', () => api.store(mobile, st.doctor!, ts, nat), ans);
    if (!r.ok || !r.code) {
      st.result = r.errorCode === 1 ? 'duplicate' : 'not_booked'; st.error = r.message;
      await play(r.errorCode === 1 ? MSG.duplicate : MSG.notFound);
      throw new Done();
    }
    st.code = r.code; st.result = 'booked';
    await play(MSG.yourCode, ...sayCode(r.code), MSG.forDay, ...sayDate(st.slotAt!), MSG.stored);
    if (s.survey) await survey();
    else throw new Done();
  }

  async function survey() {
    let score = 0;
    for (let i = 0; ; i++) {
      const d = await ask('survey', MSG.survey, 1);
      if (/^[1-5]$/.test(d)) { score = +d; break; }
      await play(MSG.surveyWrong);
      if (i + 1 >= s.retries) throw new Done();
    }
    st.survey = score;
    step('surveyScore', String(score));
    // a voice comment after the beep (the old IVR uploaded it to store_survey, which the new API no longer has)
    await play(MSG.surveyRecord);
    if (ctx.recDir) {
      const rel = `cc-svc/booking-${Date.now()}-${st.code}`;
      st.surveyRec = rel + '.wav';
      await ch.recordFile(path.posix.join(ctx.recDir, rel), s.surveyMaxSec * 1000);
      step('surveyRec', undefined, st.surveyRec);
    }
    await play(MSG.surveyBye);
  }
}

/** Main-menu key 3. */
export async function runTracking(ctx: FlowCtx) {
  const { s, api, st } = ctx;
  const { play, ask, call } = tools(ctx);
  st.kind = 'follow';
  await finish(ctx, async () => {
    for (let round = 0; ; round++) {
      let nat = '';
      for (let i = 0; ; i++) {
        const d = await ask('codeMeli', MSG.codeMeli, 10, 5000);
        if (d === '*') throw new Back();
        if (validNationalCode(d)) { nat = d; st.natMasked = maskNat(d); st.nationalCode = d; break; }
        await play(MSG.wrongCodeMeli);
        if (i + 1 >= s.retries) throw new Done();
      }
      const code = await ask('trackingCode', MSG.trackingCode, 8);
      if (code === '*') throw new Back();
      st.code = code;
      const t = await call('apiTrack', () => api.track(code, nat), r => (r.found ? 'found ' + r.id + (r.active ? '' : ' (inactive)') : 'not found'));
      if (!t.found) {
        st.result = 'not_found';
        await play(MSG.trackNotFound);
        if (round + 1 >= s.retries) throw new Done();
        continue;
      }
      st.apptId = t.id;
      if (!t.active) { st.result = 'inactive'; await play(MSG.notFound); throw new Done(); }
      st.result = 'found'; st.slotAt = new Date(t.ts * 1000);
      await play(MSG.yourCode, ...sayCode(code), MSG.forDay, ...sayDate(st.slotAt), MSG.mibashad);
      if (!s.allowCancel || !t.canCancel) throw new Done();
      // 1 = cancel the appointment, 2 / * = main menu
      const d = await ask('askCancel', MSG.askCancel, 1);
      if (d === '1') {
        const r = await call('apiCancel', () => api.cancel(code, t.id), ans);
        if (!r.ok) { st.error = r.message; await play(MSG.notFound); throw new Done(); }
        st.result = 'cancelled';
        await play(MSG.cancelled);
        throw new Done();
      }
      if (d === '2' || d === '*') throw new Back();
      await play(MSG.wrongNumber);
      throw new Done();
    }
  });
}

/** Reminder call the day before: «نوبت شما فردا ساعت … ۱ تأیید، ۵ لغو». */
export async function runReminder(ctx: FlowCtx, info: CallInfo) {
  const { api, st } = ctx;
  const { play, ask, call } = tools(ctx);
  st.kind = 'remind'; st.code = info.code; st.apptId = info.id; st.mobile = info.mobile;
  const [h, mi] = String(info.time || '').split(':').map(Number);
  await finish(ctx, async () => {
    await play(...sayTime(h || 0, mi || 0, MSG.remindStart));
    const d = await ask('remind', MSG.remindEnd, 1);
    if (d === '1') {
      const r = await call('apiApprove', () => api.approve(info.code!, info.id!), ans);
      st.result = r.ok ? 'confirmed' : 'not_found'; st.error = r.ok ? undefined : r.message;
      throw new Done();
    }
    if (d === '5') {
      const r = await call('apiCancel', () => api.cancel(info.code!, info.id!), ans);
      st.result = r.ok ? 'cancelled' : 'not_found'; st.error = r.ok ? undefined : r.message;
      if (r.ok) await play(MSG.cancelled);
      throw new Done();
    }
    st.result = 'invalid';
    await play(MSG.wrongNumber);
  });
}

/** «نوبت شما برای … لغو شد». */
export async function runCancelNotice(ctx: FlowCtx, info: CallInfo) {
  const { st } = ctx;
  const { play } = tools(ctx);
  st.kind = 'cancelnotice'; st.code = info.code; st.apptId = info.id; st.mobile = info.mobile;
  if (info.ts) st.slotAt = new Date(info.ts * 1000);
  await finish(ctx, async () => {
    await play(MSG.cancelNoticeStart, ...(st.slotAt ? sayDate(st.slotAt) : []), MSG.cancelNoticeEnd);
    st.result = 'notified';
    throw new Done();
  });
}

// ---------------------------------------------------------------- reminder call files

export interface RemindRequest { kind?: string; mobile?: string; time?: string; timestamp?: string | number; tracking_code?: string; appointment_id?: string | number }

/** An Asterisk call file for one reminder / cancellation call (Asterisk dials, retries and starts the script). */
export function reminderCallFile(r: RemindRequest, s: BookingSettings, callerId: string) {
  const mobile = normalizeMobile(String(r.mobile || ''));
  if (!mobile) throw new BadRequestException('شماره موبایل نامعتبر است');
  const kind = r.kind === 'cancel' ? 'cancel' : 'remind';
  const code = String(r.tracking_code ?? '').replace(/\D/g, ''), id = String(r.appointment_id ?? '').replace(/\D/g, '');
  if (!code || !id) throw new BadRequestException('tracking_code و appointment_id لازم است');
  const time = String(r.time || '');
  if (kind === 'remind' && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) throw new BadRequestException('زمان یادآوری باید HH:MM باشد');
  const ts = Math.floor(+(r.timestamp || 0));
  if (kind === 'cancel' && !(ts > 1e9)) throw new BadRequestException('timestamp نوبت لغوشده لازم است');
  const lines = [
    `Channel: Local/${mobile}@cc-outext`,
    ...(callerId ? [`CallerID: ${callerId}`] : []),
    'Context: cc-book-call', `Extension: ${kind}`, 'Priority: 1',
    `MaxRetries: ${s.remindRetries}`, `RetryTime: ${s.remindRetryMin * 60}`, `WaitTime: ${s.remindRing}`,
    `Set: CC_BK_MOBILE=${mobile}`, `Set: CC_BK_CODE=${code}`, `Set: CC_BK_ID=${id}`,
    ...(kind === 'remind' ? [`Set: CC_BK_TIME=${time}`] : [`Set: CC_BK_TS=${ts}`]),
    'Archive: no', '',
  ];
  return { mobile, kind, body: lines.join('\n') };
}

// ---------------------------------------------------------------- service

@Injectable()
export class BookingService implements OnModuleInit, OnModuleDestroy {
  private log = new Logger('Booking');
  private server: net.Server | null = null;
  listening = false;
  private surveyQueue: Promise<void> = Promise.resolve();
  constructor(private db: PrismaService, private store: ConfigStore, private ai: AiService) {}

  /** Survey voice comments go to speech-to-text and the AI one at a time (and again after a restart). */
  queueSurvey(id: number) {
    this.surveyQueue = this.surveyQueue.then(() => this.analyzeSurvey(id)).catch(e => this.log.warn(`survey ${id}: ${e.message}`));
    return this.surveyQueue;
  }

  async analyzeSurvey(id: number) {
    const r = await this.db.bookingLog.findUnique({ where: { id } });
    if (!r || !r.surveyRec) return;
    const file = path.resolve(env.monitorDir, r.surveyRec);
    if (!file.startsWith(path.resolve(env.monitorDir)) || !fs.existsSync(file) || fs.statSync(file).size < 4000) {
      // a beep and silence: nothing was said
      await this.db.bookingLog.update({ where: { id }, data: { surveyAiState: 'empty', surveyText: null, surveyAiError: null } });
      return;
    }
    await this.db.bookingLog.update({ where: { id }, data: { surveyAiState: 'queued', surveyAiError: null } });
    try {
      const a = await this.ai.bookingSurvey(file, r.survey || 0);
      await this.db.bookingLog.update({ where: { id }, data: { surveyText: a.text || null, surveyAi: (a.ai as any) ?? undefined, surveyAiState: a.text ? 'done' : 'empty' } });
    } catch (e) {
      await this.db.bookingLog.update({ where: { id }, data: { surveyAiState: 'failed', surveyAiError: String((e as Error).message).slice(0, 300) } });
    }
  }

  onModuleInit() {
    // comments left waiting when the service stopped
    setTimeout(() => this.db.bookingLog.findMany({ where: { surveyAiState: 'queued' }, select: { id: true } })
      .then(rows => rows.forEach(r => this.queueSurvey(r.id))).catch(() => {}), 20e3).unref();
    this.server = startFastAgi(BOOKING_PORT, ch => this.handle(ch), e => this.log.warn('FastAGI: ' + e.message));
    this.server.on('listening', () => { this.listening = true; this.log.log(`FastAGI on 127.0.0.1:${BOOKING_PORT}`); });
    this.server.on('close', () => { this.listening = false; });
  }

  onModuleDestroy() { this.server?.close(); }

  async settings(tenantId?: string | null): Promise<BookingSettings> {
    if (tenantId) {
      const r = await this.db.tenantConfig.findUnique({ where: { tenantId_key: { tenantId, key: 'booking' } } });
      if (r) return { ...BOOKING_DEFAULTS, ...((r.data as any) || {}) };
      // fall through to platform defaults if tenant has not configured yet
    }
    const r = await this.db.configEntry.findUnique({ where: { key: 'booking' } });
    return { ...BOOKING_DEFAULTS, ...((r?.data as any) || {}) };
  }

  publicView(s: BookingSettings) {
    const { pass, ...rest } = s;
    return { ...rest, hasPass: !!pass };
  }

  private async handle(ch: AgiChannel) {
    const t0 = Date.now();
    const v = async (n: string) => (await ch.send(`GET VARIABLE ${n}`).catch(() => ({ data: '' }))).data || '';
    const tenantRaw = await v('CC_TENANT');
    const tenantId = tenantRaw ? String(tenantRaw).replace(/[^A-Za-z0-9_-]/g, '') || null : null;
    // Resolve tenant row by sid-style id match when channel carries full cuid
    let resolvedTenant: string | null = tenantId;
    if (tenantId) {
      const hit = await this.db.tenant.findFirst({
        where: { OR: [{ id: tenantId }, { id: { endsWith: tenantId.replace(/^tn/, '') } }] },
        select: { id: true, features: true, active: true },
      }).catch(() => null);
      if (hit?.active) resolvedTenant = hit.id;
      else if (hit && !hit.active) resolvedTenant = null;
    }
    const s = await this.settings(resolvedTenant);
    const script = String(ch.vars.network_script || '').replace(/\/.*$/, '');
    const st: FlowState = { kind: 'none', result: 'hangup', offered: 0, steps: [{ s: 'start', v: script, t: 0 }], t0 };
    const ctx: FlowCtx = { ch, s, api: new BookingApi(s), st, recDir: env.monitorDir };
    if (!s.enabled) st.result = 'disabled';
    else {
      try {
        if (script === 'booking') await runBooking(ctx);
        else if (script === 'track') await runTracking(ctx);
        else if (script === 'remind' || script === 'cancelnotice') {
          const info: CallInfo = { time: await v('CC_BK_TIME'), ts: +(await v('CC_BK_TS')) || 0, code: await v('CC_BK_CODE'), id: await v('CC_BK_ID'), mobile: await v('CC_BK_MOBILE') };
          await (script === 'remind' ? runReminder(ctx, info) : runCancelNotice(ctx, info));
        } else throw new Error('unknown booking script: ' + script);
      } catch (e) { if (!(e instanceof AgiHangup)) { st.result = 'error'; st.error = (e as Error).message; } }
    }
    await ch.setVariable('BOOK_RESULT', st.result).catch(() => {});
    if (st.result === 'disabled') return;
    st.steps.push({ s: 'end', v: st.result, t: Date.now() - t0 });
    const callId = st.kind === 'remind' || st.kind === 'cancelnotice' || !ch.vars.uniqueid ? null : 'C' + ch.vars.uniqueid.replace(/[^0-9.]/g, '');
    const caller = st.kind === 'remind' || st.kind === 'cancelnotice' ? st.mobile || null : String(ch.vars.callerid || '').replace(/\D/g, '') || null;
    this.log.log(`${caller || 'unknown'}: ${st.kind} → ${st.result}${st.code ? ' ' + st.code : ''}${st.error ? ' (' + st.error + ')' : ''}`);
    await this.db.bookingLog.create({ data: {
      uniqueId: ch.vars.uniqueid || null, callId, tenantId: resolvedTenant, caller, kind: st.kind, result: st.result, doctor: st.doctor || null,
      slotAt: st.slotAt || null, offered: st.offered, mobile: st.mobile || null, natMasked: st.natMasked || null, nationalCode: st.nationalCode || null, code: st.code || null, apptId: st.apptId || null,
      survey: st.survey ?? null, surveyRec: st.surveyRec || null, error: st.error ? st.error.slice(0, 500) : null,
      steps: st.steps as any, secs: Math.round((Date.now() - t0) / 1000), surveyAiState: st.surveyRec ? 'queued' : 'none',
    } }).then(row => { if (st.surveyRec) this.queueSurvey(row.id); }).catch(e => this.log.warn('log not saved: ' + e.message));
  }

  async save(b: any, me: Me) {
    const cur = await this.settings(me.tenantId);
    const cfg = me.tenantId ? await this.store.tenantAll(me.tenantId) : await this.store.all();
    const val = (k: keyof BookingSettings) => b[k] ?? cur[k];
    const code = (k: 'code' | 'trackCode') => String(val(k) || '').replace(/[^0-9*#]/g, '').slice(0, 8);
    const dest = (k: 'backDest' | 'fallback') => { const x = String(val(k) || ''); return x === 'book' || x === 'booktrack' ? '' : x; };
    const baseUrl = String(val('baseUrl') || '').trim();
    if (baseUrl && !/^https?:\/\/\S+$/i.test(baseUrl)) throw new BadRequestException('آدرس API باید با http:// یا https:// شروع شود');
    const next: BookingSettings = {
      enabled: !!val('enabled'), code: code('code'), trackCode: code('trackCode'),
      baseUrl, user: String(val('user') || '').trim(),
      pass: typeof b.pass === 'string' && b.pass ? b.pass : b.clearPass ? '' : cur.pass,
      apiTimeout: clamp(val('apiTimeout'), 3, 30, 12),
      doctorId: word(val('doctorId')), placeId: word(val('placeId')), kind: word(val('kind')) || '1',
      askTreated: !!val('askTreated'), allowCancel: !!val('allowCancel'), survey: !!val('survey'), surveyMaxSec: clamp(val('surveyMaxSec'), 5, 120, 30),
      digitTimeout: clamp(val('digitTimeout'), 3, 20, 6), retries: clamp(val('retries'), 1, 5, 3),
      backDest: dest('backDest'), fallback: dest('fallback'),
      reminders: !!val('reminders'),
      remindToken: b.newToken ? randomBytes(24).toString('hex') : cur.remindToken || (val('reminders') ? randomBytes(24).toString('hex') : ''),
      remindRetries: clamp(val('remindRetries'), 0, 5, 2), remindRetryMin: clamp(val('remindRetryMin'), 5, 240, 60), remindRing: clamp(val('remindRing'), 20, 120, 60),
    };
    if (next.code && next.code === next.trackCode) throw new BadRequestException('کد نوبت‌دهی و کد پیگیری باید متفاوت باشند');
    const exts = Array.isArray(cfg.exts) ? cfg.exts : [];
    const vqs = Array.isArray(cfg.vqs) ? cfg.vqs : [];
    const rgroups = Array.isArray(cfg.rgroups) ? cfg.rgroups : [];
    for (const c of [next.code, next.trackCode].filter(Boolean)) {
      const ai = (cfg as any).aiagent;
      const taken = exts.some((e: any) => e.n === c) || vqs.some((q: any) => String(q.num) === c) || rgroups.some((g: any) => String(g.num) === c)
        || ['*77', '*43'].includes(c) || c.startsWith('*88') || (ai?.enabled && String(ai.code) === c);
      if (taken) throw new BadRequestException('کد ' + c + ' قبلاً برای بخش دیگری استفاده شده است');
    }
    if (next.enabled && !next.baseUrl) throw new BadRequestException('برای روشن کردن نوبت‌دهی، آدرس API را وارد کنید');
    if (me.tenantId) {
      await this.db.tenantConfig.upsert({
        where: { tenantId_key: { tenantId: me.tenantId, key: 'booking' } },
        create: { tenantId: me.tenantId, key: 'booking', data: next as any, updatedBy: me.id },
        update: { data: next as any, updatedBy: me.id },
      });
      this.store.resetTenant(me.tenantId);
    } else {
      await this.db.configEntry.upsert({ where: { key: 'booking' }, create: { key: 'booking', data: next as any, updatedBy: me.id }, update: { data: next as any, updatedBy: me.id } });
      this.store.reset();
    }
    const { pass, remindToken, ...safe } = next;
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'booking.save', target: me.tenantId ? `tenant:${me.tenantId}` : 'booking', detail: { ...safe, passChanged: next.pass !== cur.pass, tokenChanged: next.remindToken !== cur.remindToken } as any } });
    const applied = await this.store.applyAll().then(() => true).catch(e => { this.log.warn(e.message); return false; });
    return { ...this.publicView(next), applied };
  }

  /** «تست اتصال»: the free times exactly as a call asks for them. */
  async test() {
    const s = await this.settings();
    const t0 = Date.now();
    try {
      const ft = await new BookingApi(s).freeTimes();
      if (!ft) return { ok: true, ms: Date.now() - t0, count: 0, days: 0, times: [] };
      const fmt = (t: number) => { const d = new Date(t * 1000); return jalaliDate(d) + ' ' + hhmm(d); };
      return { ok: true, ms: Date.now() - t0, doctor: ft.doctor, days: ft.days.length, count: ft.days.reduce((a, d) => a + d.length, 0), times: ft.days.flat().slice(0, 4).map(fmt) };
    } catch (e) { return { ok: false, ms: Date.now() - t0, error: (e as Error).message }; }
  }

  /** The booking system asks for a reminder / cancellation call (instead of SSH to Issabel and cal_fire.php). */
  async remind(r: RemindRequest, token: string) {
    const s = await this.settings();
    if (!s.enabled || !s.reminders || !s.remindToken || token !== s.remindToken) throw new ForbiddenException();
    const cfg = await this.store.all();
    const trunk = cfg.trunks.find(t => t.on && t.type !== 'PRI / E1' && t.host && t.host !== '—');
    if (!trunk) throw new BadRequestException('ترانک فعالی برای تماس خروجی نیست');
    const callerId = String(trunk.did || trunk.user || '').replace(/\D/g, '');
    const c = reminderCallFile(r, s, callerId);
    const name = `booking-${c.kind}-${Date.now()}-${c.mobile}.call`;
    const tmp = path.join(OUTGOING, '..', 'tmp', name);
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, c.body, { mode: 0o660 });
    fs.renameSync(tmp, path.join(OUTGOING, name)); // atomic: Asterisk never sees a half-written file
    this.log.log(`${c.kind} call queued for ${c.mobile} (code ${r.tracking_code})`);
    return { status: true, queued: c.kind, mobile: c.mobile };
  }

  soundsReady() { return fs.existsSync(path.join(BOOKING_SOUNDS, MSG.treated + '.wav')); }
}

@Perm('vbook')
@Controller('booking')
export class BookingController {
  constructor(private booking: BookingService, private db: PrismaService) {}

  @Get()
  async get(@CurrentUser() me: Me) {
    const s = await this.booking.settings(me.tenantId);
    const since = new Date(Date.now() - 30 * 864e5);
    const logWhere: any = { at: { gte: since } };
    if (me.tenantId) logWhere.tenantId = me.tenantId;
    const [groups, recent] = await Promise.all([
      this.db.bookingLog.groupBy({ by: ['kind', 'result'], where: logWhere, _count: { _all: true } }),
      this.db.bookingLog.findMany({ where: me.tenantId ? { tenantId: me.tenantId } : {}, orderBy: { at: 'desc' }, take: 40 }),
    ]);
    const n = (k: string, r?: string) => groups.filter(g => g.kind === k && (!r || g.result === r)).reduce((a, g) => a + g._count._all, 0);
    return {
      settings: this.booking.publicView(s),
      status: {
        listening: this.booking.listening, sounds: this.booking.soundsReady(),
        booked30: n('book', 'booked'), follow30: n('follow'), cancelled30: groups.filter(g => g.result === 'cancelled').reduce((a, g) => a + g._count._all, 0),
        reminders30: n('remind'), errors30: groups.filter(g => g.result === 'error').reduce((a, g) => a + g._count._all, 0),
        calls30: groups.reduce((a, g) => a + g._count._all, 0),
      },
      remindUrl: '/api/booking/remind',
      recent: recent.map(r => ({
        id: r.id, date: jalaliDate(r.at), time: hhmm(r.at), caller: r.caller, kind: r.kind, result: r.result,
        slot: r.slotAt ? jalaliDate(r.slotAt) + ' ' + hhmm(r.slotAt) : '', mobile: r.mobile, code: r.code, survey: r.survey, error: r.error, secs: r.secs,
      })),
    };
  }

  @Put()
  save(@Body() b: any, @CurrentUser() me: Me) { return this.booking.save(b, me); }

  @Perm('vbook', 'edit')
  @Post('test')
  test() { return this.booking.test(); }

  /** Called by the booking system (token in X-Booking-Token); queues the reminder / cancellation call. */
  @Public()
  @Post('remind')
  remind(@Body() b: RemindRequest, @Headers('x-booking-token') token: string) { return this.booking.remind(b || {}, String(token || '')); }
}

// ---------------------------------------------------------------- «تماس‌های نوبت‌دهی»: every call, its path, daily numbers, follow-up

const BOOKING_KINDS = ['book', 'mata', 'follow'];
/** Inbound sessions (not the reminder calls we place) that ended without an appointment and are worth a call back. */
export const notBooked = (r: { kind: string; result: string }) => r.kind === 'book' && !['booked', 'duplicate'].includes(r.result);

@Perm('bookings')
@Controller('booking-calls')
export class BookingCallsController {
  constructor(private db: PrismaService) {}

  private async names(phones: string[]) {
    const keys = [...new Set(phones.map(p => normalizeMobile(p || '') || p).filter(Boolean))];
    const rows = keys.length ? await this.db.patient.findMany({ where: { phone: { in: keys } }, select: { phone: true, name: true } }) : [];
    const m = new Map(rows.map(r => [r.phone, r.name]));
    return (p: string | null) => (p ? m.get(normalizeMobile(p) || p) || '' : '');
  }

  private row(r: any, name: (p: string | null) => string) {
    return {
      id: r.id, date: jalaliDate(r.at), time: hhmm(r.at), at: r.at, caller: r.caller, name: name(r.caller || r.mobile), kind: r.kind, result: r.result,
      slot: r.slotAt ? jalaliDate(r.slotAt) + ' ' + hhmm(r.slotAt) : '', code: r.code, mobile: r.mobile, survey: r.survey, hasSurveyRec: !!r.surveyRec,
      offered: r.offered, secs: r.secs, error: r.error, callId: r.callId, follow: r.follow || (notBooked(r) ? 'todo' : ''), followNote: r.followNote || '', stop: stoppedAt(r),
      surveyText: r.surveyText || '', surveyAi: r.surveyAi || null, surveyAiState: r.surveyAiState,
      steps: Array.isArray(r.steps) ? r.steps.map((x: any) => x.s) : [],
    };
  }

  /** List + daily numbers for a Jalali range (default: the last 30 days). */
  @Get()
  async list(@Query('from') from?: string, @Query('to') to?: string, @CurrentUser() me?: Me) {
    const ok = (x?: string) => /^\d{4}\/\d{2}\/\d{2}$/.test(x || '');
    const f = ok(from) ? from! : jAddDays(-29), t = ok(to) ? to! : todayJ();
    const where: any = { at: { gte: new Date(jalaliToDate(f).getTime() - 864e5), lte: new Date(jalaliToDate(t).getTime() + 2 * 864e5) } };
    if (me?.tenantId) where.tenantId = me.tenantId;
    const rows = (await this.db.bookingLog.findMany({
      where, orderBy: { at: 'desc' }, take: 5000,
    })).filter(r => { const d = jalaliDate(r.at); return d >= f && d <= t; });
    const name = await this.names(rows.map(r => r.caller || r.mobile || ''));
    const by = new Map<string, any[]>();
    for (const r of rows) { const d = jalaliDate(r.at); (by.get(d) || by.set(d, []).get(d)!).push(r); }
    const sum = (list: any[]) => {
      const inb = list.filter(r => BOOKING_KINDS.includes(r.kind)), sv = list.filter(r => r.survey);
      return {
        calls: inb.length, callers: new Set(inb.map(r => r.caller).filter(Boolean)).size,
        booked: list.filter(r => r.result === 'booked').length, notBooked: list.filter(notBooked).length,
        mata: list.filter(r => r.kind === 'mata' && r.result === 'link_sent').length, follow: list.filter(r => r.kind === 'follow').length,
        cancelled: list.filter(r => r.result === 'cancelled').length, reminders: list.filter(r => r.kind === 'remind').length,
        confirmed: list.filter(r => r.result === 'confirmed').length, errors: list.filter(r => r.result === 'error').length,
        surveys: sv.length, surveyAvg: sv.length ? Math.round(sv.reduce((a, r) => a + r.survey, 0) / sv.length * 10) / 10 : null,
        todo: list.filter(r => notBooked(r) && (r.follow || 'todo') === 'todo').length,
      };
    };
    return {
      from: f, to: t, total: sum(rows),
      days: [...by.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([date, list]) => ({ date, ...sum(list) })),
      items: rows.map(r => this.row(r, name)),
    };
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    const r = await this.db.bookingLog.findUnique({ where: { id: +id || 0 } });
    if (!r) throw new NotFoundException('تماس نوبت‌دهی پیدا نشد');
    const name = await this.names([r.caller || r.mobile || '']);
    const call = r.callId ? await this.db.call.findUnique({ where: { id: r.callId }, select: { id: true, date: true, time: true, dur: true, recPath: true, queue: true, st: true } }) : null;
    // earlier calls of the same number on the booking line
    const others = r.caller ? await this.db.bookingLog.findMany({ where: { caller: r.caller, id: { not: r.id } }, orderBy: { at: 'desc' }, take: 10 }) : [];
    return {
      ...this.row(r, name), natMasked: r.natMasked, nationalCode: r.nationalCode, doctor: r.doctor, apptId: r.apptId, followBy: r.followBy, followAt: r.followAt,
      steps: Array.isArray(r.steps) ? r.steps : [],
      call: call ? { id: call.id, date: call.date, time: call.time, dur: call.dur, hasRec: !!call.recPath, queue: call.queue, st: call.st } : null,
      history: others.map(o => this.row(o, name)),
    };
  }

  @Perm('bookings', 'edit')
  @Put(':id/follow')
  async follow(@Param('id') id: string, @Body() b: { follow?: string; note?: string }, @CurrentUser() me: Me) {
    const st = ['todo', 'called', 'done'].includes(b.follow || '') ? b.follow! : 'todo';
    const r = await this.db.bookingLog.update({ where: { id: +id || 0 }, data: { follow: st, followNote: String(b.note || '').slice(0, 500) || null, followBy: me.name, followAt: new Date() } }).catch(() => null);
    if (!r) throw new NotFoundException('تماس نوبت‌دهی پیدا نشد');
    return { id: r.id, follow: r.follow, followNote: r.followNote, followBy: r.followBy, followAt: r.followAt };
  }

  /** The survey voice comment (the <audio> element passes the token in the query string). */
  @Get(':id/survey')
  async survey(@Param('id') id: string, @Res() res: ExpressResponse) {
    const r = await this.db.bookingLog.findUnique({ where: { id: +id || 0 } });
    const file = r?.surveyRec ? path.resolve(env.monitorDir, r.surveyRec) : '';
    if (!file || !file.startsWith(path.resolve(env.monitorDir)) || !fs.existsSync(file) || fs.statSync(file).size < 200) throw new NotFoundException('پیام صوتی نظرسنجی پیدا نشد');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(file);
  }
}

// ---------------------------------------------------------------- stages of a booking call (funnel / «where did they stop»)

export const STAGES: [string, string][] = [
  ['enter', 'ورود به منو'], ['treated', 'سؤال اول (ویزیت اول)'], ['times', 'شنیدن زمان خالی'], ['chosen', 'انتخاب زمان'],
  ['nat', 'کد ملی'], ['mobile', 'تأیید موبایل'], ['booked', 'ثبت نوبت'], ['survey', 'نظرسنجی'],
];
const stepsOf = (r: any): BookingStep[] => (Array.isArray(r.steps) ? r.steps : []);

/** Stages a booking-menu call reached (key 1 «treated before» becomes a Mata-link call, not a booking). */
export function stagesReached(r: any): Set<string> {
  const st = stepsOf(r), has = (n: string) => st.some(x => x.s === n);
  const out = new Set<string>(['enter']);
  if (has('apiTimes') || st.some(x => x.s === 'treated' && x.k === '2')) out.add('treated');
  if (has('chooseTime')) out.add('times');
  if (st.some(x => x.s === 'chooseTime' && x.k === '1')) out.add('chosen');
  // the mobile question only comes after a valid national code
  if (has('enterMobile') || has('mobileConfirm') || has('mobile')) out.add('nat');
  if (has('mobile')) out.add('mobile');
  if (r.result === 'booked') { ['treated', 'times', 'chosen', 'nat', 'mobile', 'booked'].forEach(k => out.add(k)); }
  if (has('surveyScore')) out.add('survey');
  return out;
}

/** The stage a booking call did not get through (null = booked, or not a booking call). */
export function stoppedAt(r: any): string | null {
  if (r.kind !== 'book' || r.result === 'booked') return null;
  const re = stagesReached(r);
  for (const [k] of STAGES) if (k !== 'survey' && !re.has(k)) return k;
  return null;
}

const STAGE_LABEL = Object.fromEntries(STAGES);
const RESULT_FA: Record<string, string> = {
  booked: 'نوبت گرفت', link_sent: 'لینک ماتا ارسال شد', found: 'نوبت اعلام شد', confirmed: 'یادآوری تأیید شد', cancelled: 'لغو شد', notified: 'اطلاع لغو داده شد',
  duplicate: 'نوبت تکراری', not_booked: 'ثبت نشد', not_found: 'نوبت پیدا نشد', inactive: 'نوبت فعال نیست', no_slots: 'زمان خالی نبود', invalid: 'نیمه‌کاره رها کرد',
  back: 'برگشت به منو', hangup: 'وسط کار قطع کرد', error: 'خطای سامانه', disabled: 'خاموش',
};
const KIND_FA: Record<string, string> = { book: 'ثبت نوبت', mata: 'لینک ماتا', follow: 'پیگیری با کد', remind: 'تماس یادآوری', cancelnotice: 'اطلاع لغو', none: 'نوبت‌دهی' };

async function rangeRows(db: PrismaService, from?: string, to?: string) {
  const ok = (x?: string) => /^\d{4}\/\d{2}\/\d{2}$/.test(x || '');
  const f = ok(from) ? from! : jAddDays(-29), t = ok(to) ? to! : todayJ();
  const rows = (await db.bookingLog.findMany({
    where: { at: { gte: new Date(jalaliToDate(f).getTime() - 864e5), lte: new Date(jalaliToDate(t).getTime() + 2 * 864e5) } }, orderBy: { at: 'asc' }, take: 50000,
  })).filter(r => { const d = jalaliDate(r.at); return d >= f && d <= t; });
  return { f, t, rows };
}

/** «گزارش نوبت‌دهی» (reports menu): funnel, where callers stop, days / hours / weekdays, choices, surveys, errors. */
@Perm('reports')
@Controller('booking-report')
export class BookingReportController {
  constructor(private db: PrismaService) {}

  @Get()
  async report(@Query('from') from?: string, @Query('to') to?: string) {
    const { f, t, rows } = await rangeRows(this.db, from, to);
    const tz = (d: Date) => { const x = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23', weekday: 'short' }).formatToParts(d); return { h: +x.find(p => p.type === 'hour')!.value % 24, wd: x.find(p => p.type === 'weekday')!.value }; };
    const WD = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    const book = rows.filter(r => r.kind === 'book'), inb = rows.filter(r => BOOKING_KINDS.includes(r.kind));
    const booked = rows.filter(r => r.result === 'booked');
    const count = (list: any[], fn: (r: any) => any) => { const m: Record<string, number> = {}; for (const r of list) { const k = fn(r); if (k != null) m[k] = (m[k] || 0) + 1; } return m; };
    const reached = book.map(r => stagesReached(r));
    const funnel = STAGES.map(([key, label]) => ({ key, label, n: reached.filter(s => s.has(key)).length }));
    const stops = STAGES.filter(([k]) => k !== 'enter' && k !== 'survey').map(([key, label]) => ({ key, label, n: book.filter(r => stoppedAt(r) === key).length }));
    const days = new Map<string, any[]>();
    for (const r of rows) { const d = jalaliDate(r.at); (days.get(d) || days.set(d, []).get(d)!).push(r); }
    const dayRow = (date: string, list: any[]) => {
      const b = list.filter(r => r.kind === 'book'), sv = list.filter(r => r.survey);
      return {
        date, calls: list.filter(r => BOOKING_KINDS.includes(r.kind)).length, callers: new Set(list.filter(r => BOOKING_KINDS.includes(r.kind)).map(r => r.caller).filter(Boolean)).size,
        book: b.length, booked: b.filter(r => r.result === 'booked').length, notBooked: b.filter(notBooked).length,
        mata: list.filter(r => r.kind === 'mata').length, follow: list.filter(r => r.kind === 'follow').length, cancelled: list.filter(r => r.result === 'cancelled').length,
        reminders: list.filter(r => r.kind === 'remind').length, errors: list.filter(r => r.result === 'error').length,
        surveyAvg: sv.length ? Math.round(sv.reduce((a, r) => a + r.survey, 0) / sv.length * 10) / 10 : null,
        stops: Object.fromEntries(stops.map(x => [x.key, b.filter(r => stoppedAt(r) === x.key).length])),
      };
    };
    // how many times were offered before the caller said yes, and which keys they used meanwhile
    const offersToYes = count(booked.filter(r => r.kind === 'book'), r => (r.offered >= 5 ? '5+' : String(r.offered || 1)));
    const keys = { next: 0, nextDay: 0, back: 0, silent: 0 };
    for (const r of book) for (const x of stepsOf(r)) if (x.s === 'chooseTime') { if (x.k === '2') keys.next++; else if (x.k === '3') keys.nextDay++; else if (x.k === '*') keys.back++; else if (!x.k) keys.silent++; }
    // seconds the booking system took to answer (time between the step before and the API step)
    const lat: Record<string, number[]> = {};
    for (const r of rows) { const st = stepsOf(r); st.forEach((x, i) => { if (/^api/.test(x.s) && i && typeof x.t === 'number' && typeof st[i - 1].t === 'number' && !String(x.v || '').startsWith('error')) (lat[x.s] = lat[x.s] || []).push(x.t - st[i - 1].t!); }); }
    const sv = rows.filter(r => r.survey);
    const avg = (a: number[]) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
    return {
      from: f, to: t,
      totals: {
        calls: inb.length, callers: new Set(inb.map(r => r.caller).filter(Boolean)).size, book: book.length, booked: booked.length, notBooked: book.filter(notBooked).length,
        conv: book.length ? Math.round(booked.length / book.length * 1000) / 10 : null, mata: rows.filter(r => r.kind === 'mata').length,
        mataSent: rows.filter(r => r.result === 'link_sent').length, follow: rows.filter(r => r.kind === 'follow').length, followFound: rows.filter(r => r.kind === 'follow' && (r.result === 'found' || r.result === 'cancelled')).length,
        cancelled: rows.filter(r => r.result === 'cancelled').length, reminders: rows.filter(r => r.kind === 'remind').length, confirmed: rows.filter(r => r.result === 'confirmed').length,
        errors: rows.filter(r => r.result === 'error').length, avgSecsBooked: avg(booked.map(r => r.secs)), avgSecsAll: avg(inb.map(r => r.secs)),
        avgOffers: booked.length ? Math.round(booked.reduce((a, r) => a + (r.offered || 1), 0) / booked.length * 10) / 10 : null,
        surveys: sv.length, surveyAvg: sv.length ? Math.round(sv.reduce((a, r) => a + r.survey!, 0) / sv.length * 10) / 10 : null,
        todo: book.filter(r => notBooked(r) && (r.follow || 'todo') === 'todo').length,
      },
      funnel, stops,
      days: [...days.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, list]) => dayRow(d, list)),
      hours: Array.from({ length: 24 }, (_, h) => { const l = inb.filter(r => tz(r.at).h === h); return { h, calls: l.length, booked: l.filter(r => r.result === 'booked').length }; }),
      weekdays: WD.map((w, i) => { const l = inb.filter(r => tz(r.at).wd === w); return { i, calls: l.length, booked: l.filter(r => r.result === 'booked').length }; }),
      offersToYes, keys,
      results: Object.entries(count(rows, r => r.result)).map(([key, n]) => ({ key, label: RESULT_FA[key] || key, n })).sort((a, b) => b.n - a.n),
      kinds: Object.entries(count(rows, r => r.kind)).map(([key, n]) => ({ key, label: KIND_FA[key] || key, n })),
      survey: {
        dist: [1, 2, 3, 4, 5].map(n => ({ n, count: sv.filter(r => r.survey === n).length })),
        withText: sv.filter(r => r.surveyText).length,
        sentiment: count(sv.filter(r => r.surveyAi), r => (r.surveyAi as any).sentiment),
        cats: BOOKING_SURVEY_CATS.map(c => ({ id: c.id, name: c.name, n: sv.filter(r => (r.surveyAi as any)?.category === c.id).length })).filter(c => c.n),
      },
      latency: Object.entries(lat).map(([k, a]) => ({ key: k, ms: avg(a), n: a.length })),
      lastErrors: rows.filter(r => r.result === 'error').slice(-15).reverse().map(r => ({ id: r.id, date: jalaliDate(r.at), time: hhmm(r.at), error: r.error })),
    };
  }

  /** Every call of the range as a styled Excel sheet (with the stage it stopped at and the survey text). */
  @Get('export')
  async export(@Res() res: ExpressResponse, @Query('from') from?: string, @Query('to') to?: string) {
    const { f, t, rows } = await rangeRows(this.db, from, to);
    const keys = [...new Set(rows.map(r => normalizeMobile(r.caller || r.mobile || '') || r.caller || '').filter(Boolean))];
    const pats = keys.length ? await this.db.patient.findMany({ where: { phone: { in: keys } }, select: { phone: true, name: true } }) : [];
    const P = new Map(pats.map(p => [p.phone, p.name]));
    const wb = new ExcelJS.Workbook();
    const H = ['تاریخ', 'ساعت', 'شماره', 'نام', 'نوع', 'نتیجه', 'توقف در مرحله', 'زمان‌های پیشنهادی', 'روز و ساعت نوبت', 'کد پیگیری', 'کد ملی', 'موبایل', 'نظرسنجی', 'متن نظرسنجی', 'گروه نظر', 'پیگیری', 'مدت (ثانیه)', 'خطا'];
    const ws = sheetBase(wb, 'تماس‌های نوبت‌دهی', H.length, C.green);
    titleBlock(ws, H.length, 'گزارش نوبت‌دهی تلفنی', `از ${f} تا ${t} · ${rows.length} تماس`);
    headerRow(ws, 5, H);
    const FOL: Record<string, string> = { todo: 'پیگیری نشده', called: 'تماس گرفته شد', done: 'پیگیری تمام شد' };
    const CAT = Object.fromEntries(BOOKING_SURVEY_CATS.map(c => [c.id, c.name]));
    rows.slice().reverse().forEach((r, i) => {
      const stop = stoppedAt(r);
      const row = ws.getRow(6 + i);
      [jalaliDate(r.at), hhmm(r.at), r.caller || r.mobile || '', P.get(normalizeMobile(r.caller || '') || r.caller || '') || '', KIND_FA[r.kind] || r.kind, RESULT_FA[r.result] || r.result,
        stop ? STAGE_LABEL[stop] : '', r.offered || '', r.slotAt ? jalaliDate(r.slotAt) + ' ' + hhmm(r.slotAt) : '', r.code || '', r.nationalCode || r.natMasked || '', r.mobile || '',
        r.survey || '', r.surveyText || '', (r.surveyAi as any)?.category ? CAT[(r.surveyAi as any).category] : '', notBooked(r) ? FOL[r.follow || 'todo'] : '', r.secs, r.error || '']
        .forEach((v, c) => Object.assign(row.getCell(c + 1), { value: v, font: font(), alignment: al(), fill: fill(i % 2 ? C.zebra : C.white) }));
    });
    [11, 7, 13, 16, 12, 16, 16, 9, 16, 12, 12, 13, 9, 40, 16, 14, 9, 30].forEach((w, i) => (ws.getColumn(i + 1).width = w));
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="booking.xlsx"; filename*=UTF-8''${encodeURIComponent('گزارش نوبت‌دهی ' + f + ' تا ' + t)}.xlsx`);
    res.send(Buffer.from(buf as ArrayBuffer));
  }
}

/** «نظرسنجی نوبت‌دهی» (AI menu): every survey of the booking line with its voice comment, text and group. */
@Perm('bsurvey')
@Controller('booking-surveys')
export class BookingSurveysController {
  constructor(private db: PrismaService, private booking: BookingService) {}

  @Get()
  async list(@Query('from') from?: string, @Query('to') to?: string) {
    const { f, t, rows } = await rangeRows(this.db, from, to);
    const sv = rows.filter(r => r.survey).reverse();
    const keys = [...new Set(sv.map(r => normalizeMobile(r.caller || r.mobile || '') || '').filter(Boolean))];
    const pats = keys.length ? await this.db.patient.findMany({ where: { phone: { in: keys } }, select: { phone: true, name: true } }) : [];
    const P = new Map(pats.map(p => [p.phone, p.name]));
    return {
      from: f, to: t, cats: BOOKING_SURVEY_CATS.map(({ id, name }) => ({ id, name })),
      items: sv.map(r => ({
        id: r.id, date: jalaliDate(r.at), time: hhmm(r.at), caller: r.caller, mobile: r.mobile, name: P.get(normalizeMobile(r.caller || r.mobile || '') || '') || '',
        score: r.survey, slot: r.slotAt ? jalaliDate(r.slotAt) + ' ' + hhmm(r.slotAt) : '', code: r.code,
        hasRec: !!r.surveyRec, text: r.surveyText || '', ai: r.surveyAi || null, state: r.surveyAiState, error: r.surveyAiError || '',
      })),
    };
  }

  @Perm('bsurvey', 'edit')
  @Post(':id/analyze')
  async analyze(@Param('id') id: string) {
    await this.booking.queueSurvey(+id || 0);
    const r = await this.db.bookingLog.findUnique({ where: { id: +id || 0 } });
    if (!r) throw new NotFoundException('نظرسنجی پیدا نشد');
    return { id: r.id, text: r.surveyText || '', ai: r.surveyAi || null, state: r.surveyAiState, error: r.surveyAiError || '' };
  }
}
