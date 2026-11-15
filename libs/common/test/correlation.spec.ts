import { randomUUID } from 'node:crypto';
import { expect } from 'chai';
import { CORRELATION_HEADER, asUuid, correlationMiddleware, isUuid } from '../src';

function run(incoming?: string) {
  const req: any = { headers: incoming ? { [CORRELATION_HEADER]: incoming } : {} };
  const headers: Record<string, string> = {};
  const res: any = { setHeader: (k: string, v: string) => (headers[k] = v) };
  let called = false;
  correlationMiddleware(req, res, () => (called = true));
  return { req, headers, called };
}

describe('correlationMiddleware', () => {
  it('ใช้ค่าที่ส่งมาถ้าหน้าตาปลอดภัย', () => {
    const { req, headers, called } = run('abc-123');
    expect(req.headers[CORRELATION_HEADER]).to.equal('abc-123');
    expect(headers['X-Correlation-Id']).to.equal('abc-123');
    expect(called).to.equal(true);
  });

  it('สร้างใหม่ถ้าไม่มี', () => {
    const { req } = run();
    expect(req.headers[CORRELATION_HEADER]).to.match(/^[0-9a-f-]{36}$/);
  });

  it('สร้างใหม่ถ้ามีอักขระอันตราย (กัน log injection)', () => {
    const { req } = run('bad\nvalue {"x":1}');
    expect(req.headers[CORRELATION_HEADER]).to.match(/^[0-9a-f-]{36}$/);
  });
});

describe('UUID correlation IDs', () => {
  it('preserves a complete UUID, including uppercase hex', () => {
    const id = randomUUID();
    expect(isUuid(id)).to.equal(true);
    expect(asUuid(id)).to.equal(id);
    expect(asUuid(id.toUpperCase())).to.equal(id.toUpperCase());
  });

  it('replaces a missing-group UUID or non-UUID correlation ID', () => {
    for (const invalid of ['12345678-1234-1234-123456789abc', 'request-123', undefined]) {
      if (invalid) expect(isUuid(invalid)).to.equal(false);
      expect(isUuid(asUuid(invalid))).to.equal(true);
    }
  });
});
