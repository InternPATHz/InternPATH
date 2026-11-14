import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { expect } from 'chai';
import { AllExceptionsFilter, AppException } from '../src';

function run(exception: unknown, url = '/x') {
  const captured: { status?: number; body?: any } = {};
  const res = {
    status(s: number) {
      captured.status = s;
      return this;
    },
    json(b: unknown) {
      captured.body = b;
      return this;
    },
  };
  const req = { method: 'GET', url, headers: { 'x-correlation-id': 'cid-1' } };
  const host: any = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }) };
  new AllExceptionsFilter().catch(exception, host);
  return captured;
}

describe('AllExceptionsFilter', () => {
  it('แปลง AppException เป็นรูปแบบ error มาตรฐาน', () => {
    const { status, body } = run(
      new AppException('QUOTA_FULL', 'โควตาตำแหน่งเต็มแล้ว', 409, [{ field: 'quota', issue: 'FULL' }]),
    );
    expect(status).to.equal(409);
    expect(body).to.deep.equal({
      error: {
        code: 'QUOTA_FULL',
        message: 'โควตาตำแหน่งเต็มแล้ว',
        details: [{ field: 'quota', issue: 'FULL' }],
        correlation_id: 'cid-1',
      },
    });
  });

  it('แปลง HttpException ของ Nest เป็นรหัสตาม status', () => {
    const { status, body } = run(new NotFoundException());
    expect(status).to.equal(404);
    expect(body.error.code).to.equal('NOT_FOUND');
  });

  it('รวมข้อความ validation เป็น details', () => {
    const { status, body } = run(new BadRequestException(['email must be an email']));
    expect(status).to.equal(400);
    expect(body.error.code).to.equal('VALIDATION_FAILED');
    expect(body.error.details).to.deep.equal([{ issue: 'email must be an email' }]);
  });

  it('Error ที่ไม่รู้จักเป็น 500 และไม่รั่วข้อความภายใน', () => {
    const { status, body } = run(new Error('db password is hunter2'));
    expect(status).to.equal(500);
    expect(body.error.code).to.equal('INTERNAL_ERROR');
    expect(JSON.stringify(body)).to.not.contain('hunter2');
  });
});

describe('AllExceptionsFilter: log ของ error 5xx (กันข้อมูลอ่อนไหวหลุดลง log)', () => {
  const SECRET = 'Key (email)=(somchai@example.com) already exists; password=hunter2';
  const NL = String.fromCharCode(10);
  let logged: string[];
  let original: typeof Logger.prototype.error;
  let nodeEnv: string | undefined;

  beforeEach(() => {
    logged = [];
    original = Logger.prototype.error;
    (Logger.prototype as any).error = (...args: unknown[]) => void logged.push(args.map((a) => String(a)).join(' | '));
    nodeEnv = process.env.NODE_ENV;
  });
  afterEach(() => {
    Logger.prototype.error = original;
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  });

  it('production: log ชื่อ error, code, stack frames และ correlation id แต่ไม่มีข้อความของ error', () => {
    process.env.NODE_ENV = 'production';
    run(Object.assign(new Error(SECRET), { code: 'P2002' }));
    const text = logged.join(NL);
    expect(text).to.contain('Error');
    expect(text).to.contain('P2002');
    expect(text).to.contain('cid-1');
    expect(text).to.match(/ at /);
    expect(text).to.not.contain('somchai@example.com');
    expect(text).to.not.contain('hunter2');
  });

  it('production: ไม่ log query string ของ URL (อาจมี token หรือคำค้นที่เป็นข้อมูลส่วนบุคคล)', () => {
    process.env.NODE_ENV = 'production';
    run(new Error('x'), '/auth/verify-email?token=SECRET-TOKEN&email=a@b.com');
    const text = logged.join(NL);
    expect(text).to.contain('/auth/verify-email');
    expect(text).to.not.contain('SECRET-TOKEN');
    expect(text).to.not.contain('a@b.com');
  });

  it('ไม่ใช่ production (dev/test): log ข้อความของ error เพื่อช่วยดีบั๊ก', () => {
    process.env.NODE_ENV = 'development';
    run(new Error('db is down'));
    expect(logged.join(NL)).to.contain('db is down');
  });

  it('error 4xx ไม่ถูก log ระดับ error', () => {
    process.env.NODE_ENV = 'production';
    run(new AppException('QUOTA_FULL', 'เต็ม', 409));
    expect(logged).to.have.length(0);
  });
});
