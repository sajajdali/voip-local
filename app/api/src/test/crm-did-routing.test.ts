import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generate } from '../asterisk/generator';
import {
  DASTGHEIB_INBOUND_DIDS, applyDidCrmRouting, isDastgheibInboundDid, isTenantPoolDid,
  type CrmSettings,
} from '../patients';

const platDg: CrmSettings = {
  enabled: true, url: '', param: 'mobile', user: '', pass: '',
  phoneFormat: '0', nameField: 'name', timeoutMs: 4000, phoneName: 'fa', showSurgery: true,
  provider: 'dastgheib', dgUrl: 'https://demo.s8n.ir', dgToken: 'dg_x', dgHost: 'demo.s8n.ir',
  kmUrl: '', kmToken: '',
};

const sinaKm: CrmSettings = {
  ...platDg,
  provider: 'kamilo',
  kmUrl: 'http://192.168.88.254:8010/api', kmToken: 'km_x',
  dgUrl: 'https://demo.s8n.ir', dgToken: 'dg_x', dgHost: 'demo.s8n.ir',
};

describe('DID CRM routing helpers', () => {
  it('recognises the three dastgheib DIDs', () => {
    for (const d of DASTGHEIB_INBOUND_DIDS) assert.equal(isDastgheibInboundDid(d), true);
    assert.equal(isDastgheibInboundDid('021009062'), true);
    assert.equal(isDastgheibInboundDid('9821008244'), true);
    assert.equal(isDastgheibInboundDid('31985000'), false);
    assert.equal(isDastgheibInboundDid('31985009'), false);
  });

  it('recognises 31985 pool DIDs', () => {
    assert.equal(isTenantPoolDid('31985000'), true);
    assert.equal(isTenantPoolDid('031985009'), true);
    assert.equal(isTenantPoolDid('21009062'), false);
  });

  it('forces dastgheib for 2100… DIDs even if tenant is kamilo', () => {
    const s = applyDidCrmRouting(sinaKm, platDg, '21009062');
    assert.equal(s.provider, 'dastgheib');
    assert.equal(s.enabled, true);
    assert.equal(s.dgHost, 'demo.s8n.ir');
  });

  it('never keeps dastgheib on 31985 when tenant inherited platform', () => {
    const inherited = { ...platDg }; // demo-x style fallback
    const s = applyDidCrmRouting(inherited, platDg, '31985000');
    assert.notEqual(s.provider, 'dastgheib');
    assert.equal(s.enabled, false); // no km credentials on inherited-only
  });

  it('keeps sina kamilo on 31985', () => {
    const s = applyDidCrmRouting(sinaKm, platDg, '31985009');
    assert.equal(s.provider, 'kamilo');
    assert.equal(s.enabled, true);
    assert.match(s.kmUrl, /8010/);
  });

  it('upgrades inherited dastgheib→kamilo when km credentials exist', () => {
    const mixed = { ...platDg, kmUrl: sinaKm.kmUrl, kmToken: sinaKm.kmToken };
    const s = applyDidCrmRouting(mixed, platDg, '31985007');
    assert.equal(s.provider, 'kamilo');
    assert.equal(s.enabled, true);
  });
});

describe('dialplan CRM lookup passes DID', () => {
  it('lookup and cname hooks include did=${CC_DID}', () => {
    const cfg: any = {
      exts: [{ n: '101', name: 'a' }], trunks: [], vqs: [{ id: 'q1', name: 'q', members: ['101'] }],
      ivrs: [], snds: [], routes: [{ id: 'r1', on: true, did: '', cid: '', dest: 'q:q1', name: 'd', prio: 1 }],
      tgroups: [], tconds: [], holidays: [], rgroups: [], fmes: {}, blist: [], bset: {},
      didRoutes: [{ did: '31985000', tenantId: 'sina', dest: 'q:q1', name: 'سینا' }],
    };
    const ext = generate(cfg, { hookUrl: 'http://127.0.0.1/h', hookSecret: 's', mohDir: '/tmp' }).files['extensions.conf'];
    assert.match(ext, /lookup\?s=s,num=\$\{CC_CID\}&did=\$\{CC_DID\}/);
    assert.match(ext, /cname\?s=s,num=\$\{CC_NUM\}&did=\$\{CC_DID\}/);
  });
});
