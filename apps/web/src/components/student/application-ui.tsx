import { CircleCheck, CircleX, Clock5 } from 'lucide-react';
import type { AcademicResult, ApplicationStatus } from '@internpath/contracts';
import { StatusBadge } from '@/components/ui/status-badge';
import { APPLICATION_STATUS, statusView } from '@/lib/status-map';

const dateFormat = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' });
const dateTimeFormat = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });

export const formatDate = (iso: string) => dateFormat.format(new Date(iso));
export const formatDateTime = (iso: string) => dateTimeFormat.format(new Date(iso));

export const ACTOR_LABEL: Record<string, string> = {
  STUDENT: 'นักศึกษา', COMPANY_HR: 'บริษัท', ADVISOR: 'อาจารย์ที่ปรึกษา', PLATFORM_ADMIN: 'ผู้ดูแลระบบ', SYSTEM: 'ระบบ',
};

// `COMPLETED` ต้องดูผลวิชาด้วย: ACADEMIC_FAIL / REPEAT_REQUIRED ไม่ควรเป็นสีเขียว (ดูหมายเหตุใน status-map.ts)
const COMPLETED_VIEW: Record<AcademicResult, { label: string; tone: 'success' | 'danger' | 'warning'; icon: typeof CircleCheck }> = {
  ACADEMIC_PASS: { label: 'ผ่านการฝึกงาน', tone: 'success', icon: CircleCheck },
  ACADEMIC_FAIL: { label: 'ไม่ผ่านรายวิชา', tone: 'danger', icon: CircleX },
  REPEAT_REQUIRED: { label: 'ต้องฝึกซ้ำ', tone: 'warning', icon: Clock5 },
};

export function ApplicationStatusBadge({ status, academicResult }: { status: ApplicationStatus; academicResult?: AcademicResult }) {
  const view = status === 'COMPLETED' && academicResult ? COMPLETED_VIEW[academicResult] : statusView(APPLICATION_STATUS, status);
  return <StatusBadge tone={view.tone} icon={view.icon}>{view.label}</StatusBadge>;
}
