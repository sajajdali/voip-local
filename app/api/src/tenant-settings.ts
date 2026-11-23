// Read/write JSON settings: platform ConfigEntry, or TenantConfig when the user/call is tenant-scoped.
import { PrismaService } from './prisma.service';
import type { Me } from './auth';

export type SettingsScope = string | null | undefined;

export async function readSetting(
  db: PrismaService,
  key: string,
  tenantId?: SettingsScope,
  opts?: { fallbackPlatform?: boolean },
): Promise<any | null> {
  if (tenantId) {
    const row = await db.tenantConfig.findUnique({ where: { tenantId_key: { tenantId, key } } });
    if (row?.data != null) return row.data;
    // First visit: show platform defaults so the form is not empty until the tenant saves their own copy
    if (opts?.fallbackPlatform) {
      const plat = await db.configEntry.findUnique({ where: { key } });
      return plat?.data ?? null;
    }
    return null;
  }
  const row = await db.configEntry.findUnique({ where: { key } });
  return row?.data ?? null;
}

export async function writeSetting(db: PrismaService, key: string, data: any, me: Me) {
  if (me.tenantId) {
    await db.tenantConfig.upsert({
      where: { tenantId_key: { tenantId: me.tenantId, key } },
      create: { tenantId: me.tenantId, key, data, updatedBy: me.id },
      update: { data, updatedBy: me.id },
    });
    return;
  }
  await db.configEntry.upsert({
    where: { key },
    create: { key, data, updatedBy: me.id },
    update: { data, updatedBy: me.id },
  });
}

export function scopeKey(tenantId?: SettingsScope) {
  return tenantId || '__platform__';
}
