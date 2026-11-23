import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generate } from '../asterisk/generator';
import { can, permsOf, PLATFORM_SECTIONS } from '../perms';
import { isPoolDid, normalizePoolDid, DID_POOL_MIN, DID_POOL_MAX } from '../tenants';
import { isSuperAdmin } from '../auth';

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
    assert.match(ext, /GotoIf\(\$\["\$\{CC_DID\}"="31985007"\]\?cc-tenant-tenX-31985007/);
    assert.match(ext, /\[cc-tenant-tenX-31985007\]/);
    assert.match(ext, /Set\(__CC_TENANT=tenX\)/);
    assert.match(ext, /Goto\(cc-queue-qX,s,1\)/);
    // hangup hook carries tenant for Call.tenantId
    assert.match(ext, /tenant=\$\{CC_TENANT\}/);
  });
});
