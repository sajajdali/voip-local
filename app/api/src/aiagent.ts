// Phone AI receptionist: the realtime voice bridge (ai-agent/bridge.py) runs as its own service; this module
// owns its settings, writes its environment files and feeds it caller details from the local patient cache.
import { BadRequestException, Body, Controller, Get, Injectable, Logger, OnModuleInit, Put } from '@nestjs/common';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { CurrentUser, Me, Roles, Perm } from './auth';
import { AiService } from './ai';
import { UsageService } from './usage';
import { Bus } from './bus';
import { ConfigStore } from './config';
import { PatientsService, daysSince } from './patients';
import { PrismaService } from './prisma.service';

export const AI_DIR = process.env.AI_AGENT_ETC || '/etc/callcenter/ai';
export const AI_STATE = process.env.AI_AGENT_STATE || '/var/lib/callcenter-ai';
export const AI_PORT = 9019;

export interface AiAgentSettings {
  enabled: boolean; code: string; provider: 'openai' | 'gemini';
  openaiKey: string; openaiModel: string; openaiVoice: string;
  geminiKey: string; geminiModel: string; geminiVoice: string;
  maxCalls: number; maxSeconds: number; closingSeconds: number;
  transferExt: string; transferRing: number; transferMobile: string; fallback: string;
  crmNationalUrl: string; crmAppLinkUrl: string; crmEmergencyUrl: string;
  record: boolean; keepTranscript: boolean; transcribeModel: string; codeInIvr: boolean;
}
const CRM_BASE = 'https://crm.drpouriaaflaki.com/api/v1/voip/surgery-status';
export const AI_AGENT_DEFAULTS: AiAgentSettings = {
  enabled: false, code: '33', provider: 'openai',
  openaiKey: '', openaiModel: 'gpt-realtime-2.1-mini', openaiVoice: 'marin',
  geminiKey: '', geminiModel: 'gemini-3.1-flash-live-preview', geminiVoice: 'Kore',
  maxCalls: 4, maxSeconds: 900, closingSeconds: 15,
  transferExt: '', transferRing: 10, transferMobile: '', fallback: 'vm',
  crmNationalUrl: CRM_BASE + '/by-national-code', crmAppLinkUrl: CRM_BASE + '/application-link', crmEmergencyUrl: CRM_BASE + '/emergency-sms',
  record: true, keepTranscript: true, transcribeModel: 'gpt-transcribe', codeInIvr: true,
};

const SECRET_KEYS = ['openaiKey', 'geminiKey'] as const;
const envLine = (k: string, v: string | number) => `${k}=${String(v).replace(/[\r\n]/g, '')}`;

@Injectable()
export class AiAgentService implements OnModuleInit {
  private log = new Logger('AiAgent');
  constructor(private db: PrismaService, private store: ConfigStore, private patients: PatientsService, private bus: Bus, private ai: AiService, private usage: UsageService) {}

  async onModuleInit() {
    // the CRM password lives in the patient-system settings; keep the bridge's copy in step
    this.bus.on('crm-saved', () => this.writeEnv().catch(e => this.log.warn(e.message)));
    await this.writeEnv().catch(e => this.log.warn('AI agent env not written: ' + e.message));
    // calls that never reach the call log (code 33 from a desk phone): still count their usage
    setInterval(() => this.sweep(), 300e3).unref();
  }

  private sweep() {
    const dir = path.join(AI_STATE, 'transcripts');
    let names: string[] = [];
    try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')); } catch { return; }
    for (const n of names) {
      const file = path.join(dir, n);
      try {
        if (Date.now() - fs.statSync(file).mtimeMs < 180e3) continue;
        const d = JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.rmSync(file, { force: true });
        this.recordUsage(null, d);
      } catch (e) { this.log.warn('sweep ' + n + ': ' + (e as Error).message); }
    }
  }

  async settings(): Promise<AiAgentSettings> {
    const r = await this.db.configEntry.findUnique({ where: { key: 'aiagent' } });
    return { ...AI_AGENT_DEFAULTS, ...((r?.data as any) || {}) };
  }

