// One-off migration of the clinic's Issabel 4 configuration (server ramo.local, extracted 2026-10-19).
// Replaces the design's sample data with the real setup so this machine can take the old server's place.
// Usage (as root): node dist/import-issabel.js <sip-secrets.tsv> <dir with sounds/custom and moh/MOH-Anns>
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { secret } from './config';
import { env } from './env';
import { todayJ } from './jalali';

const db = new PrismaClient();

// Old file name -> [panel id, display name, category]
const SOUNDS: Record<string, [string, string, string]> = {
  'sounds/custom/Sound-IVR-New.wav': ['Sound-IVR-New', 'پیام منوی روز (IVR روز)', 'ivr'],
  'sounds/custom/Sound-IVR-Night.wav': ['Sound-IVR-Night', 'پیام منوی شب (IVR شب)', 'after'],
  'sounds/custom/Sound-Work-Time.wav': ['Sound-Work-Time', 'اعلام ساعات کاری', 'after'],
  'sounds/custom/Sound-Address-new.wav': ['Sound-Address-new', 'اعلام آدرس', 'greet'],
  'sounds/custom/Sound-Anns-Q.wav': ['Sound-Anns-Q', 'اعلان صف', 'queue'],
  'moh/MOH-Anns': ['MOH-Anns', 'موسیقی انتظار صف (MOH-Anns)', 'moh'],
  'sounds/custom/Sound-IVR-Day.wav': ['Sound-IVR-Day', 'پیام منوی روز (قدیمی)', 'ivr'],
  'sounds/custom/Sound-Day.wav': ['Sound-Day', 'پیام روز (قدیمی)', 'greet'],
  'sounds/custom/Sound-Night.wav': ['Sound-Night', 'پیام شب (قدیمی)', 'after'],
  'sounds/custom/Sound-Address.wav': ['Sound-Address', 'اعلام آدرس (قدیمی)', 'greet'],
  'sounds/custom/Sound-Address-music.wav': ['Sound-Address-music', 'اعلام آدرس با موسیقی', 'greet'],
  'sounds/custom/Sound-Saat.wav': ['Sound-Saat', 'اعلام ساعات کاری (قدیمی)', 'after'],
  'sounds/custom/Sound-Time-Work-New.wav': ['Sound-Time-Work-New', 'اعلام ساعات کاری (نسخه بلند)', 'after'],
  'sounds/custom/Sound-Nobat.wav': ['Sound-Nobat', 'پیام نوبت‌دهی', 'ivr'],
};

