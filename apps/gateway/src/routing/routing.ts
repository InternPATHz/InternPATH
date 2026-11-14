export type ServiceName = 'identity' | 'job' | 'verification' | 'lifecycle' | 'notification';

const prefix = (path: string, start: string) => path === start || path.startsWith(`${start}/`);
const item = '[^/]+';

/** api-contract.md §3: specific resource actions must win over broad prefixes. */
export function resolveService(path: string): ServiceName | undefined {
  if (path === '/internal' || path.startsWith('/internal/')) return undefined;
  if (new RegExp(`^/jobs/${item}/reports$`).test(path) ||
      new RegExp(`^/reviews/${item}/reports$`).test(path)) return 'verification';
  if (new RegExp(`^/companies/${item}/reviews$`).test(path)) return 'lifecycle';

  if (['/auth', '/.well-known', '/users', '/advisor-links', '/companies/me', '/directory',
    '/admin/companies', '/admin/advisors', '/admin/students', '/admin/users', '/admin/audit-logs']
    .some((start) => prefix(path, start)) || path === '/advisors') return 'identity';
  if (['/hr/jobs', '/jobs', '/search', '/admin/jobs'].some((start) => prefix(path, start))) return 'job';
  if (['/verification', '/admin/queue', '/admin/blacklist', '/admin/risk-rules', '/admin/flags',
    '/admin/audit'].some((start) => prefix(path, start))) return 'verification';
  if (['/applications', '/me', '/hr/applications', '/hr/certificates', '/hr/reviews', '/advisor',
    '/me/certificates', '/problem-reports', '/admin/lifecycle', '/public'].some((start) => prefix(path, start)))
    return 'lifecycle';
  if (prefix(path, '/notifications')) return 'notification';
  return undefined;
}

const PUBLIC_POST = new Set([
  '/auth/register/student', '/auth/register/advisor', '/auth/register/company', '/auth/verify-email',
  '/auth/resend-verification', '/auth/login', '/auth/refresh', '/auth/password/forgot',
  '/auth/password/reset', '/auth/invitations/accept',
]);

export function isPublicRoute(method: string, path: string): boolean {
  if (method === 'POST' && PUBLIC_POST.has(path)) return true;
  if (method === 'GET' && (path === '/.well-known/jwks.json' ||
      new RegExp(`^/public/certificates/${item}(?:/verify-hash)?$`).test(path))) return true;
  return false;
}
