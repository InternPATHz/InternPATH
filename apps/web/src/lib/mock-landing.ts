import type { DirectoryCompanyListItem, JobCategory, JobObject } from '@internpath/contracts';

/**
 * ข้อมูลตัวอย่างสำหรับหน้าแรก (MOCK) — ใช้ชั่วคราวจนกว่า Job Search (Job Management) และ Company Directory (Identity)
 * จะเปิดให้เรียกโดยไม่ต้องล็อกอิน ชนิดข้อมูลอ้างอิง `@internpath/contracts` เพื่อให้เปลี่ยนไปใช้ API จริงได้โดยไม่ต้องแก้หน้าจอ
 */
export type LandingJob = {
  job: Pick<JobObject, 'id' | 'category' | 'job_title' | 'work_mode' | 'featured' | 'allowance'> & {
    company: Pick<JobObject['company'], 'name' | 'badges'>;
  };
  rating: Pick<DirectoryCompanyListItem, 'rating_avg' | 'review_count'>;
};

export const CATEGORIES: Array<{ id: JobCategory; label: string; description: string }> = [
  { id: 'TECH_IT', label: 'Tech & IT', description: 'ซอฟต์แวร์ · ข้อมูล · UX' },
  { id: 'BUSINESS_MARKETING', label: 'Business & Marketing', description: 'การตลาด · คอนเทนต์ · ธุรกิจ' },
  { id: 'CORPORATE_SERVICES', label: 'Corporate Services', description: 'บุคคล · บริการ · ธุรการ' },
];

export const MOCK_JOBS: LandingJob[] = [
  {
    job: {
      id: 'mock-job-1', category: 'TECH_IT', job_title: 'Software Engineer Intern', work_mode: 'HYBRID', featured: true,
      allowance: { type: 'AMOUNT', amount_thb: 300, text: '300 บาท/วัน' },
      company: { name: 'บริษัท โนวาเทค จำกัด', badges: ['Verified by Platform', 'University Partner'] },
    },
    rating: { rating_avg: 4.6, review_count: 12 },
  },
  {
    job: {
      id: 'mock-job-3', category: 'BUSINESS_MARKETING', job_title: 'Digital Marketing Intern', work_mode: 'ONSITE', featured: false,
      allowance: { type: 'NONE', text: 'ไม่มีค่าตอบแทน' },
      company: { name: 'บริษัท ไบรท์วิชั่น จำกัด', badges: ['Verified by Platform'] },
    },
    rating: { rating_avg: 0, review_count: 0 },
  },
  {
    job: {
      id: 'mock-job-4', category: 'CORPORATE_SERVICES', job_title: 'HR Operations Intern', work_mode: 'ONSITE', featured: false,
      allowance: { type: 'AMOUNT', amount_thb: 250, text: '250 บาท/วัน' },
      company: { name: 'บริษัท เดลต้าอินโน จำกัด', badges: ['Verified by Platform', 'University Partner'] },
    },
    rating: { rating_avg: 4.3, review_count: 8 },
  },
];
