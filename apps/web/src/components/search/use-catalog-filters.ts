'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { startTransition, useMemo, useOptimistic } from 'react';
import { filterHref } from '@/lib/catalog-navigation';

export function useCatalogFilters() {
  const pathname = usePathname();
  const params = useSearchParams();
  const [search, setSearch] = useOptimistic(params.toString());
  const searchParams = useMemo(() => new URLSearchParams(search), [search]);

  function update(changes: Record<string, string | undefined>, keepPage = false) {
    const href = filterHref(pathname, window.location.search, changes, keepPage);
    startTransition(() => {
      setSearch(href.split('?')[1] ?? '');
      window.history.replaceState(null, '', href);
    });
  }

  return { pathname, searchParams, update };
}
