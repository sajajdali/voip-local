// «وضعیت سرور»: CPU, memory, disk, what fills the disk and how fast, services and backups, condensed into a
// health score and plain recommendations for the manager.
import { Controller, Get, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { AsteriskService } from './asterisk/asterisk.service';
import { Roles, Perm } from './auth';
import { BackupService } from './backups';
import { env } from './env';
import { PrismaService } from './prisma.service';

const run = promisify(execFile);
const BACKUP_DIR = process.env.BACKUP_DIR || '/var/lib/callcenter/backups';
const SERVICES: [string, string][] = [
  ['asterisk', 'مرکز تلفن (Asterisk)'], ['callcenter-api', 'برنامه پنل'], ['postgresql', 'دیتابیس'],
  ['nginx', 'وب‌سرور'], ['callcenter-ai', 'دستیار هوشمند'], ['fail2ban', 'محافظ ورود (fail2ban)'],
];
const FOLDERS: [string, string, string][] = [
  ['rec', 'ضبط مکالمه‌ها', env.monitorDir], ['backup', 'بکاپ‌ها', BACKUP_DIR],
  ['logs', 'لاگ‌های مرکز تلفن', '/var/log/asterisk'], ['sounds', 'صداها', env.soundsDir],
];

interface Point { t: number; cpu: number; mem: number }

/** Total size and the part written in the last `days` days, walking the tree once. */
async function folderUsage(dir: string, days = 7) {
  const since = Date.now() - days * 864e5;
  let total = 0, recent = 0, files = 0;
  const walk = async (d: string, depth: number) => {
    let list: fs.Dirent[] = [];
    try { list = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 6) await walk(p, depth + 1); continue; }
      try { const st = await fs.promises.stat(p); total += st.size; files++; if (st.mtimeMs >= since) recent += st.size; } catch { /* vanished */ }
    }
  };
  await walk(dir, 0);
  return { total, recent, files };
}

@Injectable()
export class SystemService implements OnModuleInit {
  private log = new Logger('System');
  private lastCpu = this.cpuTimes();
  cpuNow = 0;
  history: Point[] = [];
  private folders: any = null;
  private foldersAt = 0;

  constructor(private db: PrismaService, private ast: AsteriskService, private backups: BackupService) {}

  onModuleInit() {
    setInterval(() => this.sampleCpu(), 5000).unref();
    // one point every minute, two hours kept
    setInterval(() => {
      this.history.push({ t: Date.now(), cpu: this.cpuNow, mem: this.memPct() });
      if (this.history.length > 120) this.history.shift();
    }, 60e3).unref();
    setTimeout(() => this.history.push({ t: Date.now(), cpu: this.cpuNow, mem: this.memPct() }), 6000).unref();
  }

  private cpuTimes() {
    let idle = 0, total = 0;
    for (const c of os.cpus()) { for (const v of Object.values(c.times)) total += v; idle += c.times.idle; }
    return { idle, total };
  }

  private sampleCpu() {
    const now = this.cpuTimes();
    const dt = now.total - this.lastCpu.total, di = now.idle - this.lastCpu.idle;
    if (dt > 0) this.cpuNow = Math.max(0, Math.min(100, Math.round((1 - di / dt) * 1000) / 10));
    this.lastCpu = now;
  }

  private memInfo() {
    const m: Record<string, number> = {};
    try { for (const l of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) { const x = /^(\w+):\s+(\d+)/.exec(l); if (x) m[x[1]] = +x[2] * 1024; } } catch { /* not linux */ }
    const total = m.MemTotal || os.totalmem(), avail = m.MemAvailable || os.freemem();
    return { total, used: total - avail, avail, cache: (m.Cached || 0) + (m.Buffers || 0), swapTotal: m.SwapTotal || 0, swapUsed: (m.SwapTotal || 0) - (m.SwapFree || 0) };
  }

  private memPct() { const m = this.memInfo(); return Math.round(m.used / m.total * 1000) / 10; }

  private temperature() {
    try {
      const zones = fs.readdirSync('/sys/class/thermal').filter(z => z.startsWith('thermal_zone'));
      const temps = zones.map(z => +fs.readFileSync(`/sys/class/thermal/${z}/temp`, 'utf8') / 1000).filter(t => t > 0 && t < 120);
      return temps.length ? Math.round(Math.max(...temps)) : null;
    } catch { return null; }
  }

