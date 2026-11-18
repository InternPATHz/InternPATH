import type { ReminderDuePayload, ReminderType } from '@internpath/contracts';
import { formatDate } from '../../modules/applications/application-view';

/** E14 `ReminderDue` (lifecycle → notification) — event-contract E14 */
export const REMINDER_DUE = 'ReminderDue';

export interface ReminderDueInput {
  reminderType: ReminderType;
  applicationId: string;
  dueDate: Date;
  audience: ReminderDuePayload['audience'];
  daysOverdue: number;
  deadlineAt?: string;
}

/**
 * ใส่แค่ `user_id` + `role` ของผู้รับ (ห้ามมีชื่อ/อีเมล — README §5.11)
 * `entity_type = APPLICATION` ทุกชนิด (เตือนออกใบรับรองก็ยังไม่มีใบ — อ้างใบสมัคร)
 */
export function buildReminderDue(input: ReminderDueInput): ReminderDuePayload {
  return {
    reminder_type: input.reminderType,
    entity_type: 'APPLICATION',
    entity_id: input.applicationId,
    due_date: formatDate(input.dueDate) as string,
    audience: input.audience.map((a) => ({ user_id: a.user_id, role: a.role })),
    context: {
      application_id: input.applicationId,
      days_overdue: Math.max(0, input.daysOverdue),
      ...(input.deadlineAt ? { deadline_at: input.deadlineAt } : {}),
    },
  };
}
