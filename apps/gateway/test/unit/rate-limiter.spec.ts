import { expect } from 'chai';
import { RateLimiter } from '../../src/rate-limit/rate-limiter';

describe('Gateway rate limiter capacity', () => {
  it('evicts the least recently used bucket instead of rejecting every new client', () => {
    const limiter = new RateLimiter();
    const login = { name: 'login', max: 1, windowMs: 60_000 };

    for (let index = 0; index < 10_000; index++) {
      expect(limiter.checkIp(login, `client-${index}`)).to.equal(0);
    }

    expect(limiter.checkIp(login, 'client-0')).to.be.greaterThan(0);
    expect(limiter.checkIp(login, 'new-client')).to.equal(0);
    expect(limiter.checkIp(login, 'client-0')).to.be.greaterThan(0);
    expect(limiter.checkIp(login, 'client-1')).to.equal(0);

    const certificate = { name: 'certificate', max: 30, windowMs: 60_000 };
    expect(limiter.checkIp(certificate, 'certificate-visitor')).to.equal(0);
    expect(limiter.checkAccount(login, '/auth/login', Buffer.from('{"email":"new@example.com"}'))).to.equal(0);
  });
});
