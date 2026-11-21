# API Contract (InternPath)

> ที่เก็บหลักของ **REST Endpoint** — path, สิทธิ์, ข้อกำหนดของ Request/Response และรูปแบบ Error
> กฎธุรกิจดู [README.md](../README.md) | Enum/ฟิลด์ดู [data-schema.md](data-schema.md) | Event ดู [event-contract.md](event-contract.md)
> เอกสารนี้ระบุ "สัญญา" ระดับ Endpoint; Schema ละเอียดของ DTO เขียนด้วย `class-validator` + OpenAPI ในโค้ด และต้องไม่ขัดกับเอกสารนี้

---

## 1. ข้อตกลงทั่วไป

| หัวข้อ | ข้อตกลง |
| :--- | :--- |
| Base URL | `/api/v1` (ที่ Gateway) • Endpoint ภายใน `/internal/v1` (**ไม่ผ่าน Gateway**) |
| รูปแบบข้อมูล | JSON (`application/json`), `snake_case` ทุกฟิลด์ • อัปโหลดไฟล์ใช้ `multipart/form-data` |
| Auth | `Authorization: Bearer <JWT>`; Endpoint สาธารณะระบุ **Public** |
| Role | `S` = STUDENT • `H` = COMPANY_HR (`HO` = เฉพาะ Owner) • `A` = ADVISOR • `AD` = PLATFORM_ADMIN • `SVC` = Service Token |
| Header | `X-Correlation-Id` (Gateway สร้างให้), `Idempotency-Key` (ระบุในบาง POST) |
| เวลา | ISO-8601 UTC ในทุก Response (`2026-11-13T08:30:00Z`); วันที่ล้วน `YYYY-MM-DD` |
| Pagination | `?page=1&page_size=20` (สูงสุด 100) → `{ "data": [...], "meta": { "page", "page_size", "total" } }` |
| Sort / Filter | `?sort=-created_at` • `?status=...` • `?q=...` |
| Response สำเร็จ | `200` (อ่าน/แก้) • `201` (สร้าง) • `204` (ไม่มีเนื้อหา) • ข้อมูลเดี่ยวส่งตรง (ไม่ห่อ `data`); รายการห่อด้วย `data` + `meta` |
| การเปลี่ยนสถานะ | ใช้ **Action Endpoint** แบบ `POST /resource/{id}/actions/{action}` (ไม่ใช้ PATCH `status`) |
| Concurrency | Action ที่เปลี่ยนสถานะคืน `409 STATE_CONFLICT` เมื่อสถานะปัจจุบันไม่ตรงเงื่อนไข (มีคนเปลี่ยนไปก่อน) |
| ข้อมูลที่ห้ามส่ง | Response ต้องไม่รั่ว `password_hash`, Token hash, `object_key` ของ Private bucket (ส่งเป็น Signed URL แทน) |

## 2. รูปแบบ Error (ทุก Service เหมือนกัน — `libs/common`)

```json
{
  "error": {
    "code": "QUOTA_FULL",
    "message": "โควตาตำแหน่งเต็มแล้ว",
    "details": [ { "field": "end_date", "issue": "MIN_30_DAYS" } ],
    "correlation_id": "uuid"
  }
}
```

