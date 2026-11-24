import type { ApplicationStatus, HrApplicationDetail } from '@internpath/contracts';
import { formatDate, formatDateTime } from '@/components/student/application-ui';
import { APPLICATION_STATUS, statusView } from '@/lib/status-map';

const steps = ['สมัคร', 'ส่งข้อเสนอ', 'นักศึกษายืนยัน', 'อาจารย์อนุมัติ', 'ฝึกงาน', 'ประเมินผล'];
const stage: Partial<Record<ApplicationStatus, number>> = {
  PENDING: 0, HR_ACCEPTED: 1, ADVISOR_PENDING: 2, ADVISOR_APPROVED: 3, IN_PROGRESS: 4,
  EVALUATED_PASS: 5, EVALUATED_FAIL: 5, FAIL_DISPUTED: 5, REEVALUATION_REQUESTED: 5, COMPLETED: 5, NO_EVALUATION: 5,
};

export function ApplicantProgress({ status }: { status: ApplicationStatus }) {
  const current = stage[status];
  if (current === undefined) return null;
  return (
    <ol aria-label="ความคืบหน้าใบสมัคร" className="mt-4 grid grid-cols-3 gap-y-4 rounded-xl border border-border bg-surface p-4 text-center text-xs sm:grid-cols-6">
      {steps.map((label, index) => (
        <li key={label} aria-current={index === current ? 'step' : undefined}
          className={index <= current ? 'font-semibold text-ink' : 'text-ink-soft'}>
          <span aria-hidden="true" className="relative mb-1.5 block">
            <span className="absolute inset-x-0 top-1/2 border-t border-border" />
            <span className={`relative mx-auto block h-3 w-3 rounded-full border-2 ${index === current ? 'border-ink bg-surface' : index < current ? 'border-ink bg-ink' : 'border-border bg-surface'}`} />
          </span>
          {label}
        </li>
      ))}
    </ol>
  );
}

export function ApplicantTrainingPeriod({ actualStart, plannedEnd, today, canEvaluate }: {
  actualStart?: string; plannedEnd?: string; today: string; canEvaluate: boolean;
}) {
  if (!actualStart || !plannedEnd) return null;
  const from = Date.parse(actualStart);
  const end = Date.parse(plannedEnd);
  const now = Date.parse(today);
  const day = 86_400_000;
  const duration = Math.floor((end - from) / day) + 1;
  if (!Number.isFinite(duration) || duration < 1 || !Number.isFinite(now) || now < from) return null;
  const elapsed = Math.min(duration, Math.floor((now - from) / day) + 1);
  return (
    <section aria-labelledby="applicant-training-week" className="rounded-xl bg-tile p-5 text-white">
      <p className="text-sm text-white/75">ช่วงฝึกงาน</p>
      <h2 id="applicant-training-week" className="mt-1 text-xl font-semibold">สัปดาห์ที่ {Math.ceil(elapsed / 7)} จาก {Math.ceil(duration / 7)}</h2>
      <p className="mt-2 text-sm text-white/80">เริ่มงานจริง {formatDate(actualStart)} · สิ้นสุดตามข้อเสนอ {formatDate(plannedEnd)}</p>
      <progress aria-label="จำนวนวันที่ผ่านไปในช่วงฝึกงาน" value={elapsed} max={duration} className="mt-4 block h-2 w-full appearance-none overflow-hidden rounded-full bg-white/25 [&::-moz-progress-bar]:bg-white [&::-webkit-progress-bar]:bg-white/25 [&::-webkit-progress-value]:bg-white" />
      {canEvaluate && <a href="#actions-title" className="mt-3 inline-block text-sm font-medium text-primary-on-dark hover:underline">ไปที่การประเมินผล ›</a>}
    </section>
  );
}

export function ApplicantHistory({ app }: { app: HrApplicationDetail }) {
  const entries = [{ label: 'ส่งใบสมัคร', date: app.created_at, dateOnly: false }];
  if (app.actual_start_date) entries.push({ label: 'เริ่มฝึกงานจริง', date: app.actual_start_date, dateOnly: true });
  if (app.actual_end_date) entries.push({ label: 'สิ้นสุดการฝึกงานจริง', date: app.actual_end_date, dateOnly: true });
  if (app.evaluation) {
    entries.push({ label: app.evaluation.result === 'PASS' ? 'บริษัทประเมินผ่าน' : 'บริษัทประเมินไม่ผ่าน', date: app.evaluation.evaluated_at, dateOnly: false });
  }
  if (app.status !== 'PENDING' || app.status_changed_at !== app.created_at) {
    entries.push({ label: `สถานะล่าสุด · ${statusView(APPLICATION_STATUS, app.status).label}`, date: app.status_changed_at, dateOnly: false });
  }
  entries.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  return (
    <aside aria-label="ประวัติใบสมัคร" className="self-start rounded-xl border border-border bg-surface p-5">
      <h2 className="text-lg font-semibold">ประวัติ</h2>
      <ol className="mt-3 space-y-3 border-l border-border pl-4 text-sm">
        {entries.map(({ label, date, dateOnly }) => (
          <li key={label}>
            <p className="font-medium">{label}</p>
            <time dateTime={date} className="text-xs text-ink-soft">{dateOnly ? formatDate(date) : formatDateTime(date)}</time>
          </li>
        ))}
      </ol>
    </aside>
  );
}
