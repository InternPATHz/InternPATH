'use client';

import { useEffect, useState } from 'react';
import type { AdminCompanyListItem, Paginated } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { allPages } from '@/lib/list';

export function CompanyPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { request } = useAuth();
  const [term, setTerm] = useState('');
  const [items, setItems] = useState<AdminCompanyListItem[] | null>(null);
  const [retry, setRetry] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setFailed(false);
    allPages<AdminCompanyListItem>((page) =>
      request<Paginated<AdminCompanyListItem>>(`/admin/companies?page=${page}&page_size=100`),
    ).then(
      (data) => {
        if (active) setItems(data);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [request, retry]);
  const search = term.trim().toLowerCase();
  const matches = items?.filter(
    (company) => company.name.toLowerCase().includes(search) || company.registration_no.includes(search),
  );
  return (
    <div className="grid min-w-0 gap-1 text-sm">
      <label>
        ค้นบริษัทจากชื่อหรือเลขทะเบียน
        <input
          type="search"
          value={term}
          onChange={(e) => {
            setTerm(e.target.value);
            onChange('');
          }}
          className="mt-1 block w-full rounded-lg border border-border px-3 py-2"
        />
      </label>
      {failed ? (
        <button type="button" className="text-left text-primary" onClick={() => setRetry((n) => n + 1)}>
          โหลดรายชื่อบริษัทอีกครั้ง
        </button>
      ) : (
        <select
          aria-label="เลือกบริษัท"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-lg border border-border p-2"
        >
          <option value="">{!matches ? 'กำลังโหลดบริษัท…' : matches.length ? 'เลือกบริษัท' : 'ไม่พบบริษัท'}</option>
          {matches?.map((company) => (
            <option key={company.id} value={company.id}>
              {company.name} · {company.registration_no}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
