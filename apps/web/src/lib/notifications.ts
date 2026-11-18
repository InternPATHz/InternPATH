import type { NotificationItem, Paginated, UnreadCountResponse } from '@internpath/contracts';

/**
 * ชั้นเรียกข้อมูลศูนย์แจ้งเตือน (api-contract §8)
 * ตอนนี้ใช้ข้อมูลจำลอง (MOCK) เพราะ Notification-A (API In-App) ยังไม่เปิด — ตั้ง `NEXT_PUBLIC_NOTIFICATIONS_MOCK=false` เพื่อสลับไปเรียก API จริง
 * ข้อมูลจำลองเก็บใน localStorage ของเบราว์เซอร์ (เฉพาะตอนพัฒนา)
 */
export const NOTIFICATIONS_MOCK = process.env.NEXT_PUBLIC_NOTIFICATIONS_MOCK !== 'false';

type Request = <T>(path: string, init?: { method?: 'GET' | 'POST'; body?: unknown }) => Promise<T>;

export interface NotificationsApi {
  list(page: number, pageSize: number, unreadOnly: boolean): Promise<Paginated<NotificationItem>>;
  unreadCount(): Promise<number>;
  markRead(id: string): Promise<void>;
  markAllRead(): Promise<void>;
}

function realApi(request: Request): NotificationsApi {
  return {
    list: (page, pageSize, unreadOnly) =>
      request<Paginated<NotificationItem>>(`/notifications?page=${page}&page_size=${pageSize}${unreadOnly ? '&unread=true' : ''}`),
    unreadCount: async () => (await request<UnreadCountResponse>('/notifications/unread-count')).count,
    markRead: async (id) => { await request<void>(`/notifications/${encodeURIComponent(id)}/actions/read`, { method: 'POST' }); },
    markAllRead: async () => { await request<void>('/notifications/actions/read-all', { method: 'POST' }); },
  };
}

// ---------------------------------------------------------------- ข้อมูลจำลอง

const STORAGE_KEY = 'internpath.mock.notifications';
let memory: NotificationItem[] | null = null;

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function seed(): NotificationItem[] {
  return [
    { id: 'mock-n-1', type: 'APPLICATION_STATUS_CHANGED', title: 'บริษัทตอบรับใบสมัครของคุณ', body: 'บริษัท ตัวอย่าง จำกัด ส่งข้อเสนอให้คุณแล้ว กรุณายืนยันภายใน 3 วัน', link: '/student/applications', read: false, created_at: ago(15) },
    { id: 'mock-n-2', type: 'JOB_STATUS_CHANGED', title: 'ประกาศของคุณผ่านการตรวจสอบ', body: 'ประกาศ Frontend Developer Intern เปิดรับสมัครแล้ว', link: '/hr/jobs', read: false, created_at: ago(90) },
    { id: 'mock-n-3', type: 'CERTIFICATE_ISSUED', title: 'คุณได้รับ E-Certificate', body: 'ดาวน์โหลดใบรับรองการฝึกงานได้จากหน้าใบรับรองของคุณ', read: true, created_at: ago(60 * 26) },
    { id: 'mock-n-4', type: 'REMINDER_DUE', title: 'ใกล้ครบกำหนดตอบกลับ', body: 'มีผู้สมัครรอการพิจารณาจากคุณมากกว่า 2 วันแล้ว', link: '/hr/applicants', read: true, created_at: ago(60 * 50) },
  ];
}

function all(): NotificationItem[] {
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    memory = raw ? (JSON.parse(raw) as NotificationItem[]) : seed();
  } catch { memory = seed(); }
  return memory;
}

function save(items: NotificationItem[]) {
  memory = items;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); } catch { /* ใช้หน่วยความจำต่อ */ }
}

const delay = () => new Promise((resolve) => setTimeout(resolve, 150));
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function mockApi(): NotificationsApi {
  return {
    async list(page, pageSize, unreadOnly) {
      await delay();
      const items = all().filter((item) => !unreadOnly || !item.read).sort((a, b) => b.created_at.localeCompare(a.created_at));
      return { data: copy(items.slice((page - 1) * pageSize, page * pageSize)), meta: { page, page_size: pageSize, total: items.length } };
    },
    async unreadCount() { await delay(); return all().filter((item) => !item.read).length; },
    async markRead(id) { await delay(); save(all().map((item) => (item.id === id ? { ...item, read: true } : item))); },
    async markAllRead() { await delay(); save(all().map((item) => ({ ...item, read: true }))); },
  };
}

export function notificationsApi(request: Request): NotificationsApi {
  return NOTIFICATIONS_MOCK ? mockApi() : realApi(request);
}
