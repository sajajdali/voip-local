// Owns the AMI connection: applies generated configuration, polls live status, originates calls.
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { env } from '../env';
import { Ami } from './ami';
import { generate, VoipConfig } from './generator';

export interface Live { exts: Record<string, { st: string; dev?: string; ring?: boolean }>; queues: Record<string, { waiting: number; sla: number }>; trunks: Record<string, { reg: boolean; used: number }> }

@Injectable()
export class AsteriskService extends EventEmitter implements OnModuleInit {
  private log = new Logger('Asterisk');
  ami = new Ami(env.amiHost, env.amiPort, env.amiUser, env.amiSecret);
  live: Live = { exts: {}, queues: {}, trunks: {} };
  private lastLive = '';
  private cfg: VoipConfig | null = null;
  private applying: Promise<any> = Promise.resolve();

  onModuleInit() {
    this.ami.on('ready', () => { this.log.log('AMI connected'); if (this.cfg) this.apply(this.cfg).catch(() => {}); });
    this.ami.on('error', e => this.log.warn('AMI: ' + e.message));
    this.ami.on('event', m => this.emit('ami', m));
    this.ami.start();
    setInterval(() => this.poll().catch(() => {}), 1500);
  }

  /** Write the generated files, sync AstDB and reload the touched modules (Issabel's "Apply Config"). */
  apply(cfg: VoipConfig) {
    this.cfg = cfg;
    this.applying = this.applying.catch(() => {}).then(() => this.doApply(cfg));
    return this.applying;
  }

  private async doApply(cfg: VoipConfig) {
    const g = generate(cfg, { hookUrl: env.hookUrl, hookSecret: env.hookSecret, mohDir: env.mohDir });
    fs.mkdirSync(env.confDir, { recursive: true });
    for (const [name, text] of Object.entries(g.files)) {
      const f = path.join(env.confDir, name);
      fs.writeFileSync(f + '.tmp', text);
      fs.renameSync(f + '.tmp', f);
    }
    // one music-on-hold directory per sound
    for (const s of cfg.snds) {
      const src = path.join(env.soundsDir, s.id.replace(/[^A-Za-z0-9_-]/g, '') + '.wav');
      const dir = path.join(env.mohDir, s.id.replace(/[^A-Za-z0-9_-]/g, ''));
      try { fs.mkdirSync(dir, { recursive: true }); const dst = path.join(dir, 'track.wav'); if (fs.existsSync(src)) fs.copyFileSync(src, dst); } catch { /* ignore */ }
    }
    if (!this.ami.connected) return { applied: false, error: 'اتصال به Asterisk برقرار نیست', warnings: g.warnings };
    for (const [fam, kv] of Object.entries(g.astdb)) {
      await this.ami.action({ Action: 'DBDelTree', Family: fam }).catch(() => {});
      for (const [k, v] of Object.entries(kv)) await this.ami.action({ Action: 'DBPut', Family: fam, Key: k, Val: v });
    }
    const outs: string[] = [];
    for (const c of ['module reload res_pjsip.so', 'dialplan reload', 'module reload app_queue.so', 'moh reload']) outs.push(await this.ami.command(c).catch(e => 'ERR ' + e.message));
    const errs = outs.join('\n').split('\n').filter(l => /error|failed|unable/i.test(l));
    if (errs.length) this.log.warn('reload: ' + errs.join(' | '));
    return { applied: true, warnings: g.warnings };
  }