  private async serviceStates() {
    return Promise.all(SERVICES.map(async ([unit, label]) => {
      let state = 'unknown';
      try { state = (await run('systemctl', ['is-active', unit], { timeout: 3000 })).stdout.trim(); }
      catch (e: any) { state = String(e.stdout || 'inactive').trim() || 'inactive'; }
      return { unit, label, state };
    }));
  }

  private async folderStats() {
    // walking the recordings is not free: refresh at most every 10 minutes
    if (this.folders && Date.now() - this.foldersAt < 600e3) return this.folders;
    const out: any[] = [];
    for (const [key, label, dir] of FOLDERS) out.push({ key, label, ...(await folderUsage(dir)) });
    const dbRow: any[] = await this.db.$queryRawUnsafe('select pg_database_size(current_database())::bigint as size');
    out.push({ key: 'db', label: 'دیتابیس', total: Number(dbRow[0]?.size || 0), recent: 0, files: 0 });
    this.folders = out; this.foldersAt = Date.now();
    return out;
  }

  async snapshot() {
    const st = fs.statfsSync('/');
    const disk = { total: st.blocks * st.bsize, free: st.bavail * st.bsize, used: (st.blocks - st.bfree) * st.bsize };
    const mem = this.memInfo();
    const [services, folders, lastBackup, sched, calls, recs] = await Promise.all([
      this.serviceStates(), this.folderStats(),
      this.db.backup.findFirst({ where: { status: 'done' }, orderBy: { createdAt: 'desc' } }),
      this.backups.schedule(),
      this.db.call.count(), this.db.call.count({ where: { recPath: { not: null } } }),
    ]);
    const live = this.ast.live;
    const trunks = Object.values(live.trunks || {}).filter((t: any) => t.on !== false);
    const exts = Object.values(live.exts || {});
    // disk growth: what was written in the last 7 days, per day
    const perDay = folders.filter((f: any) => f.key !== 'db').reduce((n: number, f: any) => n + f.recent, 0) / 7;
    const daysLeft = perDay > 1e6 ? Math.floor(disk.free / perDay) : null;
    const load = os.loadavg(), cores = os.cpus().length;
    const temp = this.temperature();
    const s = {
      host: os.hostname(), os: (() => { try { return (/PRETTY_NAME="([^"]+)"/.exec(fs.readFileSync('/etc/os-release', 'utf8')) || [])[1] || os.type(); } catch { return os.type(); } })(),
      uptime: os.uptime(), now: Date.now(),
      cpu: { pct: this.cpuNow, cores, load, model: (os.cpus()[0]?.model || '').replace(/\s+/g, ' ').trim(), temp },
      mem, disk, folders, perDay, daysLeft, services,
      telephony: { ami: this.ast.ami.connected, trunksUp: trunks.filter((t: any) => t.reg).length, trunks: trunks.length, extsOnline: exts.filter((e: any) => e.st !== 'offline').length, exts: exts.length },
      backup: { last: lastBackup ? lastBackup.createdAt.getTime() : null, lastSize: lastBackup?.sizeBytes || 0, auto: !!(sched as any).enabled, time: (sched as any).time || '' },
      calls, recs, history: this.history,
    };
    return { ...s, ...this.assess(s) };
  }

  /** Score 0-100 and what the manager should do, most urgent first. */
  private assess(s: any) {
    const tips: { level: 'bad' | 'warn' | 'ok'; title: string; text: string }[] = [];
    let score = 100;
    const diskPct = s.disk.used / s.disk.total * 100, memPct = s.mem.used / s.mem.total * 100;
    const down = s.services.filter((x: any) => x.state !== 'active');
    for (const x of down) {
      const ai = x.unit === 'callcenter-ai';
      tips.push({ level: ai ? 'warn' : 'bad', title: `${x.label} کار نمی‌کند`, text: ai ? 'اگر دستیار هوشمند روشن است، کلید API و تنظیمات آن را بررسی کنید.' : 'این سرویس باید همیشه روشن باشد؛ سرور را بررسی کنید.' });
      score -= ai ? 8 : 25;
    }
    if (s.telephony.trunks && s.telephony.trunksUp < s.telephony.trunks) { tips.push({ level: 'bad', title: 'خط مخابرات وصل نیست', text: 'ترانک رجیستر نیست؛ تماس‌های ورودی و خروجی برقرار نمی‌شوند. اتصال شبکه به مخابرات را بررسی کنید.' }); score -= 30; }
    if (!s.telephony.ami) { tips.push({ level: 'bad', title: 'ارتباط پنل با مرکز تلفن قطع است', text: 'وضعیت زنده و اعمال تنظیمات کار نمی‌کند.' }); score -= 20; }
    if (diskPct >= 90) { tips.push({ level: 'bad', title: 'دیسک تقریباً پر است', text: 'ضبط‌ها و بکاپ‌های قدیمی را به جای دیگری منتقل کنید یا دیسک بزرگ‌تر بگذارید.' }); score -= 30; }
    else if (diskPct >= 75) { tips.push({ level: 'warn', title: 'فضای دیسک رو به اتمام است', text: 'برای ضبط‌ها و بکاپ‌های قدیمی برنامه‌ریزی کنید.' }); score -= 12; }
    if (s.daysLeft !== null && s.daysLeft < 90) { tips.push({ level: s.daysLeft < 30 ? 'bad' : 'warn', title: `با این روند حدود ${s.daysLeft} روز دیگر دیسک پر می‌شود`, text: 'ضبط‌های قدیمی را آرشیو کنید یا فضای دیسک را افزایش دهید.' }); score -= s.daysLeft < 30 ? 20 : 8; }
    if (memPct >= 90) { tips.push({ level: 'bad', title: 'حافظه (RAM) تقریباً پر است', text: 'سرور ممکن است کند شود؛ ری‌استارت یا افزایش رم را در نظر بگیرید.' }); score -= 20; }
    else if (memPct >= 75) { tips.push({ level: 'warn', title: 'مصرف حافظه بالاست', text: 'روند مصرف را زیر نظر داشته باشید.' }); score -= 8; }
    if (s.mem.swapTotal && s.mem.swapUsed / s.mem.swapTotal > 0.25) { tips.push({ level: 'warn', title: 'سرور از حافظه مجازی (swap) استفاده می‌کند', text: 'یعنی رم کم آمده است؛ افزایش رم پیشنهاد می‌شود.' }); score -= 6; }
    if (s.cpu.load[2] > s.cpu.cores) { tips.push({ level: 'warn', title: 'پردازنده زیر فشار است', text: 'بار ۱۵ دقیقه اخیر از تعداد هسته‌ها بیشتر است.' }); score -= 10; }
    if (s.cpu.temp && s.cpu.temp >= 80) { tips.push({ level: 'warn', title: `دمای پردازنده بالاست (${s.cpu.temp}°)`, text: 'تهویه و گرد و غبار دستگاه را بررسی کنید.' }); score -= 8; }
    const age = s.backup.last ? (Date.now() - s.backup.last) / 864e5 : null;
    if (age === null) { tips.push({ level: 'warn', title: 'هنوز بکاپی روی سرور گرفته نشده', text: 'از صفحه «بکاپ و بازیابی» یک بکاپ بگیرید و بکاپ خودکار را روشن کنید.' }); score -= 10; }
    else if (age > 7) { tips.push({ level: 'warn', title: `آخرین بکاپ سرور ${Math.floor(age)} روز پیش بوده`, text: 'بکاپ خودکار را روشن کنید.' }); score -= 8; }
    if (!s.backup.auto) { tips.push({ level: 'warn', title: 'بکاپ خودکار روی سرور خاموش است', text: 'بکاپ شبانه روی مک فعال است، ولی بهتر است بکاپ خودکار سرور هم روشن باشد.' }); score -= 4; }
    const logs = s.folders.find((f: any) => f.key === 'logs');
    if (logs && logs.total > 1e9) { tips.push({ level: 'warn', title: 'لاگ‌های مرکز تلفن بزرگ شده‌اند', text: 'چرخش و پاک‌سازی خودکار لاگ‌ها را بررسی کنید.' }); score -= 4; }
    if (!tips.length) tips.push({ level: 'ok', title: 'همه چیز مرتب است', text: 'نیازی به اقدام نیست.' });
    score = Math.max(0, Math.min(100, Math.round(score)));
    const order = { bad: 0, warn: 1, ok: 2 };
    tips.sort((a, b) => order[a.level] - order[b.level]);
    return { score, verdict: score >= 85 ? 'وضعیت عالی' : score >= 65 ? 'نیاز به توجه' : 'نیاز به اقدام فوری', tips };
  }
}

@Perm('sys')
@Controller('system')
export class SystemController {
  constructor(private sys: SystemService) {}

  @Get()
  status() { return this.sys.snapshot(); }
}
