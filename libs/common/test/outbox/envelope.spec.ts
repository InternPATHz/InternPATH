import { randomUUID } from 'node:crypto';
import { expect } from 'chai';
import { buildEnvelope, type OutboxRow } from '../../src';

describe('buildEnvelope', () => {
  it('ฟิลด์ตรงตาม event-contract §1', () => {
    const payload = { job_id: 'x', nested: { k: [1, 2] } };
    const row: OutboxRow = {
      id: randomUUID(),
      type: 'JobSubmitted',
      version: 2,
      aggregate_id: randomUUID(),
      payload,
      correlation_id: randomUUID(),
      created_at: new Date('2026-11-13T08:30:00.000Z'),
    };
    const env = buildEnvelope(row, 'job');
    expect(env).to.deep.equal({
      event_id: row.id,
      type: 'JobSubmitted',
      version: 2,
      occurred_at: '2026-11-13T08:30:00.000Z',
      correlation_id: row.correlation_id,
      producer: 'job',
      payload,
    });
    expect(env.payload).to.equal(payload);
  });
});
