/** ชื่ออ่านง่ายของ action/target_type ที่ Verification เขียนลง `admin_audit_log` — ค่าที่ไม่รู้จักแสดงรหัสเดิม */
export const ACTION_LABEL: Record<string, string> = {
  QUEUE_APPROVE: 'อนุมัติประกาศ (คิว)',
  QUEUE_REJECT: 'ปฏิเสธประกาศ (คิว)',
  REPORT_DISMISS: 'ยกเลิกรายงานประกาศ',
  REPORT_UPHOLD: 'ยืนยันรายงานประกาศ',
  REVIEW_PUBLISH: 'เผยแพร่/คงรีวิว',
  REVIEW_REMOVE: 'ลบรีวิว',
  FLAG_SET: 'ตั้งธงบริษัท',
  FLAG_CLEAR: 'เคลียร์ธงบริษัท',
  BLACKLIST_CREATE: 'เพิ่มคำต้องห้าม',
  BLACKLIST_UPDATE: 'แก้ไขคำต้องห้าม',
  BLACKLIST_DELETE: 'ลบคำต้องห้าม',
  RISK_RULES_UPDATE: 'แก้กฎคะแนนความเสี่ยง',
};

export const TARGET_LABEL: Record<string, string> = {
  queue_item: 'รายการคิว',
  job: 'ประกาศงาน',
  company: 'บริษัท',
  company_flag: 'ธงบริษัท',
  review: 'รีวิว',
  blacklist_term: 'คำต้องห้าม',
  risk_rules: 'กฎคะแนนความเสี่ยง',
};

export const actionLabel = (code: string): string => ACTION_LABEL[code] ?? code;
export const targetLabel = (code: string): string => TARGET_LABEL[code] ?? code;

/** วันที่ (YYYY-MM-DD) → ช่วงเวลาไทย (+07:00) สำหรับ `from`/`to` ของ API */
export const startOfDay = (date: string): string => `${date}T00:00:00.000+07:00`;
export const endOfDay = (date: string): string => `${date}T23:59:59.999+07:00`;
