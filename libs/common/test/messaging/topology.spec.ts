import { expect } from 'chai';
import {
  DEFAULT_RETRY_DELAYS_MS,
  consumerQueueName,
  dlqName,
  retryQueueName,
} from '../../src';

describe('messaging topology names', () => {
  it('consumerQueueName ต่อเป็น <consumer>.<EventType>', () => {
    expect(consumerQueueName('notification', 'JobVerified')).to.equal('notification.JobVerified');
  });

  it('dlqName ต่อท้ายด้วย .dlq', () => {
    expect(dlqName('notification.JobVerified')).to.equal('notification.JobVerified.dlq');
  });

  it('retryQueueName ใช้เลขครั้งที่เริ่มจาก 1', () => {
    expect(retryQueueName('job', 2)).to.equal('job.retry.2');
  });

  it('DEFAULT_RETRY_DELAYS_MS เท่ากับ 5 วินาที / 30 วินาที / 2 นาที', () => {
    expect([...DEFAULT_RETRY_DELAYS_MS]).to.deep.equal([5000, 30000, 120000]);
  });
});
