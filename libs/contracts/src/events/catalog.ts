// ต้องตรงกับ docs/event-contract.md §4 (สรุป Event ทั้งหมด) — มีเทสต์เทียบกับเอกสารใน libs/common/test/messaging/provision.spec.ts
import type { ServiceName } from './envelope';

export interface EventCatalogEntry {
  /** E01-E19 ตามเอกสาร */
  id: string;
  type: string;
  producer: ServiceName;
  /** ชื่อ Service ผู้รับ (ชื่อคิว = `<consumer>.<type>`) — `gateway` ไม่อยู่ใน ServiceName เพราะไม่ส่ง Event */
  consumers: readonly string[];
}

export const EVENT_CATALOG: readonly EventCatalogEntry[] = [
  { id: 'E01', type: 'JobSubmitted', producer: 'job', consumers: ['verification'] },
  { id: 'E02', type: 'JobVerified', producer: 'verification', consumers: ['job'] },
  { id: 'E03', type: 'JobStatusChanged', producer: 'job', consumers: ['lifecycle', 'notification', 'verification'] },
  { id: 'E04', type: 'ReportThresholdReached', producer: 'verification', consumers: ['job', 'notification'] },
  { id: 'E05', type: 'CompanyStatusChanged', producer: 'identity', consumers: ['job', 'lifecycle', 'verification', 'notification'] },
  { id: 'E06', type: 'CompanyEntitlementChanged', producer: 'identity', consumers: ['job'] },
  { id: 'E07', type: 'AdvisorLinkChanged', producer: 'identity', consumers: ['lifecycle', 'notification'] },
  { id: 'E08', type: 'ApplicationStatusChanged', producer: 'lifecycle', consumers: ['notification'] },
  { id: 'E09', type: 'ReviewSubmitted', producer: 'lifecycle', consumers: ['verification'] },
  { id: 'E10', type: 'ReviewModerationResult', producer: 'verification', consumers: ['lifecycle', 'notification'] },
  { id: 'E11', type: 'ReviewPublished', producer: 'lifecycle', consumers: ['identity', 'notification'] },
  { id: 'E12', type: 'CertificateIssued', producer: 'lifecycle', consumers: ['notification'] },
  { id: 'E13', type: 'CertificateRevoked', producer: 'lifecycle', consumers: ['notification'] },
  { id: 'E14', type: 'ReminderDue', producer: 'lifecycle', consumers: ['notification'] },
  { id: 'E15', type: 'UserDeletionRequested', producer: 'identity', consumers: ['lifecycle', 'job', 'verification', 'notification'] },
  { id: 'E16', type: 'UserSuspended', producer: 'identity', consumers: ['gateway', 'notification'] },
  { id: 'E17', type: 'ProblemReportCreated', producer: 'lifecycle', consumers: ['notification'] },
  { id: 'E18', type: 'CompanyFlagChanged', producer: 'verification', consumers: ['job', 'notification'] },
  { id: 'E19', type: 'ConductReportCreated', producer: 'lifecycle', consumers: ['notification'] },
];
