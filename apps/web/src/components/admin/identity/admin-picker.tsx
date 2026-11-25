import { useEffect, useState } from 'react';
import type { AdminUserListItem, Paginated } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { FilterSelect } from '@/components/admin/filter-fields';
import { allPages } from '@/lib/list';

export function AdminPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { request } = useAuth();
  const [users, setUsers] = useState<AdminUserListItem[]>([]);
  const [retry, setRetry] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    allPages((page) =>
      request<Paginated<AdminUserListItem>>(`/admin/users?role=PLATFORM_ADMIN&page_size=100&page=${page}`),
    ).then(
      (rows) => {
        if (active) {
          setUsers(rows);
          setFailed(false);
        }
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [request, retry]);
  const counts = new Map<string, number>();
  for (const { full_name } of users) counts.set(full_name, (counts.get(full_name) ?? 0) + 1);
  const options: Array<[string, string]> = [['', 'ผู้ดูแลทั้งหมด']];
  if (value && !users.some((user) => user.id === value)) options.push([value, value]);
  for (const user of users)
    options.push([
      user.id,
      counts.get(user.full_name) === 1 ? user.full_name : `${user.full_name} (${user.email})`,
    ]);
  return (
    <div className="min-w-0">
      <FilterSelect label="ผู้ดูแล" value={value} options={options} onChange={onChange} />
      {failed && (
        <button type="button" onClick={() => setRetry((n) => n + 1)} className="text-sm text-primary">
          โหลดผู้ดูแลอีกครั้ง
        </button>
      )}
    </div>
  );
}
