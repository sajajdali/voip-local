// Seeds the database with the design's sample data (operators, VoIP config, 170 sample calls).
// Usage: node dist/seed.js [--force]   (writes generated passwords to stdout as JSON)
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as fs from 'fs';
import * as path from 'path';
import { secret } from './config';
import { jalaliDate, jalaliToDate, todayJ } from './jalali';

const db = new PrismaClient();

function designData() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'seed-data', 'design-logic.js'), 'utf8');
  const head = src.slice(0, src.indexOf('class Component'));
  // eslint-disable-next-line no-new-func
  return new Function(head + '; return {ROUTES0,TG0,HOL0,TC0,RG0,FM0,BL0,EXT0,TR0,QU0,SND0,IVR0,OPS,build,TODAY};')();
}

async function main() {
  const force = process.argv.includes('--force');
  if (!force && (await db.user.count())) { console.log(JSON.stringify({ skipped: true })); return; }
  const D = designData();
  // The design's sample month ends on its TODAY; shift every sample date so it ends on the real today.
  const shiftDays = Math.round((jalaliToDate(todayJ()).getTime() - jalaliToDate(D.TODAY).getTime()) / 86400e3);
  const shift = (j: string) => jalaliDate(new Date(jalaliToDate(j).getTime() + shiftDays * 86400e3 + 12 * 3600e3));

  if (force) { for (const t of ['note', 'follow', 'call', 'patient', 'configEntry', 'user', 'auditLog']) await (db as any)[t].deleteMany(); }

  const creds: Record<string, string> = {};
  const mk = async (username: string, name: string, role: string, ext: string | null) => {
    const pw = secret().slice(0, 10);
    creds[username] = pw;
    await db.user.create({ data: { username, name, role, ext, password: await bcrypt.hash(pw, 10) } });
  };
  await mk('admin', 'مدیر سامانه', 'admin', null);
  for (const o of D.OPS) await mk('op' + o.ext, o.name, o.ext === '201' ? 'supervisor' : 'operator', o.ext);
  await mk('accounting', 'واحد حسابداری', 'accounting', '220');
  await mk('reception', 'واحد پذیرش', 'reception', null);
  await mk('emergency', 'پشتیبانی اضطراری', 'emergency', '210');

  const strip = (l: any[], f: string[]) => l.map(x => { const y = { ...x }; f.forEach(k => delete y[k]); return y; });
  const config: Record<string, any> = {
    exts: strip(D.EXT0, ['st']).map((e: any) => ({ ...e, secret: secret() })),
    trunks: strip(D.TR0, ['used', 'reg']).map((t: any) => ({ ...t, user: '', pass: '' })),
    vqs: strip(D.QU0, ['waiting', 'sla']), ivrs: D.IVR0, snds: D.SND0, routes: D.ROUTES0, tgroups: D.TG0, tconds: D.TC0,
    holidays: D.HOL0, rgroups: D.RG0, fmes: D.FM0, blist: D.BL0, bset: { anon: true, action: 'hang', sound: 's4' },
  };
  for (const [key, data] of Object.entries(config)) await db.configEntry.create({ data: { key, data } });

  const calls = D.build();
  const pats = new Map<string, any>();
  for (const c of calls) {
    const date = shift(c.date);
    const [h, m] = c.time.split(':').map(Number);
    const g = jalaliToDate(date);
    const startedAt = new Date(Date.UTC(g.getUTCFullYear(), g.getUTCMonth(), g.getUTCDate(), h, m) - 3.5 * 3600e3); // Tehran wall clock
    if (c.known) pats.set(c.phoneRaw, { phone: c.phoneRaw, name: c.name, nid: c.nid, surgery: c.surgery === '—' ? null : c.surgery });
    await db.call.create({
      data: {
        id: c.id, startedAt, date, time: c.time, phone: c.phoneRaw, dir: c.dir, st: c.st, queue: c.queue, opExt: c.op ? c.op.ext : null,
        dur: c.dur, wait: c.wait, recPath: c.dur > 0 ? 'demo' : null, wave: c.wave,
        ai: c.ai ? { cat: c.ai.cat.id, tx: c.ai.tx, sum: c.ai.sum, kw: c.ai.kw, urg: c.ai.urg, sent: c.ai.sent, conf: c.ai.conf } : undefined,
        aiState: c.ai ? 'done' : 'none', survey: c.survey || undefined,
      },
    });
    if (c.follow) await db.follow.create({ data: { callId: c.id, status: c.follow } });
  }
  for (const p of pats.values()) await db.patient.create({ data: { ...p, source: 'seed' } });
  console.log(JSON.stringify({ seeded: true, calls: calls.length, patients: pats.size, users: creds }));
}

main().finally(() => db.$disconnect());
