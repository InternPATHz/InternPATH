import { expect } from 'chai';
import { validateAdminUrl, validateTestTarget } from '../support/db';

describe('Job disposable database target safety (no database required)', () => {
  const admin = 'postgresql://test_admin@127.0.0.1:5432/postgres';
  const name = 'job_it_0123456789abcdef';
  const target = `postgresql://test_admin@127.0.0.1:5432/${name}`;

  it('accepts an explicit local maintenance connection and a generated test target', () => {
    expect(validateAdminUrl(admin)).to.equal(admin);
    expect(() => validateTestTarget(admin, target, name)).not.to.throw();
    for (const host of ['localhost', '[::1]']) {
      expect(() => validateAdminUrl(`postgresql://test_admin@${host}/postgres`)).not.to.throw();
    }
  });

  for (const [label, url] of [
    ['missing URL', ''],
    ['invalid URL', 'invalid'],
    ['non-PostgreSQL protocol', 'https://test_admin@127.0.0.1/postgres'],
    ['remote host', 'postgresql://test_admin@example.com/postgres'],
    ['application database', 'postgresql://test_admin@127.0.0.1/job_db'],
    ['other service database', 'postgresql://test_admin@127.0.0.1/verification_db'],
    ['missing user', 'postgresql://127.0.0.1/postgres'],
    ['host override', `${admin}?host=example.com`],
    ['database override', `${admin}?dbname=job_db`],
    ['connection options', `${admin}?options=-csearch_path=other`],
    ['fragment', `${admin}#other`],
  ]) {
    it(`rejects ${label} before connecting`, () => {
      expect(() => validateAdminUrl(url)).to.throw();
    });
  }

  for (const invalid of [
    'job_db',
    'identity_db',
    'job_it_',
    'job_it_1234',
    `${name}"; DROP DATABASE postgres;--`,
  ]) {
    it(`rejects a target name outside the generated-name allow-list: ${invalid.split(';')[0]}`, () => {
      expect(() => validateTestTarget(admin, target, invalid)).to.throw();
    });
  }

  it('rejects a different host, user, port, database, or added URL parameters', () => {
    for (const altered of [
      target.replace('127.0.0.1', 'localhost'),
      target.replace('test_admin', 'another_user'),
      target.replace('5432', '5433'),
      target.replace(name, 'job_it_ffffffffffffffff'),
      `${target}?host=example.com`,
    ]) {
      expect(() => validateTestTarget(admin, altered, name)).to.throw();
    }
  });

  it('does not include supplied credentials in URL validation errors', () => {
    const marker = 'test-secret-marker';
    let message = '';
    try {
      validateAdminUrl(`postgresql://test_admin:${marker}@example.com/postgres`);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).to.be.a('string').and.not.equal('');
    expect(message).not.to.include(marker);
  });
});
