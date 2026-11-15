import { ConfigService } from '@nestjs/config';
import { expect } from 'chai';
import { S3StorageService } from '../../src/common/storage/s3-storage.service';

describe('S3StorageService (Unit)', () => {
  let service: S3StorageService;

  before(() => {
    const config = new ConfigService({
      S3_ENDPOINT: 'http://127.0.0.1:9000',
      S3_REGION: 'auto',
      S3_BUCKET_PRIVATE: 'internpath-private',
      S3_ACCESS_KEY: 'internpath',
      S3_SECRET_KEY: 'change-me-too-12345',
    });
    service = new S3StorageService(config);
  });

  it('สร้าง object key เป็น UUID สุ่ม ไม่ติดชื่อไฟล์เดิมหรือ PII (README §5.9)', () => {
    const key1 = service.generateKey('resumes', 'pdf');
    const key2 = service.generateKey('resumes', 'pdf');

    expect(key1).to.not.equal(key2);
    expect(key1).to.match(/^resumes\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/);
    expect(key2).to.match(/^resumes\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/);

    const certKey = service.generateKey('certificates');
    expect(certKey).to.match(/^certificates\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('โยน Error ชัดเจนหากไม่มี S3_ACCESS_KEY หรือ S3_SECRET_KEY', () => {
    const originalAccessKey = process.env.S3_ACCESS_KEY;
    const originalSecretKey = process.env.S3_SECRET_KEY;
    delete process.env.S3_ACCESS_KEY;
    delete process.env.S3_SECRET_KEY;

    try {
      const emptyConfig = new ConfigService({});
      expect(() => new S3StorageService(emptyConfig)).to.throw(
        'S3 credentials are not configured (S3_ACCESS_KEY and S3_SECRET_KEY are required)',
      );

      const missingSecretConfig = new ConfigService({ S3_ACCESS_KEY: 'my-key' });
      expect(() => new S3StorageService(missingSecretConfig)).to.throw(
        'S3 credentials are not configured (S3_ACCESS_KEY and S3_SECRET_KEY are required)',
      );

      const missingAccessKeyConfig = new ConfigService({ S3_SECRET_KEY: 'my-secret' });
      expect(() => new S3StorageService(missingAccessKeyConfig)).to.throw(
        'S3 credentials are not configured (S3_ACCESS_KEY and S3_SECRET_KEY are required)',
      );
    } finally {
      if (originalAccessKey !== undefined) {
        process.env.S3_ACCESS_KEY = originalAccessKey;
      } else {
        delete process.env.S3_ACCESS_KEY;
      }

      if (originalSecretKey !== undefined) {
        process.env.S3_SECRET_KEY = originalSecretKey;
      } else {
        delete process.env.S3_SECRET_KEY;
      }
    }
  });
});
