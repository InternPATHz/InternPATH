import { expect } from 'chai';
import { RateLimiter } from '../../src/rate-limit/rate-limiter';

describe('Gateway rate limiter capacity', () => {
  it('limits student creation per advisor without sharing a bucket across advisors', () => {
    const limiter = new RateLimiter();
    const rule = limiter.rule('POST', '/advisor-links/students')!;
    expect(rule).to.include({ name: 'advisor-create-student', max: 30, windowMs: 3_600_000 });
    expect(limiter.rule('GET', '/advisor-links/students')).to.equal(undefined);
    for (let index = 0; index < 30; index++) expect(limiter.checkActor(rule, 'advisor-a')).to.equal(0);
    expect(limiter.checkActor(rule, 'advisor-a')).to.be.greaterThan(0);
    expect(limiter.checkActor(rule, 'advisor-b')).to.equal(0);
    for (let index = 0; index < 120; index++) expect(limiter.checkAdvisorCreateIp('203.0.113.10')).to.equal(0);
    expect(limiter.checkAdvisorCreateIp('203.0.113.10')).to.be.greaterThan(0);
    expect(limiter.checkAdvisorCreateIp('203.0.113.11')).to.equal(0);
  });
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

  it('gives each public read route its own 60/min bucket and only for GET', () => {
    const limiter = new RateLimiter();
    const paths = ['/search/jobs', '/jobs/abc', '/directory/companies', '/directory/companies/abc',
      '/companies/abc/reviews'];
    const rules = paths.map((path) => limiter.rule('GET', path));
    for (const [index, rule] of rules.entries()) {
      expect(rule, paths[index]).to.include({ max: 60, windowMs: 60_000 });
      expect(rule!.name, paths[index]).to.match(/^public-/);
    }
    expect(new Set(rules.map((rule) => rule!.name)).size).to.equal(paths.length);
    for (const [method, path] of [['POST', '/jobs/abc/reports'], ['GET', '/jobs/abc/reports'], ['POST', '/search/jobs'],
      ['GET', '/users/me']]) expect(limiter.rule(method, path), `${method} ${path}`).to.equal(undefined);
  });

  it('rejects the 61st public read from one IP without touching other routes or IPs', () => {
    const limiter = new RateLimiter();
    const search = limiter.rule('GET', '/search/jobs')!;
    const directory = limiter.rule('GET', '/directory/companies')!;
    for (let index = 0; index < 60; index++) expect(limiter.checkIp(search, '203.0.113.1')).to.equal(0);
    expect(limiter.checkIp(search, '203.0.113.1')).to.be.greaterThan(0);
    expect(limiter.checkIp(directory, '203.0.113.1')).to.equal(0);
    expect(limiter.checkIp(search, '203.0.113.2')).to.equal(0);
  });
});
