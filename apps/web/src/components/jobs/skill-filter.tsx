'use client';

import { ChevronDown, Search } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { JobTag } from '@internpath/contracts';
import { filterPill } from '@/components/search/catalog-filters';
import { MAX_SEARCH_TAGS } from '@/lib/job-search';

export function SkillFilter({ tags, failed, selected, toggle }: {
  tags: JobTag[] | null; failed: boolean; selected: string[]; toggle: (slug: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const panel = useId();
  useEffect(() => {
    if (!open) return;
    input.current?.focus({ preventScroll: true });
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  const needle = term.trim().toLowerCase();
  const matches = tags?.filter(({ name, slug }) => name.toLowerCase().includes(needle) || slug.includes(needle));
  return (
    <div ref={container} className="relative hidden lg:block"
      onBlur={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
      onKeyDown={(event) => {
        if (open && event.key === 'Escape') {
          event.preventDefault();
          setOpen(false);
          trigger.current?.focus({ preventScroll: true });
        }
      }}>
      <button type="button" ref={trigger} aria-expanded={open} aria-controls={panel}
        className={`${filterPill(!!selected.length)} inline-flex items-center gap-1.5`}
        onClick={() => { setTerm(''); setOpen(!open); }}>
        ทักษะ{selected.length > 0 && ` (${selected.length})`}<ChevronDown aria-hidden="true" size={14} />
      </button>
      {open && <div id={panel} role="group" aria-label="เลือกทักษะ"
        className="absolute right-0 z-30 mt-2 w-80 rounded-xl border border-border bg-surface p-3 text-sm shadow-lg xl:left-0 xl:right-auto">
        <label className="relative block">
          <Search size={16} aria-hidden="true" className="absolute left-3 top-3 text-ink-soft" />
          <input type="search" ref={input} aria-label="ค้นหาทักษะ" placeholder="ค้นหาทักษะ" value={term}
            onChange={(event) => setTerm(event.target.value)}
            className="w-full rounded-lg border border-border bg-surface-muted py-2 pl-9 pr-3 focus:border-primary" />
        </label>
        <div className="my-2 max-h-[min(15rem,40vh)] space-y-1 overflow-y-auto overscroll-contain">
          {failed ? <p role="status">โหลดรายการทักษะไม่สำเร็จ</p> : !matches ? <p role="status">กำลังโหลดทักษะ…</p>
            : !matches.length ? <p role="status">{tags?.length ? 'ไม่พบทักษะที่ค้นหา' : 'ยังไม่มีทักษะให้เลือก'}</p>
            : matches.map(({ slug, name }) => {
              const checked = selected.includes(slug);
              return (
                <label key={slug} className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-surface-muted has-[:checked]:bg-primary-soft has-[:disabled]:text-ink-soft">
                  <input type="checkbox" checked={checked} disabled={!checked && selected.length >= MAX_SEARCH_TAGS}
                    onChange={() => toggle(slug)} className="mt-1 shrink-0 accent-primary" />
                  <span className="min-w-0 [overflow-wrap:anywhere]">{name}</span>
                </label>
              );
            })}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border pt-2 text-xs text-ink-soft">
          <span>ตรงกับทักษะใดก็ได้ที่เลือก</span><span aria-live="polite">เลือก {selected.length} จาก {MAX_SEARCH_TAGS}</span>
        </div>
      </div>}
    </div>
  );
}
