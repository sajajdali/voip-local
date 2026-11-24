import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isInboundContext, isInboundLocal } from '../livecalls';

describe('livecalls inbound helpers', () => {
  it('recognises booking / tenant / trunk contexts as inbound', () => {
    for (const c of ['from-trunk', 'cc-inbound', 'cc-book', 'cc-route-r1', 'cc-ivr-i2', 'cc-tenant-sina-31985009', 'cc-queue-q1']) {
      assert.equal(isInboundContext(c), true, c);
    }
    assert.equal(isInboundContext('cc-callback'), false);
    assert.equal(isInboundContext('cc-outext'), false);
  });

  it('recognises Local simulate-inbound channels', () => {
    assert.equal(isInboundLocal('Local/31985009@from-trunk-00000001;2'), true);
    assert.equal(isInboundLocal('Local/ai@cc-inbound-0001;1'), true);
    assert.equal(isInboundLocal('Local/0912@cc-outext-0001;1'), false);
    assert.equal(isInboundLocal('PJSIP/trunk-t31985-00000001'), false);
  });
});
