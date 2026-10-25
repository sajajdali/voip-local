// «بکاپ و بازیابی» (like Issabel's Backup/Restore): pick components, build a .tar.gz, list / download /
// upload / restore, plus an optional schedule. Database parts are stored as JSON per table, files as-is.
import { BadRequestException, Body, Controller, Delete, Get, Injectable, Logger, NotFoundException, OnModuleInit, Param, Post, Put, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { execFile } from 'child_process';
import type { Response } from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { CurrentUser, Me, Roles, Perm } from './auth';
import { ConfigStore } from './config';
import { env } from './env';
import { hhmm, jalaliDate, localParts } from './jalali';
import { PrismaService } from './prisma.service';

const run = promisify(execFile);
const DIR = process.env.BACKUP_DIR || '/var/lib/callcenter/backups';
const SOUNDS = env.soundsDir;                                   // /var/lib/asterisk/sounds/custom
const MOH = env.mohDir;                                         // /var/lib/asterisk/moh-cc
const REC = path.join(env.monitorDir, 'cc');                    // call recordings
const VM = path.join(env.monitorDir, 'cc-vm');                  // voicemail

export const COMPONENTS: Record<string, { label: string; desc: string; tables?: string[]; restorable: boolean }> = {
  voip: { label: 'تنظیمات VoIP', desc: 'داخلی‌ها (با رمز SIP)، ترانک‌ها، صف‌ها، IVR، مسیرهای ورودی و خروجی، شرایط زمانی و تعطیلات، گروه زنگ، دنبال‌کردن تماس، لیست سیاه، تنظیمات API', tables: ['ConfigEntry'], restorable: true },
  users: { label: 'کاربران پنل', desc: 'حساب‌های کاربری، نقش‌ها و رمزهای ورود (به‌صورت رمزنگاری‌شده)', tables: ['User'], restorable: true },
  calls: { label: 'تماس‌ها و گزارش‌ها', desc: 'لیست تماس‌ها، پیگیری‌ها، یادداشت‌ها و ارجاع‌ها، پرونده‌ها و CDR خام', tables: ['Call', 'Follow', 'Note', 'Patient', 'cdr'], restorable: true },
  sounds: { label: 'صداها و موسیقی انتظار', desc: 'فایل‌های صوتی IVR، اعلان‌ها و موسیقی انتظار صف‌ها', restorable: true },
  recordings: { label: 'ضبط مکالمات', desc: 'فایل‌های ضبط‌شده همه مکالمه‌ها (حجیم)', restorable: true },
  voicemail: { label: 'پیام‌های صوتی', desc: 'فایل‌های صوتی پیام‌هایی که بیماران گذاشته‌اند', restorable: true },
  logs: { label: 'لاگ تغییرات و ارسال‌ها', desc: 'تاریخچه تغییر تنظیمات، ورودها و گزارش ارسال‌های API', tables: ['AuditLog', 'WebhookLog'], restorable: true },
  system: { label: 'پیکربندی سرور', desc: 'فایل‌های Asterisk و تنظیمات سامانه (شامل رمزهای سرور) — فقط برای دانلود؛ بازیابی دستی', restorable: false },
};
const KEYS = Object.keys(COMPONENTS);
const SERIAL: Record<string, string> = { Note: 'id', AuditLog: 'id', WebhookLog: 'id', cdr: 'id' };

async function du(p: string) {
  try { const { stdout } = await run('du', ['-sb', p]); return +stdout.split('\t')[0] || 0; } catch { return 0; }
}
const fileCount = (p: string) => { try { return fs.readdirSync(p).length; } catch { return 0; } };

interface Schedule { enabled: boolean; freq: 'daily' | 'weekly'; time: string; weekday: number; keep: number; components: string[]; lastRun?: string }
const SCHED0: Schedule = { enabled: false, freq: 'daily', time: '02:00', weekday: 0, keep: 7, components: ['voip', 'users', 'calls', 'sounds', 'voicemail', 'logs'] };

@Injectable()
export class BackupService implements OnModuleInit {
  private log = new Logger('Backup');
  private busy = false;

  constructor(private db: PrismaService, private store: ConfigStore) {}

  onModuleInit() {
    fs.mkdirSync(DIR, { recursive: true });
    // a server restart interrupts running jobs
    this.db.backup.updateMany({ where: { status: 'running' }, data: { status: 'failed', error: 'سرویس در حین کار ری‌استارت شد' } }).catch(() => {});
    setInterval(() => this.tick().catch(e => this.log.warn(e.message)), 60e3);
  }

  async schedule(): Promise<Schedule> {
    const r = await this.db.configEntry.findUnique({ where: { key: 'backupSchedule' } });
    return { ...SCHED0, ...((r?.data as any) || {}) };
  }

  async saveSchedule(b: Partial<Schedule>, me: Me) {
    const cur = await this.schedule();
    const comps = (b.components || cur.components).filter(c => KEYS.includes(c));
    if (b.enabled && !comps.length) throw new BadRequestException('حداقل یک بخش را برای بکاپ خودکار انتخاب کنید');
    const next: Schedule = {
      ...cur, enabled: !!(b.enabled ?? cur.enabled), freq: b.freq === 'weekly' ? 'weekly' : 'daily',
      time: /^\d{2}:\d{2}$/.test(b.time || '') ? b.time! : cur.time, weekday: Math.min(6, Math.max(0, +(b.weekday ?? cur.weekday) || 0)),
      keep: Math.min(60, Math.max(1, +(b.keep ?? cur.keep) || 7)), components: comps,
    };
    await this.db.configEntry.upsert({ where: { key: 'backupSchedule' }, create: { key: 'backupSchedule', data: next as any }, update: { data: next as any } });
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'backup.schedule', target: 'backup', detail: next as any } });
    return next;
  }

  private async tick() {
    const s = await this.schedule();
    if (!s.enabled || this.busy) return;
    const now = new Date();
    const l = localParts(now);
    const today = jalaliDate(now);
    if (`${l.hh}:${l.mm}` < s.time || s.lastRun === today) return;
    if (s.freq === 'weekly' && (now.getDay() + 1) % 7 !== s.weekday) return;   // 0 = Saturday
    await this.db.configEntry.update({ where: { key: 'backupSchedule' }, data: { data: { ...s, lastRun: today } as any } });
    await this.create(s.components, 'زمان‌بندی خودکار', 'بکاپ خودکار', true);
    // keep only the newest N automatic backups
    const autos = await this.db.backup.findMany({ where: { auto: true, status: 'done' }, orderBy: { createdAt: 'desc' } });
    for (const b of autos.slice(s.keep)) await this.remove(b.id).catch(() => {});
  }

  async sizes() {
    const counts = async (t: string) => (await this.db.$queryRawUnsafe<any[]>(`SELECT count(*)::int AS n FROM "${t}"`))[0].n as number;
    const [rec, vm, snd, moh] = await Promise.all([du(REC), du(VM), du(SOUNDS), du(MOH)]);
    const calls = await counts('Call');
    return {
      voip: { size: 0, info: (await counts('ConfigEntry')) + ' بخش تنظیمات' },
      users: { size: 0, info: (await counts('User')) + ' کاربر' },
      calls: { size: 0, info: calls + ' تماس' },
      sounds: { size: snd + moh, info: fileCount(SOUNDS) + ' فایل' },
      recordings: { size: rec, info: fileCount(REC) + ' فایل' },
      voicemail: { size: vm, info: fileCount(VM) + ' فایل' },
      logs: { size: 0, info: (await counts('AuditLog')) + ' رکورد' },
      system: { size: 0, info: 'Asterisk + تنظیمات سامانه' },
    } as Record<string, { size: number; info: string }>;
  }

  async disk() {
    try {
      const { stdout } = await run('df', ['-k', DIR]);
      const f = stdout.trim().split('\n').pop()!.split(/\s+/);
      return { total: +f[1] * 1024, free: +f[3] * 1024 };
    } catch { return { total: 0, free: 0 }; }
  }

  /** Start a backup job; returns immediately, the job runs in the background. */
  async create(components: string[], by: string, note: string, auto = false) {
    const comps = KEYS.filter(k => components.includes(k));
    if (!comps.length) throw new BadRequestException('حداقل یک بخش را انتخاب کنید');
    if (this.busy) throw new BadRequestException('یک بکاپ یا بازیابی دیگر در حال انجام است؛ چند لحظه بعد دوباره امتحان کنید');
    const d = new Date();
    const id = 'bk-' + jalaliDate(d).replace(/\//g, '') + '-' + hhmm(d).replace(':', '') + '-' + Math.random().toString(36).slice(2, 6);
    const file = path.join(DIR, id + '.tar.gz');
    await this.db.backup.create({ data: { id, by, note: note || null, components: comps, status: 'running', auto, file } });
    this.busy = true;
    this.build(id, comps, file, by).catch(async e => {
      await this.db.backup.update({ where: { id }, data: { status: 'failed', error: String(e.message || e).slice(0, 500) } }).catch(() => {});
      fs.rmSync(file, { force: true });
    }).finally(() => { this.busy = false; });
    return { id };
  }

  private async build(id: string, comps: string[], file: string, by: string) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbk-'));
    try {
      fs.mkdirSync(path.join(tmp, 'data'));
      const counts: Record<string, number> = {};
      for (const c of comps) for (const t of COMPONENTS[c].tables || []) {
        const r = await this.db.$queryRawUnsafe<any[]>(`SELECT coalesce(json_agg(t), '[]'::json)::text AS j FROM "${t}" t`);
        fs.writeFileSync(path.join(tmp, 'data', t + '.json'), r[0].j);
        counts[t] = JSON.parse(r[0].j).length;
      }
      const manifest = { format: 'aflaki-callcenter-backup', version: 1, id, createdAt: new Date().toISOString(), date: jalaliDate(new Date()), time: hhmm(new Date()), by, components: comps, counts, host: os.hostname() };
      fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2));
      const args = ['czf', file, '-C', tmp, 'manifest.json', 'data'];
      const add = (dir: string, name: string, as: string) => { if (fs.existsSync(path.join(dir, name))) args.push('-C', dir, `--transform=s,^${name}\\(/\\|$\\),${as}\\1,`, name); };
      // transforms are global in GNU tar; distinct source names keep them from clashing
      if (comps.includes('sounds')) { add(path.dirname(SOUNDS), path.basename(SOUNDS), 'sounds/custom'); add(path.dirname(MOH), path.basename(MOH), 'sounds/moh'); }
      if (comps.includes('recordings')) add(env.monitorDir, 'cc', 'recordings');
      if (comps.includes('voicemail')) add(env.monitorDir, 'cc-vm', 'voicemail');
      if (comps.includes('system')) { add('/etc', 'asterisk', 'system/asterisk'); if (fs.existsSync('/etc/callcenter/api.env')) args.push('-C', '/etc', '--transform=s,^callcenter/,system/callcenter/,', 'callcenter/api.env'); }
      await run('tar', args, { maxBuffer: 16 * 1024 * 1024 });
      const size = fs.statSync(file).size;
      await this.db.backup.update({ where: { id }, data: { status: 'done', sizeBytes: size, counts: counts as any } });
      this.log.log(`backup ${id} done (${(size / 1048576).toFixed(1)} MB, ${comps.join(',')})`);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  async list() {
    return this.db.backup.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  }

  async remove(id: string) {
    const b = await this.db.backup.findUnique({ where: { id } });
    if (!b) throw new NotFoundException('بکاپ پیدا نشد');
    if (b.status === 'running') throw new BadRequestException('بکاپ در حال ساخت است');
    fs.rmSync(b.file, { force: true });
    await this.db.backup.delete({ where: { id } });
  }

  async file(id: string) {
    const b = await this.db.backup.findUnique({ where: { id } });
    if (!b || b.status !== 'done' || !fs.existsSync(b.file)) throw new NotFoundException('فایل بکاپ پیدا نشد');
    return b;
  }

  /** Register an uploaded archive after checking its manifest. */
  async adopt(tmpFile: string, originalName: string, me: Me) {
    let manifest: any;
    try {
      const { stdout } = await run('tar', ['xzf', tmpFile, '-O', 'manifest.json'], { maxBuffer: 1024 * 1024 });
      manifest = JSON.parse(stdout);
    } catch { fs.rmSync(tmpFile, { force: true }); throw new BadRequestException('این فایل بکاپ معتبر سامانه نیست'); }
    if (manifest.format !== 'aflaki-callcenter-backup') { fs.rmSync(tmpFile, { force: true }); throw new BadRequestException('این فایل بکاپ معتبر سامانه نیست'); }
    const id = 'up-' + Date.now().toString(36);
    const file = path.join(DIR, id + '.tar.gz');
    fs.copyFileSync(tmpFile, file); fs.rmSync(tmpFile, { force: true });
    const comps = (manifest.components || []).filter((c: string) => KEYS.includes(c));
    await this.db.backup.create({ data: { id, by: me.name, note: `بارگذاری‌شده: ${originalName} (ساخته‌شده ${manifest.date || ''} ${manifest.time || ''})`, components: comps, status: 'done', file, sizeBytes: fs.statSync(file).size, counts: manifest.counts || {} } });
    return { id };
  }

  /** Restore selected components. A safety backup of the same components is taken first. */
  async restore(id: string, components: string[], me: Me) {
    const b = await this.file(id);
    const comps = (b.components as string[]).filter(c => components.includes(c) && COMPONENTS[c].restorable);
    if (!comps.length) throw new BadRequestException('بخشی برای بازیابی انتخاب نشده است');
    const safety = await this.create(comps, me.name, `بکاپ ایمنی قبل از بازیابی ${b.id}`);
    // wait for the safety backup to finish before touching anything
    for (let i = 0; i < 600; i++) {
      const s = await this.db.backup.findUnique({ where: { id: safety.id } });
      if (s?.status === 'done') break;
      if (s?.status === 'failed') throw new BadRequestException('بکاپ ایمنی قبل از بازیابی ناموفق بود؛ بازیابی انجام نشد: ' + s.error);
      await new Promise(r => setTimeout(r, 1000));
    }
    this.busy = true;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrs-'));
    try {
      await run('tar', ['xzf', b.file, '-C', tmp], { maxBuffer: 16 * 1024 * 1024 });
      const restored: Record<string, number> = {};
      for (const c of comps) {
        for (const t of COMPONENTS[c].tables || []) {
          const f = path.join(tmp, 'data', t + '.json');
          if (!fs.existsSync(f)) continue;
          const json = fs.readFileSync(f, 'utf8');
          await this.db.$transaction([
            this.db.$executeRawUnsafe(`DELETE FROM "${t}"`),
            this.db.$executeRawUnsafe(`INSERT INTO "${t}" SELECT * FROM json_populate_recordset(NULL::"${t}", $1::json)`, json),
          ]);
          if (SERIAL[t]) await this.db.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('"${t}"', '${SERIAL[t]}'), GREATEST(coalesce((SELECT max("${SERIAL[t]}") FROM "${t}"), 0), 1))`);
          restored[t] = JSON.parse(json).length;
        }
        const copy = async (from: string, to: string) => {
          if (!fs.existsSync(from)) return;
          fs.mkdirSync(to, { recursive: true });
          await run('cp', ['-a', from + '/.', to + '/']);
        };
        if (c === 'sounds') { await copy(path.join(tmp, 'sounds/custom'), SOUNDS); await copy(path.join(tmp, 'sounds/moh'), MOH); }
        if (c === 'recordings') await copy(path.join(tmp, 'recordings'), REC);
        if (c === 'voicemail') await copy(path.join(tmp, 'voicemail'), VM);
      }
      if (comps.includes('voip') || comps.includes('sounds')) { this.store.reset(); await this.store.applyAll(); }
      await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'backup.restore', target: b.id, detail: { components: comps, restored, safetyBackup: safety.id } as any } });
      return { ok: true, components: comps, restored, safetyBackup: safety.id };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      this.busy = false;
    }
  }
}

@Perm('vbackup')
@Controller('backups')
export class BackupController {
  constructor(private svc: BackupService) {}

  @Get()
  async get() {
    const [items, sizes, disk, schedule] = await Promise.all([this.svc.list(), this.svc.sizes(), this.svc.disk(), this.svc.schedule()]);
    return { items, disk, schedule, components: Object.entries(COMPONENTS).map(([id, c]) => ({ id, label: c.label, desc: c.desc, restorable: c.restorable, ...sizes[id] })) };
  }

  @Post()
  create(@Body() b: { components: string[]; note?: string }, @CurrentUser() me: Me) { return this.svc.create(b.components || [], me.name, String(b.note || '').slice(0, 200)); }

  @Put('schedule')
  schedule(@Body() b: any, @CurrentUser() me: Me) { return this.svc.saveSchedule(b, me); }

  @Delete(':id')
  async remove(@Param('id') id: string) { await this.svc.remove(id); return { ok: true }; }

  @Get(':id/download')
  async download(@Param('id') id: string, @Res() res: Response) {
    const b = await this.svc.file(id);
    res.download(b.file, `callcenter-backup-${b.id}.tar.gz`);
  }

  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { dest: os.tmpdir(), limits: { fileSize: 20 * 1024 * 1024 * 1024 } }))
  upload(@UploadedFile() file: Express.Multer.File, @CurrentUser() me: Me) {
    if (!file) throw new BadRequestException('فایلی ارسال نشد');
    return this.svc.adopt(file.path, Buffer.from(file.originalname, 'latin1').toString('utf8'), me);
  }

  @Perm('vbackup', 'edit')
  @Post(':id/restore')
  restore(@Param('id') id: string, @Body() b: { components: string[] }, @CurrentUser() me: Me) { return this.svc.restore(id, b.components || [], me); }
}