| HTTP | `code` ตัวอย่าง | เมื่อ |
| :-: | :--- | :--- |
| 400 | `VALIDATION_FAILED`, `REASON_REQUIRED`, `FILE_TYPE_NOT_ALLOWED`, `FILE_TOO_LARGE`, `MISSING_REQUIRED_JOB_FIELDS` | Input ไม่ถูกต้อง |
| 401 | `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `ACCOUNT_SUSPENDED`, `EMAIL_NOT_VERIFIED` | ไม่ได้ล็อกอิน/Token เสีย |
| 403 | `FORBIDDEN_ROLE` (รวม HR รายงานรีวิวของบริษัทอื่น และ HR Member นอกสายงาน — `details[].issue` = `FORBIDDEN_CATEGORY`), `NOT_OWNER_OF_RESOURCE`, `COMPANY_NOT_VERIFIED`, `ADVISOR_NOT_LINKED`, `REAPPLY_BLOCKED`, `CONSENT_REQUIRED`, `ALREADY_CONFIRMED_ELSEWHERE` | สิทธิ์/เงื่อนไขธุรกิจไม่ผ่าน |
| 404 | `NOT_FOUND` | ไม่มีทรัพยากร หรือไม่มีสิทธิ์เห็น (ใช้ 404 แทน 403 สำหรับทรัพยากรที่ไม่ควรรู้ว่ามีอยู่) |
| 409 | `STATE_CONFLICT`, `QUOTA_FULL`, `ALREADY_APPLIED`, `ALREADY_REPORTED`, `ALREADY_REVIEWED`, `ALREADY_REPLIED` | ขัดกับสถานะปัจจุบัน |
| 422 | `JOB_NOT_REPORTABLE`, `REVIEW_NOT_REPORTABLE`, `UNSUPPORTED_ITEM_TYPE`, `INVALID_PERIOD_MIN_30_DAYS`, `EVALUATION_NOT_OPEN`, `CERT_MIN_ACTUAL_DAYS`, `DISPUTE_WINDOW_CLOSED`, `DELETION_BLOCKED`, `QUOTA_BELOW_COMMITTED` | กฎธุรกิจไม่ผ่าน |
| 429 | `RATE_LIMITED` | Rate limit (มี `Retry-After`) |

**รหัส error ใหม่:** ใช้เฉพาะ `code` ในตารางนี้ รายละเอียดเฉพาะเหตุการณ์ใส่ใน `details[].issue` (เช่น `STATE_CONFLICT` + `JOB_FROZEN`, `EVALUATION_NOT_OPEN` + `BEFORE_END_DATE`, `NOT_FOUND` + `RESUME_DELETED_BY_STUDENT`) — ถ้าจำเป็นต้องมี `code` ใหม่ ให้เพิ่มในตารางนี้ก่อน (PM ตัดสิน 2026-11-18)
| 502/503/504 | `UPSTREAM_UNAVAILABLE` | Service ปลายทางล่ม |

## 3. การ Route ที่ Gateway

| Path prefix | Service |
| :--- | :--- |
| `/auth/**`, `/.well-known/**`, `/users/**`, `/advisor-links/**`, `/companies/me/**`, `/directory/**`, `/admin/companies/**`, `/admin/advisors/**`, `/admin/students/**`, `/admin/users/**`, `/admin/audit-logs` | identity |
| `/hr/jobs/**`, `/jobs/**`, `/search/**`, `/tags`, `/admin/jobs/**`, `/admin/tags/**` | job |
| `/verification/**`, `/admin/queue/**`, `/admin/flags/**`, `/admin/audit`, `/jobs/{id}/reports`, `/reviews/{id}/reports` | verification |
| `/applications/**`, `/me/**`, `/hr/applications/**`, `/hr/certificates/**`, `/hr/reviews/**`, `/advisor/**`, `/me/certificates/**`, `/companies/{id}/reviews`, `/problem-reports/**`, `/admin/lifecycle/**`, `/public/**` | lifecycle |
| `/notifications/**` | notification |
| `/internal/**` | **ไม่ Route** |

**กฎการจับคู่:** เลือก pattern ที่ **เจาะจงที่สุด (Longest match)** ก่อน — เช่น `/jobs/{id}/reports` ไปที่ verification ทั้งที่ `/jobs/**` เป็นของ job, `/companies/{id}/reviews` ไป lifecycle ทั้งที่ `/companies/me/**` เป็นของ identity, `/reviews/{id}/reports` ไป verification ส่วน `/hr/reviews/**` ไป lifecycle ต้องมีเทสต์ Routing ใน Gateway ครอบคลุมทุกแถวของตารางนี้ (ไม่ให้ path ชนกันเมื่อเพิ่ม Endpoint ใหม่)

Gateway ตรวจ JWT + Denylist + Rate Limit ก่อน forward และเติม `X-User-Id`, `X-User-Role`, `X-Company-Id` (Service ยังตรวจ JWT ซ้ำเอง)

**เส้นทางอ่านสาธารณะ (PM ตัดสิน 2026-11-18):** 5 เส้นทาง `GET` ต่อไปนี้ **ไม่ต้องล็อกอิน (Public)** — `/search/jobs`, `/jobs/{id}`, `/directory/companies`, `/directory/companies/{id}`, `/companies/{company_id}/reviews` Gateway ข้ามการตรวจ JWT เฉพาะ 5 เส้นทางนี้ (เฉพาะ `GET`; `/jobs/{id}/reports` ยังเป็น `POST` ต้องล็อกอิน) จึง **Service เจ้าของต้องไม่ใส่ JWT Guard ที่ 5 เส้นทางนี้** (ไม่งั้นผู้เยี่ยมชมได้ `401` จาก Service เอง) Response เหมือนกันทุกผู้เรียก ไม่ขึ้นกับตัวตน (ไม่มี `contact_notes`, `registration_no`, `phone`, เอกสารบริษัท) • Rate limit **60 ครั้ง/นาที/IP แยกต่อเส้นทาง** (bucket ของใครของมัน เพราะหน้าแรกเรียก `/search/jobs` และ `/directory/companies?ids=` พร้อมกัน — SA ตัดสิน 2026-11-18, PM อนุมัติ 2026-11-18; ใช้กับผู้ที่ล็อกอินแล้วด้วยเพราะผูกกับเส้นทาง) เกินแล้ว `429 RATE_LIMITED` + `Retry-After` • ส่ง `Cache-Control: public, max-age=60` • ต้องมีเทสต์ Routing ใน Gateway ครอบคลุมทั้ง 5 แถว (ผู้เรียกไม่มี Token ต้องผ่านและไม่ถูกส่ง `X-User-*`) • เหตุผลที่ไม่ใช้ prefix `/public/**`: prefix นี้ถูกกำหนดให้ Lifecycle (ตารางด้านบน)

---

## 4. Identity & Organization Service

### 4.1 Auth
| Method | Path | Role | คำอธิบาย |
| :--- | :--- | :---: | :--- |
| POST | `/auth/student-invitations/accept` | Public | `{token, password, accept_privacy:true}` → `204`; ตั้งรหัสผ่านและยืนยันอีเมลของนักศึกษาที่อาจารย์สร้างให้ (บัญชีเป็น `ACTIVE`) — token ใช้ได้ครั้งเดียว อายุ 7 วัน; ผิด/หมดอายุ/ใช้แล้ว ⇒ `400 VALIDATION_FAILED` (`INVALID_TOKEN`) **ไม่มี `POST /auth/register/student`** (นักศึกษาไม่สมัครเอง — ปรับ Requirement 2026-11-21 เรียกเส้นทางเดิมได้ `404`) |
| POST | `/auth/register/advisor` | Public | `@ac.th`, สถานะ `PENDING_EMAIL` → (ยืนยัน) → `PENDING_APPROVAL` |
| POST | `/auth/register/company` | Public | `{company:{name, registration_no (ตัวเลข 13 หลัก), website?, phone?}, user:{email(domain องค์กร), password, full_name}, accept_privacy:true}` — ปฏิเสธอีเมลสาธารณะ (`PUBLIC_EMAIL_NOT_ALLOWED`); คนแรก = Owner |
| POST | `/auth/verify-email` | Public | `{token}` |
| POST | `/auth/resend-verification` | Public | rate-limited |
| POST | `/auth/login` | Public | `{email, password, unlock_token?}` → `{access_token, refresh_token, expires_in, user}` ; ปฏิเสธถ้า `EMAIL_NOT_VERIFIED` / `ACCOUNT_SUSPENDED`; ล็อกชั่วคราวเมื่อผิดซ้ำ แต่ลิงก์ปลดล็อกใช้ครั้งเดียวพร้อมรหัสผ่านที่ถูกต้องได้ |
| POST | `/auth/login/unlock/request` | Public | `{email}` → 204 เสมอ; ส่งลิงก์ปลดล็อกอายุ 15 นาทีเฉพาะบัญชีที่ถูกล็อก โดยไม่เปิดเผยว่ามีบัญชีหรือไม่ |
| POST | `/auth/refresh` | Public | `{refresh_token}` → Token ใหม่ (Rotation; อ่านข้อมูลล่าสุดเพื่อออก Claim) |
| POST | `/auth/logout` | Any | เพิกถอน Refresh Token |
| POST | `/auth/password/forgot` | Public | `{email}` → 204 เสมอ (ไม่เผยว่ามีบัญชีหรือไม่) |
| POST | `/auth/password/reset` | Public | `{token, new_password}` ใช้ได้ครั้งเดียว |
| GET | `/.well-known/jwks.json` | Public | Public Key (ถ้าเลือกใช้ JWKS — Open Decision #2) |

ข้อกำหนดของ Auth รอบแรก: `POST /auth/register/advisor` รับ `{email(@ac.th), password, full_name, department, accept_privacy:true}`; รหัสผ่านของทุกบทบาทยาวอย่างน้อย 12 ตัวอักษรและเก็บแบบ Argon2id; บันทึก `PRIVACY_POLICY` consent เมื่อสมัคร. ลิงก์ยืนยันอีเมลหมดอายุใน 24 ชั่วโมง, ลิงก์รีเซ็ตรหัสผ่านหมดอายุใน 30 นาทีและใช้ได้ครั้งเดียว; Refresh Token อยู่ได้ 30 วันและหมุนทุกครั้งที่ใช้. ล็อกบัญชี 15 นาทีเมื่อรหัสผ่านผิดครบ 5 ครั้ง แต่เจ้าของบัญชีใช้ลิงก์ปลดล็อกอายุ 15 นาทีร่วมกับรหัสผ่านเพื่อเข้าสู่ระบบได้ โดยลิงก์ถูกใช้หลังตรวจ token และรหัสผ่านถูกต้องเท่านั้น และออกลิงก์ใหม่ได้เมื่อไม่มีลิงก์ที่ยังใช้ได้. `resend-verification`, `password/forgot` และ `login/unlock/request` คืน 204 แม้อีเมลไม่มีในระบบ เพื่อไม่เปิดเผยรายชื่อบัญชี; จำกัดการขอซ้ำต่อบัญชีอย่างน้อย 60 วินาที (Gateway ยังต้องจำกัดต่อ IP ตาม README §5.7). ลิงก์อีเมลสร้างจาก `WEB_BASE_URL` และส่งผ่าน SMTP ที่ตั้งค่าไว้.

### 4.2 ผู้ใช้และโปรไฟล์ระบุตัวตน
| Method | Path | Role | คำอธิบาย |
| :--- | :--- | :---: | :--- |
| GET | `/users/me` | Any | ข้อมูลตนเอง + สถานะ advisor link / บริษัท |
| PATCH | `/users/me` | Any | แก้ชื่อ/โทร |
| POST | `/users/me/deletion-request` | Any | คำขอลบบัญชี (PM ตัดสิน 2026-11-17: **ซิงโครนัส** — Identity ตรวจสิทธิ์แล้วลบในคำขอเดียว) สำเร็จ `204` ไม่มี body และ token ของบัญชีถูกเพิกถอนทันที; `422 DELETION_BLOCKED` ถ้ามีใบสมัครที่ยังดำเนินอยู่ (ตรวจกับ Lifecycle: `ADVISOR_PENDING`, `ADVISOR_APPROVED`, `IN_PROGRESS`, `FAIL_DISPUTED`, `REEVALUATION_REQUESTED`) หรือเป็น Owner ที่ยังไม่โอน; `503 UPSTREAM_UNAVAILABLE` ถ้าตรวจกับ Lifecycle ไม่ได้ (ปฏิเสธไว้ก่อน ไม่ปล่อยผ่าน); สิ่งที่แต่ละ Service ทำหลังลบ ดู data-schema §2.3 |
| POST | `/advisor-links/students` | A | **อาจารย์เพิ่มนักศึกษา** (อาจารย์ต้อง `ACTIVE`): `{email(@ac.th ของมหาวิทยาลัยเดียวกับอาจารย์), full_name, student_code, major, year_level}` → `201 {student_user_id, email, invitation_expires_at}` สร้างบัญชี `STUDENT` ที่ยังไม่ตั้งรหัสผ่าน ผูก `advisor_id` เป็น `LINKED` ทันที (ส่ง `AdvisorLinkChanged`) และส่งอีเมลคำเชิญ; `409 STATE_CONFLICT` (`EMAIL_ALREADY_REGISTERED`), `409 STATE_CONFLICT` (`STUDENT_CODE_ALREADY_USED`) (รหัสนักศึกษาซ้ำในมหาวิทยาลัยเดียวกัน), `400 VALIDATION_FAILED` (`EMAIL_DOMAIN_NOT_ALLOWED`); rate limit ที่ Gateway |
| GET | `/advisor-links/students` | A | นักศึกษาที่ `LINKED` กับตน (รายชื่อพื้นฐานสำหรับจัดการบัญชี): `?q=&year_level=&activation=PENDING\|ACTIVE` + Pagination → `{user_id, full_name, email, student_code, major, year_level, activation_status, invitation_expires_at?}` (รายชื่อพร้อมสถานะการฝึกงานและตัวกรองกำลังฝึก/ฝึกเสร็จแล้ว ดู `GET /advisor/students` §7.4) |
| PATCH | `/advisor-links/students/{student_id}` | A | `{full_name?, major?, year_level?}` แก้ข้อมูลนักศึกษาในความดูแล (ไม่ใช่ของตน ⇒ `404 NOT_FOUND`); เปลี่ยน `major`/`year_level` มีผลกับใบสมัครถัดไป ไม่ย้อนใบเดิม |
| POST | `/advisor-links/students/{student_id}/actions/resend-invitation` | A | ส่งคำเชิญใหม่ (ลิงก์เดิมใช้ไม่ได้) → `204`; นักศึกษาตั้งรหัสผ่านแล้ว ⇒ `409 STATE_CONFLICT` |
| DELETE | `/advisor-links/students/{student_id}/invitation` | A | ยกเลิกบัญชีที่ยังไม่ได้ตั้งรหัสผ่าน (ลบบัญชีและคำเชิญ) → `204`; ตั้งรหัสผ่านแล้ว ⇒ `409 STATE_CONFLICT` |
| POST | `/users/me/consents` | S | บันทึก Consent: `{type:'RESUME_SHARE', application_id?, target_company_id}` |

### 4.3 บริษัทและทีม HR
| Method | Path | Role | คำอธิบาย |
| :--- | :--- | :---: | :--- |
| GET | `/companies/me` | H | ข้อมูลบริษัท + สถานะ + เหตุผล `NEED_MORE_INFO` |
| PATCH | `/companies/me` | HO | แก้ข้อมูลบริษัท (ถ้าแก้ชื่อ/โลโก้ต้องส่ง `CompanyStatusChanged` Snapshot) |
| POST | `/companies/me/logo` | HO | multipart `file` (jpg/png/webp ≤ 2 MB) → Public bucket |
| POST | `/companies/me/documents` | HO | multipart `file` (PDF ≤ 5 MB), `doc_type` |
| GET | `/companies/me/documents` | H | รายการ + Signed URL |
| POST | `/companies/me/resubmit` | HO | ส่งเอกสารเพิ่มเมื่อ `NEED_MORE_INFO` → `PENDING` |
| GET | `/companies/me/members` | H | Pagination มาตรฐาน `{ data, meta }`; เรียง Owner ก่อน แล้วตามวันที่เข้าร่วม; คืน `user_id, full_name, email, member_role, categories[], joined_at` (Owner = ทุกสายงาน) |
| POST | `/companies/me/invitations` | HO | `{email, categories[]}` (โดเมนองค์กรเท่านั้น; `categories` 1–3 ค่าของ `JobCategory` = สายงานของสมาชิกใหม่ — README 5.6) |
| GET | `/companies/me/invitations` | HO | คำเชิญที่ยังรอรับ (ยังไม่ถูกใช้/ยกเลิก/หมดอายุ) → `{data: [{id, email, categories[], invited_at, expires_at}]}` ไม่คืนโทเคน (PM ตัดสิน 2026-11-18) |
| DELETE | `/companies/me/invitations/{id}` | HO | ยกเลิกคำเชิญที่ยังรอรับ → `204` (ลิงก์เดิมใช้ไม่ได้ทันที); ไม่พบ/ไม่ใช่ของบริษัทนี้/ถูกใช้แล้ว ⇒ `404 NOT_FOUND` (PM ตัดสิน 2026-11-18) |
| POST | `/auth/invitations/accept` | Public | `{token, password, full_name}` |
| DELETE | `/companies/me/members/{user_id}` | HO | |
| PUT | `/companies/me/members/{user_id}/categories` | HO | `{categories: JobCategory[]}` (1–3 ค่า) กำหนดสายงานของสมาชิก → `204`; เป้าหมายเป็น Owner ⇒ `400 VALIDATION_FAILED` (Owner เห็นทุกสายงาน); มีผลกับ JWT (`company_categories`) หลัง refresh/ล็อกอินใหม่ |
| GET | `/companies/me/owner-transfer` | H | คำขอโอนสิทธิ์ Owner ที่ค้างอยู่ของผู้เรียก → `{direction: 'OUTGOING'\|'INCOMING', other_user: {user_id, full_name}, requested_at}` (`OUTGOING` = ผู้เรียกเป็น Owner ที่ขอโอน, `INCOMING` = ผู้เรียกเป็นผู้รับ); ไม่มีคำขอที่เกี่ยวกับผู้เรียก ⇒ `404 NOT_FOUND` (PM ตัดสิน 2026-11-18) |
| POST | `/companies/me/owner-transfer` | HO | `{to_user_id}` |
| POST | `/companies/me/owner-transfer/actions/{accept\|decline\|cancel}` | H/HO | ผู้รับกดยืนยัน |

### 4.4 Company Directory (สาธารณะ — ไม่ต้องล็อกอิน)
| Method | Path | Role | คำอธิบาย |
| :--- | :--- | :---: | :--- |
| GET | `/directory/companies` | **Public** | `?q=&category=&partner=true&ids=<uuid>,<uuid>` + Pagination มาตรฐาน — เฉพาะบริษัท `VERIFIED`; `ids` = ดึงหลายบริษัทในครั้งเดียว (สูงสุด 50 ตัว ไม่ส่ง `q`/`category` ก็ได้; ใช้ดึงคะแนนดาวของการ์ดงานทั้งหน้าโดยไม่ต้องเรียกทีละบริษัท; มากกว่า 50 หรือรูปแบบผิด ⇒ `400 VALIDATION_FAILED`; ไม่พบ/ไม่ใช่ `VERIFIED` ⇒ ไม่อยู่ในผลลัพธ์ ไม่ error); คืน `id, name, logo_url, university_partner, rating_avg, review_count` |
| GET | `/directory/companies/{id}` | **Public** | รายละเอียด + `rating_avg/review_count` (ดึงจาก `company_rating_stats`); เฉพาะ `VERIFIED` นอกนั้น `404 NOT_FOUND`; ไม่มี `registration_no`, `phone`, เอกสาร |

### 4.5 Admin (Identity)
| Method | Path | Role | คำอธิบาย |
| :--- | :--- | :---: | :--- |
| GET | `/admin/companies` | AD | `?status=PENDING&page=` |
| GET | `/admin/companies/{id}` | AD | รวมเอกสารและเกณฑ์อนุมัติ (README 5.6) |
| POST | `/admin/companies/{id}/actions/{verify\|need-more-info\|reject\|suspend\|unsuspend}` | AD | `{reason}` (บังคับยกเว้น `verify`/`unsuspend`) → ส่ง `CompanyStatusChanged`; `suspend` ส่ง `UserSuspended` ของสมาชิก |
| PUT | `/admin/companies/{id}/university-partner` | AD | `{enabled}` |
| PUT | `/admin/companies/{id}/entitlements` | AD | `{featured_enabled, fast_track_enabled}` → `CompanyEntitlementChanged` |
| POST | `/admin/companies/{id}/owner` | AD | `{user_id}` แต่งตั้ง Owner ใหม่ (บริษัทที่ไม่มี Owner) |
| GET | `/admin/advisors` | AD | `?status=PENDING_APPROVAL` |
| POST | `/admin/advisors/{id}/actions/{approve\|reject}` | AD | |
| POST | `/admin/students/{id}/advisor` | AD | `{advisor_id}` ย้ายอาจารย์ทันที (`LINKED`) |
| POST | `/admin/users/{id}/actions/{suspend\|unsuspend}` | AD | → `UserSuspended` |
| GET | `/admin/audit-logs` | AD | Audit ของ Identity |

---

## 5. Job Management Service

### 5.1 ฝั่ง HR
| Method | Path | Role | คำอธิบาย |
| :--- | :--- | :---: | :--- |
| GET | `/hr/jobs` | H | งานของบริษัท `?status=&category=` (HR Member เห็นเฉพาะประกาศของสายงานตน — README 5.6) — รายการอาจมี `JobDraftObject` (`status=DRAFT`, ฟิลด์ `null` ได้) ปนกับ Job Object ปกติ แยกด้วย `status` |
| POST | `/hr/jobs` | H | สร้าง `DRAFT` (ต้องเป็นบริษัท `VERIFIED` มิฉะนั้น 403 `COMPANY_NOT_VERIFIED` — UAT-01) — body = ฟิลด์ที่แก้ได้ของ Job Object **ทุกฟิลด์ไม่บังคับ** (DRAFT ไม่ครบได้; ครบตอน `submit`) → `201` Job Object — เป็น `JobDraftObject` (ฟิลด์เนื้อหา/โครงสร้างเป็น `null` ได้) เพราะ `status=DRAFT` (`CreateJobRequest`) • `category` (สายงาน — บังคับตอน `submit`) และ `tag_ids[]` (Tag ทักษะ 1–10 จากรายการกลาง §5.4); HR Member สร้างได้เฉพาะสายงานของตน ⇒ `403 FORBIDDEN_ROLE` (`details[].issue` = `FORBIDDEN_CATEGORY`) |
| GET | `/hr/jobs/{id}` | H | `status=DRAFT` ⇒ `JobDraftObject` (ไม่ครบได้) • ประกาศ `ADMIN_REJECTED` มี `admin_reason` (เหตุผลที่ Admin ระบุตอนปฏิเสธ — Job เก็บจาก `reasons[]` ของ `JobVerified.ADMIN_REJECT`; ปรับ 2026-11-21 เพราะถอด `GET /verification/jobs/{job_id}/result`) • Job Object มี `tags[]` (`{id,name,slug}`) |
| PATCH | `/hr/jobs/{id}` | H | แก้ไขบางฟิลด์ (`UpdateJobRequest`) — แก้ได้เมื่อ `DRAFT`/`PUBLISHED`/`ADMIN_REJECTED` (และ `CLOSED` เฉพาะ `quota`, `application_deadline`, `target_majors`, `internship period` ฟิลด์อื่น ⇒ `409 STATE_CONFLICT`); สถานะอื่น ⇒ `409 STATE_CONFLICT`. เมื่อ `PUBLISHED` แก้ได้ทุกฟิลด์รวม `tag_ids` โดยงานคง `PUBLISHED` ไม่ตรวจซ้ำ (README 5.1.2) **ยกเว้นบริษัทที่ติดธง `UNDER_REVIEW`:** แก้ข้อความอิสระ (data-schema §4 "ฟิลด์ที่ต้องตรวจซ้ำ") ⇒ `PUBLISHED`→`VERIFYING` และส่ง `JobSubmitted(kind=EDIT)`; สถานะ `ADMIN_REJECTED` แก้แล้วคงสถานะเดิมจนกว่าจะ `submit`; HR Member แก้ได้เฉพาะประกาศของสายงานตน ⇒ `403 FORBIDDEN_ROLE` (`details[].issue` = `FORBIDDEN_CATEGORY`) • Response: Job Object (มุมมอง HR) + `requires_reverification: bool` (`UpdateJobResponse`) |
| POST | `/hr/jobs/{id}/actions/submit` | H | เผยแพร่/ส่งจาก `DRAFT`/`ADMIN_REJECTED` (สถานะอื่น ⇒ `409 STATE_CONFLICT`) • **บริษัทไม่ติดธง ⇒ `200` Job Object ที่ `status=PUBLISHED` ทันที** (Job เปลี่ยนสถานะเองและส่ง `JobStatusChanged`) • **บริษัทติดธง `UNDER_REVIEW` ⇒ `200` Job Object ที่ `status=VERIFYING`** และส่ง `JobSubmitted` (Verification ตอบ `JobVerified` → `PENDING_REVIEW`) — `400 MISSING_REQUIRED_JOB_FIELDS` (+ `details[]` ระบุฟิลด์ที่ขาด รวม `category` และ `tag_ids` 1–10 รายการ; รายการฟิลด์บังคับใน data-schema §4), `403 FORBIDDEN_ROLE` (`details[].issue` = `FORBIDDEN_CATEGORY`) (HR Member นอกสายงานของตน) • ไม่มี rate limit การส่งต่อวันอีกแล้ว |
| POST | `/hr/jobs/{id}/actions/close` | H | → `CLOSED` |
| POST | `/hr/jobs/{id}/actions/reopen` | H | `CLOSED`→`PUBLISHED` (ต้องยังไม่เลย deadline และโควตาเหลือ) |
| PUT | `/hr/jobs/{id}/featured` | H | `{enabled}` — ต้องมี `featured_enabled` และงานเป็น `PUBLISHED` |

**Job Object (ย่อ):** `id, company{id,name,logo_url,badges[]}, category, job_title, description, responsibilities, qualifications, allowance{type,amount_thb,text}, location, work_mode, hours_per_week, period{start,end}, target_majors[], tags[{id,name,slug}], quota, quota_available, application_deadline, status, featured, published_at` — มุมมอง HR/Admin (`/hr/jobs/**`, `/admin/jobs`) เพิ่ม `contact_notes` และ `suspended_from_status` ไม่แสดงในหน้าสาธารณะ (`/jobs/{id}`, `/search/jobs`)

**`JobDraftObject` (`status=DRAFT`):** รูปแบบเดียวกับ Job Object แต่ `category, job_title, description, responsibilities, qualifications, allowance, location, work_mode, hours_per_week, period.start/end, target_majors, quota, quota_available, application_deadline` เป็น `null` ได้ (HR สร้าง DRAFT ไม่ครบได้ — data-schema §4); Job Object ปกติ (ทุกสถานะที่ไม่ใช่ `DRAFT`) ฟิลด์เหล่านี้ครบเสมอ; `DRAFT` ปรากฏเฉพาะมุมมอง HR ไม่ปรากฏใน `/jobs/{id}`, `/search/jobs`, Internal; ชนิดใน `@internpath/contracts`: `JobDraftObject`, `HrJobObject` = `JobObject | JobDraftObject`

### 5.2 Job Search (สาธารณะ — ไม่ต้องล็อกอิน)
| Method | Path | Role | คำอธิบาย |
| :--- | :--- | :---: | :--- |
| GET | `/search/jobs` | **Public** | `?q=&category=&tags=&work_mode=&major=&allowance=true&company_id=&sort=newest\|deadline` (`tags` = slug คั่นด้วย `,` ตรงกับ Tag ใดก็ได้ที่ระบุ) + Pagination มาตรฐาน — เฉพาะ `PUBLISHED` **และบริษัทเจ้าของประกาศเป็น `VERIFIED`** (จาก `company_snapshots` — data-schema §8.2.2; `meta.total` นับด้วยเงื่อนไขเดียวกัน บริษัทถูกระงับ ⇒ ประกาศหายจากผลและจากจำนวน กลับเป็น `VERIFIED` ⇒ กลับมาเห็นเอง) (PM ตัดสิน 2026-11-18); `featured` ขึ้นก่อนเสมอ แล้วเรียงตาม `sort` (ค่าเริ่มต้น `newest` = `published_at` ใหม่ก่อน; `deadline` = `application_deadline` ใกล้ก่อน); คืน `major_mismatch` เมื่อ client ส่ง `major` มา (คำนวณจากพารามิเตอร์ ไม่พึ่งตัวตนผู้เรียก) **ด้วยกฎเดียวกับ `POST /applications` (§7.2):** ตัดช่องว่างหัวท้าย ยุบช่องว่างซ้อน ไม่สนตัวพิมพ์ แล้วเทียบ **ตรงทั้งค่า** กับสาขาใน `target_majors` (ไม่ใช้ substring เช่น `computer sci` ไม่ตรงกับ `Computer Science`); ประกาศที่ไม่ระบุสาขา ⇒ `false`; `major` ที่ว่างหรือมีแต่ช่องว่างถือว่าไม่ส่ง (ไม่คืนฟิลด์) (PM ตัดสิน 2026-11-18); หน้าแรกใช้ `?page_size=3` ขอ "งานเด่น" ไม่มี endpoint เฉพาะ |
| GET | `/jobs/{id}` | **Public** | รายละเอียดสาธารณะ (เฉพาะ `PUBLISHED`/`CLOSED`; สถานะอื่น ⇒ `404 NOT_FOUND`; HR เจ้าของดูได้ทุกสถานะผ่าน `/hr/jobs/{id}`); `CLOSED` ส่ง `X-Robots-Tag: noindex`; **บริษัทเจ้าของประกาศไม่ใช่ `VERIFIED` ⇒ `404 NOT_FOUND` ทั้ง `PUBLISHED` และ `CLOSED`** (รูปแบบเดียวกับไม่พบ ไม่เปิดเผยว่ามีอยู่; กลับเป็น `VERIFIED` ⇒ กลับมาเห็นเอง) — ใบสมัครที่ค้างอยู่ดูผ่านหน้าใบสมัคร (ชื่อประกาศจาก snapshot ของ Lifecycle) ไม่พึ่งหน้าสาธารณะ (PM ตัดสิน 2026-11-18) |

> คะแนนดาวบริษัทไม่อยู่ใน Job: Web ดึงจาก `/directory/companies/{id}` (README 4.3)

### 5.3 Admin (Job)
| Method | Path | Role | คำอธิบาย |
| :--- | :--- | :---: | :--- |
| GET | `/admin/jobs` | AD | ดูงานทุกสถานะ (สำหรับอ้างอิงจากคิว) |

*การเปลี่ยนสถานะโดย Admin ไม่เรียกที่นี่โดยตรง — ผ่าน Verification (§6) ซึ่งส่ง `JobVerified` มาที่ Job*

---

### 5.4 Tag ทักษะ (รายการกลาง)
Tag = ป้ายทักษะ/เทคโนโลยีของประกาศงาน (เช่น `NextJs`, `NestJs`, `Rust` — README 5.1.0) Job เป็นเจ้าของรายการ Tag
| Method | Path | Role | คำอธิบาย |
| :--- | :--- | :---: | :--- |
| GET | `/tags` | **Public** | `?q=` (ค้นชื่อ) + Pagination มาตรฐาน (`page_size` ≤ 100) — เฉพาะ Tag ที่ใช้งาน (`active=true`) → `{id, name, slug}` เรียงชื่อ; ใช้เป็นตัวเลือกของ HR และตัวกรองหน้าค้นหา |
| GET | `/admin/tags` | AD | `?q=&active=` + Pagination → `{id, name, slug, active, job_count}` (รวมที่ปิดใช้งาน) |
| POST | `/admin/tags` | AD | `{name}` (1–50 ตัวอักษร) → `201 {id, name, slug, active:true}`; `slug` สร้างจากชื่อ (ตัวพิมพ์เล็ก ตัดอักขระที่ไม่ใช่ตัวอักษร/ตัวเลข เช่น `Next.js` → `nextjs`); `slug` ซ้ำ ⇒ `409 STATE_CONFLICT` (`TAG_EXISTS`) |
| PATCH | `/admin/tags/{id}` | AD | `{name?, active?}` — เปลี่ยนชื่อได้ (slug คงเดิม), `active=false` = ปิดใช้งาน: ไม่ขึ้นให้เลือกใหม่ แต่ประกาศเดิมที่ติด Tag นี้ยังแสดงตามเดิม; ไม่พบ ⇒ `404`; ไม่มี Audit Log แยก (เก็บ `created_by`/`updated_by` ในตาราง) |
`tag_ids[]` ที่ HR ส่ง: ต้องเป็น Tag ที่ `active` จำนวน 1–10 รายการไม่ซ้ำ ไม่เช่นนั้น `400 VALIDATION_FAILED` (`details[].issue` = `TAG_UNKNOWN`/`TAG_INACTIVE`/`TAGS_COUNT`)

## 6. Verification & Trust Service

### 6.1 Admin Queue
| Method | Path | Role | คำอธิบาย |
| :--- | :--- | :---: | :--- |
| GET | `/admin/queue` | AD | `?type=&priority=&overdue=true&status=` + Pagination มาตรฐาน (§1) — ไม่ส่ง `status` ⇒ เฉพาะรายการที่ยังไม่ปิด (`OPEN`/`IN_REVIEW`); ดูที่ปิดแล้วด้วย `status=RESOLVED` → รายการพร้อม `company_name`, `due_at`, `overdue`; เรียงค่าเริ่มต้น `FAST_TRACK` ก่อน แล้ว `due_at` น้อยไปมาก |
| GET | `/admin/queue/{id}` | AD | (รายการ `REVIEW_REPORT` เพิ่ม `review:{review_id,rating,outcome_label,title,body,moderation_status}` และ `review_reports:[{id,reporter_user_id,reason,created_at}]` เฉพาะ `REVIEW_REPORT`; ฟิลด์ของประกาศเป็นค่าว่าง) รายละเอียด + `origin`, `submission_id`, `reports:[{id, reporter_user_id, category, detail, counted, status, created_at}]` (เฉพาะ `JOB_REPORT` — ตัวตนผู้รายงานเห็นได้เฉพาะ Admin ที่นี่ที่เดียว; ชนิดอื่น `[]`) |
| POST | `/admin/queue/{id}/actions/{approve\|reject}` | AD | งาน `JOB_REVIEW` (ประกาศของบริษัทที่ติดธง `UNDER_REVIEW`) → ส่ง `JobVerified(ADMIN_APPROVE/ADMIN_REJECT)`; `reject` ต้องมี `reason`; `204`; `409 STATE_CONFLICT` (ตัดสินไปแล้ว/สองคนกดพร้อมกัน), `422 SUBMISSION_UNKNOWN` (รายการยังไม่ทราบ submission), `422 UNSUPPORTED_ITEM_TYPE` (ชนิดอื่นที่ยังไม่รองรับ) |
| POST | `/admin/queue/{id}/actions/{dismiss-report\|uphold-report}` | AD | เฉพาะ `JOB_REPORT` (ชนิดอื่น ⇒ `422 UNSUPPORTED_ITEM_TYPE`; ปิดแล้ว ⇒ `409 STATE_CONFLICT`; `204`; body `{reason?}`) **รายการที่ระงับแล้ว (`origin=REPORT_THRESHOLD`):** `dismiss` ⇒ `JobVerified(RESTORE)` + รายงานของรอบนี้ `DISMISSED` + รีเซ็ตตัวนับ + `consecutive_dismissed +1` ของผู้รายงานแต่ละคน; `uphold` ⇒ `JobVerified(REMOVE)` + รายงาน `UPHELD`/`counted=true` + `consecutive_dismissed=0` — รายการที่ไม่มี `submission_id` (ประกาศไม่เคยส่งตรวจ) ตัดสินได้ตามปกติ Event ไม่มี `submission_id` (event-contract E02; ปรับ 2026-11-22) **รายการ "ไม่นับ" (`origin=REPORT_UNCOUNTED`, ประกาศยัง `PUBLISHED`):** `dismiss` ปิดรายงานและรีเซ็ตตัวนับ ไม่ส่ง Event; `uphold` ทำให้รายงานเป็น `counted=true` แล้วคำนวณตัวนับใหม่ ครบเกณฑ์ ⇒ ระงับตามปกติ (E04) ไม่ส่ง `REMOVE` และไม่มี action ระงับด้วยมือ (R5-G02) — เขียน audit `REPORT_DISMISS`/`REPORT_UPHOLD` |
| POST | `/admin/queue/{id}/actions/{publish-review\|remove-review}` | AD | เฉพาะ `REVIEW_REPORT` (ชนิดอื่น ⇒ `422 UNSUPPORTED_ITEM_TYPE`; ตัดสินแล้ว/สถานะรีวิวเปลี่ยนไปแล้ว ⇒ `409 STATE_CONFLICT`); `204`; body `{reason?}` (`remove-review` **ต้องมี `reason`** 1–500 ตัวอักษร ไม่เช่นนั้น `400`) → ส่ง `ReviewModerationResult` (`ADMIN_PUBLISH`/`ADMIN_REMOVE`, `reasons` มี `ADMIN` และ `REPORTED` เมื่อเป็นรายการ `REVIEW_REPORT`); `publish-review` ของ `REVIEW_REPORT` = ยืนยันให้รีวิวคงอยู่ |
| POST | `/admin/queue/{id}/actions/company-clear-flag` | AD | `COMPANY_ACCOUNT`: เคลียร์ธง `UNDER_REVIEW` + ปิดรายการ + `CompanyFlagChanged(active=false)`; `204`; body `{reason?}`; ชนิดอื่น ⇒ `422 UNSUPPORTED_ITEM_TYPE`; ปิดแล้ว ⇒ `409 STATE_CONFLICT`; audit `FLAG_CLEAR` |

### 6.2 ธงบริษัท
| Method | Path | Role | คำอธิบาย |
| :--- | :--- | :---: | :--- |
| PUT | `/admin/flags/companies/{company_id}/under-review` | AD | `{active, reason}` (`reason` บังคับทั้งสองทิศ; บริษัทที่ไม่รู้จัก ⇒ `404 NOT_FOUND`) ตั้ง/เคลียร์ → `200 {company_id, active, changed}`; ค่าเดิมอยู่แล้ว ⇒ `changed=false` ไม่ส่ง `CompanyFlagChanged`/ไม่เขียน audit; ตั้งด้วยมือไม่สร้างรายการคิว, เคลียร์ปิดรายการ `COMPANY_ACCOUNT` ที่เปิดอยู่ (`resolution=ADMIN_CLEAR_FLAG`); audit `FLAG_SET`/`FLAG_CLEAR` |
| GET | `/admin/flags/companies` | AD | `?active=&q=` (ค้นชื่อบริษัท) + Pagination มาตรฐาน; เรียงที่ตั้งล่าสุดก่อน; เฉพาะบริษัทที่เคยติดธง → `{company_id, company_name, active, set_by, set_reason, set_at, cleared_at, trigger_count}` |

### 6.3 (เลิกใช้) Blacklist และกฎคะแนนความเสี่ยง

ปรับ Requirement 2026-11-21: ตัดระบบคำต้องห้าม, Risk Score และกฎคะแนนทั้งหมด ถอด `/admin/blacklist/**` และ `/admin/risk-rules` (เรียกแล้วได้ `404`) ประกาศงานใช้ Tag ทักษะแทน (§5.4) และการจัดการประกาศที่ไม่เหมาะสมใช้การรายงาน (§6.4) ทุกการแก้ของ Admin เขียน `admin_audit_log` (ดู §6.6)

### 6.4 การรายงาน
| Method | Path | Role | คำอธิบาย |
| :--- | :--- | :---: | :--- |
| POST | `/jobs/{job_id}/reports` | S | `{category, detail}` (`category` ตาม §11, `detail` 20–1000 ตัวอักษร) → `201 {id, status:'OPEN'}` (ไม่บอกว่ารายงานนับเข้าเกณฑ์หรือไม่) — รายงานได้เฉพาะประกาศ `PUBLISHED`/`CLOSED` (`422 JOB_NOT_REPORTABLE`; ไม่รู้จักประกาศ `404`), `409 ALREADY_REPORTED` (1 ครั้ง/ประกาศ แม้หลังรีเซ็ต), `429 RATE_LIMITED` + `Retry-After` (วินาที) เมื่อเกิน 5 ครั้ง/วัน (นับตามปฏิทิน `Asia/Bangkok`); ครบ 3 บัญชีที่นับเข้าเกณฑ์ ⇒ `ReportThresholdReached` + รายการคิว `JOB_REPORT`; ผู้รายงานที่ถูกยกคำร้องติด 3 ครั้ง ⇒ รายงานไม่นับแต่ยังเข้าคิว |
| POST | `/reviews/{review_id}/reports` | S,H | `{reason}` (10–1000 ตัวอักษร ผิดรูป ⇒ `400`) 1 ครั้งต่อผู้ใช้ต่อรีวิว → `201 {id, status:'OPEN'}` และสร้างรายการคิว `REVIEW_REPORT` ถ้ายังไม่มีรายการเปิดของรีวิวนั้น; ไม่รู้จักรีวิว `404`; รีวิวที่ถูกพัก/ถูกลบ ⇒ `422 REVIEW_NOT_REPORTABLE`; ซ้ำ `409 ALREADY_REPORTED`; HR รายงานได้เฉพาะรีวิวของบริษัทตน (`403 FORBIDDEN_ROLE`) |

### 6.5 (เลิกใช้) ผลตรวจประกาศและการอุทธรณ์

ปรับ Requirement 2026-11-21: ไม่มีการตรวจคะแนน/คำต้องห้ามและไม่มี `AUTO_REJECTED` จึง **ถอด**`GET /verification/jobs/{job_id}/result` และ `POST /verification/jobs/{job_id}/appeal` (เรียกแล้วได้ `404`) HR ดูสถานะประกาศจาก Job API (`GET /hr/jobs/{id}`) เหตุผลที่ Admin ปฏิเสธประกาศของบริษัทที่ติดธง (`ADMIN_REJECTED`) แจ้ง HR ผ่านการแจ้งเตือนและเก็บใน `status_history.reason` ของ Job

### 6.6 Audit
| Method | Path | Role | คำอธิบาย |
| :--- | :--- | :---: | :--- |
| GET | `/admin/audit` | AD | บันทึกการกระทำของ Admin ย้อนหลัง: `?actor=&action=&target_type=&from=&to=` + Pagination; เรียงใหม่ไปเก่า → `{id, admin_id, action, target_type, target_id, before, after, reason, correlation_id, occurred_at}` (action เช่น `QUEUE_APPROVE`, `QUEUE_REJECT`, `REPORT_DISMISS`, `REPORT_UPHOLD`, `FLAG_SET`, `FLAG_CLEAR`) |

---

## 7. Student Experience & Internship Lifecycle Service

### 7.1 โปรไฟล์และเรซูเม่ (นักศึกษา)
| Method | Path | Role | คำอธิบาย |
| :--- | :--- | :---: | :--- |
| GET/PUT | `/me/profile` | S | โปรไฟล์ — `PUT` แทนที่ฟิลด์ที่แก้ได้ทั้งชุด (ไม่ส่ง = ล้างค่า): `headline` ≤ 200, `bio` ≤ 2000, `skills` ≤ 30 รายการ (รายการละ 1–50 ตัวอักษร ตัดซ้ำไม่สนตัวพิมพ์), `portfolio_url` http/https ≤ 500; ห้ามส่ง `major`/`year_level` (สำเนาจาก Identity ตอน `GET`/`PUT` — PM ตัดสิน 2026-11-18) • `GET`/`PUT` คืน `photo_url?` (Signed URL ~10 นาที; ไม่มีรูป ⇒ ไม่มีฟิลด์) — `PUT` ไม่รับ `photo_url` (รูปเปลี่ยนผ่าน endpoint ด้านล่างเท่านั้น) |
| PUT | `/me/profile/photo` | S | multipart `file` (jpg/png/webp ≤ 2 MB, ตรวจ MIME จริง) → **Private bucket**; แทนที่รูปเดิมและลบไฟล์เก่า; `200` `{photo_url}` (PM ตัดสิน 2026-11-18) • ชนิด/ขนาดผิด ⇒ `400 FILE_TYPE_NOT_ALLOWED`/`FILE_TOO_LARGE` |
| DELETE | `/me/profile/photo` | S | ลบไฟล์ใน Storage และล้าง `photo_key`; ไม่มีรูป ⇒ `204` (idempotent) |
| POST | `/me/resumes` | S | multipart PDF ≤ 5 MB (ตรวจ MIME จริง); **มีเรซูเม่ที่ยังไม่ลบได้ไม่เกิน 5 ไฟล์ต่อนักศึกษา** — เกินแล้ว `400 VALIDATION_FAILED` + `details: [{field:'file', issue:'RESUME_LIMIT_REACHED'}]` (ตรวจก่อนอัปโหลดและตรวจซ้ำใต้ล็อก; ไม่ทิ้งไฟล์ค้างใน Storage) (PM ตัดสิน 2026-11-18) |
| GET | `/me/resumes` | S | พร้อม Signed URL (~10 นาที) |
| DELETE | `/me/resumes/{id}` | S | ลบไฟล์ใน Storage แล้ว soft-delete; **ลบได้แม้ผูกกับใบสมัครที่ยังดำเนินอยู่** (สิทธิ์ลบของเจ้าของข้อมูล — README 5.11) ⇒ HR/อาจารย์ที่เปิดเรซูเม่ของใบสมัครนั้นได้ `404 NOT_FOUND` + `details[].issue = RESUME_DELETED_BY_STUDENT`; เรซูเม่ไฟล์แรกเป็นไฟล์หลักอัตโนมัติ ลบไฟล์หลักแล้วไฟล์ที่อัปโหลดล่าสุดขึ้นแทน (PM ตัดสิน 2026-11-18) |
| GET | `/hr/applications/{id}/resume` | H | Signed URL — เฉพาะบริษัทที่นักศึกษาสมัครและมี Consent; เห็นได้ทุกสถานะของใบสมัคร (ยังไม่จำกัดตามสถานะ — ทบทวนภายหลัง) |
| GET | `/advisor/applications/{id}/resume` | A | เฉพาะนักศึกษาในความดูแล |

### 7.2 ใบสมัคร — นักศึกษา
| Method | Path | Role | คำอธิบาย |
| :--- | :--- | :---: | :--- |
| POST | `/applications` | S | `{job_id, resume_id, cover_letter?, consent:true}` — Guard: `EMAIL_NOT_VERIFIED`, `ADVISOR_NOT_LINKED`, `REAPPLY_BLOCKED`, `ALREADY_APPLIED`, งานไม่ `PUBLISHED`; Response รวม `major_mismatch` |
| GET | `/me/applications` | S | `?status=` |
| GET | `/me/applications/{id}` | S | รวม **timeline** จาก `status_history` + `available_actions[]` (ปุ่มที่กดได้) |
| GET | `/me/application-eligibility` | S | `{can_apply, blocked_reason}` (เช่น ผ่านวิชาแล้ว) สำหรับแสดงข้อความที่ปุ่มสมัคร |
| POST | `/applications/{id}/actions/confirm-offer` | S | `HR_ACCEPTED`→`ADVISOR_PENDING` |
| POST | `/applications/{id}/actions/decline-offer` | S | `HR_ACCEPTED`→`STUDENT_DECLINED` |
| POST | `/applications/{id}/actions/withdraw` | S | `PENDING`/`ADVISOR_PENDING`/`ADVISOR_APPROVED` เท่านั้น |
| POST | `/applications/{id}/actions/request-termination` | S | `IN_PROGRESS`, `{reason}` |
| POST | `/applications/{id}/actions/dispute-fail` | S | ภายใน 7 วัน `{statement}` → `422 DISPUTE_WINDOW_CLOSED` |
| POST | `/applications/{id}/problem-reports` | S | เฉพาะ `IN_PROGRESS`; `{category, detail}` |

**กติกาของ `POST /applications` และ action ฝั่งนักศึกษา (PM ตัดสิน 2026-11-18 — รีวิว PR #42):** ใช้เฉพาะ `code` ในตาราง §2 รายละเอียดอยู่ใน `details[].issue`
- **ลำดับตรวจตอนสมัคร:** `consent` ในคำขอ → อีเมลยืนยัน/ผูกอาจารย์ → `REAPPLY_BLOCKED` → เรซูเม่เป็นของตนและไม่ถูกลบ → ประกาศเปิดรับ (ข้อมูลสดจาก Job) → บริษัท `VERIFIED` → Consent ที่ Identity → ไม่มีใบสมัครซ้ำที่ยังดำเนินอยู่ (`409 ALREADY_APPLIED`)
- **Consent:** ไม่ติ๊ก `consent` ⇒ `403 CONSENT_REQUIRED` + `CONSENT_NOT_ACCEPTED`; Identity ไม่มี Consent ของบริษัทนี้ ⇒ `403 CONSENT_REQUIRED` + `CONSENT_NOT_RECORDED` หน้าเว็บต้องบันทึก Consent ที่ `POST /users/me/consents` (`{type:'RESUME_SHARE', target_company_id}`) **ก่อน** เรียก `POST /applications`
- **ประกาศไม่เปิดรับ:** `409 STATE_CONFLICT` + `JOB_NOT_PUBLISHED` / `JOB_CLOSED` / `DEADLINE_PASSED`; วัน `application_deadline` ยังสมัครได้ (นับตามวันเวลากรุงเทพ); ไม่มีหรืออ่านค่า deadline ไม่ออก ⇒ ถือว่าปิด; **ไม่ตรวจ `quota_available` ตอนสมัคร** (จองโควตาตอน HR ตอบรับ — README 5.2.2)
- **บริษัท/Job:** ไม่มี snapshot ของบริษัท ⇒ ถือว่าไม่ `VERIFIED` (`403 COMPANY_NOT_VERIFIED`, fail-closed); Job ล่ม ⇒ `502 UPSTREAM_UNAVAILABLE`
- **ไม่พบทรัพยากร:** ไม่มีประกาศ/เรซูเม่ ⇒ `404 NOT_FOUND` + `field` (`job_id` | `resume_id`); ใบสมัครของนักศึกษาคนอื่น ⇒ `404` (ไม่บอกว่ามีอยู่)
- **`major_mismatch`:** เทียบสาขานักศึกษากับ `target_majors` แบบตัดช่องว่างและไม่สนตัวพิมพ์; ประกาศไม่ระบุสาขา ⇒ `false` (เตือนเท่านั้น ไม่บล็อกการสมัคร)
- **ความยาวสูงสุด:** `cover_letter` / `statement` / `detail` ของรายงานปัญหา 5000 ตัวอักษร, `reason` 2000 ตัวอักษร
- **`request-termination`:** ไม่มี `reason` ⇒ `400 REASON_REQUIRED`; **`dispute-fail`:** โต้แย้งได้ 1 ครั้งต่อผลประเมิน 1 รอบ และคำโต้แย้งเก็บแยกจาก `status_history`/E08 (อาจมีข้อมูลส่วนตัว)
- **`problem-reports`:** เฉพาะ `IN_PROGRESS` (อื่น ⇒ `409 STATE_CONFLICT` + `NOT_IN_PROGRESS`), `due_at = created_at + 48 ชั่วโมง`, ไม่เปลี่ยนสถานะใบสมัคร และ HR/บริษัทมองไม่เห็น (ไม่มี endpoint ฝั่ง HR)
- `applications.resume_consent_id` เป็น `null` จนกว่า Identity จะคืน `consent_id` ในผลของ `POST /internal/v1/consents/check` (PM ตัดสิน 2026-11-18 ให้เพิ่ม — เพิ่มฟิลด์อย่างเดียว ไม่กระทบของเดิม); Lifecycle อ่านเมื่อมีค่า ไม่มีค่า ⇒ ยังเป็น `null`

### 7.3 ใบสมัคร — HR
| Method | Path | Role | คำอธิบาย |
| :--- | :--- | :---: | :--- |
| GET | `/hr/applications` | H | `?job_id=&status=&category=` (เฉพาะ `company_id` ของตน; HR Member เห็นเฉพาะสายงานของตน) |
| GET | `/hr/applications/{id}` | H | โปรไฟล์ที่ได้รับ Consent แล้วเท่านั้น • `available_actions[]` (ถ้านักศึกษา confirm ที่อื่นอยู่ ⇒ ไม่มี `accept` และมี `accept_blocked_reason`) |
| POST | `/hr/applications/{id}/actions/accept` | H | `{start_date, end_date}` (ห่าง ≥ 30 วัน) → `403 ALREADY_CONFIRMED_ELSEWHERE`, `409 QUOTA_FULL`, `422 INVALID_PERIOD_MIN_30_DAYS` |
| POST | `/hr/applications/{id}/actions/reject` | H | `{reason?}` |
| POST | `/hr/applications/{id}/actions/rescind-offer` | H | `{reason}` บังคับ |
| POST | `/hr/applications/{id}/actions/start` | H | `{actual_start_date, start_date?, end_date?}` → `IN_PROGRESS`; Response `{warning:'NO_CERTIFICATE_ELIGIBLE'}` เมื่อ `< 30` วัน |
| POST | `/hr/applications/{id}/actions/terminate` | H | `{reason, actual_end_date?}` |
| POST | `/hr/applications/{id}/actions/evaluate` | H | `{result:'PASS'|'FAIL', reason(บังคับเมื่อ FAIL), note?}` → `422 EVALUATION_NOT_OPEN` ก่อน `end_date` |
| POST | `/hr/applications/{id}/certificate` | H | ออก E-Certificate (`PASS` + ฝึกจริง ≥ 30 วัน → `422 CERT_MIN_ACTUAL_DAYS`) |
| POST | `/hr/certificates/{id}/actions/revoke` | H | เฉพาะใบที่บริษัทตนออก `{reason}` |
| POST | `/hr/reviews/{id}/reply` | H | 1 ครั้ง/รีวิว (`409 ALREADY_REPLIED`) |

**กติกาฝั่ง HR (PM ตัดสิน 2026-11-18 — Lifecycle 1.5):**
- **สิทธิ์:** HR เปิดใบสมัครของบริษัทอื่น ⇒ `403 NOT_OWNER_OF_RESOURCE` (UAT-29 ข้อ 2 — ต่างจากฝั่งนักศึกษาที่ได้ `404`)
- **สิทธิ์ตามสายงาน (HR Member):** `GET /hr/applications` กรองเฉพาะใบสมัครของประกาศที่อยู่ในสายงาน (`category`) ของสมาชิก และทุก endpoint `/hr/applications/{id}/**` ของใบสมัครสายอื่น ⇒ `403 FORBIDDEN_ROLE` (`details[].issue` = `FORBIDDEN_CATEGORY`); ** Owner เห็นและทำได้ทุกสายงาน**Lifecycle ใช้ `job_snapshots.category` (เติมจาก Internal job ตอนสมัคร) เทียบกับ `company_categories` ใน JWT
- **`GET /hr/applications/{id}`:** ไม่มี Consent หรือ Identity ล่ม ⇒ ยังได้ `200` แต่ไม่มี `profile` (ไม่คืน `502` ทั้งหน้า); `profile.photo_url?` (Signed URL ~10 นาที) **เห็นเฉพาะเมื่อมี Consent เท่านั้น เหมือนฟิลด์อื่นของ `profile`** — รายการ `GET /hr/applications` หน้าสาธารณะ รีวิว และใบรับรอง **ต้องไม่มีรูปเด็ดขาด** (รีวิวไม่ระบุชื่อต้องย้อนหาตัวตนไม่ได้); หน้าเว็บแสดงข้อความกลางว่ายังไม่มีข้อมูลโปรไฟล์ เพราะแยกสาเหตุไม่ได้; ยังไม่มีผลประเมินในรายละเอียด (ฟิลด์ `evaluation?` จะเพิ่มตอนทำ `evaluate` เพื่อให้ HR เห็นผลของตนก่อนประเมินซ้ำ)
- **`start`:** `actual_start_date` เป็นวันในอนาคตไม่ได้ (วันนี้ตามเวลากรุงเทพใช้ได้) และ `end_date` ต้องอยู่หลัง `start_date` และ `actual_start_date` ผิด ⇒ `400 VALIDATION_FAILED` + `details[].issue`; ระยะ `end_date − actual_start_date` < 30 วัน **ไม่ใช่ error** ผ่านพร้อม `warning: 'NO_CERTIFICATE_ELIGIBLE'` (README 5.2.2, UAT-35)
- **`terminate`:** `actual_end_date` เป็นวันในอนาคตไม่ได้ และห้ามก่อนวันเริ่มงานจริง; ไม่ส่ง ⇒ วันนี้ตามเวลากรุงเทพ
- **E08:** ไม่ส่ง `hr_user_ids` — Notification ดึงสมาชิกบริษัทจาก Identity เอง (event-contract §6.1)

### 7.4 อาจารย์
| Method | Path | Role | คำอธิบาย |
| :--- | :--- | :---: | :--- |
| GET | `/advisor/applications` | A | `?status=ADVISOR_PENDING` เฉพาะนักศึกษาในความดูแล + ธง `flagged_for_advisor`, `major_mismatch` • มี `academic_result` (`ACADEMIC_PASS`/`ACADEMIC_FAIL`/`REPEAT_REQUIRED`) เมื่ออาจารย์บันทึกผลแล้ว ยังไม่บันทึก ⇒ ไม่มีฟิลด์ (เหมือน `GET /me/applications`; PM ตัดสิน 2026-11-22) — ใช้รูปเดียวกันใน response ของ action ฝั่งอาจารย์ (`AdvisorApplicationItem`) |
| POST | `/advisor/applications/{id}/actions/approve` | A | `ADVISOR_PENDING`→`ADVISOR_APPROVED` |
| POST | `/advisor/applications/{id}/actions/reject` | A | `{reason}` บังคับ |
| GET | `/advisor/disputes` | A | คิว `FAIL_DISPUTED` |
| POST | `/advisor/applications/{id}/actions/{request-reevaluation\|uphold-fail}` | A | `request-reevaluation` ได้ 1 รอบ |
| POST | `/advisor/applications/{id}/academic-result` | A | `{academic_result, note?}` — ห้ามเปลี่ยน FAIL ของบริษัทเป็น PASS (`FAIL`→เฉพาะ `ACADEMIC_FAIL`/`REPEAT_REQUIRED`) |
| POST | `/advisor/applications/{id}/actions/terminate` | A | `{reason}` ใช้ในกรณีบริษัทถูกระงับขณะฝึก |
| POST | `/advisor/applications/{id}/actions/continue` | A | กรณีบริษัทถูกระงับ: เลือก "ฝึกต่อ" (บันทึก decision) |
| GET | `/advisor/problem-reports` | A | |
| POST | `/problem-reports/{id}/actions/{acknowledge\|resolve}` | A,AD | `resolve` รับ `{note, follow_up_action?}` — **H ได้ 403/404** |
| GET | `/advisor/students` | A | รายชื่อนักศึกษาในความดูแลพร้อมสถานะการฝึกงาน: `?q=&year_level=&training_status=IN_TRAINING\|COMPLETED` + Pagination → `{student_user_id, full_name, student_code, major, year_level, training_status, active_application_count}` — `year_level` = ชั้นปีของนักศึกษา, `IN_TRAINING` = มีใบสมัครสถานะ `IN_PROGRESS`, `COMPLETED` = มีใบสมัครสถานะ `COMPLETED` (ไม่ส่ง `training_status` ⇒ ทุกคน; นักศึกษาที่ไม่มีทั้งสองสถานะมี `training_status=NONE`); ชื่อ/รหัส/สาขา/ชั้นปีดึงสดจาก Identity (`students/summaries`) **ไม่เก็บ `full_name`**; ตัวกรองเพิ่มเติม PM จะแจ้งภายหลัง |
| GET | `/advisor/students/{id}/overview` | A | สรุปสถานะฝึกงานของนักศึกษาในความดูแล |

### 7.5 E-Certificate และการตรวจสอบ
| Method | Path | Role | คำอธิบาย |
| :--- | :--- | :---: | :--- |
| GET | `/me/certificates` | S | |
| GET | `/me/certificates/{id}/download` | S | Signed URL (~10 นาที) |
| GET | `/public/certificates/{certificate_code}` | **Public** | `{status:'VALID'|'REVOKED', holder_name, company_name, job_title, period}` — **ไม่มี PII อื่น**; Header `X-Robots-Tag: noindex`; Rate limit ต่อ IP; ไม่พบ ⇒ 404 รูปแบบเดียวกันไม่ว่าเป็น ID ที่ไม่มีอยู่หรือรูปแบบผิด |

**กติกาใบรับรอง (PM ตัดสิน 2026-11-18):**
- ออกใบได้เมื่อบริษัทประเมิน `PASS` และฝึกจริง ≥ 30 วัน จากสถานะ `EVALUATED_PASS` **หรือ `COMPLETED`** (กัน HR ถูกล็อกถาวรเมื่ออาจารย์บันทึกผลก่อนกดออกใบ)
- **ใบสมัครหนึ่งใบมีใบรับรองได้ใบเดียว** แม้เพิกถอนแล้วก็ออกใหม่ไม่ได้ (ยอมรับข้อจำกัดนี้: เพิกถอนผิดแล้วแก้ไม่ได้ผ่านระบบ)
- ใบที่ถูกเพิกถอนยังอยู่ในรายการ (`status: 'REVOKED'`) แต่ดาวน์โหลดไม่ได้; หน้าสาธารณะแสดงสถานะ `REVOKED`
- URL ใน QR คือ **หน้าเว็บ** `/public/certificates?code={certificate_code}` (ไม่ใช่เส้นทาง API ด้านบน) หน้านั้นเรียก `GET /public/certificates/{certificate_code}`
- **ไม่มี `verify-hash`** (ตัดออก — ดู §10 ข้อ 1)

### 7.6 รีวิว
| Method | Path | Role | คำอธิบาย |
| :--- | :--- | :---: | :--- |
| POST | `/applications/{id}/review` | S | `{rating, title?, body, anonymous}` — `409 ALREADY_REVIEWED`; `422 EVALUATION_NOT_OPEN`/ไม่มีสิทธิ์ ถ้ายังไม่ประเมิน/ยุติ; Response `status:'SUBMITTED'` |
| GET | `/companies/{company_id}/reviews` | **Public** | เฉพาะ `PUBLISHED`; แสดง `outcome_label`; ถ้า `anonymous` ⇒ `display_major`, `display_year` แทนชื่อ |
| GET | `/me/reviews` | S | |

### 7.7 Admin (Lifecycle)
| Method | Path | Role | คำอธิบาย |
| :--- | :--- | :---: | :--- |
| GET | `/admin/lifecycle/no-evaluation-candidates` | AD | ใบสมัครที่ HR ไม่ประเมินครบ 14 วัน (`IN_PROGRESS` / `TERMINATED` ฝึก ≥ 30 วัน / `REEVALUATION_REQUESTED`) |
| POST | `/admin/lifecycle/applications/{id}/actions/confirm-no-evaluation` | AD | → `NO_EVALUATION` |
| POST | `/admin/lifecycle/applications/{id}/actions/terminate` | AD | `{reason}` |
| POST | `/admin/lifecycle/certificates/{id}/actions/revoke` | AD | `{reason}` |
| POST | `/admin/lifecycle/students/{user_id}/reapply-unlock` | AD | `{reason}` → บันทึก Audit |
| GET | `/admin/lifecycle/problem-reports` | AD | |
| GET | `/admin/lifecycle/company-stats/{company_id}` | AD | สถิติถอนข้อเสนอ/ยุติ (สัญญาณตรวจสอบ) |
| GET | `/admin/lifecycle/audit-logs` | AD | |

---

## 8. Notification Service

| Method | Path | Role | คำอธิบาย |
| :--- | :--- | :---: | :--- |
| GET | `/notifications` | Any | `?unread=true` (ของตนเอง) + Pagination มาตรฐาน — `{data:[{id, type, title, body, link?, read, created_at}], meta}` ใหม่สุดก่อน (`NotificationItem`); `link` เป็นเส้นทางภายในเว็บ; `read` = อ่านแล้วหรือไม่ (จาก `read_at` ใน DB — ไม่คืนเวลา); ห้ามคืน `user_id`/`source_event_id`/`data` (PM ตัดสิน 2026-11-18) |
| GET | `/notifications/unread-count` | Any | สำหรับ Notification Bell → `{count}` (`UnreadCountResponse`) |
| POST | `/notifications/{id}/actions/read` | Any | `204` (idempotent); ของผู้อื่น/ไม่พบ ⇒ `404` |
| POST | `/notifications/actions/read-all` | Any | `204` |

*(ไม่มี Endpoint ที่ Service อื่นเรียกเพื่อส่งแจ้งเตือน — ใช้ Event เท่านั้น)*

---

## 9. Internal API (`/internal/v1/**`, ใช้ Service Token เท่านั้น, ไม่ผ่าน Gateway)

| Service | Method | Path | ผู้เรียก | คำอธิบาย |
| :--- | :--- | :--- | :--- | :--- |
| job | POST | `/internal/v1/jobs/{job_id}/quota/reserve` | lifecycle | `{application_id}` → `200 {reserved:true}` / `409 QUOTA_FULL`; ซ้ำด้วย `application_id` เดิมขณะการจองยังเป็น `RESERVED`/`CONFIRMED` ⇒ `200` โดยไม่หักซ้ำ • **`RELEASED` ไม่ใช่สถานะสิ้นสุด (PM ตัดสิน 2026-11-19):** reserve ด้วย `application_id` เดิมหลัง `RELEASED` ⇒ จองใหม่ตามปกติ (`RESERVED` อีกครั้ง; โควตาเต็ม ⇒ `409 QUOTA_FULL`) เพราะ Lifecycle เป็นผู้เรียกที่ล็อกใบสมัครและชี้ขาดอยู่แล้ว (ผู้ใช้กดตอบรับใหม่หลังธุรกรรมล้มและ release ชดเชย ต้องทำต่อได้ด้วยใบสมัครเดิม) • คำขอ reserve เก่าที่มาช้าแล้วจองซ้อน (ค้างโดยที่ Lifecycle ไม่ถือโควตา) ⇒ Reconciliation (`reservation-check` ทุก 30 นาที — Lifecycle ชี้ขาด) คืนให้เอง จึงไม่ใช้ Attempt Identifier และห้ามตอบ `501` |
| job | POST | `/internal/v1/jobs/{job_id}/quota/confirm` | lifecycle | `{application_id}` `RESERVED`→`CONFIRMED` (idempotent) |
| job | POST | `/internal/v1/jobs/{job_id}/quota/release` | lifecycle | `{application_id, reason}` → คืนโควตา (idempotent; ไม่มีการจอง = `200` no-op) |
| job | GET | `/internal/v1/jobs/{job_id}` | lifecycle | สถานะ/โควตา/`job_title`/`category`/`target_majors`/deadline ตอนสมัคร (ลดความเสี่ยง Snapshot ล้าสมัย); `job_title` ใช้เติม `job_snapshots.title` — E03 `JobStatusChanged` ไม่มีชื่อประกาศ จึงสร้าง snapshot ด้วยชื่อว่างได้ และ Lifecycle เติมชื่อตอนมีใบสมัครแรก (PM ตัดสิน 2026-11-18) |
| lifecycle | POST | `/internal/v1/applications/reservation-check` | job | `{application_ids[]}` → `[{application_id, should_hold_quota: bool}]` (Reconciliation ทุก 30 นาที — Lifecycle ชี้ขาด) • **ฝั่ง Lifecycle กันและซ่อมเอง (PM ตัดสิน 2026-11-19, QIR-01/QIR-03):** คำสั่งที่จองโควตา (`accept`) ถือ lease ต่อใบ (`applications.quota_op_until`, 45 วินาที) ตั้งแต่ก่อน reserve จนจบ release ชดเชย คำสั่งซ้อนได้ `409 STATE_CONFLICT` (`QUOTA_OPERATION_IN_PROGRESS`) และ Scheduler (ทุก `SCHEDULER_INTERVAL_MINUTES`) ซ่อม **ทุกใบที่ `quota_reserved = true`** ด้วย reserve ซ้ำ (+ confirm เมื่อผ่าน `start` มาแล้ว — รวม `TERMINATED`/หลังประเมิน เพราะที่นั่งที่ confirm แล้วคงอยู่ถาวร) — กู้ release เก่าที่มาช้าและ confirm ที่ล้มหลัง commit ซึ่ง `reservation-check` แบบ boolean กู้ไม่ได้; ใบที่ยืนยันตรงแล้วและสถานะนิ่ง ≥ 1 ชั่วโมงถูกจด `quota_synced_at` (ตรวจล่าสุด) แล้วข้ามชั่วคราว — ตรวจซ้ำทุก 24 ชั่วโมง ไม่ข้ามถาวร; `confirm` หลัง commit ได้ `409` ⇒ ซ่อมทันที (reserve + confirm) ไม่รอ Scheduler; ซ่อมได้ `409 QUOTA_FULL` = จองเกินจริง (Critical Inconsistency) ⇒ ไม่นับว่าสำเร็จ log ระดับ error ข้อความ `CRITICAL quota inconsistency (over-allocation)` และลองใหม่รอบหน้า (ต้องมีคนตัดสินว่าใครได้ที่นั่ง — PM ตัดสิน 2026-11-19) |
| lifecycle | GET | `/internal/v1/users/{user_id}/deletion-eligibility` | identity | `200 {eligible: boolean, blocking_application_count: number}` — `eligible=false` เมื่อผู้ใช้มีใบสมัครสถานะ `ADVISOR_PENDING`/`ADVISOR_APPROVED`/`IN_PROGRESS`/`FAIL_DISPUTED`/`REEVALUATION_REQUESTED`; ไม่มีใบสมัครหรือไม่รู้จักผู้ใช้ ⇒ `eligible=true`; Identity ปฏิเสธการลบเมื่อเรียกไม่สำเร็จ (fail-closed); Service Token: audience `lifecycle`, secret `LIFECYCLE_SERVICE_SECRET_IDENTITY` (PM ตัดสิน 2026-11-17) |
| identity | GET | `/internal/v1/users/{user_id}/contact` | notification | `{email, full_name}` (ใช้ตอนส่งเท่านั้น; ห้าม cache ถาวร) |
| identity | GET | `/internal/v1/users/contacts?ids=` | notification | แบบ Batch (≤ 100) |
| identity | GET | `/internal/v1/students/names?ids=` | lifecycle | แบบ Batch (≤ 100) → `[{user_id, full_name}]` ชื่อนักศึกษาสำหรับหน้ารายการของ HR/อาจารย์ — ไม่มีอีเมล; คืนเฉพาะนักศึกษา `ACTIVE` (เงื่อนไขเดียวกับ `students/{user_id}`) — ข้ามบัญชีที่ถูกระงับ/ลบ/ยังไม่ยืนยันและ id ที่ไม่ใช่นักศึกษา (SA ตัดสิน 2026-11-18) |
| identity | GET | `/internal/v1/students/summaries?ids=` | lifecycle | แบบ Batch (≤ 100) → `[{user_id, full_name, student_code, major, year_level}]` ข้ามบัญชีที่ลบแล้วและ id ที่ไม่ใช่นักศึกษา — ใช้กับ `GET /advisor/students` ดึงสดทุกครั้ง **ห้ามเก็บ `full_name` ลง DB/cache/Event/log** (PM ตัดสิน 2026-11-21) |
| identity | GET | `/internal/v1/students/{user_id}` | lifecycle | `{full_name, major, year_level, university_id, email_verified, advisor_id, advisor_link_status}` ตอนสมัครงาน และชื่อแสดงผลให้ HR (มี Consent)/อาจารย์ — Lifecycle ดึงสดทุกครั้ง **ห้ามเก็บ `full_name` ลง DB/cache/Event/log** (SA ตัดสิน 2026-11-18) |
| identity | GET | `/internal/v1/companies/{company_id}/members` | notification, lifecycle | ผู้รับแจ้งเตือนฝั่ง HR |
| identity | POST | `/internal/v1/consents/check` | lifecycle | `{student_user_id, company_id}` → `{has_consent, consent_id?}` (`consent_id` = Consent ที่ใช้อยู่ ส่งเมื่อ `has_consent=true`; ใช้ผูก `applications.resume_consent_id` — PM ตัดสิน 2026-11-18) |
| identity | POST | `/internal/v1/consents/check-batch` | lifecycle | `{company_id, student_user_ids[]}` (1–100, ตัดซ้ำ) → `[{student_user_id, consent_id}]` เฉพาะคนที่มี Consent เรียงตามคำขอ (id ที่ไม่อยู่ในผล = ไม่มี Consent) เงื่อนไขเดียวกับ `consents/check` — สำหรับหน้ารายการใบสมัครของ HR แทนการเรียกทีละคน (SA ตัดสิน 2026-11-19) |
| identity | GET | `/internal/v1/admins` | notification | รายชื่อ `user_id` ของ Admin |
| identity | GET | `/internal/v1/denylist` | gateway | รายการ `user_id` ที่ถูกระงับ (ดึงตอนเริ่มระบบ/ทุก 30 วินาที) |
| verification | GET | `/internal/v1/jobs/{job_id}/flags` | job | (สำรอง) สถานะธงบริษัท |

ข้อกำหนด: ทุก Endpoint ภายในต้องตรวจ `aud` ของ Service Token และ allow-list ผู้เรียก; คืน Error รูปแบบเดียวกับ §2

---

## 10. สิ่งที่ต้องตกลงเพิ่มก่อนเริ่ม Implement
| # | ประเด็น | หมายเหตุ |
| :-: | :--- | :--- |
| 1 | ~~`verify-hash` ของ Certificate~~ | ปิดแล้ว (PM ตัดสิน 2026-11-18): **ตัดออก** ไม่มี Endpoint สาธารณะ — ยังเก็บ SHA-256 ของไฟล์ในระบบตาม README 5.4 |
| 2 | ~~Pagination/Sort มาตรฐานของ Admin Queue~~ | ปิดแล้ว: ใช้ Pagination มาตรฐาน §1; เรียงค่าเริ่มต้น `FAST_TRACK` ก่อนแล้ว `due_at` น้อยไปมาก (§6.1) — ปรับตาม UI ภายหลังได้ |

## 11. รูปร่าง Response/ค่า Enum ที่ PM ตัดสินแล้ว (2026-11-14)

**แหล่งความจริงของชนิดข้อมูลคือ `libs/contracts/src/dto/`** (เอกสารนี้ระบุเฉพาะระดับ Endpoint) — เปลี่ยนต้องแก้ทั้งสองที่ในPR เดียวกัน (developer-guide §4 ข้อ 8)

| หัวข้อ | ที่ตัดสิน | ไฟล์ |
| :--- | :--- | :--- |
| Response ของ Identity (`/users/me`, `/companies/me`, สมาชิก, เอกสาร, รายการ Admin, Internal) | ตามฟิลด์ใน data-schema §3 **ยกเว้น** `password_hash`, token hash, `object_key` (ใช้ Signed URL) | `dto/identity-responses.ts` |
| Response ของ Lifecycle/Notification (ใบสมัคร, เรซูเม่, ใบรับรอง, รีวิว, แจ้งเตือน, Internal job) | ตามฟิลด์ใน data-schema §6-§7; `available_actions[]` เป็นชื่อ `{action}` ของ endpoint | `dto/lifecycle-responses.ts` |
| `user` ใน `LoginResponse` | `AuthUser` (id, email, full_name, phone?, role, status, email_verified, created_at) | `dto/identity-responses.ts` |
| `doc_type` เอกสารบริษัท | `REGISTRATION_CERT`, `VAT_CERT`, `AUTHORIZATION_LETTER`, `OTHER` | `CompanyDocType` |
| `category` รายงานประกาศ (R5-G01) | `SCAM_OR_FEE`, `MISLEADING_INFO`, `INAPPROPRIATE_CONTENT`, `DUPLICATE_OR_SPAM`, `OTHER`; `detail` 20–1000 ตัวอักษร | `JobReportCategory` |
| `category` รายงานปัญหาระหว่างฝึก | `WORKLOAD_OR_HOURS`, `NO_ALLOWANCE_AS_PROMISED`, `UNSAFE_OR_HARASSMENT`, `DIFFERENT_FROM_JOB_POST`, `OTHER` | `ProblemReportCategory` |

*(ข้อ `reopen` ประกาศ, `TERMINATED`→ประเมินต่อ, อาจารย์ให้ FAIL ได้แม้บริษัท PASS และ Event E16–E18 ทีมยืนยันแล้ว — ดู [data-schema.md](data-schema.md) §8 และ [event-contract.md](event-contract.md) §4)*
