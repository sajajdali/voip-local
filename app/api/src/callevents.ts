// Live call events for «ارسال تماس‌ها (API)». The dialplan marks the steps only it knows about with a UserEvent
// (call start, IVR key, queue, survey); ringing, answer and transfer come from Asterisk's own AMI events.
// Each call is followed by its linkedid; events of calls that never sent «call.started» (internal calls,
// monitoring, AI side channels) are ignored. The end of a call is reported by CallsService.ingest → WebhookService.finished.
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AsteriskService } from './asterisk/asterisk.service';
import { normalizePhone } from './calls';
import { ConfigStore } from './config';
import { jalaliDate } from './jalali';
import { PrismaService } from './prisma.service';
import { WebhookService } from './webhook';

interface Tracked {
  callId: string; dir: 'in' | 'out'; phone: string; start: number; queue: string;
  answered: boolean; ringAt: Map<string, number>; ended?: NodeJS.Timeout;
}

/** What is on the other end of a dialled channel. */
export function dialTarget(chan: string): { target: 'extension' | 'external' | 'mobile' | 'ai' | 'other'; extension?: string; number?: string } {
  if (/^PJSIP\/trunk-/.test(chan)) return { target: 'external' };
  // Platform: PJSIP/105-0001 · Tenant: PJSIP/tnxxxxxxxx_105-0001 → report dial number 105
  let m = /^PJSIP\/(?:[A-Za-z0-9]+_)?(\d+)-/.exec(chan);
  if (m) return { target: 'extension', extension: m[1] };
  m = /^Local\/(\d+)@cc-outext/.exec(chan);
  if (m) return { target: 'mobile', number: m[1] };
  if (/^Local\/ai@cc-ai-session/.test(chan)) return { target: 'ai' };
  return { target: 'other' };
}

/** Dial digits from a raw ext / tenant sip id (tn…_102 → 102). */
export function extDigits(raw: string) {
  const s = String(raw || '').trim();
  const m = /(?:^|_)(\d{2,6})$/.exec(s);
  if (m) return m[1];
  const d = s.replace(/\D/g, '');
  return d.length >= 2 && d.length <= 6 ? d : '';
}

const dec = (v: any) => { try { return decodeURIComponent(String(v ?? '')); } catch { return String(v ?? ''); } };

@Injectable()
export class CallEventsService implements OnModuleInit {
  private log = new Logger('CallEvents');
  private calls = new Map<string, Tracked>(); // by linkedid
  private names = { at: 0, ops: new Map<string, string>() };

  constructor(private ast: AsteriskService, private hooks: WebhookService, private db: PrismaService, private store: ConfigStore) {}

  onModuleInit() {
    this.ast.on('ami', (m: any) => this.onAmi(m).catch(e => this.log.warn(`${m.Event}: ${e.message}`)));
  }

  /** Operator name for an extension: the panel user on it, else the extension's own label. */
  private async operator(ext: string) {
    if (Date.now() - this.names.at > 60e3) {
      const cfgP = typeof (this.store as any).withDidRoutes === 'function' ? (this.store as any).withDidRoutes() : this.store.all();
      const [users, cfg] = await Promise.all([this.db.user.findMany({ where: { ext: { not: null }, active: true }, select: { ext: true, name: true } }), cfgP]);
      const ops = new Map<string, string>();
      for (const e of cfg.exts || []) if (e.name) ops.set(String(e.n), e.name);
      for (const u of users) if (u.ext) ops.set(u.ext, u.name);
      this.names = { at: Date.now(), ops };
    }
    return { extension: ext, name: this.names.ops.get(ext) || null };
  }

