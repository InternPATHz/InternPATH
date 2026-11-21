import type { ApplicationStatus, ApplicationStatusChangedPayload } from '@internpath/contracts';

type Channel = 'EMAIL' | 'IN_APP';
type Role = 'student' | 'hr' | 'advisor';

const matrix: Partial<Record<ApplicationStatus, Partial<Record<Role, Channel>>>> = {
  PENDING: { hr: 'EMAIL' },
  HR_ACCEPTED: { student: 'EMAIL' },
  ADVISOR_PENDING: { hr: 'IN_APP', advisor: 'EMAIL' },
  ADVISOR_APPROVED: { student: 'EMAIL', hr: 'EMAIL' },
  IN_PROGRESS: { student: 'EMAIL', advisor: 'IN_APP' },
  EVALUATED_PASS: { student: 'EMAIL', advisor: 'IN_APP' },
  EVALUATED_FAIL: { student: 'EMAIL', advisor: 'EMAIL' },
  FAIL_DISPUTED: { hr: 'IN_APP', advisor: 'EMAIL' },
  REEVALUATION_REQUESTED: { student: 'IN_APP', hr: 'EMAIL' },
  COMPLETED: { student: 'IN_APP', hr: 'IN_APP', advisor: 'IN_APP' },
  NO_EVALUATION: { student: 'IN_APP', hr: 'IN_APP', advisor: 'IN_APP' },
  TERMINATED: { student: 'EMAIL', hr: 'EMAIL', advisor: 'EMAIL' },
  HR_REJECTED: { student: 'EMAIL' },
  ADVISOR_REJECTED: { student: 'EMAIL', hr: 'IN_APP' },
  OFFER_RESCINDED: { student: 'EMAIL' },
  CANCELLED: { student: 'EMAIL', advisor: 'IN_APP' },
  STUDENT_DECLINED: { hr: 'IN_APP' },
  WITHDRAWN: { hr: 'IN_APP' },
  EXPIRED: { student: 'IN_APP', hr: 'IN_APP' },
};

export function applicationChannels(payload: ApplicationStatusChangedPayload) {
  const channels = { ...matrix[payload.to_status] };
  const reachedAdvisor =
    payload.from_status === 'ADVISOR_PENDING' || payload.from_status === 'ADVISOR_APPROVED';
  if (
    (payload.to_status === 'OFFER_RESCINDED' || payload.to_status === 'WITHDRAWN') &&
    reachedAdvisor
  ) {
    channels.advisor = 'IN_APP';
  }
  if (payload.to_status === 'EXPIRED' && payload.from_status === 'ADVISOR_APPROVED')
    channels.advisor = 'IN_APP';
  return channels;
}