  private async poll() {
    if (!this.ami.connected || !this.cfg) return;
    const cfg = this.cfg;
    const exts: Live['exts'] = {};
    const ds = await this.ami.action({ Action: 'DeviceStateList' }, true).catch(() => ({ events: [] }));
    const devState: Record<string, string> = {};
    for (const e of ds.events || []) if (/^PJSIP\//.test(e.Device || '')) devState[e.Device.slice(6)] = e.State;
    const contacts = await this.ami.action({ Action: 'PJSIPShowContacts' }, true).catch(() => ({ events: [] }));
    const ua: Record<string, string> = {};
    for (const c of contacts.events || []) { const n = String(c.Endpoint || c.ObjectName || '').split('/')[0]; if (n && c.UserAgent) ua[n] = c.UserAgent; }
    for (const e of cfg.exts) {
      const s = devState[e.n] || 'UNAVAILABLE';
      const st = /INUSE|BUSY|RINGINUSE|ONHOLD/.test(s) && s !== 'NOT_INUSE' ? 'busy' : s === 'NOT_INUSE' || s === 'RINGING' ? 'online' : 'offline';
      exts[e.n] = { st, ring: /RINGING|RINGINUSE/.test(s), ...(ua[e.n] ? { dev: ua[e.n].slice(0, 40) } : {}) };
    }
    const queues: Live['queues'] = {};
    const qs = await this.ami.action({ Action: 'QueueStatus' }, true).catch(() => ({ events: [] }));
    for (const q of cfg.vqs) {
      const p = (qs.events || []).find((e: any) => e.Event === 'QueueParams' && e.Queue === 'cc-' + q.id);
      if (p) queues[q.id] = { waiting: +p.Calls || 0, sla: Math.round(+p.ServicelevelPerf2 || +p.ServicelevelPerf || (+p.Completed ? 0 : 100)) };
    }
    const trunks: Live['trunks'] = {};
    const regs = await this.ami.action({ Action: 'PJSIPShowRegistrationsOutbound' }, true).catch(() => ({ events: [] }));
    const chans = await this.ami.action({ Action: 'CoreShowChannels' }, true).catch(() => ({ events: [] }));
    this.emit('channels', (chans.events || []).filter((c: any) => c.Event === 'CoreShowChannel'));
    for (const t of cfg.trunks) {
      const r = (regs.events || []).find((e: any) => e.ObjectName === `trunk-${t.id}-reg`);
      const used = (chans.events || []).filter((c: any) => String(c.Channel || '').startsWith(`PJSIP/trunk-${t.id}-`)).length;
      trunks[t.id] = { reg: r ? r.Status === 'Registered' : false, used };
    }
    this.live = { exts, queues, trunks };
    const j = JSON.stringify(this.live);
    if (j !== this.lastLive) { this.lastLive = j; this.emit('live', this.live); }
  }

  /** OPTIONS qualify of a trunk; returns round-trip time. */
  async testTrunk(id: string) {
    if (!this.ami.connected) return { ok: false, error: 'اتصال به Asterisk برقرار نیست' };
    const ep = 'trunk-' + id;
    try { await this.ami.action({ Action: 'PJSIPQualify', Endpoint: ep }); } catch (e) { return { ok: false, error: 'ترانک در مرکز تلفن تعریف نشده یا غیرفعال است' }; }
    await new Promise(r => setTimeout(r, 1500));
    const c = await this.ami.action({ Action: 'PJSIPShowContacts' }, true).catch(() => ({ events: [] }));
    const x = (c.events || []).find((e: any) => String(e.ObjectName || e.Aor || '').startsWith(ep));
    if (!x) return { ok: false, error: 'پاسخی از سرور ترانک دریافت نشد' };
    if (!/Avail|Reachable/i.test(x.Status || '')) return { ok: false, error: 'سرور ترانک در دسترس نیست (' + (x.Status || 'Unknown') + ')' };
    return { ok: true, ms: Math.round((+x.RoundtripUsec || 0) / 1000) };
  }

  originate(opExt: string, number: string, origId: string, name: string, vmId: string | null) {
    return this.ami.action({
      Action: 'Originate', Channel: `PJSIP/${opExt}`, Context: 'cc-callback', Exten: number, Priority: 1, Async: 'true', Timeout: 30000,
      CallerID: `"${name.replace(/"/g, '')}" <${number}>`,
      Variable: [`__CC_ORIG=${origId}`, `__CC_OPEXT=${opExt}`, `__CC_NUM=${number}`, `CC_VMID=${vmId || ''}`],
    });
  }

  hangupExt(opExt: string) {
    return this.ami.action({ Action: 'Hangup', Channel: `/^PJSIP\\/${opExt}-.*$/` }).catch(() => null);
  }
}
