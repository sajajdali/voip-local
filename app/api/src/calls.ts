// Calls: bootstrap payload, call list, click-to-call, dialplan hooks, follow-up workflow, recordings.
import { BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, Logger, NotFoundException, Param, Post, Query, Req, Res } from '@nestjs/common';
import { execFile } from 'child_process';
import type { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import * as ExcelJS from 'exceljs';
import { AiService } from './ai';
import { AsteriskService } from './asterisk/asterisk.service';
import { CurrentUser, Me, Public } from './auth';
import { Bus } from './bus';
import { ConfigStore } from './config';
import { env } from './env';
import { hhmm, jalaliDate, jalaliToDate, jAddDays, todayJ } from './jalali';
import { PatientsService, daysSince } from './patients';
import { PrismaService } from './prisma.service';
import { WebhookService, publicSurvey } from './webhook';

const run = promisify(execFile);
const digits = (s: any) => String(s ?? '').replace(/\D/g, '');
/** Operator delivers mobiles as 9…, 98… or 0098…; store them in the standard 0… form. */
/** Panel text for the last surgery: Jalali date and how long ago. */
function surgeryText(iso: string | null | undefined) {
  const days = daysSince(iso);
  if (days == null) return iso && !/^\d{4}-/.test(iso) ? iso : '—';
  return jalaliDate(new Date(iso + 'T12:00:00Z')) + ' (' + (days === 0 ? 'امروز' : days.toLocaleString('fa-IR') + ' روز پیش') + ')';
}

export function normalizePhone(raw: string) {
  const d = String(raw || '').replace(/\D/g, '');
  if (/^0098\d{10}$/.test(d)) return '0' + d.slice(4);
  if (/^98\d{10}$/.test(d)) return '0' + d.slice(2);
  if (/^9\d{9}$/.test(d)) return '0' + d;
  return d;
}
export const faDigits = (t: string) => t.replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d]);
export const fmtPhone = (p: string) => (/^09\d{9}$/.test(p) ? `${p.slice(0, 4)} ${p.slice(4, 7)} ${p.slice(7)}` : p);

