import type { NotificationItem, Paginated, UnreadCountResponse } from '@internpath/contracts';

/** ชั้นเรียกข้อมูลศูนย์แจ้งเตือน In-App (api-contract §8) — Notification Service ผ่าน Gateway */

type Request = <T>(path: string, init?: { method?: 'GET' | 'POST'; body?: unknown }) => Promise<T>;

export interface NotificationsApi {
  list(page: number, pageSize: number, unreadOnly: boolean): Promise<Paginated<NotificationItem>>;
  unreadCount(): Promise<number>;
  markRead(id: string): Promise<void>;
  markAllRead(): Promise<void>;
}

export function notificationsApi(request: Request): NotificationsApi {
  return {
    list: (page, pageSize, unreadOnly) =>
      request<Paginated<NotificationItem>>(`/notifications?page=${page}&page_size=${pageSize}${unreadOnly ? '&unread=true' : ''}`),
    unreadCount: async () => (await request<UnreadCountResponse>('/notifications/unread-count')).count,
    markRead: async (id) => { await request<void>(`/notifications/${encodeURIComponent(id)}/actions/read`, { method: 'POST' }); },
    markAllRead: async () => { await request<void>('/notifications/actions/read-all', { method: 'POST' }); },
  };
}
