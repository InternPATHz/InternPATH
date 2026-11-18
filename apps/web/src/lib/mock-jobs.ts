import type { DirectoryCompanyListItem, JobCategory, SearchJobItem, WorkMode } from '@internpath/contracts';

/**
 * ข้อมูลตัวอย่างของหน้าค้นหางาน (MOCK) — ใช้ชั่วคราวจนกว่า `GET /search/jobs` (Job) และ `GET /directory/companies?ids=` (Identity)
 * จะเปิดใช้ได้โดยไม่ต้องล็อกอิน (api-contract §5.2, §4.4) ชนิดข้อมูลตรงกับ `@internpath/contracts` เพื่อสลับไป API จริงได้โดยไม่แก้หน้าจอ
 * ทั้งหมดเป็นสถานะ `PUBLISHED` เพราะ Search ส่งเฉพาะประกาศที่เผยแพร่แล้ว
 */

const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();
const day = (offsetDays: number) => iso(offsetDays).slice(0, 10);

type Seed = {
  id: string;
  company: number;
  category: JobCategory;
  title: string;
  workMode: WorkMode;
  location: string;
  allowance: number | null;
  majors: string[];
  quota: [available: number, total: number];
  publishedDaysAgo: number;
  deadlineInDays: number;
  featured?: boolean;
  summary: string;
};

export const MOCK_COMPANIES: Array<{ id: string; name: string; badges: string[]; rating: Pick<DirectoryCompanyListItem, 'rating_avg' | 'review_count'> }> = [
  { id: 'mock-co-1', name: 'บริษัท โนวาเทค จำกัด', badges: ['Verified by Platform', 'University Partner'], rating: { rating_avg: 4.6, review_count: 12 } },
  { id: 'mock-co-2', name: 'บริษัท ไบรท์วิชั่น จำกัด', badges: ['Verified by Platform'], rating: { rating_avg: 0, review_count: 0 } },
  { id: 'mock-co-3', name: 'บริษัท เดลต้าอินโน จำกัด', badges: ['Verified by Platform', 'University Partner'], rating: { rating_avg: 4.3, review_count: 8 } },
  { id: 'mock-co-4', name: 'บริษัท ไพน์ดาต้า จำกัด', badges: ['Verified by Platform'], rating: { rating_avg: 3.9, review_count: 5 } },
  { id: 'mock-co-5', name: 'บริษัท ซันไรส์ครีเอทีฟ จำกัด', badges: ['Verified by Platform'], rating: { rating_avg: 4.1, review_count: 3 } },
];

