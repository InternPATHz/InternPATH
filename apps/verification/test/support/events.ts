import { randomUUID } from 'node:crypto';
import type {
  CompanyStatusChangedPayload,
  EventEnvelope,
  JobStatusChangedPayload,
  JobSubmittedPayload,
} from '@internpath/contracts';

export const LONG = 'พัฒนาเว็บแอปพลิเคชันร่วมกับทีมวิศวกรอาวุโสและเรียนรู้กระบวนการทำงานจริงของบริษัท '.repeat(2);
export const PHONE = ' โทร 081-234-5678';

export function submitted(
  over: Partial<JobSubmittedPayload> = {},
  content: Partial<JobSubmittedPayload['content']> = {},
): JobSubmittedPayload {
  return {
    job_id: randomUUID(),
    company_id: randomUUID(),
    submission_id: randomUUID(),
    submission_kind: 'NEW',
    content: {
      job_title: 'นักศึกษาฝึกงานด้านพัฒนาซอฟต์แวร์',
      description: LONG,
      responsibilities: 'เขียนโค้ดและทดสอบ',
      qualifications: 'กำลังศึกษาด้านคอมพิวเตอร์',
      allowance_text: 'เบี้ยเลี้ยงรายเดือน',
      location: 'กรุงเทพฯ',
      ...content,
    },
    work_mode: 'HYBRID',
    hours_per_week: 35,
    allowance: { type: 'AMOUNT', amount_thb: 5000 },
    company_flag_under_review: false,
    fast_track: false,
    submitted_at: new Date().toISOString(),
    ...over,
  };
}

export function envelope<T extends string, P>(type: T, payload: P, producer: 'job' | 'identity' = 'job'): EventEnvelope<T, P> {
  return {
    event_id: randomUUID(),
    type,
    version: 1,
    occurred_at: new Date().toISOString(),
    correlation_id: randomUUID(),
    producer,
    payload,
  };
}

export const submittedEnv = (p: JobSubmittedPayload) => envelope('JobSubmitted', p);

export function statusChanged(over: Partial<JobStatusChangedPayload> = {}): JobStatusChangedPayload {
  return {
    job_id: randomUUID(),
    company_id: randomUUID(),
    from_status: 'VERIFYING',
    to_status: 'PENDING_REVIEW',
    reason_code: 'VERIFY_TIMEOUT',
    entity_version: 2,
    changed_at: new Date().toISOString(),
    ...over,
  };
}

export function companyChanged(over: Partial<CompanyStatusChangedPayload> = {}): CompanyStatusChangedPayload {
  return {
    company_id: randomUUID(),
    status: 'VERIFIED',
    snapshot: { name: 'บริษัท ตัวอย่าง จำกัด', university_partner: false, verified_badge: true },
    entity_version: 1,
    changed_at: new Date().toISOString(),
    ...over,
  };
}
