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

const progressSteps = [
  'ส่งใบสมัคร', 'บริษัทตอบรับ', 'อาจารย์พิจารณา', 'เริ่มฝึกงาน', 'ประเมินผล', 'จบการฝึก',
] as const;

const progressIndex: Partial<Record<ApplicationStatus, number>> = {
  PENDING: 0,
  HR_ACCEPTED: 1,
  ADVISOR_PENDING: 2,
  ADVISOR_APPROVED: 2,
  IN_PROGRESS: 3,
  EVALUATED_PASS: 4,
  EVALUATED_FAIL: 4,
  FAIL_DISPUTED: 4,
  REEVALUATION_REQUESTED: 4,
  COMPLETED: 5,
};

export const isClosedApplication = (status: ApplicationStatus) => status === 'COMPLETED' || progressIndex[status] === undefined;

export function ApplicationProgress({ status, timeline = [] }: {
  status: ApplicationStatus;
  timeline?: Array<{ to_status: ApplicationStatus; occurred_at: string }>;
}) {
  const current = progressIndex[status];
  if (current === undefined) return null;
  const dates = new Map<number, string>();
  for (const entry of timeline) {
    const step = progressIndex[entry.to_status];
    if (step === undefined) continue;
    const previous = dates.get(step);
    if (!previous || Date.parse(entry.occurred_at) < Date.parse(previous)) dates.set(step, entry.occurred_at);
  }

  return (
    <ol aria-label="ความคืบหน้าใบสมัคร" className="grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-6">
      {progressSteps.map((label, index) => (
        <li key={label} aria-current={index === current ? 'step' : undefined}
          className={`border-t-2 pt-2 text-xs ${index <= current ? 'border-primary text-ink' : 'border-border text-ink-soft'} ${index === current ? 'font-semibold' : ''}`}>
          {label}
          {dates.has(index) && <span className="mt-1 block font-normal text-ink-soft">{formatDate(dates.get(index)!)}</span>}
        </li>
      ))}
    </ol>
  );
}