const SEEDS: Seed[] = [
  { id: 'mock-job-1', company: 0, category: 'TECH_IT', title: 'Software Engineer Intern', workMode: 'HYBRID', location: 'กรุงเทพมหานคร', allowance: 300, majors: ['วิทยาการคอมพิวเตอร์', 'วิศวกรรมคอมพิวเตอร์'], quota: [2, 3], publishedDaysAgo: 2, deadlineInDays: 20, featured: true, summary: 'พัฒนาฟีเจอร์ฝั่ง Web ร่วมกับทีมวิศวกร พร้อมพี่เลี้ยงประจำตลอดการฝึก' },
  { id: 'mock-job-2', company: 3, category: 'TECH_IT', title: 'Data Analyst Intern', workMode: 'ONSITE', location: 'นนทบุรี', allowance: 250, majors: ['สถิติ', 'วิทยาการข้อมูล', 'วิทยาการคอมพิวเตอร์'], quota: [1, 2], publishedDaysAgo: 5, deadlineInDays: 12, summary: 'ทำความสะอาดข้อมูลและสร้างแดชบอร์ดสรุปผลให้ทีมธุรกิจ' },
  { id: 'mock-job-3', company: 1, category: 'BUSINESS_MARKETING', title: 'Digital Marketing Intern', workMode: 'ONSITE', location: 'กรุงเทพมหานคร', allowance: null, majors: ['การตลาด', 'นิเทศศาสตร์'], quota: [3, 3], publishedDaysAgo: 1, deadlineInDays: 28, summary: 'ช่วยวางแผนแคมเปญออนไลน์และรายงานผลรายสัปดาห์' },
  { id: 'mock-job-4', company: 2, category: 'CORPORATE_SERVICES', title: 'HR Operations Intern', workMode: 'ONSITE', location: 'ปทุมธานี', allowance: 250, majors: ['การจัดการทรัพยากรมนุษย์', 'บริหารธุรกิจ'], quota: [1, 1], publishedDaysAgo: 8, deadlineInDays: 6, summary: 'สนับสนุนงานสรรหา จัดเตรียมเอกสารจ้างงาน และงานธุรการบุคคล' },
  { id: 'mock-job-5', company: 0, category: 'TECH_IT', title: 'UX/UI Design Intern', workMode: 'REMOTE', location: 'ทำงานทางไกล', allowance: 200, majors: ['ออกแบบสื่อสาร', 'วิทยาการคอมพิวเตอร์'], quota: [2, 2], publishedDaysAgo: 3, deadlineInDays: 15, summary: 'ออกแบบหน้าจอและทดสอบต้นแบบกับผู้ใช้จริงร่วมกับทีมผลิตภัณฑ์' },
  { id: 'mock-job-6', company: 4, category: 'BUSINESS_MARKETING', title: 'Content Creator Intern', workMode: 'HYBRID', location: 'กรุงเทพมหานคร', allowance: 150, majors: ['นิเทศศาสตร์', 'ภาษาไทย'], quota: [2, 4], publishedDaysAgo: 6, deadlineInDays: 25, featured: true, summary: 'เขียนบทความและผลิตคลิปสั้นสำหรับช่องทางโซเชียลของลูกค้า' },
  { id: 'mock-job-7', company: 3, category: 'TECH_IT', title: 'Machine Learning Intern', workMode: 'HYBRID', location: 'นนทบุรี', allowance: 350, majors: ['วิทยาการข้อมูล', 'วิทยาการคอมพิวเตอร์'], quota: [1, 1], publishedDaysAgo: 10, deadlineInDays: 9, summary: 'ทดลองโมเดลจำแนกข้อความและประเมินผลกับชุดข้อมูลภายใน' },
  { id: 'mock-job-8', company: 2, category: 'CORPORATE_SERVICES', title: 'Accounting Support Intern', workMode: 'ONSITE', location: 'ปทุมธานี', allowance: null, majors: ['การบัญชี'], quota: [2, 2], publishedDaysAgo: 4, deadlineInDays: 18, summary: 'ช่วยบันทึกบัญชีรายวันและตรวจสอบเอกสารประกอบการเบิกจ่าย' },
  { id: 'mock-job-9', company: 1, category: 'BUSINESS_MARKETING', title: 'Business Development Intern', workMode: 'ONSITE', location: 'กรุงเทพมหานคร', allowance: 300, majors: ['บริหารธุรกิจ', 'การตลาด'], quota: [1, 2], publishedDaysAgo: 12, deadlineInDays: 4, summary: 'ศึกษาตลาดคู่แข่งและเตรียมข้อเสนอสำหรับลูกค้าองค์กร' },
  { id: 'mock-job-10', company: 4, category: 'TECH_IT', title: 'QA Tester Intern', workMode: 'REMOTE', location: 'ทำงานทางไกล', allowance: 200, majors: ['วิทยาการคอมพิวเตอร์', 'เทคโนโลยีสารสนเทศ'], quota: [3, 3], publishedDaysAgo: 7, deadlineInDays: 22, summary: 'เขียนกรณีทดสอบและรายงานข้อบกพร่องของแอปพลิเคชันมือถือ' },
  { id: 'mock-job-11', company: 0, category: 'CORPORATE_SERVICES', title: 'Customer Support Intern', workMode: 'HYBRID', location: 'กรุงเทพมหานคร', allowance: 180, majors: ['ภาษาอังกฤษ', 'บริหารธุรกิจ'], quota: [2, 3], publishedDaysAgo: 9, deadlineInDays: 30, summary: 'ตอบคำถามลูกค้าผ่านแชตและอีเมล พร้อมสรุปปัญหาที่พบบ่อย' },
  { id: 'mock-job-12', company: 3, category: 'BUSINESS_MARKETING', title: 'Market Research Intern', workMode: 'ONSITE', location: 'นนทบุรี', allowance: null, majors: ['สถิติ', 'เศรษฐศาสตร์'], quota: [1, 1], publishedDaysAgo: 14, deadlineInDays: 8, summary: 'รวบรวมและวิเคราะห์ข้อมูลตลาดเพื่อสนับสนุนการตัดสินใจของทีมขาย' },
];

export const MOCK_SEARCH_JOBS: SearchJobItem[] = SEEDS.map((seed) => {
  const company = MOCK_COMPANIES[seed.company];
  return {
    id: seed.id,
    company: { id: company.id, name: company.name, badges: company.badges },
    category: seed.category,
    job_title: seed.title,
    description: seed.summary,
    responsibilities: seed.summary,
    qualifications: `นักศึกษาสาขา${seed.majors.join(' หรือ ')} ชั้นปี 3 ขึ้นไป`,
    allowance: seed.allowance === null
      ? { type: 'NONE', text: 'ไม่มีค่าตอบแทน' }
      : { type: 'AMOUNT', amount_thb: seed.allowance, text: `${seed.allowance} บาท/วัน` },
    location: seed.location,
    work_mode: seed.workMode,
    hours_per_week: 40,
    period: { start: day(60), end: day(150) },
    target_majors: seed.majors,
    quota: seed.quota[1],
    quota_available: seed.quota[0],
    application_deadline: day(seed.deadlineInDays),
    status: 'PUBLISHED',
    featured: seed.featured ?? false,
    published_at: iso(-seed.publishedDaysAgo),
  };
});
