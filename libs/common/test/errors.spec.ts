import { BadRequestException, NotFoundException } from '@nestjs/common';
import { expect } from 'chai';
import { AllExceptionsFilter, AppException } from '../src';

function run(exception: unknown) {
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
  const req = { method: 'GET', url: '/x', headers: { 'x-correlation-id': 'cid-1' } };
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
