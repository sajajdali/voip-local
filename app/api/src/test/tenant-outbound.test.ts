import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generate } from '../asterisk/generator';
import { prefixEntityId, prefixTenantCollection } from '../tenant-scope';
import { autoOutboundId, isAutoOutbound, makeAutoOutbound, POOL_TRUNK_ID, TENANT_OUT_PATS } from '../tenant-outbound';

describe('tenant outbound auto rows', () => {
  it('builds a pool-trunk CLI row per DID', () => {
    const r = makeAutoOutbound('31985001');
    assert.equal(r.id, autoOutboundId('31985001'));
    assert.equal(r.trunk, POOL_TRUNK_ID);
    assert.equal(r.cli, '31985001');
    assert.equal(r.did, '31985001');
    assert.equal(r.auto, true);
    assert.equal(r.pats, TENANT_OUT_PATS);
    assert.ok(isAutoOutbound(r, '31985001'));
    assert.equal(isAutoOutbound({ id: 'manual', trunk: 't31985' }, '31985001'), false);
  });

  it('prefixes IVR opts destinations for tenant queues', () => {
    const ivrs = prefixTenantCollection('cmwt46nsg0002qmn1vekjxww1', 'ivrs', [{
      id: 'i1', name: 'منوی سینا', opts: [{ k: '1', dest: 'q:q1', label: 'پذیرش' }],
    }]);
    assert.equal(ivrs[0].id, prefixEntityId('cmwt46nsg0002qmn1vekjxww1', 'i1'));
    assert.equal(ivrs[0].opts[0].dest, 'q:' + prefixEntityId('cmwt46nsg0002qmn1vekjxww1', 'q1'));
  });
});

describe('dialplan tenant outbound isolation', () => {
  it('blocks platform trunks when CC_TENANT is set and uses tenant CLI AstDB', () => {
    const tid = 'cmwt46nsg0002qmn1vekjxww1';
    const sip = prefixEntityId(tid, '102');
    const qid = prefixEntityId(tid, 'q1');
    const cfg: any = {
      exts: [{ n: '102', name: 'پذیرش', sip, tenantId: tid, secret: 'x' }],
      trunks: [
        { id: 't31985', on: true, host: '10.183.101.233', did: '31985001', type: 'SIP', codec: 'alaw' },
        { id: 't21009062', on: true, host: '1.2.3.4', did: '21009062', type: 'SIP', codec: 'alaw' },
      ],
      vqs: [{ id: qid, name: 'پذیرش سینا', members: ['102'], tenantId: tid, prefRingSec: 40 }],
      ivrs: [], snds: [], routes: [],
      oroutes: [
        { id: prefixEntityId(tid, 'odid31985001'), name: 'خروجی 31985001', on: true, pats: TENANT_OUT_PATS, trunk: 't31985', cli: '31985001', did: '31985001', auto: true, tenantId: tid },
        { id: 'o4', name: 'platform catchall', on: true, pats: '.', trunk: 't21009062' },
      ],
      tgroups: [], tconds: [], holidays: [], rgroups: [], fmes: {}, blist: [], bset: {},
      didRoutes: [{ did: '31985001', tenantId: tid, dest: 'q:' + qid, name: 'سینا' }],
      prefagent: { ringSec: 40 },
    };
    const g = generate(cfg, { hookUrl: 'http://127.0.0.1/h', hookSecret: 's', mohDir: '/tmp' });
    const ext = g.files['extensions.conf'];
    assert.match(ext, /GotoIf\(\$\["\$\{CC_TENANT\}"!=""\]\?skiptenant\)/);
    assert.match(ext, /ccoutcli/);
    assert.match(ext, /ccoutdid/);
    assert.match(ext, /trunk-t31985/);
    assert.equal(g.astdb.ccoutcli[tid], '31985001');
    assert.equal(g.astdb.ccoutdid[`${tid}_31985001`], '1');
    // preferred agent block still on tenant queue
    assert.match(ext, new RegExp('\\[cc-queue-' + qid + '\\]'));
    assert.match(ext, /Dial\(PJSIP\/\$\{CC_PREFEXT\},40/);
  });
});
