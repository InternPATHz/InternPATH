// ต้องตรงกับ docs/api-contract.md §1-§2 — ฟิลด์ snake_case ทุกตัว, เวลา ISO-8601 UTC

/** Pagination มาตรฐาน: `?page=1&page_size=20` (page_size สูงสุด 100) */
export interface PageQuery {
  page?: number;
  page_size?: number;
  /** เช่น `-created_at` */
  sort?: string;
}

export interface PageMeta {
  page: number;
  page_size: number;
  total: number;
}

/** รายการห่อด้วย `data` + `meta` (ข้อมูลเดี่ยวส่งตรง ไม่ห่อ) */
export interface Paginated<T> {
  data: T[];
  meta: PageMeta;
}

export interface ApiErrorDetail {
  field?: string;
  issue: string;
}

/** รูปแบบ Error เดียวกันทุก Service (§2) */
export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: ApiErrorDetail[];
    correlation_id: string;
  };
}
