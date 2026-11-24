import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generate } from '../asterisk/generator';
import { can, permsOf, PLATFORM_SECTIONS } from '../perms';
import { isPoolDid, normalizePoolDid, DID_POOL_MIN, DID_POOL_MAX, tenantAdminPerms } from '../tenants';
import { isSuperAdmin } from '../auth';
import {
  cleanFeatures, featureAllows, normalizeInboundDid, prefixDest, prefixDestIfOwned, prefixEntityId, prefixTenantCollection, tenantPrefix,
} from '../tenant-scope';

describe('DID pool 31985', () => {
  it('accepts 31985000…31985999', () => {
    assert.equal(isPoolDid('31985000'), true);
    assert.equal(isPoolDid('31985007'), true);
    assert.equal(isPoolDid('31985999'), true);
    assert.equal(normalizePoolDid('31985-007'), '31985007');
  });
  it('rejects numbers outside the pool', () => {
    assert.equal(isPoolDid('31984999'), false);
    assert.equal(isPoolDid('31986000'), false);
    assert.equal(isPoolDid('21009062'), false);
    assert.equal(isPoolDid(''), false);
    assert.throws(() => normalizePoolDid('123'), /۳۱۹۸۵/);
  });
  it('pool size is 1000', () => {
    assert.equal(DID_POOL_MAX - DID_POOL_MIN + 1, 1000);
  });
  it('normalizes provider DID variants to pool form', () => {
    assert.equal(normalizeInboundDid('031985007'), '31985007');
    assert.equal(normalizeInboundDid('9831985007'), '31985007');
    assert.equal(normalizeInboundDid('009831985007'), '31985007');
    assert.equal(normalizeInboundDid('31985007'), '31985007');
  });
});

describe('super-admin vs tenant scoping', () => {
  it('platform admin is super-admin', () => {
    assert.equal(isSuperAdmin({ id: '1', name: 'a', role: 'admin', ext: null, username: 'admin', tenantId: null }), true);
  });
  it('tenant-bound admin is not super-admin and cannot use trunk', () => {
    const me = { id: '2', name: 't', role: 'admin', ext: null, username: 'tadmin', tenantId: 'ten1', perms: permsOf({ role: 'admin', tenantId: 'ten1' }) };
    assert.equal(isSuperAdmin(me), false);
    assert.equal(can(me, 'vtrunk', 'view'), false);
    assert.equal(can(me, 'tenants', 'view'), false);
    for (const s of PLATFORM_SECTIONS) assert.equal(can(me, s, 'view'), false);
    assert.equal(can(me, 'calls', 'view'), true);
  });
  it('impersonating platform admin is scoped like a tenant, not super-admin', () => {
    const me = {
      id: '1', name: 'a', role: 'admin', ext: null, username: 'admin',
      tenantId: 'ten1', impersonating: true, impersonateTenantId: 'ten1',
      perms: tenantAdminPerms(),
    };
    assert.equal(isSuperAdmin(me), false);
    assert.equal(can(me, 'tenants', 'view'), false);
    assert.equal(can(me, 'vtrunk', 'view'), false);
    assert.equal(can(me, 'calls', 'view'), true);
    assert.equal(can(me, 'vext', 'view'), true);
  });
});

