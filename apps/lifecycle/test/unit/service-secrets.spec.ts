import { expect } from 'chai';
import type { ConfigService } from '@nestjs/config';
import { CERTIFICATE_ACTION } from '../../src/modules/hr-applications/hr-applications.service';
import { ServiceSecretsCheck, missingServiceSecrets } from '../../src/config/service-secrets.check';

const OK = 'x'.repeat(32);

describe('ServiceSecretsCheck (Unit) — fail-fast ตอนเริ่มระบบ (PM ขอ 18 พ.ย.)', () => {
  it('รายงานชื่อ env ที่ว่าง/สั้นกว่า 32 ตัว (ไม่คืนค่า secret)', () => {
    const env: Record<string, string> = { IDENTITY_SERVICE_SECRET_LIFECYCLE: OK, JOB_SERVICE_SECRET_LIFECYCLE: 'short' };
    expect(missingServiceSecrets((n) => env[n])).to.deep.equal(['JOB_SERVICE_SECRET_LIFECYCLE']);
    expect(missingServiceSecrets(() => undefined)).to.deep.equal([
      'IDENTITY_SERVICE_SECRET_LIFECYCLE',
      'JOB_SERVICE_SECRET_LIFECYCLE',
    ]);
    expect(missingServiceSecrets(() => OK)).to.deep.equal([]);
  });

  it('onModuleInit throw เมื่อขาด (แอปไม่เริ่ม) • ครบ ⇒ ผ่าน', () => {
    const check = (value?: string) => new ServiceSecretsCheck({ get: () => value } as unknown as ConfigService);
    expect(() => check(undefined).onModuleInit()).to.throw(/IDENTITY_SERVICE_SECRET_LIFECYCLE, JOB_SERVICE_SECRET_LIFECYCLE/);
    expect(() => check(OK).onModuleInit()).to.not.throw();
  });
});

describe('available_actions ของ HR (Unit)', () => {
  it("ชื่อปุ่มออกใบรับรองคงที่ = 'certificate' (หน้าเว็บ #60 ใช้ — PM ขอห้ามเปลี่ยน)", () => {
    expect(CERTIFICATE_ACTION).to.equal('certificate');
  });
});