  /**
   * How often this number has been in touch: all calls and today's (Tehran day), both directions and inbound only.
   * The counts include the call that is starting (it is saved only when it ends), so a first-time caller has 1 / 1.
   */
  async callerHistory(phone: string, dir: 'in' | 'out') {
    if (!phone || phone === 'unknown') return null;
    const today = jalaliDate(new Date());
    const [total, todayN, inTotal, inToday, last] = await Promise.all([
      this.db.call.count({ where: { phone } }),
      this.db.call.count({ where: { phone, date: today } }),
      this.db.call.count({ where: { phone, dir: 'in' } }),
      this.db.call.count({ where: { phone, dir: 'in', date: today } }),
      this.db.call.findFirst({ where: { phone }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } }),
    ]);
    const mine = dir === 'in' ? 1 : 0;
    return { total: total + 1, today: todayN + 1, inboundTotal: inTotal + mine, inboundToday: inToday + mine, lastCallAt: last ? last.startedAt.toISOString() : null, firstCall: total === 0 };
  }

  async onAmi(m: any) {
    const lid = String(m.Linkedid || '');
    if (m.Event === 'UserEvent' && m.UserEvent === 'CCEvent') return this.onMarker(m, lid);
    const t = lid && this.calls.get(lid);
    if (!t) return;
    switch (m.Event) {
      case 'DialBegin': return this.onDialBegin(t, m);
      case 'DialEnd': return this.onDialEnd(t, m);
      case 'BlindTransfer': return this.onBlind(t, m);
      case 'AttendedTransfer': return this.onAttended(t, m);
      case 'Hangup':
        // the caller's own channel is gone: forget the call shortly after (the end event comes from the hangup handler)
        if (m.Uniqueid === lid && !t.ended) t.ended = setTimeout(() => this.calls.delete(lid), 120e3);
        return;
    }
  }

  private async onMarker(m: any, lid: string) {
    const type = String(m.Type || '');
    if (type === 'call.started') {
      const dir = m.Dir === 'out' ? 'out' : 'in';
      const num = dec(m.Num);
      const phone = normalizePhone(num) || num;
      const callId = 'C' + String(m.Uid || m.Uniqueid || lid).replace(/[^0-9.]/g, '');
      if (!lid || this.calls.has(lid)) return;
      this.calls.set(lid, { callId, dir, phone, start: Date.now(), queue: '', answered: false, ringAt: new Map() });
      const [patient, calls] = await Promise.all([
        /^09\d{9}$/.test(phone) ? this.db.patient.findUnique({ where: { phone }, select: { name: true } }) : null,
        this.callerHistory(phone, dir).catch(() => null),
      ]);
      const opExt = String(m.Opext || '').replace(/\D/g, '');
      return this.hooks.record('call.started', callId, {
        direction: dir === 'in' ? 'inbound' : 'outbound', phone,
        callerNumber: dir === 'in' ? phone : null, calledNumber: dir === 'in' ? String(m.Did || '').replace(/\D/g, '') || null : phone,
        patientName: patient?.name || null,
        calls,
        ...(dir === 'out' && opExt ? { operator: await this.operator(opExt) } : {}),
        isCallback: m.Callback === '1',
      });
    }
    const t = this.calls.get(lid);
    if (!t) return;
    if (type === 'call.ivr') return this.hooks.record('call.ivr', t.callId, { menu: dec(m.Menu), key: String(m.Key || ''), label: dec(m.Label) || null });
    if (type === 'call.queued') {
      t.queue = dec(m.Queue);
      return this.hooks.record('call.queued', t.callId, { queue: t.queue, phone: t.phone });
    }
    if (type === 'call.ringing') {
      // Dialplan marker for preferred-agent ring (AMI DialBegin also fires; this tags target=preferred).
      const raw = String(m.Ext || m.Ansext || '');
      const ext = extDigits(raw);
      const target = String(m.Target || '').toLowerCase() === 'preferred' ? 'preferred' : 'extension';
      if (!ext) return;
      const key = `pref:${ext}`;
      const last = t.ringAt.get(key) || 0;
      if (Date.now() - last < 5e3) return;
      t.ringAt.set(key, Date.now());
      const op = await this.operator(ext);
      return this.hooks.record('call.ringing', t.callId, {
        target, preferred: target === 'preferred', extension: ext, operator: op.name, queue: t.queue || null,
      });
    }
    if (type === 'preferred.missed') {
      const ext = extDigits(String(m.Ext || ''));
      return this.hooks.record('preferred.missed', t.callId, {
        extension: ext || null, operator: ext ? (await this.operator(ext)).name : null, queue: t.queue || null,
      });
    }
    if (type === 'survey.started') {
      const ext = String(m.Ansext || '').replace(/\D/g, '');
      return this.hooks.record('survey.started', t.callId, { phone: t.phone, operator: ext ? await this.operator(ext) : null });
    }
  }

  private async onDialBegin(t: Tracked, m: any) {
    const d = dialTarget(String(m.DestChannel || ''));
    if (d.target === 'other') return;
    // a queue re-rings the same phones every few seconds: one «ringing» per phone per half minute is enough
    const key = d.extension || d.number || d.target;
    const last = t.ringAt.get(key) || 0;
    if (Date.now() - last < 30e3) return;
    t.ringAt.set(key, Date.now());
    const who = d.target === 'extension' ? { extension: d.extension, operator: (await this.operator(d.extension!)).name } : d.target === 'mobile' ? { number: d.number } : d.target === 'external' ? { number: t.phone } : {};
    return this.hooks.record('call.ringing', t.callId, { target: d.target, ...who, queue: t.queue || null });
  }

  private async onDialEnd(t: Tracked, m: any) {
    if (m.DialStatus !== 'ANSWER' || t.answered) return;
    const d = dialTarget(String(m.DestChannel || ''));
    if (d.target === 'other') return;
    t.answered = true;
    const who = d.target === 'extension' ? { extension: d.extension, operator: (await this.operator(d.extension!)).name } : d.target === 'mobile' ? { number: d.number } : d.target === 'external' ? { number: t.phone } : {};
    return this.hooks.record('call.answered', t.callId, { target: d.target, ...who, queue: t.queue || null, waitSeconds: Math.round((Date.now() - t.start) / 1000) });
  }

  private async onBlind(t: Tracked, m: any) {
    if (m.Result && m.Result !== 'Success') return;
    const from = dialTarget(String(m.TransfererChannel || ''));
    const to = String(m.Extension || '');
    t.answered = false; // the next answer is the transfer target's
    return this.hooks.record('call.transferred', t.callId, {
      kind: 'blind',
      from: from.extension ? await this.operator(from.extension) : null,
      to: /^\d{2,5}$/.test(to) ? await this.operator(to) : { number: to },
    });
  }

  private async onAttended(t: Tracked, m: any) {
    if (m.Result && m.Result !== 'Success') return;
    const from = dialTarget(String(m.OrigTransfererChannel || ''));
    // the operator's second call is to the target: its connected line is who the caller ends up with
    const num = String(m.SecondTransfererConnectedLineNum || '').replace(/\D/g, '');
    const tt = dialTarget(String(m.TransferTargetChannel || ''));
    return this.hooks.record('call.transferred', t.callId, {
      kind: 'attended',
      from: from.extension ? await this.operator(from.extension) : null,
      to: num ? (num.length <= 5 ? await this.operator(num) : { number: num }) : tt.extension ? await this.operator(tt.extension) : null,
    });
  }
}
