import type { CertificateIssuedPayload, CertificateRevokedPayload } from '@internpath/contracts';

export const CERTIFICATE_ISSUED = 'CertificateIssued';
export const CERTIFICATE_REVOKED = 'CertificateRevoked';

/** แถว `certificates` ที่ใช้สร้าง E12/E13 */
export interface CertificateEventSource {
  id: string;
  applicationId: string;
  studentUserId: string;
  companyId: string;
}

/** E12 (event-contract §5) — มีแค่ id **ห้ามมีชื่อผู้ถือ/ข้อมูลส่วนบุคคล** */
export function buildCertificateIssued(
  cert: CertificateEventSource,
  issuedByUserId: string,
  issuedAt: Date,
): CertificateIssuedPayload {
  return {
    certificate_id: cert.id,
    application_id: cert.applicationId,
    student_user_id: cert.studentUserId,
    company_id: cert.companyId,
    issued_by_user_id: issuedByUserId,
    issued_at: issuedAt.toISOString(),
  };
}

/** E13 (event-contract §5) */
export function buildCertificateRevoked(
  cert: CertificateEventSource,
  revokedByUserId: string,
  revokedByRole: CertificateRevokedPayload['revoked_by_role'],
  reason: string,
  revokedAt: Date,
): CertificateRevokedPayload {
  return {
    certificate_id: cert.id,
    application_id: cert.applicationId,
    student_user_id: cert.studentUserId,
    revoked_by_user_id: revokedByUserId,
    revoked_by_role: revokedByRole,
    reason,
    revoked_at: revokedAt.toISOString(),
  };
}
