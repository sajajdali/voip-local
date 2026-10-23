// Settings snapshot for git: all VoIP/panel settings WITHOUT secrets (SIP passwords, trunk passwords, API token).
//   node dist/config-snapshot.js export <file.json>   — write snapshot
//   node dist/config-snapshot.js import <file.json>   — load snapshot into an empty/new server
// On import, extensions without a password get a new random one (phones then need the new password);
// the full encrypted backup (deploy/backup-to-mac.sh) restores the original passwords instead.
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import { secret } from './config';

const db = new PrismaClient();

async function main() {
  const [mode, file] = process.argv.slice(2);
  if (mode === 'export') {
    const rows = await db.configEntry.findMany({ orderBy: { key: 'asc' } });
    const out: Record<string, any> = {};
    for (const r of rows) {
      let d: any = r.data;
      if (r.key === 'exts') d = d.map((e: any) => ({ ...e, secret: undefined }));
      if (r.key === 'trunks') d = d.map((t: any) => ({ ...t, pass: t.pass ? '' : t.pass }));
      if (r.key === 'webhook') d = { ...d, token: '' };
      if (r.key === 'blist') d = d.map((b: any) => ({ ...b, hits: 0, today: 0, last: '—', lastDay: undefined }));
      out[r.key] = d;
    }
    fs.writeFileSync(file, JSON.stringify({ exportedAt: new Date().toISOString(), note: 'secrets removed', config: out }, null, 2) + '\n');
    console.log('exported', Object.keys(out).length, 'settings to', file);
  } else if (mode === 'import') {
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [key, data0] of Object.entries<any>(snap.config)) {
      let data = data0;
      if (key === 'exts') data = data.map((e: any) => ({ ...e, secret: e.secret || secret() }));
      await db.configEntry.upsert({ where: { key }, create: { key, data }, update: { data } });
    }
    console.log('imported', Object.keys(snap.config).length, 'settings — restart callcenter-api to apply them to Asterisk');
  } else {
    console.log('usage: config-snapshot.js export|import <file.json>');
  }
}

main().finally(() => db.$disconnect());
