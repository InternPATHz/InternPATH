// ต้องตรงกับ docs/event-contract.md (E05)

/** E05 `CompanyStatusChanged` (identity → job, lifecycle, verification, notification) */
export interface CompanyStatusChangedPayload {
  company_id: string;
  status: 'PENDING' | 'NEED_MORE_INFO' | 'VERIFIED' | 'REJECTED' | 'SUSPENDED';
  previous_status?: string;
  snapshot: { name: string; logo_key?: string; university_partner: boolean; verified_badge: boolean };
  owner_user_id?: string;
  reason?: string;
  entity_version: number;
  changed_at: string;
}
