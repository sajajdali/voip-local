// Per-tenant storage quota: used bytes (recordings + sounds) vs quota.
import * as fs from 'fs';
import * as path from 'path';
import { HttpException } from '@nestjs/common';
import { env } from './env';
import { PrismaService } from './prisma.service';

export const DEFAULT_STORAGE_MB = 2048; // 2 GB
export const MB = 1024 * 1024;
export const GB = 1024 * MB;

export function mbToBytes(mb: number) {
  return Math.max(0, Math.floor(Number(mb) || 0)) * MB;
}

export function bytesToMb(bytes: number) {
  return Math.round((Number(bytes) || 0) / MB);
}

function fileSize(p: string | null | undefined): number {
  if (!p || p === 'demo') return 0;
  try {
    if (!fs.existsSync(p)) return 0;
    return fs.statSync(p).size || 0;
  } catch {
    return 0;
  }
}

/** Sum recording + related side/survey files for a call row. */
export function callStorageBytes(c: { recPath?: string | null; survey?: any }) {
  let n = fileSize(c.recPath);
  if (c.recPath && c.recPath !== 'demo') {
    const base = c.recPath.replace(/\.wav$/i, '');
    n += fileSize(base + '-op.wav') + fileSize(base + '-pt.wav');
  }
  const sv = c.survey && typeof c.survey === 'object' ? (c.survey as any).rec : null;
  n += fileSize(sv);
  return n;
}

export async function tenantUsedBytes(db: PrismaService, tenantId: string): Promise<{
  usedBytes: number;
  recordingsBytes: number;
  soundsBytes: number;
  recordingFiles: number;
  soundFiles: number;
}> {
  const calls = await db.call.findMany({
    where: { tenantId },
    select: { recPath: true, survey: true },
  });
  let recordingsBytes = 0;
  let recordingFiles = 0;
  for (const c of calls) {
    const b = callStorageBytes(c);
    if (b > 0) { recordingsBytes += b; recordingFiles++; }
  }

  const cfg = await db.tenantConfig.findUnique({ where: { tenantId_key: { tenantId, key: 'snds' } } }).catch(() => null);
  const snds = cfg && Array.isArray(cfg.data) ? (cfg.data as any[]) : [];
  let soundsBytes = 0;
  let soundFiles = 0;
  for (const s of snds) {
    const id = String(s?.id || '').replace(/[^A-Za-z0-9_-]/g, '');
    if (!id) continue;
    const f = path.join(env.soundsDir, id + '.wav');
    const b = fileSize(f);
    if (b > 0) { soundsBytes += b; soundFiles++; }
  }

  return {
    usedBytes: recordingsBytes + soundsBytes,
    recordingsBytes,
    soundsBytes,
    recordingFiles,
    soundFiles,
  };
}

export function storageSnapshot(quotaMb: number, used: { usedBytes: number; recordingsBytes: number; soundsBytes: number; recordingFiles: number; soundFiles: number }) {
  const quotaBytes = mbToBytes(quotaMb > 0 ? quotaMb : DEFAULT_STORAGE_MB);
  const usedBytes = used.usedBytes;
  const freeBytes = Math.max(0, quotaBytes - usedBytes);
  const pct = quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 1000) / 10) : 100;
  const full = usedBytes >= quotaBytes;
  return {
    quotaMb: Math.round(quotaBytes / MB),
    quotaBytes,
    usedBytes,
    freeBytes,
    pct,
    full,
    recordingsBytes: used.recordingsBytes,
    soundsBytes: used.soundsBytes,
    recordingFiles: used.recordingFiles,
    soundFiles: used.soundFiles,
  };
}

/** Throw 507 if adding `needBytes` would exceed the tenant quota. */
export async function assertTenantStorageRoom(db: PrismaService, tenantId: string, needBytes: number, quotaMb?: number | null) {
  let mb = quotaMb;
  if (mb == null) {
    const t = await db.tenant.findUnique({ where: { id: tenantId }, select: { storageQuotaMb: true } as any });
    mb = (t as any)?.storageQuotaMb ?? DEFAULT_STORAGE_MB;
  }
  const used = await tenantUsedBytes(db, tenantId);
  const snap = storageSnapshot(Number(mb) || DEFAULT_STORAGE_MB, used);
  if (snap.usedBytes + Math.max(0, needBytes) > snap.quotaBytes) {
    throw new HttpException({
      statusCode: 507,
      code: 'STORAGE_FULL',
      message: 'فضای ذخیره‌سازی شما پر است؛ برای ادامه باید فضای بیشتری بخرید',
      storage: snap,
    }, 507);
  }
  return snap;
}
