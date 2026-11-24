// Keep each tenant's outbound oroutes in sync with DID assign / unassign.
// Auto rows are tagged `auto: true` + `did` so removal is precise; trunk is always the 31985 pool.
import { PrismaService } from './prisma.service';

/** Shared pool trunk for DID range 31985000…31985999. */
export const POOL_TRUNK_ID = 't31985';

/** Dial patterns: 8+number (strip 8) or direct mobile/national. */
export const TENANT_OUT_PATS = '8|.,0X.,9X.';

export function autoOutboundId(did: string) {
  return 'odid' + String(did).replace(/\D/g, '');
}

export function makeAutoOutbound(did: string) {
  const d = String(did).replace(/\D/g, '');
  return {
    id: autoOutboundId(d),
    name: 'خروجی ' + d,
    on: true,
    pats: TENANT_OUT_PATS,
    trunk: POOL_TRUNK_ID,
    cli: d,
    did: d,
    auto: true,
  };
}

/** True when this oroute was created by DID sync (safe to delete on unassign). */
export function isAutoOutbound(r: any, did?: string) {
  if (!r || typeof r !== 'object') return false;
  if (!r.auto) return false;
  if (did) {
    const d = String(did).replace(/\D/g, '');
    return String(r.did || r.cli || '') === d || String(r.id || '') === autoOutboundId(d);
  }
  return true;
}

/**
 * Add or remove the auto outbound/CLI row for a DID inside TenantConfig.oroutes.
 * Does not touch manually created oroutes. Returns the new list (also persisted).
 */
export async function syncDidOutbound(
  db: PrismaService,
  tenantId: string,
  did: string,
  action: 'add' | 'remove',
  updatedBy?: string | null,
): Promise<any[]> {
  const d = String(did).replace(/\D/g, '');
  if (!d) return [];
  const row = await db.tenantConfig.findUnique({ where: { tenantId_key: { tenantId, key: 'oroutes' } } });
  let list: any[] = Array.isArray(row?.data) ? [...(row!.data as any[])] : [];

  if (action === 'add') {
    const exists = list.some(r => isAutoOutbound(r, d) || String(r?.cli || '') === d || String(r?.did || '') === d);
    if (!exists) list.push(makeAutoOutbound(d));
  } else {
    list = list.filter(r => !isAutoOutbound(r, d));
  }

  await db.tenantConfig.upsert({
    where: { tenantId_key: { tenantId, key: 'oroutes' } },
    create: { tenantId, key: 'oroutes', data: list as any, updatedBy: updatedBy || null },
    update: { data: list as any, updatedBy: updatedBy || null },
  });
  return list;
}

/** Rebuild auto outbound rows from the tenant's current DID assignments (idempotent). */
export async function resyncTenantOutbound(
  db: PrismaService,
  tenantId: string,
  updatedBy?: string | null,
): Promise<any[]> {
  const dids = (await db.didAssignment.findMany({ where: { tenantId }, orderBy: { did: 'asc' }, select: { did: true } })).map(x => x.did);
  const row = await db.tenantConfig.findUnique({ where: { tenantId_key: { tenantId, key: 'oroutes' } } });
  const manual = Array.isArray(row?.data) ? (row!.data as any[]).filter(r => !isAutoOutbound(r)) : [];
  const auto = dids.map(makeAutoOutbound);
  const list = [...auto, ...manual];
  await db.tenantConfig.upsert({
    where: { tenantId_key: { tenantId, key: 'oroutes' } },
    create: { tenantId, key: 'oroutes', data: list as any, updatedBy: updatedBy || null },
    update: { data: list as any, updatedBy: updatedBy || null },
  });
  return list;
}
