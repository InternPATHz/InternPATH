import { expect } from 'chai';
import { isPublicRoute, resolveService } from '../src/routing';

describe('Gateway routing contract §3', () => {
  it('covers every path group and the overlapping resource actions', () => {
    const cases = [
      ['/auth/login', 'identity'], ['/.well-known/jwks.json', 'identity'], ['/users/me', 'identity'],
      ['/advisors', 'identity'], ['/advisor-links/requests', 'identity'], ['/companies/me/documents', 'identity'],
      ['/directory/companies', 'identity'], ['/admin/companies/1', 'identity'], ['/admin/advisors', 'identity'],
      ['/admin/students/1/advisor', 'identity'], ['/admin/users/1', 'identity'], ['/admin/audit-logs', 'identity'],
      ['/hr/jobs/1', 'job'], ['/jobs/1', 'job'], ['/search/jobs', 'job'], ['/admin/jobs/1', 'job'],
      ['/verification/jobs/1/result', 'verification'], ['/admin/queue', 'verification'],
      ['/admin/blacklist/test', 'verification'], ['/admin/risk-rules', 'verification'],
      ['/admin/flags/companies', 'verification'], ['/jobs/1/reports', 'verification'],
      ['/reviews/1/reports', 'verification'], ['/admin/audit', 'verification'],
      ['/applications/1', 'lifecycle'], ['/me/resumes', 'lifecycle'], ['/hr/applications/1', 'lifecycle'],
      ['/hr/certificates/1', 'lifecycle'], ['/hr/reviews/1/reply', 'lifecycle'],
      ['/advisor/applications', 'lifecycle'], ['/me/certificates', 'lifecycle'],
      ['/companies/1/reviews', 'lifecycle'], ['/problem-reports/1', 'lifecycle'],
      ['/admin/lifecycle/audit-logs', 'lifecycle'], ['/public/certificates/abc', 'lifecycle'],
      ['/notifications', 'notification'], ['/notifications/unread-count', 'notification'],
    ] as const;
    for (const [path, service] of cases) expect(resolveService(path), path).to.equal(service);
    for (const path of ['/internal/v1/denylist', '/internal', '/unknown', '/advisors/1', '/jobs-extra'])
      expect(resolveService(path), path).to.equal(undefined);
  });

  it('only allows documented public methods without a user token', () => {
    for (const path of ['/auth/login', '/auth/register/student', '/auth/password/forgot', '/auth/refresh',
      '/auth/invitations/accept']) expect(isPublicRoute('POST', path), path).to.equal(true);
    expect(isPublicRoute('GET', '/.well-known/jwks.json')).to.equal(true);
    expect(isPublicRoute('GET', '/public/certificates/abc')).to.equal(true);
    expect(isPublicRoute('POST', '/auth/logout')).to.equal(false);
    expect(isPublicRoute('GET', '/jobs/1')).to.equal(false);
    expect(isPublicRoute('POST', '/public/certificates/abc')).to.equal(false);
  });
});
