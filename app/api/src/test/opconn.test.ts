import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dossierClass } from '../opconn';
import { extDigits } from '../callevents';

describe('extDigits', () => {
  it('strips tenant sip prefix', () => {
    assert.equal(extDigits('tnvekjxww1_102'), '102');
    assert.equal(extDigits('102'), '102');
    assert.equal(extDigits('PJSIP/tnvekjxww1_102'), '102');
  });
});

describe('dossierClass', () => {
  it('priorVip when appointments_total > 0', () => {
    assert.equal(dossierClass({ found: true, appointments_total: 3, appointments: [] }), 'priorVip');
  });
  it('noAppt when found false or zero appointments', () => {
    assert.equal(dossierClass({ found: false }), 'noAppt');
    assert.equal(dossierClass({ found: true, appointments_total: 0, appointments: [] }), 'noAppt');
  });
  it('priorVip from dastgheib services', () => {
    assert.equal(dossierClass({ found: true, patient: {}, services: [{ id: 1 }] }), 'priorVip');
  });
  it('unknown when empty', () => {
    assert.equal(dossierClass(null), 'unknown');
    assert.equal(dossierClass({}), 'unknown');
  });
});