describe('feature flags + id prefix', () => {
  it('defaults all features on', () => {
    const f = cleanFeatures(null);
    assert.equal(f.booking, true);
    assert.equal(f.ai, true);
    assert.equal(f.api, true);
    assert.equal(featureAllows(f, 'booking'), true);
    assert.equal(featureAllows({ ...f, booking: false }, 'booking'), false);
    assert.equal(featureAllows({ ...f, queues: false }, 'vqs'), false);
  });
  it('tenant admin gets AI/integration settings when features on', () => {
    const p = tenantAdminPerms();
    for (const s of ['vai', 'vagent', 'vcrm', 'vapi', 'vsms', 'ai', 'aiconv']) {
      assert.ok(p[s]?.includes('view'), s + ' missing');
    }
    for (const s of PLATFORM_SECTIONS) assert.equal(p[s], undefined);
  });
  it('tenant admin loses AI/API when those features are off', () => {
    const p = tenantAdminPerms({ ...cleanFeatures(null), ai: false, api: false, agent: false, crm: false, sms: false });
    for (const s of ['vai', 'vagent', 'vcrm', 'vapi', 'vsms', 'ai', 'aiconv', 'coach']) {
      assert.equal(p[s], undefined, s + ' should be stripped');
    }
    assert.ok(p.vext?.includes('view'));
  });
  it('prefixes entity ids per tenant without collision', () => {
    const a = prefixEntityId('tenantAAA', 'q1');
    const b = prefixEntityId('tenantBBB', 'q1');
    assert.notEqual(a, b);
    assert.equal(prefixDest('tenantAAA', 'q:q1'), 'q:' + a);
    assert.equal(prefixDest('tenantAAA', 'book'), 'book');
    assert.equal(prefixDest('tenantAAA', 'e:101'), 'e:101');
    assert.ok(tenantPrefix('cuid12345678').startsWith('tn'));
  });
  it('does not rewrite sound or extension ids', () => {
    const snds = prefixTenantCollection('ten1', 'snds', [{ id: 's99', name: 'hi' }]);
    assert.equal(snds[0].id, 's99');
    const exts = prefixTenantCollection('ten1', 'exts', [{ n: '401', name: 'a' }]);
    assert.equal(exts[0].n, '401');
  });
  it('keeps platform defaultDest unprefixed when tenant does not own the queue', () => {
    assert.equal(prefixDestIfOwned('ten1', 'q:q400', { vqs: [] }), 'q:q400');
    assert.equal(prefixDestIfOwned('ten1', 'q:q1', { vqs: [{ id: 'q1' }] }), 'q:' + prefixEntityId('ten1', 'q1'));
  });
});

describe('dialplan DID → tenant', () => {
  it('emits tenant context and destination ahead of generic routes', () => {
    const cfg: any = {
      exts: [{ n: '101', name: 'a' }],
      trunks: [{ id: 't31985', on: true, host: '10.183.101.233', did: '31985001', type: 'SIP', codec: 'alaw' }],
      vqs: [{ id: 'qX', name: 'پذیرش X', members: ['101'] }],
      ivrs: [], snds: [],
      routes: [{ id: 'r1', on: true, did: '', cid: '', dest: 'q:qX', name: 'default', prio: 1 }],
      tgroups: [], tconds: [], holidays: [], rgroups: [], fmes: {}, blist: [], bset: {},
      didRoutes: [{ did: '31985007', tenantId: 'tenX', dest: 'q:qX', name: 'Clinic X' }],
    };
    const g = generate(cfg, { hookUrl: 'http://127.0.0.1/h', hookSecret: 's', mohDir: '/tmp' });
    const ext = g.files['extensions.conf'];
    assert.match(ext, /GotoIf\(\$\["\$\{CC_DID\}"="31985007"/);
    assert.match(ext, /\[cc-tenant-tenX-31985007\]/);
    assert.match(ext, /Set\(__CC_TENANT=tenX\)/);
    assert.match(ext, /Goto\(cc-queue-qX,s,1\)/);
    assert.match(ext, /tenant=\$\{CC_TENANT\}/);
    assert.match(ext, /lookup\?s=s,num=\$\{CC_CID\}&did=\$\{CC_DID\}/);
    // DID normalize strips 98/0 and last-8
    assert.match(ext, /strip98/);
    assert.match(ext, /last8/);
  });

  it('prefixed tenant queue ids do not collide across tenants', () => {
    const cfg: any = {
      exts: [{ n: '201', name: 'a' }, { n: '301', name: 'b' }],
      trunks: [],
      vqs: [
        { id: 'tnA_q1', name: 'A', members: ['201'] },
        { id: 'tnB_q1', name: 'B', members: ['301'] },
      ],
      ivrs: [], snds: [], routes: [], tgroups: [], tconds: [], holidays: [], rgroups: [], fmes: {}, blist: [], bset: {},
      didRoutes: [
        { did: '31985001', tenantId: 'tenA', dest: 'q:tnA_q1', name: 'A' },
        { did: '31985002', tenantId: 'tenB', dest: 'q:tnB_q1', name: 'B' },
      ],
    };
    const g = generate(cfg, { hookUrl: 'http://127.0.0.1/h', hookSecret: 's', mohDir: '/tmp' });
    const ext = g.files['extensions.conf'];
    assert.match(ext, /\[cc-queue-tnA_q1\]/);
    assert.match(ext, /\[cc-queue-tnB_q1\]/);
    assert.match(ext, /Goto\(cc-queue-tnA_q1,s,1\)/);
    assert.match(ext, /Goto\(cc-queue-tnB_q1,s,1\)/);
  });
});