  publicView(s: AiAgentSettings) {
    const hint = (k: string) => (k ? '••••' + k.slice(-4) : '');
    const { openaiKey, geminiKey, ...rest } = s;
    return { ...rest, hasOpenaiKey: !!openaiKey, openaiKeyHint: hint(openaiKey), hasGeminiKey: !!geminiKey, geminiKeyHint: hint(geminiKey) };
  }

  async save(b: any, me: Me) {
    const cur = await this.settings();
    const cfg = await this.store.all();
    const str = (k: keyof AiAgentSettings) => String(b[k] ?? cur[k]).trim();
    const int = (k: keyof AiAgentSettings, min: number, max: number) => Math.min(max, Math.max(min, Math.round(+(b[k] ?? cur[k]) || min)));
    const url = (k: keyof AiAgentSettings) => { const u = str(k); if (u && !/^https?:\/\/\S+$/i.test(u)) throw new BadRequestException('آدرس باید با http:// یا https:// شروع شود'); return u; };
    const next: AiAgentSettings = {
      enabled: !!(b.enabled ?? cur.enabled),
      code: str('code').replace(/[^0-9*#]/g, ''),
      provider: b.provider === 'gemini' || (b.provider === undefined && cur.provider === 'gemini') ? 'gemini' : 'openai',
      openaiKey: typeof b.openaiKey === 'string' && b.openaiKey.trim() ? b.openaiKey.trim() : cur.openaiKey,
      openaiModel: str('openaiModel') || AI_AGENT_DEFAULTS.openaiModel, openaiVoice: str('openaiVoice') || AI_AGENT_DEFAULTS.openaiVoice,
      geminiKey: typeof b.geminiKey === 'string' && b.geminiKey.trim() ? b.geminiKey.trim() : cur.geminiKey,
      geminiModel: str('geminiModel') || AI_AGENT_DEFAULTS.geminiModel, geminiVoice: str('geminiVoice') || AI_AGENT_DEFAULTS.geminiVoice,
      maxCalls: int('maxCalls', 1, 20), maxSeconds: int('maxSeconds', 60, 3600), closingSeconds: int('closingSeconds', 5, 60),
      transferExt: str('transferExt').replace(/\D/g, ''), transferRing: int('transferRing', 5, 60),
      transferMobile: str('transferMobile').replace(/\D/g, ''), fallback: str('fallback') || 'vm',
      crmNationalUrl: url('crmNationalUrl'), crmAppLinkUrl: url('crmAppLinkUrl'), crmEmergencyUrl: url('crmEmergencyUrl'),
      record: !!(b.record ?? cur.record), keepTranscript: !!(b.keepTranscript ?? cur.keepTranscript), codeInIvr: !!(b.codeInIvr ?? cur.codeInIvr),
      transcribeModel: str('transcribeModel') || AI_AGENT_DEFAULTS.transcribeModel,
    };
    if (b.clearOpenaiKey) next.openaiKey = '';
    if (b.clearGeminiKey) next.geminiKey = '';
    if (next.code) {
      const taken = cfg.exts.some(e => e.n === next.code) || cfg.vqs.some(q => String(q.num) === next.code) || cfg.rgroups.some(g => String(g.num) === next.code);
      if (taken) throw new BadRequestException('کد ' + next.code + ' قبلاً برای یک داخلی، صف یا گروه زنگ استفاده شده است');
    }
    if (next.transferExt && !cfg.exts.some(e => e.n === next.transferExt)) throw new BadRequestException('داخلی انتقال وجود ندارد: ' + next.transferExt);
    if (next.fallback === 'ai') next.fallback = 'vm';
    if (next.enabled && !(next.provider === 'openai' ? next.openaiKey : next.geminiKey)) throw new BadRequestException('برای روشن کردن دستیار، کلید API سرویس انتخاب‌شده را وارد کنید');
    await this.db.configEntry.upsert({ where: { key: 'aiagent' }, create: { key: 'aiagent', data: next as any, updatedBy: me.id }, update: { data: next as any, updatedBy: me.id } });
    const safe: any = { ...next }; SECRET_KEYS.forEach(k => delete safe[k]);
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'aiagent.save', target: 'aiagent', detail: { ...safe, openaiKeyChanged: !!b.openaiKey, geminiKeyChanged: !!b.geminiKey } } });
    await this.writeEnv(next);
    // the dialplan (code, destination, transfer) depends on these settings
    this.store.reset();
    const applied = await this.store.applyAll().then(() => true).catch(e => { this.log.warn(e.message); return false; });
    return { ...this.publicView(next), applied };
  }

  /** Environment files read by the bridge service; a systemd path unit restarts it when agent.env changes. */
  async writeEnv(s?: AiAgentSettings) {
    s = s || await this.settings();
    const crm = await this.patients.settings();
    fs.mkdirSync(AI_DIR, { recursive: true });
    const write = (name: string, lines: string[]) => {
      const file = path.join(AI_DIR, name), body = lines.join('\n') + '\n';
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === body) return;
      fs.writeFileSync(file + '.tmp', body, { mode: 0o640 });
      fs.renameSync(file + '.tmp', file);
    };
    write('crm.env', [
      '# Generated by the call-center panel (settings → patient system / AI receptionist). Do not edit.',
      envLine('CRM_API_URL', crm.url), envLine('CRM_NATIONAL_CODE_API_URL', s.crmNationalUrl), envLine('CRM_APPLICATION_LINK_API_URL', s.crmAppLinkUrl),
      envLine('CRM_EMERGENCY_SMS_API_URL', s.crmEmergencyUrl), envLine('CRM_API_USERNAME', crm.user), envLine('CRM_API_PASSWORD', crm.pass),
      envLine('CRM_API_TIMEOUT', 2.5), envLine('CRM_METADATA_DIR', path.join(AI_STATE, 'callers')),
    ]);
    write('agent.env', [
      '# Generated by the call-center panel (settings → AI receptionist). Do not edit.',
      envLine('AI_PROVIDER', s.provider),
      envLine('OPENAI_API_KEY', s.openaiKey), envLine('OPENAI_REALTIME_MODEL', s.openaiModel), envLine('OPENAI_REALTIME_VOICE', s.openaiVoice),
      envLine('GEMINI_API_KEY', s.geminiKey), envLine('GEMINI_LIVE_MODEL', s.geminiModel), envLine('GEMINI_LIVE_VOICE', s.geminiVoice),
      envLine('ASTERISK_AI_HOST', '127.0.0.1'), envLine('ASTERISK_AI_PORT', AI_PORT),
      envLine('ASTERISK_AI_MAX_CALLS', s.maxCalls), envLine('ASTERISK_AI_MAX_SECONDS', s.maxSeconds), envLine('ASTERISK_AI_CLOSING_SECONDS', s.closingSeconds),
      envLine('ASTERISK_AI_FALLBACK_WAV', '/var/lib/asterisk/sounds/custom/ai-unavailable-fa.wav'),
      envLine('ASTERISK_AI_APPOINTMENTS_DB', path.join(AI_STATE, 'appointments.db')),
      envLine('ASTERISK_AI_TRANSFER_DIR', path.join(AI_STATE, 'transfers')),
      envLine('ASTERISK_AI_CALLER_METADATA_DIR', path.join(AI_STATE, 'callers')),
      envLine('CRM_CONFIG_PATH', path.join(AI_DIR, 'crm.env')),
      // the call file always comes back (it carries the usage); the spoken lines only when kept
      envLine('ASTERISK_AI_TRANSCRIPT_DIR', path.join(AI_STATE, 'transcripts')),
      envLine('ASTERISK_AI_KEEP_TRANSCRIPT', s.keepTranscript ? '1' : '0'),
      envLine('ASTERISK_AI_TRANSCRIBE_MODEL', s.transcribeModel),
    ]);
  }

  /** Before the AI answers: hand the bridge what we know about the caller (no extra CRM request). */
  async writeCallerMeta(uuid: string, phone: string | null) {
    if (!/^[0-9a-f-]{36}$/i.test(uuid) || !phone) return;
    await this.patients.waitLookup(phone, 2500);
    const p = await this.db.patient.findUnique({ where: { phone } });
    const days = daysSince(p?.surgery);
    const meta = {
      name: p?.name || '', mobile: phone,
      has_surgery_record: days != null ? true : null,
      last_surgery_date: days != null ? p!.surgery : '',
      days_since_surgery: days,
    };
    const file = path.join(AI_STATE, 'callers', uuid + '.json');
    fs.writeFileSync(file, JSON.stringify(meta), { mode: 0o660 });
    // the bridge deletes it on read; never leave patient details behind if the call died first
    setTimeout(() => fs.rm(file, { force: true }, () => {}), 120e3).unref();
  }

  /** After an AI call: take the bridge's transcript, keep it with the call and summarise it for the manager. */
  importConversation(callId: string, uuid: string) {
    if (!/^[0-9a-f-]{36}$/i.test(uuid)) return;
    (async () => {
      const file = path.join(AI_STATE, 'transcripts', uuid + '.json');
      // the bridge writes it as its session closes, a moment after Asterisk hangs up
      for (let i = 0; i < 20 && !fs.existsSync(file); i++) await new Promise(r => setTimeout(r, 500));
      if (!fs.existsSync(file)) { await this.db.call.update({ where: { id: callId }, data: { aiState: 'none' } }).catch(() => {}); return; }
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.rmSync(file, { force: true });
      this.recordUsage(callId, d);
      const lines = (Array.isArray(d.transcript) ? d.transcript : []).slice(0, 2000);
      const conv = { provider: String(d.provider || ''), model: String(d.model || ''), duration: +d.duration || 0, endReason: String(d.end_reason || ''), lines };
      await this.db.call.update({ where: { id: callId }, data: { aiConv: conv as any } });
      this.bus.emit('calls', { id: callId });
      await this.ai.summarizeConversation(callId, lines);
    })().catch(e => this.log.warn(`conversation ${callId}: ${e.message}`));
  }

  /** What the live conversation cost, as the provider reported it to the bridge. */
  private recordUsage(callId: string | null, d: any) {
    const u = d.usage || {}, r = u.realtime || {}, t = u.transcribe || {};
    const s = { openaiModel: String(d.model || '') };
    if (r.responses || r.audio_in || r.audio_out) {
      this.usage.record({ feature: 'agent_voice', callId, kind: 'realtime', model: s.openaiModel || 'realtime',
        inTok: (r.text_in || 0), cached: r.cached, outTok: r.text_out, audioIn: r.audio_in, audioOut: r.audio_out });
    }
    if (t.count) {
      // billed per minute; when only tokens are reported, ~10 audio tokens make one second
      const seconds = t.seconds || (t.audio_tokens ? t.audio_tokens / 10 : 0);
      this.settings().then(st => this.usage.record({ feature: 'agent_voice', callId, kind: 'stt', model: st.transcribeModel, seconds, inTok: t.in_tokens, outTok: t.out_tokens })).catch(() => {});
    }
  }

  /** Is the bridge listening? */
  running() {
    return new Promise<boolean>(resolve => {
      const sock = net.connect({ host: '127.0.0.1', port: AI_PORT });
      const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
      sock.setTimeout(800, () => done(false));
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
    });
  }
}

@Perm('vagent')
@Controller('aiagent')
export class AiAgentController {
  constructor(private agent: AiAgentService, private db: PrismaService) {}

  @Get()
  async get() {
    const s = await this.agent.settings();
    const since = new Date(Date.now() - 30 * 864e5);
    const calls = await this.db.call.count({ where: { queue: 'دستیار هوشمند', startedAt: { gte: since } } });
    return { settings: this.agent.publicView(s), status: { running: await this.agent.running(), calls30: calls } };
  }

  @Put()
  save(@Body() b: any, @CurrentUser() me: Me) { return this.agent.save(b, me); }
}
