// Carry only list filters into a detail link. Its return path always belongs to the same catalog.
type Catalog = '/jobs' | '/companies';

export function catalogHref(list: Catalog, params: URLSearchParams, itemId?: string) {
  const keys = list === '/jobs'
    ? ['q', 'category', 'work_mode', 'allowance', 'tags', 'major', 'company_id', 'sort', 'page']
    : ['q', 'category', 'partner', 'page'];
  const query = new URLSearchParams();
  if (itemId) query.set('id', itemId);
  for (const key of keys) {
    const value = params.get(key);
    if (value) query.set(key, value);
  }
  const path = itemId ? `${list}/item` : list;
  return query.size ? `${path}?${query}` : path;
}

export function filterHref(path: string, search: string, changes: Record<string, string | undefined>, keepPage = false) {
  const next = new URLSearchParams(search);
  for (const [key, value] of Object.entries(changes)) {
    if (value) next.set(key, value);
    else next.delete(key);
  }
  if (!keepPage) next.delete('page');
  return next.size ? `${path}?${next}` : path;
}
