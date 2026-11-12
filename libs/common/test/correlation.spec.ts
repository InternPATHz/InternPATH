import { expect } from 'chai';
import { CORRELATION_HEADER, correlationMiddleware } from '../src';

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
