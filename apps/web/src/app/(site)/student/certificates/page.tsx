'use client';

import { RequireAuth } from '@/components/layout/require-auth';
import { CertificateList } from '@/components/student/certificate-list';

export default function StudentCertificatesPage() {
  return (
    <RequireAuth roles={['STUDENT']}>
      <CertificateList />
    </RequireAuth>
  );
}