/** Duration (s) and 56 loudness bars of a recording, for the waveform in the voicemail view. */
export async function audioInfo(file: string) {
  try {
    const { stdout } = await run('ffmpeg', ['-v', 'quiet', '-i', file, '-ac', '1', '-ar', '2000', '-f', 's16le', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    const n = Math.floor(stdout.length / 2);
    if (!n) return { dur: 0, wave: [] as number[] };
    const bins = 56, per = Math.max(1, Math.floor(n / bins)), wave: number[] = [];
    let max = 1;
    const rms: number[] = [];
    for (let b = 0; b < bins; b++) {
      let s = 0;
      for (let i = b * per; i < Math.min(n, (b + 1) * per); i++) { const v = stdout.readInt16LE(i * 2); s += v * v; }
      const r = Math.sqrt(s / per); rms.push(r); if (r > max) max = r;
    }
    for (const r of rms) wave.push(6 + Math.round((r / max) * 34));
    return { dur: Math.round(n / 2000), wave };
  } catch { return { dur: 0, wave: [] as number[] }; }
}

interface Orig { opExt: string; number: string; name: string; vmId: string | null; userId: string; at: number; note?: string; callId?: string }

@Injectable()
export class CallsService {
  private log = new Logger('Calls');
  origs = new Map<string, Orig>();

  constructor(private db: PrismaService, private bus: Bus, private patients: PatientsService, private store: ConfigStore, private ai: AiService, private ast: AsteriskService, private hooks: WebhookService) {
    ast.on('ami', (m: any) => {
      // Operator did not pick up the originate: no channel reached the dialplan, so log it here.
      if (m.Event === 'OriginateResponse' && m.Response === 'Failure') {
        for (const [id, o] of this.origs) if (m.Exten === o.number && String(m.Channel || '').includes(o.opExt)) { this.endOrig(id, false).catch(() => {}); break; }
      }
    });
    setInterval(() => { const t = Date.now(); for (const [id, o] of this.origs) if (t - o.at > 3 * 3600e3) this.origs.delete(id); }, 600e3);
  }

  async list(from = jAddDays(-120)) {
    const [rows, pats, users, cfg, follows] = await Promise.all([
      this.db.call.findMany({ where: { date: { gte: from } }, orderBy: { startedAt: 'desc' } }),
      this.db.patient.findMany(), this.db.user.findMany({ where: { ext: { not: null } } }), this.store.all(), this.db.follow.findMany(),
    ]);
    const P = new Map(pats.map(p => [p.phone, p]));
    const U = new Map(users.map(u => [u.ext, u]));
    const F = new Map(follows.map(f => [f.callId, f.status]));
    return rows.map(c => {
      const p = P.get(c.phone);
      const u = c.opExt ? U.get(c.opExt) : null;
      const e = c.opExt ? cfg.exts.find(x => x.n === c.opExt) : null;
      const op = c.opExt ? { id: u ? u.id : 'e' + c.opExt, name: u ? u.name : e ? e.name : 'داخلی ' + c.opExt, ext: c.opExt } : null;
      // a connection shorter than SHORT_CALL_SEC is not a conversation: it counts as missed everywhere
      const short = (c.st === 'answered' || c.st === 'transferred') && c.dur < env.shortCallSec;
      return {
        id: c.id, date: c.date, time: c.time, name: p ? p.name : 'شماره ناشناس', phone: fmtPhone(c.phone), phoneRaw: c.phone,
        nid: p && p.nid ? p.nid : '—', surgery: surgeryText(p?.surgery), known: !!p, dir: c.dir, st: short ? 'missed' : c.st, short, op, queue: c.queue,
        dur: c.dur, wait: c.wait, hasRec: !!c.recPath, ai: c.ai, survey: publicSurvey(c.survey), follow: c.st === 'voicemail' ? F.get(c.id) || 'new' : null,
        wave: c.wave, callback: c.callback, summary: c.summary || '',
      };
    });
  }

  async workflow() {
    const [follows, notes] = await Promise.all([this.db.follow.findMany(), this.db.note.findMany({ orderBy: { id: 'asc' } })]);
    const follow: Record<string, string> = {}, doneAt: Record<string, string> = {}, n: Record<string, any[]> = {};
    for (const f of follows) { follow[f.callId] = f.status; if (f.doneAt) doneAt[f.callId] = f.doneAt; }
    for (const x of notes) (n[x.callId] = n[x.callId] || []).push({ t: x.t, ref: x.ref, by: x.by, at: x.at });
    return { follow, doneAt, notes: n };
  }

  /** Called by the dialplan hangup handler (cc-hangup) for every finished inbound/outbound call. */
  async ingest(q: Record<string, string>) {
    if (q.blocked === '1') return;
    const start = +q.start || Math.floor(Date.now() / 1000), end = +q.end || start, ansts = +q.ansts || 0;
    const dir = q.dir === 'out' ? 'out' : 'in';
    const phone = normalizePhone(dir === 'in' ? q.num || q.cid : q.num) || 'unknown';
    const id = 'C' + String(q.uid || start).replace(/[^0-9.]/g, '');
    let recPath: string | null = q.rec ? path.join(env.monitorDir, q.rec.replace(/\.\.+/g, '')) : null;
    if (recPath) { await new Promise(r => setTimeout(r, 1200)); if (!fs.existsSync(recPath) || fs.statSync(recPath).size < 2000) recPath = null; }
    const info = recPath ? await audioInfo(recPath) : { dur: 0, wave: [] };
    let st: string, dur: number, wait: number;
    if (q.vm === '1') { st = recPath && info.dur >= 1 ? 'voicemail' : 'missed'; dur = recPath ? info.dur : 0; wait = Math.max(0, end - start - dur); }
    else if (q.ansext || ansts) { st = q.xfer === '1' ? 'transferred' : 'answered'; dur = Math.max(1, end - (ansts || start)); wait = Math.max(0, (ansts || start) - start); }
    else { st = 'missed'; dur = 0; wait = Math.max(0, end - start); }
    const sv = (q.sv || '').replace(/\D/g, '').split('').map(Number).filter(n => n >= 1 && n <= 5);
    // answers stop at the first unanswered question; a partial survey still counts
    let svRec: string | null = sv.length && q.svrec ? path.join(env.monitorDir, q.svrec.replace(/\.\.+/g, '')) : null;
    if (svRec && (!fs.existsSync(svRec) || fs.statSync(svRec).size < 4000)) svRec = null;
    const survey = sv.length ? { answers: sv.slice(0, 5), score: Math.round((sv.reduce((a, b) => a + b, 0) / sv.length) * 10) / 10, comment: '', ...(svRec ? { rec: svRec } : {}) } : null;
    const orig = q.orig ? this.origs.get(q.orig) : undefined;
    const at = new Date(start * 1000);
    const opExt = dir === 'in' ? digits(q.ansext) || null : digits(q.opext || q.ansext) || null;
    const data = {
      startedAt: at, date: jalaliDate(at), time: hhmm(at), phone, dir, st, queue: q.queue || (dir === 'out' ? 'تماس خروجی' : '—'), opExt,
      dur, wait, did: digits(q.did) || null, recPath, survey: survey as any, callback: !!q.orig, summary: orig?.note || null, wave: info.wave as any,
      aiState: recPath ? 'queued' : 'none',
    };
    await this.db.call.upsert({ where: { id }, create: { id, ...data }, update: data });
    if (q.orig) {
      if (orig) orig.callId = id;
      await this.endOrig(q.orig, st === 'answered', true);
    }
    this.bus.emit('calls', { id });
    if (recPath) this.ai.enqueue(id);
    if (svRec) {
      this.bus.emit('notify', { role: 'admin', text: 'نظرسنجی با امتیاز پایین و پیام صوتی از ' + phone });
      this.ai.transcribeSurvey(id);
    }
    this.hooks.enqueue(id);
  }

  /** Finish a click-to-call: move a "new" voicemail to "follow" on success and notify the operator's browser. */
  async endOrig(origId: string, answered: boolean, logged = false) {
    const o = this.origs.get(origId);
    if (!o) return;
    if (!logged) {
      const at = new Date(o.at);
      const id = 'CB' + o.at;
      await this.db.call.upsert({ where: { id }, create: { id, startedAt: at, date: jalaliDate(at), time: hhmm(at), phone: o.number, dir: 'out', st: 'missed', queue: 'پیگیری پیام صوتی', opExt: o.opExt, callback: true, summary: o.note || null }, update: {} });
      this.bus.emit('calls', { id });
      this.hooks.enqueue(id);
    }
    if (answered && o.vmId) {
      const f = await this.db.follow.findUnique({ where: { callId: o.vmId } });
      if (!f || f.status === 'new') {
        await this.db.follow.upsert({ where: { callId: o.vmId }, create: { callId: o.vmId, status: 'follow' }, update: { status: 'follow' } });
        this.bus.emit('workflow', { follow: { [o.vmId]: 'follow' } });
      }
    }
    this.bus.emit('cb', { userId: o.userId, origId, stage: 'ended', answered });
    this.origs.delete(origId);
  }
}

@Controller()
export class CallsController {
  constructor(private calls: CallsService, private db: PrismaService, private store: ConfigStore, private ast: AsteriskService, private bus: Bus) {}

  @Get('health')
  @Public()
  health() { return { ok: true, ami: this.ast.ami.connected, time: new Date().toISOString() }; }

  @Get('bootstrap')
  async bootstrap(@CurrentUser() me: Me) {
    const [config, workflow, calls, users] = await Promise.all([this.store.forRole(me.role), this.calls.workflow(), this.calls.list(), this.db.user.findMany({ where: { active: true } })]);
    const live = this.ast.live;
    config.exts = config.exts.map((e: any) => ({ ...e, st: live.exts[e.n]?.st || 'offline', dev: live.exts[e.n]?.dev || e.dev }));
    const operators = users.filter(u => u.ext).map(u => ({ id: u.id, name: u.name, ext: u.ext }));
    return { me, operators, config, workflow, calls };
  }

  @Get('calls')
  async list(@Query('from') from?: string) { return { calls: await this.calls.list(from && /^\d{4}\/\d{2}\/\d{2}$/.test(from) ? from : undefined) }; }

  @Post('calls/originate')
  async originate(@Body() b: { phone: string; name: string; vmId?: string }, @CurrentUser() me: Me) {
    const number = digits(b.phone);
    if (!me.ext) throw new BadRequestException('برای کاربر شما داخلی تعریف نشده است');
    if (number.length < 3) throw new BadRequestException('شماره نامعتبر است');
    if (!this.ast.ami.connected) throw new BadRequestException('اتصال به مرکز تلفن برقرار نیست');
    const origId = 'O' + Date.now() + Math.floor(Math.random() * 1000);
    this.calls.origs.set(origId, { opExt: me.ext, number, name: String(b.name || number), vmId: b.vmId || null, userId: me.id, at: Date.now() });
    await this.ast.originate(me.ext, number, origId, String(b.name || number), b.vmId || null);
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'call.originate', target: number, detail: { vmId: b.vmId || null } } });
    return { origId };
  }

  @Post('calls/hangup')
  async hangup(@Body() b: { origId: string; note?: string }, @CurrentUser() me: Me) {
    const o = this.calls.origs.get(b.origId);
    if (!o) return { ok: true };
    if (o.userId !== me.id && me.role !== 'admin') throw new ForbiddenException();
    if (b.note) o.note = b.note;
    await this.ast.hangupExt(o.opExt);
    return { ok: true };
  }

  @Post('calls/summary')
  async summary(@Body() b: { origId: string; note: string }) {
    const o = this.calls.origs.get(b.origId);
    const note = String(b.note || '').slice(0, 2000);
    if (o) { o.note = note; if (o.callId) await this.db.call.update({ where: { id: o.callId }, data: { summary: note } }); }
    else {
      // the call already finished: attach to the latest callback without a summary
      const c = await this.db.call.findFirst({ where: { callback: true, summary: null }, orderBy: { startedAt: 'desc' } });
      if (c) await this.db.call.update({ where: { id: c.id }, data: { summary: note } });
    }
    this.bus.emit('calls', {});
    return { ok: true };
  }

  @Post('workflow')
  async workflow(@Body() b: { follow?: Record<string, string>; doneAt?: Record<string, string>; notes?: Record<string, any[]> }, @CurrentUser() me: Me) {
    const out: any = {};
    for (const [id, status] of Object.entries(b.follow || {})) {
      if (!['new', 'follow', 'done'].includes(status)) continue;
      await this.db.follow.upsert({ where: { callId: id }, create: { callId: id, status }, update: { status } });
      (out.follow = out.follow || {})[id] = status;
    }
    for (const [id, doneAt] of Object.entries(b.doneAt || {})) {
      await this.db.follow.upsert({ where: { callId: id }, create: { callId: id, status: 'done', doneAt: String(doneAt) }, update: { doneAt: String(doneAt) } });
      (out.doneAt = out.doneAt || {})[id] = doneAt;
    }
    for (const [id, list] of Object.entries(b.notes || {})) {
      const have = await this.db.note.findMany({ where: { callId: id } });
      const key = (n: any) => [n.t, n.ref, n.by, n.at].join('|');
      const known = new Set(have.map(key));
      for (const n of list || []) {
        if (known.has(key(n))) continue;
        await this.db.note.create({ data: { callId: id, t: String(n.t || '').slice(0, 4000), ref: String(n.ref || 'none'), by: me.name, at: String(n.at || '') } });
        const role = ({ acc: 'accounting', rec: 'reception', emg: 'emergency' } as any)[n.ref];
        if (role) this.bus.emit('notify', { role, text: 'یک پیام صوتی توسط ' + me.name + ' به کارتابل شما ارجاع شد' });
      }
      const all = await this.db.note.findMany({ where: { callId: id }, orderBy: { id: 'asc' } });
      (out.notes = out.notes || {})[id] = all.map(x => ({ t: x.t, ref: x.ref, by: x.by, at: x.at }));
    }
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'workflow', target: Object.keys({ ...b.follow, ...b.doneAt, ...b.notes }).join(','), detail: b as any } });
    this.bus.emit('workflow', out);
    return out;
  }

  /** Extensions that rang and did not answer, per caller uniqueid, from Asterisk's queue_log. */
  private ringsByCall(names: Map<string, string>) {
    const out = new Map<string, Set<string>>();
    try {
      for (const line of fs.readFileSync(env.queueLog, 'utf8').split('\n')) {
        const f = line.split('|');
        if (f[4] !== 'RINGNOANSWER' && f[4] !== 'RINGCANCELED') continue;
        const ext = names.get(f[3]) || (f[3].match(/\d{2,}/) || [''])[0];
        if (!ext) continue;
        if (!out.has(f[1])) out.set(f[1], new Set());
        out.get(f[1])!.add(ext);
      }
    } catch { /* no queue_log yet */ }
    return out;
  }

  /** Excel export of calls. kind = "missed": unanswered-calls report; otherwise the filtered list. Real data only. */
  @Post('calls/export')
  async export(@Body() b: { ids: string[]; title?: string; from?: string; to?: string; kind?: string }, @CurrentUser() me: Me, @Res() res: Response) {
    const ids = new Set((b.ids || []).map(String));
    if (!ids.size) throw new BadRequestException('تماسی انتخاب نشده است');
    const all = await this.calls.list('1300/01/01');
    const rows = all.filter(c => ids.has(c.id)).sort((a, z) => `${a.date} ${a.time}`.localeCompare(`${z.date} ${z.time}`));
    const missed = b.kind === 'missed';
    const unreached = b.kind === 'unreached';
    const cfg = await this.store.all();
    const names = new Map<string, string>(cfg.exts.map((e: any) => [e.name, e.n]));
    const rings = this.ringsByCall(names);
    const WD = ['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه'];
    const weekday = (j: string) => WD[jalaliToDate(j).getUTCDay()];
    const ST: Record<string, string> = { answered: 'پاسخ‌داده', missed: 'بی‌پاسخ', voicemail: 'پیام صوتی گذاشت', transferred: 'انتقال‌یافته' };
    const stage = (c: any) => {
      const q = String(c.queue || '');
      if (c.st === 'voicemail') return 'پیام صوتی گذاشت';
      if (c.short) return `وصل شد ولی کمتر از ${env.shortCallSec} ثانیه طول کشید${c.op ? ' (داخلی ' + c.op.ext + ')' : ''}`;
      if (/Night|منوی شب/.test(q)) return 'منوی شب (خارج از ساعت کاری)';
      if (/^IVR/.test(q)) return 'هنگام شنیدن منوی روز (قبل از انتخاب گزینه)';
      const vq = cfg.vqs.find((x: any) => x.name === q);
      if (vq) return `در صف انتظار — صف ${vq.num}`;
      if (/^گروه زنگ/.test(q)) return q;
      if (/^داخلی/.test(q)) return 'تماس مستقیم با ' + q;
      return q || '—';
    };
    const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    const when = (c: any) => `${c.date} ${c.time}`;
    const anyName = rows.some(c => c.known);
    // latest real conversation per number (answered inbound / answered outbound)
    const lastOk: Record<string, string> = {};
    for (const x of all) {
      const ok = x.dir === 'in' ? x.st === 'answered' || x.st === 'transferred' : x.st === 'answered';
      if (ok && (!lastOk[x.phoneRaw] || lastOk[x.phoneRaw] < when(x))) lastOk[x.phoneRaw] = when(x);
    }
    const callbacks = (c: any) => all.filter(y => y.dir === 'out' && y.phoneRaw === c.phoneRaw && when(y) > when(c)).sort((a, z) => when(a).localeCompare(when(z)));
    const cbText = (c: any) => {
      const l = callbacks(c);
      if (!l.length) return 'خیر — تماسی گرفته نشده';
      const ok = l.find(y => y.st === 'answered');
      return ok ? `بله — ${l.length} بار، صحبت شد ${mmss(ok.dur)} (داخلی ${ok.op ? ok.op.ext : '—'}، ${ok.date} ساعت ${ok.time})` : `بله — ${l.length} بار، جواب نداد`;
    };
    // total talk time of the callbacks that actually reached the caller
    const cbTalk = (c: any) => { const t = callbacks(c).filter(y => y.st === 'answered').reduce((n, y) => n + y.dur, 0); return t ? mmss(t) : '—'; };
    const reached = (c: any) => (lastOk[c.phoneRaw] || '') > when(c);
    const stageShort = (c: any) => (c.short ? `مکالمه زیر ${env.shortCallSec} ثانیه` : c.st === 'voicemail' ? 'پیام صوتی' : /Night|منوی شب/.test(c.queue) ? 'منوی شب' : /^IVR/.test(c.queue) ? 'منوی روز' : 'صف انتظار');

    type Col = { h: string; w: number; v: (c: any, i: number) => any; center?: boolean };
    const cols: Col[] = missed ? [
      { h: 'ردیف', w: 7, v: (_, i) => i + 1, center: true },
      { h: 'تاریخ', w: 12, v: c => c.date, center: true },
      { h: 'روز', w: 11, v: c => weekday(c.date), center: true },
      { h: 'ساعت', w: 8, v: c => c.time, center: true },
      { h: 'شماره تماس‌گیرنده', w: 16, v: c => c.phoneRaw, center: true },
      ...(anyName ? [{ h: 'نام بیمار', w: 20, v: (c: any) => (c.known ? c.name : '') }] : []),
      { h: 'مرحله قطع تماس', w: 36, v: c => stage(c) },
      { h: 'مدت انتظار تا قطع (ثانیه)', w: 14, v: c => c.wait, center: true },
      { h: 'داخلی‌های زنگ‌خورده بدون پاسخ', w: 22, v: c => [...(rings.get(c.id.replace(/^C/, '')) || [])].sort().join('، ') || '—', center: true },
      { h: 'تعداد تماس این شماره در همان روز', w: 14, v: c => all.filter(x => x.dir === 'in' && x.phoneRaw === c.phoneRaw && x.date === c.date).length, center: true },
      { h: 'بعداً پاسخ داده شد؟', w: 30, v: c => { const x = all.filter(y => y.dir === 'in' && y.phoneRaw === c.phoneRaw && when(y) > when(c) && (y.st === 'answered' || y.st === 'transferred')).sort((a, z) => when(a).localeCompare(when(z)))[0]; return x ? `بله — ${x.date} ساعت ${x.time}، مکالمه ${mmss(x.dur)}` : 'خیر'; } },
      { h: 'تماس برگشتی از کلینیک', w: 44, v: c => cbText(c) },
      { h: 'مدت مکالمه تماس برگشتی', w: 14, v: c => cbTalk(c), center: true },
      { h: 'وضعیت پیگیری', w: 18, v: c => (reached(c) ? 'ارتباط برقرار شد' : 'هنوز بدون ارتباط'), center: true },
    ] : unreached ? [
      { h: 'ردیف', w: 7, v: (_, i) => i + 1, center: true },
      { h: 'شماره تماس‌گیرنده', w: 16, v: g => g.p, center: true },
      ...(anyName ? [{ h: 'نام بیمار', w: 20, v: (g: any) => (g.last.known ? g.last.name : '') }] : []),
      { h: 'تعداد تلاش بدون ارتباط', w: 14, v: g => g.l.length, center: true },
      { h: 'اولین تلاش', w: 18, v: g => `${g.l[0].date} ساعت ${g.l[0].time}`, center: true },
      { h: 'آخرین تلاش', w: 18, v: g => `${g.last.date} ساعت ${g.last.time}`, center: true },
      { h: 'مرحله‌های قطع', w: 30, v: g => Object.entries(g.l.reduce((m: any, x: any) => { const k = stageShort(x); m[k] = (m[k] || 0) + 1; return m; }, {})).map(([k, n]) => `${n} بار ${k}`).join('، ') },
      { h: 'بیشترین انتظار (ثانیه)', w: 13, v: g => Math.max(...g.l.map((x: any) => x.wait)), center: true },
      { h: 'داخلی‌های زنگ‌خورده', w: 18, v: g => [...new Set(g.l.flatMap((x: any) => [...(rings.get(x.id.replace(/^C/, '')) || [])]))].sort().join('، ') || '—', center: true },
      { h: 'تماس برگشتی کلینیک', w: 26, v: g => { const n = all.filter(y => y.dir === 'out' && y.phoneRaw === g.p && when(y) > when(g.l[0])).length; return n ? `${n} بار تماس گرفته شد، جواب نداد` : 'هنوز تماسی گرفته نشده'; } },
      { h: 'وضعیت', w: 16, v: () => 'هنوز بدون ارتباط', center: true },
    ] : [
      { h: 'ردیف', w: 7, v: (_, i) => i + 1, center: true },
      { h: 'تاریخ', w: 12, v: c => c.date, center: true },
      { h: 'روز', w: 11, v: c => weekday(c.date), center: true },
      { h: 'ساعت', w: 8, v: c => c.time, center: true },
      { h: 'شماره تماس‌گیرنده', w: 16, v: c => c.phoneRaw, center: true },
      ...(anyName ? [{ h: 'نام بیمار', w: 20, v: (c: any) => (c.known ? c.name : '') }] : []),
      { h: 'وضعیت', w: 14, v: c => ST[c.st] || c.st, center: true },
      { h: 'مسیر / مرحله', w: 36, v: c => { const vq = cfg.vqs.find((x: any) => x.name === c.queue); return c.st === 'answered' || c.st === 'transferred' ? (vq ? `صف ${vq.num}` : c.queue) : stage(c); } },
      { h: 'پاسخ‌دهنده (داخلی)', w: 14, v: c => (c.op ? c.op.ext : '—'), center: true },
      { h: 'انتظار (ثانیه)', w: 12, v: c => c.wait, center: true },
      { h: 'مدت مکالمه', w: 11, v: c => (c.dur ? mmss(c.dur) : '—'), center: true },
      { h: 'ضبط مکالمه', w: 11, v: c => (c.hasRec ? 'دارد' : 'ندارد'), center: true },
    ];

    let data: any[] = rows;
    if (unreached) {
      const by: Record<string, any[]> = {};
      for (const c of rows) if (!reached(c) && /^09\d{9}$/.test(c.phoneRaw)) (by[c.phoneRaw] = by[c.phoneRaw] || []).push(c);
      data = Object.entries(by).map(([p, l]) => ({ p, l, last: l[l.length - 1] })).sort((a, z) => z.l.length - a.l.length || when(z.last).localeCompare(when(a.last)));
    }
    const title = String(b.title || 'تماس‌ها').slice(0, 60);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'مرکز تماس دکتر افلاکی';
    wb.created = new Date();
    const ws = wb.addWorksheet(title.slice(0, 31), { views: [{ rightToLeft: true, state: 'frozen', ySplit: 3 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    ws.columns = cols.map(c => ({ width: c.w }));
    const rtl = (center?: boolean) => ({ horizontal: center ? 'center' : 'right', vertical: 'middle', readingOrder: 'rtl', wrapText: true }) as any;
    ws.mergeCells(1, 1, 1, cols.length);
    Object.assign(ws.getCell(1, 1), { value: faDigits(`${title} — مرکز تماس دکتر افلاکی`), font: { bold: true, size: 14, color: { argb: 'FF2E2F31' } }, alignment: rtl() });
    ws.mergeCells(2, 1, 2, cols.length);
    Object.assign(ws.getCell(2, 1), { value: faDigits(`بازه: ${b.from || '—'} تا ${b.to || '—'} · تعداد: ${unreached ? data.length + ' شماره (' + data.reduce((n: number, g: any) => n + g.l.length, 0) + ' تلاش بدون ارتباط)' : rows.length + ' تماس'} · تهیه: ${me.name} · ${jalaliDate(new Date())} ساعت ${hhmm(new Date())}`), font: { size: 11, color: { argb: 'FF6B6E72' } }, alignment: rtl() });
    const head = ws.getRow(3);
    cols.forEach((c, k) => Object.assign(head.getCell(k + 1), { value: c.h, font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E2F31' } }, alignment: rtl(true) }));
    head.height = 32;
    data.forEach((c, i) => {
      const r = ws.getRow(i + 4);
      cols.forEach((col, k) => {
        const cell = r.getCell(k + 1);
        const v = col.v(c, i);
        // Persian digits inside text keep word order correct in every viewer; phone numbers stay dialable
        cell.value = typeof v === 'string' && !col.h.startsWith('شماره') ? faDigits(v) : v;
        cell.alignment = rtl(col.center);
        if (col.h.startsWith('شماره')) cell.numFmt = '@';
        if (col.h === 'وضعیت پیگیری' || col.h === 'وضعیت') cell.font = { bold: true, color: { argb: String(cell.value).startsWith('ارتباط') ? 'FF3D6A0C' : 'FFB42318' } };
        cell.border = { bottom: { style: 'thin', color: { argb: 'FFEEEFEB' } } };
      });
      if (i % 2) r.eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F8F5' } }; });
    });
    ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: cols.length } };
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'calls.export', target: title, detail: { count: rows.length, from: b.from, to: b.to, kind: b.kind || 'all' } } });
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="calls.xlsx"; filename*=UTF-8''${encodeURIComponent(title)}.xlsx`);
    res.send(Buffer.from(buf as ArrayBuffer));
  }

  @Get('recordings/:id/survey')
  async surveyComment(@Param('id') id: string, @Res() res: Response) {
    const c = await this.db.call.findUnique({ where: { id } });
    const file = (c?.survey as any)?.rec;
    if (!file || !path.resolve(file).startsWith(path.resolve(env.monitorDir)) || !fs.existsSync(file)) throw new NotFoundException('پیام صوتی نظرسنجی پیدا نشد');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(path.resolve(file));
  }

  @Get('recordings/:id')
  async recording(@Param('id') id: string, @Query('download') dl: string, @Res() res: Response) {
    const c = await this.db.call.findUnique({ where: { id } });
    if (!c || !c.recPath) throw new NotFoundException('ضبطی برای این تماس وجود ندارد');
    const file = c.recPath === 'demo' ? env.demoAudio : c.recPath;
    if (!path.resolve(file).startsWith(path.resolve(env.monitorDir)) && file !== env.demoAudio) throw new ForbiddenException();
    if (!fs.existsSync(file)) throw new NotFoundException('فایل ضبط پیدا نشد');
    if (dl) res.setHeader('Content-Disposition', `attachment; filename="${c.id}.wav"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(path.resolve(file));
  }
}

/** Endpoints the Asterisk dialplan calls through CURL(); only from localhost with the shared secret. */
@Controller('hooks')
export class HooksController {
  constructor(private calls: CallsService, private store: ConfigStore, private bus: Bus, private patients: PatientsService) {}

  private check(req: Request, s: string) {
    const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
    if (s !== env.hookSecret || !['127.0.0.1', '::1'].includes(ip)) throw new ForbiddenException();
  }

  @Public()
  @Post('call')
  async call(@Req() req: Request, @Query('s') s: string, @Body() b: Record<string, string>) {
    this.check(req, s);
    this.calls.ingest({ ...req.query as any, ...b }).catch(e => new Logger('Hooks').error(e.message));
    return 'ok';
  }

  /** Inbound call entered the dialplan: start the CRM lookup in the background and answer at once. */
  @Public()
  @Post('lookup')
  lookup(@Req() req: Request, @Query('s') s: string, @Body() b: Record<string, string>) {
    this.check(req, s);
    const phone = normalizePhone(b.num || (req.query.num as string));
    if (phone) this.patients.lookup(phone);
    return 'ok';
  }

  /** Just before the phones ring: the caller's name for the phone display ('' = show the number). */
  @Public()
  @Post('cname')
  async cname(@Req() req: Request, @Query('s') s: string, @Body() b: Record<string, string>) {
    this.check(req, s);
    const phone = normalizePhone(b.num || (req.query.num as string));
    return phone ? this.patients.phoneName(phone) : '';
  }

  @Public()
  @Post('answer')
  answer(@Req() req: Request, @Query('s') s: string, @Body() b: Record<string, string>) {
    this.check(req, s);
    const orig = b.orig || (req.query.orig as string);
    const o = orig && this.calls.origs.get(orig);
    if (o) this.bus.emit('cb', { userId: o.userId, origId: orig, stage: 'live' });
    return 'ok';
  }

  @Public()
  @Post('blhit')
  async blhit(@Req() req: Request, @Query('s') s: string, @Body() b: Record<string, string>) {
    this.check(req, s);
    const num = digits(b.num || req.query.num);
    const cfg = await this.store.all();
    const today = todayJ();
    const blist = cfg.blist.map(x => x.num === num ? { ...x, hits: (x.hits || 0) + 1, today: (x.lastDay === today ? x.today || 0 : 0) + 1, lastDay: today, last: today + ' · ' + hhmm(new Date()) } : x);
    await this.store.saveRaw('blist', blist);
    return 'ok';
  }
}
