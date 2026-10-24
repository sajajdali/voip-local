// Live calls for the manager: who is talking to whom right now (from Asterisk's channel list) and
// listen-only monitoring in the browser. Asterisk's ChanSpy runs on an AudioSocket channel that
// connects back to this process; its audio frames are relayed to the listener's websocket.
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as net from 'net';
import type { Socket } from 'socket.io';
import { AsteriskService } from './asterisk/asterisk.service';
import type { Me } from './auth';
import { Bus } from './bus';
import { normalizePhone } from './calls';
import { ConfigStore } from './config';
import { PrismaService } from './prisma.service';

const SPY_PORT = 9030;
const KIND = { hangup: 0x00, uuid: 0x01, audio: 0x10, error: 0xff };
const SILENCE = Buffer.alloc(320); // 20 ms of 8 kHz 16-bit silence

export interface LiveCall {
  id: string; dir: 'in' | 'out' | 'internal'; phone: string; name: string; state: string; stateKey: string;
  with: string; queue: string; since: number; talkSince: number | null; channel: string;
}

interface Spy { uuid: string; ws: Socket; me: Me; callId: string; tcp?: net.Socket; keep?: NodeJS.Timeout; started: number }

const hms = (d: string) => { const [h, m, s] = String(d || '0:0:0').split(':').map(Number); return (h || 0) * 3600 + (m || 0) * 60 + (s || 0); };

@Injectable()
export class LiveCallsService implements OnModuleInit {
  private log = new Logger('LiveCalls');
  calls: LiveCall[] = [];
  private talkSince = new Map<string, number>();
  private names = new Map<string, string>();
  private namesAt = 0;
  private spies = new Map<string, Spy>();
  private last = '';

  constructor(private ast: AsteriskService, private bus: Bus, private db: PrismaService, private store: ConfigStore) {}

  onModuleInit() {
    this.ast.on('channels', (chans: any[]) => this.update(chans).catch(e => this.log.warn(e.message)));
    net.createServer(sock => this.onAudioSocket(sock)).listen(SPY_PORT, '127.0.0.1').on('error', e => this.log.error('spy socket: ' + e.message));
  }

