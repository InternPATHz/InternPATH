import { CircleCheck, Clock5, ScanSearch, type LucideIcon } from 'lucide-react';
import type { ProblemReportCategory, ProblemReportStatus, ResolveProblemReportRequest } from '@internpath/contracts';
import type { StatusTone } from '@/components/ui/status-badge';

/** ชื่อหมวด/สถานะ/การดำเนินการต่อของรายงานปัญหาระหว่างฝึกงาน — ใช้ร่วมกันระหว่างหน้าอาจารย์และหน้า Admin */
export const PROBLEM_CATEGORY_LABEL: Record<ProblemReportCategory, string> = {
  WORKLOAD_OR_HOURS: 'ปริมาณงานหรือชั่วโมงทำงาน',
  NO_ALLOWANCE_AS_PROMISED: 'ไม่ได้รับค่าตอบแทนตามที่ระบุ',
  UNSAFE_OR_HARASSMENT: 'ความไม่ปลอดภัยหรือการคุกคาม',
  DIFFERENT_FROM_JOB_POST: 'งานไม่ตรงกับประกาศ',
  OTHER: 'อื่น ๆ',
};

export const PROBLEM_STATUS_VIEW: Record<ProblemReportStatus, { label: string; tone: StatusTone; icon: LucideIcon }> = {
  OPEN: { label: 'รอรับเรื่อง', tone: 'warning', icon: Clock5 },
  ACKNOWLEDGED: { label: 'รับเรื่องแล้ว', tone: 'info', icon: ScanSearch },
  RESOLVED: { label: 'ปิดเรื่องแล้ว', tone: 'success', icon: CircleCheck },
};

export type ProblemFollowUp = NonNullable<ResolveProblemReportRequest['follow_up_action']>;

export const PROBLEM_FOLLOW_UP_LABEL: Record<ProblemFollowUp, string> = {
  MONITOR_COMPANY: 'ติดตามบริษัท',
  TERMINATE: 'ยุติการฝึก',
  ESCALATE_COMPANY_REVIEW: 'ส่งต่อให้ตรวจบัญชีบริษัท',
};
