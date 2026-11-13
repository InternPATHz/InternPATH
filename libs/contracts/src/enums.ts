// Enum กลางของระบบ — ต้องตรงกับ docs/data-schema.md §2.1 (ที่เก็บหลัก)
// เพิ่ม/เปลี่ยนค่า = เปลี่ยน contract: ต้องแก้เอกสารและบอกใน PR (ดู docs/developer-guide.md)

export type Role = 'STUDENT' | 'COMPANY_HR' | 'ADVISOR' | 'PLATFORM_ADMIN';

export type UserStatus = 'PENDING_EMAIL' | 'PENDING_APPROVAL' | 'ACTIVE' | 'SUSPENDED' | 'DELETED';

export type CompanyStatus = 'PENDING' | 'NEED_MORE_INFO' | 'VERIFIED' | 'REJECTED' | 'SUSPENDED';

export type CompanyMemberRole = 'OWNER' | 'MEMBER';

export type AdvisorLinkStatus = 'NONE' | 'ADVISOR_LINK_PENDING' | 'LINKED';

export type JobStatus =
  | 'DRAFT'
  | 'VERIFYING'
  | 'PUBLISHED'
  | 'PENDING_REVIEW'
  | 'AUTO_REJECTED'
  | 'ADMIN_REJECTED'
  | 'SUSPENDED'
  | 'REMOVED'
  | 'CLOSED';

export type WorkMode = 'ONSITE' | 'REMOTE' | 'HYBRID';

export type JobCategory = 'TECH_IT' | 'BUSINESS_MARKETING' | 'CORPORATE_SERVICES';

export type QuotaReservationStatus = 'RESERVED' | 'CONFIRMED' | 'RELEASED';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export type QueueItemType =
  | 'JOB_REVIEW'
  | 'JOB_APPEAL'
  | 'COMPANY_ACCOUNT'
  | 'JOB_REPORT'
  | 'REVIEW_HELD'
  | 'REVIEW_REPORT';

export type QueueItemStatus = 'OPEN' | 'IN_REVIEW' | 'RESOLVED';

export type ApplicationStatus =
  | 'PENDING'
  | 'HR_ACCEPTED'
  | 'ADVISOR_PENDING'
  | 'ADVISOR_APPROVED'
  | 'IN_PROGRESS'
  | 'EVALUATED_PASS'
  | 'EVALUATED_FAIL'
  | 'FAIL_DISPUTED'
  | 'REEVALUATION_REQUESTED'
  | 'COMPLETED'
  | 'TERMINATED'
  | 'NO_EVALUATION'
  | 'HR_REJECTED'
  | 'STUDENT_DECLINED'
  | 'ADVISOR_REJECTED'
  | 'OFFER_RESCINDED'
  | 'WITHDRAWN'
  | 'EXPIRED'
  | 'CANCELLED';

export type AcademicResult = 'ACADEMIC_PASS' | 'ACADEMIC_FAIL' | 'REPEAT_REQUIRED';

export type TerminatedBy = 'COMPANY' | 'STUDENT' | 'ADVISOR' | 'ADMIN';

export type CertificateStatus = 'VALID' | 'REVOKED';

export type ReviewStatus = 'SUBMITTED' | 'PUBLISHED' | 'HELD' | 'REMOVED';

export type ProblemReportStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';

export type NotificationChannel = 'IN_APP' | 'EMAIL';
