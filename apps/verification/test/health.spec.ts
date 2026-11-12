import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { configureApp } from '@internpath/common';
import { expect } from 'chai';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('verification — health', () => {
  let app: INestApplication;

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  after(async () => {
    await app.close();
  });

  it('GET /health → 200', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).to.deep.equal({ status: 'ok', service: 'verification' });
  });

  it('ตอบ Correlation ID กลับใน Header', async () => {
    const res = await request(app.getHttpServer()).get('/health').set('X-Correlation-Id', 'test-123');
    expect(res.headers['x-correlation-id']).to.equal('test-123');
  });

  it('Route ที่ไม่มี → 404 ในรูปแบบ error มาตรฐาน', async () => {
    const res = await request(app.getHttpServer()).get('/v1/nope').expect(404);
    expect(res.body.error.code).to.equal('NOT_FOUND');
    expect(res.body.error).to.have.property('correlation_id');
  });
});
