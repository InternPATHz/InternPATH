import { ConfigService } from '@nestjs/config';
import { expect } from 'chai';
import { LIFECYCLE_DEFAULTS } from '../../src/config/lifecycle.constants';
import { LifecycleConfigService } from '../../src/config/lifecycle-config.service';

describe('LifecycleConfigService (Unit)', () => {
  it('คืนค่าเริ่มต้นถูกต้องตาม README §5.3, §5.4, §5.7', async () => {
    const envConfig = new ConfigService();
    const service = new LifecycleConfigService(envConfig);

    expect(await service.getNumber('CERT_MIN_ACTUAL_DAYS')).to.equal(30);
    expect(await service.getNumber('SLA_PENDING_DAYS')).to.equal(14);
    expect(await service.getNumber('SLA_ACCEPTED_DAYS')).to.equal(5);
    expect(await service.getNumber('SLA_ADVISOR_PENDING_DAYS')).to.equal(7);
    expect(await service.getNumber('DISPUTE_WINDOW_DAYS')).to.equal(7);
    expect(await service.getNumber('SCHEDULER_INTERVAL_MINUTES')).to.equal(15);
    expect(await service.getNumber('RECONCILIATION_INTERVAL_MINUTES')).to.equal(30);
    expect(await service.getNumber('SIGNED_URL_EXPIRES_SECONDS')).to.equal(600);
  });

  it('อ่านค่าจาก env ก่อนค่าเริ่มต้นเมื่อมีการตั้งค่า', async () => {
    const envConfig = new ConfigService({
      CERT_MIN_ACTUAL_DAYS: '45',
      SLA_PENDING_DAYS: '10',
    });
    const service = new LifecycleConfigService(envConfig);

    expect(await service.getNumber('CERT_MIN_ACTUAL_DAYS')).to.equal(45);
    expect(await service.getNumber('SLA_PENDING_DAYS')).to.equal(10);
  });

  it('อ่านค่าจาก config_overrides ใน DB ก่อนค่าจาก env', async () => {
    const envConfig = new ConfigService({ CERT_MIN_ACTUAL_DAYS: '45' });
    const mockPrisma = {
      configOverride: {
        findUnique: async ({ where }: { where: { key: string } }) => {
          if (where.key === 'CERT_MIN_ACTUAL_DAYS') {
            return { key: 'CERT_MIN_ACTUAL_DAYS', value: '1' };
          }
          return null;
        },
      },
    } as any;

    const service = new LifecycleConfigService(envConfig, mockPrisma);
    expect(await service.getNumber('CERT_MIN_ACTUAL_DAYS')).to.equal(1);
    expect(await service.getNumber('SLA_PENDING_DAYS')).to.equal(LIFECYCLE_DEFAULTS.SLA_PENDING_DAYS);
  });
});
