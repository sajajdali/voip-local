import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pickCrmAgentId } from '../patients';

describe('pickCrmAgentId', () => {
  it('prefers summary.agent_id', () => {
    assert.equal(pickCrmAgentId({
      found: true, appointments_total: 1,
      summary: { agent_id: 17, agent_name: 'سارا', full_name: 'بیمار' },
      appointments: [{ id: 1, agent_id: 99, date: '1404/01/01' }],
    }), '17');
  });

  it('falls back to next then appointments', () => {
    assert.equal(pickCrmAgentId({
      found: true, appointments_total: 1,
      next_appointment: { id: 2, agent_id: 'aa-1', date: '1404/02/01' },
      appointments: [{ id: 1, agent_id: 'bb-2', date: '1403/12/01' }],
    }), 'aa-1');
    assert.equal(pickCrmAgentId({
      found: true, appointments_total: 1,
      appointments: [{ id: 1, agent_id: 'bb-2', date: '1403/12/01' }],
    }), 'bb-2');
  });

  it('returns empty when missing', () => {
    assert.equal(pickCrmAgentId(null), '');
    assert.equal(pickCrmAgentId({ found: false }), '');
    assert.equal(pickCrmAgentId({ found: true, appointments_total: 0, appointments: [] }), '');
  });
});