  // ---------------- live call list
  private async update(chans: any[]) {
    const cfg = await this.store.all();
    const extOf = (ch: string) => (/^PJSIP\/(\d+)-/.exec(ch) || [])[1] || '';
    const isTrunk = (ch: string) => /^PJSIP\/trunk-/.test(ch);
    const real = chans.filter(c => !/^AudioSocket\//.test(c.Channel || '') && c.Application !== 'ChanSpy');
    const groups = new Map<string, any[]>();
    for (const c of real) { const k = c.Linkedid || c.Uniqueid; (groups.get(k) || groups.set(k, []).get(k)!).push(c); }
    const now = Date.now();
    const out: LiveCall[] = [];
    for (const [id, l] of groups) {
      let caller = l.find(c => c.Uniqueid === id) || l[0];
      // a call placed into the dialplan through a Local channel (route test, simulated inbound): its ;2 half is the caller
      if (caller && /^Local\/.*;1$/.test(caller.Channel)) {
        const half = l.find(c => c.Channel === caller.Channel.replace(/;1$/, ';2'));
        if (half && /^cc-(inbound|route|ivr|tc|queue|rg|ext|vm|ai)/.test(half.Context || '')) caller = half;
      }
      if (!caller || /^Local\/.*;1$/.test(caller.Channel) || /@cc-(ai-session|outext)/.test(caller.Channel)) continue;
      const ch = caller.Channel as string;
      const dir: LiveCall['dir'] = isTrunk(ch) || /^Local\/.*@cc-inbound/.test(ch) ? 'in' : l.some(c => isTrunk(c.Channel) || /@cc-outext/.test(c.Channel)) || caller.Context === 'cc-callback' ? 'out' : 'internal';
      const phone = normalizePhone(dir === 'in' ? caller.CallerIDNum : dir === 'out' ? caller.ConnectedLineNum || caller.Exten : caller.CallerIDNum) || caller.CallerIDNum || '';
      const bridged = caller.BridgeId ? l.find(c => c !== caller && c.BridgeId === caller.BridgeId) : null;
      const peerOf = (c: any) => {
        if (!c) return '';
        if (/^Local\/ai@cc-ai-session/.test(c.Channel)) return 'دستیار هوشمند';
        const e = extOf(c.Channel);
        if (e) { const x = cfg.exts.find(y => y.n === e); return 'داخلی ' + e + (x && x.name ? ' – ' + x.name : ''); }
        const m = /^Local\/(\d+)@cc-outext/.exec(c.Channel);
        return m ? 'موبایل ' + m[1] : '';
      };
      const app = String(caller.Application || '');
      const qid = (/^cc-([A-Za-z0-9_-]+)/.exec(String(caller.ApplicationData || '')) || [])[1];
      const queue = app === 'Queue' && qid ? (cfg.vqs.find(q => q.id === qid) || { name: qid }).name : '';
      let stateKey = 'other', state = 'در حال برقراری', withWhom = '';
      if (bridged) {
        stateKey = 'talk'; withWhom = dir === 'in' ? peerOf(bridged) : dir === 'out' ? peerOf(caller) || peerOf(bridged) : peerOf(bridged);
        state = withWhom === 'دستیار هوشمند' ? 'در گفتگو با دستیار هوشمند' : 'در حال مکالمه';
        if (dir === 'out' && extOf(ch)) withWhom = peerOf(caller);
      } else if (app === 'Queue') { stateKey = 'queue'; state = 'در صف انتظار'; }
      else if (/^(BackGround|WaitExten|Playback|Read)$/.test(app)) { stateKey = 'ivr'; state = caller.Context === 'cc-survey' ? 'در حال نظرسنجی' : 'در منوی تلفنی'; }
      else if (app === 'Record') { stateKey = 'vm'; state = 'در حال گذاشتن پیام صوتی'; }
      else if (app === 'Dial' || l.some(c => /Ring/.test(c.ChannelStateDesc || ''))) {
        stateKey = 'ring'; state = 'در حال زنگ خوردن';
        withWhom = l.filter(c => c !== caller && extOf(c.Channel)).map(c => extOf(c.Channel)).join('، ');
      }
      if (stateKey === 'talk') { if (!this.talkSince.has(id)) this.talkSince.set(id, now); } else this.talkSince.delete(id);
      out.push({
        id, dir, phone, name: '', state, stateKey, with: withWhom, queue, channel: ch,
        since: now - hms(caller.Duration) * 1000, talkSince: this.talkSince.get(id) || null,
      });
    }
    for (const k of [...this.talkSince.keys()]) if (!groups.has(k)) this.talkSince.delete(k);
    await this.fillNames(out);
    out.sort((a, b) => a.since - b.since);
    this.calls = out;
    const j = JSON.stringify(out.map(c => [c.id, c.stateKey, c.with, c.name, c.talkSince]));
    if (j !== this.last) { this.last = j; this.bus.emit('livecalls', out); }
    // a listened call ended: tell the listener
    for (const s of this.spies.values()) if (!groups.has(s.callId)) this.stop(s.uuid, 'تماس تمام شد');
  }

  private async fillNames(list: LiveCall[]) {
    const phones = [...new Set(list.map(c => c.phone).filter(p => /^09\d{9}$/.test(p)))];
    const missing = phones.filter(p => !this.names.has(p));
    if (missing.length || Date.now() - this.namesAt > 60e3) {
      const rows = await this.db.patient.findMany({ where: { phone: { in: phones } }, select: { phone: true, name: true } });
      if (Date.now() - this.namesAt > 60e3) { this.names.clear(); this.namesAt = Date.now(); }
      for (const p of phones) this.names.set(p, '');
      for (const r of rows) this.names.set(r.phone, r.name);
    }
    for (const c of list) c.name = this.names.get(c.phone) || '';
  }

  // ---------------- listen-only monitoring
  async listen(ws: Socket, me: Me, callId: string) {
    const call = this.calls.find(c => c.id === callId);
    if (!call) throw new Error('این تماس دیگر برقرار نیست');
    for (const s of this.spies.values()) if (s.ws.id === ws.id) this.stop(s.uuid, '');
    const uuid = randomUUID();
    this.spies.set(uuid, { uuid, ws, me, callId, started: Date.now() });
    try {
      // q: no beep or name announcement; E: leave when the listened call hangs up. No w/B: the listener can never be heard.
      await this.ast.ami.action({
        Action: 'Originate', Channel: `AudioSocket/127.0.0.1:${SPY_PORT}/${uuid}`, Application: 'ChanSpy', Data: `${call.channel},qE`,
        Async: 'true', Timeout: 10000, CallerID: '"Monitor" <0>',
      });
    } catch (e) {
      this.spies.delete(uuid);
      throw new Error('شروع شنود ناموفق بود: ' + (e as Error).message);
    }
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'live.listen', target: call.phone || call.channel, detail: { with: call.with, state: call.state } as any } }).catch(() => {});
    return { uuid, call };
  }

  stop(uuid: string, reason: string) {
    const s = this.spies.get(uuid);
    if (!s) return;
    this.spies.delete(uuid);
    if (s.keep) clearInterval(s.keep);
    if (s.tcp && !s.tcp.destroyed) { try { s.tcp.end(Buffer.from([KIND.hangup, 0, 0])); } catch { /* closed */ } s.tcp.destroy(); }
    if (reason) s.ws.emit('liveaudio:end', { uuid, reason });
  }

  stopFor(ws: Socket) { for (const s of [...this.spies.values()]) if (s.ws.id === ws.id) this.stop(s.uuid, ''); }

  private onAudioSocket(sock: net.Socket) {
    let buf = Buffer.alloc(0);
    let spy: Spy | undefined;
    sock.setNoDelay(true);
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 3) {
        const kind = buf[0], len = buf.readUInt16BE(1);
        if (buf.length < 3 + len) break;
        const payload = buf.subarray(3, 3 + len);
        buf = buf.subarray(3 + len);
        if (kind === KIND.uuid) {
          const hex = payload.toString('hex');
          const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
          spy = this.spies.get(id);
          if (!spy) { sock.destroy(); return; }
          spy.tcp = sock;
          // AudioSocket expects traffic both ways; the listener's side is silence and never reaches anyone
          spy.keep = setInterval(() => { if (!sock.destroyed) sock.write(Buffer.concat([Buffer.from([KIND.audio, 0x01, 0x40]), SILENCE])); }, 20);
          spy.ws.emit('liveaudio:start', { uuid: spy.uuid });
        } else if (kind === KIND.audio && spy) {
          spy.ws.emit('liveaudio', payload);
        } else if (kind === KIND.hangup || kind === KIND.error) {
          if (spy) this.stop(spy.uuid, 'شنود پایان یافت');
          sock.destroy();
          return;
        }
      }
    });
    sock.on('close', () => { if (spy && this.spies.has(spy.uuid)) this.stop(spy.uuid, 'شنود پایان یافت'); });
    sock.on('error', () => {});
  }
}
