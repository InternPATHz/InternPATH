import type { ConductReportCategory, ConductReportStatus } from '@internpath/contracts';
import type { StatusTone } from '@/components/ui/status-badge';

/** หมวดรายงานพฤติกรรมนักศึกษาจากบริษัท (ตรงกับ enum ของ Lifecycle) */
export const CONDUCT_CATEGORY_LABEL: Record<ConductReportCategory, string> = {
  ATTENDANCE: 'การมาทำงาน / ตรงต่อเวลา',
  BEHAVIOR: 'ความประพฤติ',
  PERFORMANCE: 'ผลการทำงาน',
  SAFETY: 'ความปลอดภัย / ฝ่าฝืนกฎบริษัท',
  OTHER: 'อื่น ๆ',
};

export const CONDUCT_STATUS_VIEW: Record<ConductReportStatus, { label: string; tone: StatusTone }> = {
  OPEN: { label: 'รออาจารย์รับทราบ', tone: 'warning' },
  ACKNOWLEDGED: { label: 'อาจารย์รับทราบแล้ว', tone: 'success' },
};

/** ความยาวรายละเอียด — ตรงกับ Lifecycle (`CONDUCT_DETAIL_MIN/MAX`) */
export const CONDUCT_DETAIL_MIN = 10;
export const CONDUCT_DETAIL_MAX = 2000;