function convertSounds(srcRoot: string) {
  fs.mkdirSync(env.soundsDir, { recursive: true });
  const out: any[] = [];
  for (const [rel, [id, name, cat]] of Object.entries(SOUNDS)) {
    let src = path.join(srcRoot, rel);
    if (fs.existsSync(src) && fs.statSync(src).isDirectory()) src = path.join(src, fs.readdirSync(src)[0]);
    if (!fs.existsSync(src)) { console.warn('missing sound', rel); continue; }
    const dst = path.join(env.soundsDir, id + '.wav');
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', src, '-ac', '1', '-ar', '8000', '-sample_fmt', 's16', dst]);
    const dur = Math.round(+execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', dst]).toString() || 0);
    out.push({ id, name, cat, dur, date: todayJ(), file: path.basename(src) });
  }
  return out;
}

async function main() {
  const [secretsFile, soundsRoot] = process.argv.slice(2);
  const secrets = new Map<string, string>();
  for (const line of fs.readFileSync(secretsFile, 'utf8').split('\n')) { const [k, v] = line.split('\t'); if (k && v) secrets.set(k.trim(), v.trim()); }

  const exts = ['100', '101', '102', '103', '104', '105', '106', '107', '108', '109', '999', '1001'].map(n => ({
    n, name: 'داخلی ' + n, type: 'SIP', dev: '', rec: true, vm: false, q: ['101', '102', '103'].includes(n) ? 'Q-Main' : '—',
    secret: secrets.get(n) || secret(),
  }));
  const snds = convertSounds(soundsRoot);

  const config: Record<string, any> = {
    exts,
    trunks: [
      { id: 't88886279', name: '88886279', prov: 'اپراتور مخابرات (خط اصلی)', type: 'SIP', host: '10.153.101.175', did: '88886279', ch: 30, codec: 'alaw,gsm,ulaw', user: '', pass: '', dtmf: 'inband', on: true },
      { id: 'tPanasonic', name: 'To-Panasonic', prov: 'مرکز تلفن Panasonic', type: 'SIP', host: '192.168.0.101:35060', did: '—', ch: 8, codec: 'alaw,gsm,ulaw', user: '', pass: '', dtmf: 'inband', on: false },
    ],
    vqs: [{ id: 'q400', name: 'Q-Main', num: '400', strat: 'ringall', members: ['101', '102', '103'], maxWait: 0, ring: 15, riu: true, moh: 'MOH-Anns', fail: 'hang' }],
    ivrs: [
      { id: 'i2', name: 'Day-IVR (منوی روز)', did: '—', greet: 'Sound-IVR-New', after: '', hours: 'شنبه، دوشنبه، چهارشنبه ۱۳ تا ۱۹ · یکشنبه و سه‌شنبه ۱۴ تا ۱۸', timeout: 1, rep: 0, ddial: true, tdest: 'q:q400', idest: 'q:q400',
        opts: [{ k: '0', label: 'صف اصلی', dest: 'q:q400' }, { k: '1', label: 'ساعات کاری', dest: 'ann:Sound-Work-Time' }, { k: '2', label: 'آدرس', dest: 'ann:Sound-Address-new' }, { k: '4', label: 'صف اصلی', dest: 'q:q400' }] },
      { id: 'i4', name: 'Night-IVR (منوی شب)', did: '—', greet: 'Sound-IVR-Night', after: '', hours: 'خارج از ساعات کاری', timeout: 1, rep: 0, ddial: false, tdest: 'hang', idest: 'hang',
        opts: [{ k: '1', label: 'ساعات کاری', dest: 'ann:Sound-Work-Time' }, { k: '2', label: 'آدرس', dest: 'ann:Sound-Address-new' }] },
    ],
    snds,
    routes: [{ id: 'r1', name: 'همه تماس‌های ورودی', did: '', cid: '', dest: 'tc:tc1', prio: 1, prefix: '', moh: '', rec: 'always', alert: '', lang: 'fa', fax: false, on: true }],
    oroutes: [
      { id: 'o2', name: 'To-Panasonic', pats: '1XX, 6XX', trunk: 'tPanasonic', prepend: '', on: false },
      { id: 'o4', name: '9_outside (همه شماره‌ها)', pats: '.', trunk: 't88886279', prepend: '', on: true },
    ],
    // design days: 0 = Saturday … 6 = Friday
    tgroups: [{ id: 'g1', name: 'Time-Work', ranges: [{ days: [0, 2, 4], from: '13:00', to: '19:00' }, { days: [1, 3], from: '14:00', to: '18:00' }] }],
    tconds: [{ id: 'tc1', name: 'Time-Work', group: 'g1', open: 'ivr:i2', closed: 'ivr:i4', useHol: false, ovr: 'none' }],
    holidays: [], rgroups: [], fmes: {}, blist: [],
    bset: { anon: false, action: 'hang', sound: '' },
  };
  for (const [key, data] of Object.entries(config)) await db.configEntry.upsert({ where: { key }, create: { key, data }, update: { data } });

  // sample data from the design is not real: remove it
  await db.note.deleteMany(); await db.follow.deleteMany(); await db.call.deleteMany(); await db.patient.deleteMany();
  await db.$executeRawUnsafe('DELETE FROM cdr');
  const keep = await db.user.findMany({ where: { role: 'admin' } });
  await db.user.deleteMany({ where: { role: { not: 'admin' } } });
  const creds: Record<string, string> = {};
  for (const n of ['100', '101', '102', '103', '104', '105', '106', '107', '108', '109']) {
    const pw = secret().slice(0, 10);
    creds['op' + n] = pw;
    await db.user.create({ data: { username: 'op' + n, name: 'اپراتور ' + n, role: n === '100' ? 'supervisor' : 'operator', ext: n, password: await bcrypt.hash(pw, 10) } });
  }
  await db.auditLog.create({ data: { action: 'import.issabel', target: 'all', detail: { exts: exts.length, sounds: snds.length, secretsReused: exts.filter(e => secrets.has(e.n)).length } } });
  console.log(JSON.stringify({ imported: true, exts: exts.length, secretsReused: exts.filter(e => secrets.has(e.n)).length, sounds: snds.length, admins: keep.length, users: creds }));
}

main().finally(() => db.$disconnect());
