# Data Schema & State Machine (InternPath)

> ที่เก็บหลักของ **ตาราง ฟิลด์ Enum และ State Machine** ของทุก Service
> กฎธุรกิจดู [README.md](../README.md) | Event ดู [event-contract.md](event-contract.md) | Endpoint ดู [api-contract.md](api-contract.md)
> เป็นสเปกเชิงแนวคิด — `schema.prisma` ของแต่ละ Service ต้องสอดคล้องกับเอกสารนี้ (ชื่อฟิลด์ใน Prisma ใช้ camelCase + `@map` เป็น snake_case)

---

## 1. ข้อตกลงร่วม

| หัวข้อ | ข้อตกลง |
| :--- | :--- |
| ฐานข้อมูล | 1 DB ต่อ Service (PostgreSQL) — **ห้ามอ่านตารางข้าม Service และห้าม FK ข้าม DB** อ้างด้วย ID เท่านั้น (คอลัมน์ที่อ้างข้าม Service ระบุเป็น `ref:<service>` ด้านล่าง) |
| PK | `id uuid` (default `gen_random_uuid()`) |
| เวลา | `timestamptz` UTC: `created_at`, `updated_at` ทุกตาราง |
| Soft delete | ไม่ใช้ ใช้ `status` / Anonymize ตาม README 5.11 |
| Optimistic concurrency | ตารางที่เปลี่ยนสถานะมี `version int` และเปลี่ยนด้วย `updateMany({ where: { id, status: <เดิม> } })` ตรวจจำนวนแถว (README 4.4) |
| Enum | เก็บเป็น `text` + CHECK หรือ Prisma enum — ค่าตามหัวข้อ 2 |
| ตารางที่ **ทุก Service ต้องมี** | `outbox_events`, `processed_events`, `status_history`, (`admin_audit_log` ถ้ามีหน้า Admin) — ดูหัวข้อ 2.4 |

## 2. Enum และตารางมาตรฐานร่วม

### 2.1 Enum สถานะ (ที่เก็บหลัก)

| Enum | ค่า | เจ้าของ |
| :--- | :--- | :--- |
| `Role` | `STUDENT`, `COMPANY_HR`, `ADVISOR`, `PLATFORM_ADMIN` | identity |
| `UserStatus` | `PENDING_EMAIL` (รอยืนยันอีเมล — รวมนักศึกษาที่อาจารย์สร้างและยังไม่ตั้งรหัสผ่าน), `PENDING_APPROVAL` (อาจารย์), `ACTIVE`, `SUSPENDED`, `DELETED` | identity |
| `CompanyStatus` | `PENDING`, `NEED_MORE_INFO`, `VERIFIED`, `REJECTED`, `SUSPENDED` | identity |
| `CompanyMemberRole` | `OWNER`, `MEMBER` | identity |
| `AdvisorLinkStatus` | `NONE`, `ADVISOR_LINK_PENDING` (เลิกใช้ — ไม่มีขั้นที่นักศึกษาเลือกอาจารย์), `LINKED` | identity |
| `JobStatus` | `DRAFT`, `VERIFYING`, `PUBLISHED`, `PENDING_REVIEW`, `AUTO_REJECTED` (เลิกใช้ — สงวนค่าไว้ ไม่มีเส้นทางไปสถานะนี้), `ADMIN_REJECTED`, `SUSPENDED`, `REMOVED`, `CLOSED` (ความหมายดู README 5.1.1) | job |
| `WorkMode` | `ONSITE`, `REMOTE`, `HYBRID` | job |
| `JobCategory` | `TECH_IT`, `BUSINESS_MARKETING`, `CORPORATE_SERVICES` | job |
| `QuotaReservationStatus` | `RESERVED`, `CONFIRMED`, `RELEASED` | job |
| `QueueItemType` | `JOB_REVIEW` (ประกาศของบริษัทที่ติดธง `UNDER_REVIEW` รอ Admin), `COMPANY_ACCOUNT` (ตรวจบัญชีบริษัทที่ติดธง `UNDER_REVIEW` — **ไม่ใช่** การอนุมัติบัญชีสมัครใหม่ ซึ่งอยู่ที่หน้า Admin ของ Identity), `JOB_REPORT`, `REVIEW_REPORT` | verification |
| `QueueItemStatus` | `OPEN`, `IN_REVIEW`, `RESOLVED` | verification |
| `ApplicationStatus` | `PENDING`, `HR_ACCEPTED`, `ADVISOR_PENDING`, `ADVISOR_APPROVED`, `IN_PROGRESS`, `EVALUATED_PASS`, `EVALUATED_FAIL`, `FAIL_DISPUTED`, `REEVALUATION_REQUESTED`, `COMPLETED`, `TERMINATED`, `NO_EVALUATION`, `HR_REJECTED`, `STUDENT_DECLINED`, `ADVISOR_REJECTED`, `OFFER_RESCINDED`, `WITHDRAWN`, `EXPIRED`, `CANCELLED` (ความหมายดู README 5.2.1) | lifecycle |
| `AcademicResult` | `ACADEMIC_PASS`, `ACADEMIC_FAIL`, `REPEAT_REQUIRED` | lifecycle |
| `TerminatedBy` | `COMPANY`, `STUDENT`, `ADVISOR`, `ADMIN` | lifecycle |
| `CertificateStatus` | `VALID`, `REVOKED` | lifecycle |
| `ReviewStatus` | `SUBMITTED`, `PUBLISHED`, `HELD` (เลิกใช้ — ไม่มีการสแกนเนื้อหารีวิว), `REMOVED` | lifecycle |
| `ProblemReportStatus` | `OPEN`, `ACKNOWLEDGED`, `RESOLVED` | lifecycle |
| `NotificationChannel` | `IN_APP`, `EMAIL` | notification |

### 2.2 ตารางร่วมที่ทุก Service มี

**`outbox_events`**
| ฟิลด์ | ชนิด | หมายเหตุ |
| :--- | :--- | :--- |
| id | uuid PK | = `event_id` |
| type | text | ชื่อ Event |
| version | int | Schema version |
| aggregate_id | uuid | entity ที่เกี่ยวข้อง (ใช้รักษาลำดับ) |
| payload | jsonb | |
| correlation_id | uuid | |
| created_at | timestamptz | |
| published_at | timestamptz null | index: `WHERE published_at IS NULL` |
| attempts | int default 0 | |

**`processed_events`**: `event_id uuid`, `consumer text`, `processed_at` — PK (`event_id`, `consumer`)

**`status_history`** (append-only — ห้าม UPDATE/DELETE; บังคับด้วยสิทธิ์ DB role หรือ trigger)
| ฟิลด์ | ชนิด |
| :--- | :--- |
| id | uuid |
| entity | text (`APPLICATION`/`JOB`/`COMPANY`/`CERTIFICATE`/…) |
| entity_id | uuid |
| from_status | text null |
| to_status | text |
| actor_id | uuid null (null = SYSTEM; หลัง Anonymize = `anonymous_actor_id`) |
| actor_role | text |
| reason | text null |
| correlation_id | uuid |
| occurred_at | timestamptz |

Index: (`entity`, `entity_id`, `occurred_at`)

**`admin_audit_log`** (append-only; ใน Service ที่ Admin ทำรายการ)
`id`, `admin_id`, `action text`, `target_type`, `target_id`, `before jsonb`, `after jsonb`, `reason`, `correlation_id`, `occurred_at`

### 2.3 กติกา Anonymize (README 5.11)
เมื่อได้รับ `UserDeletionRequested`: ลบ/ล้าง PII ในตารางของตนและไฟล์ใน Storage; แทน `actor_id` ใน `status_history`/`admin_audit_log` ด้วย `anonymous_actor_id`; ข้อมูลที่ "เก็บแต่ไม่ระบุตัวตน" = ใบรับรอง, รีวิวที่เผยแพร่

**Authorized Anonymization Operation (PM ตัดสิน 2026-11-15):** trigger append-only ของ `status_history` / `admin_audit_log` ต้องอนุญาต `UPDATE` ได้ก็ต่อเมื่อ (1) transaction นั้นตั้งค่าท้องถิ่น (local) สองตัว: `SET LOCAL internpath.anonymize = 'on'` และ `internpath.anonymous_actor_id = '<uuid>'` ซึ่งเป็นรหัสนิรนามเดียวกับที่ส่งใน `UserDeletionRequested` (ตั้งด้วย `set_config('internpath.anonymous_actor_id', <uuid>, true)` เพื่อให้มีผลเฉพาะ transaction; ทำเฉพาะใน handler ของ `UserDeletionRequested`) **และ** (2) คอลัมน์ที่เปลี่ยนมีเพียง `actor_id` (ของ `admin_audit_log` คือ `admin_id`) ค่าเดิมต้องไม่เป็น `NULL` และค่าใหม่ต้องเท่ากับ `internpath.anonymous_actor_id` ทุกคอลัมน์อื่นต้องเหมือนเดิม ถ้า setting ใดขาดหรือค่าไม่ตรง trigger จะปฏิเสธ (อ้างอิงการทำงานจริงที่ `apps/identity/prisma/migrations/20261115120000_authorized_history_anonymization`) — นอกนี้ `UPDATE`/`DELETE` ยังถูกปฏิเสธเหมือนเดิม (ไม่แยกข้อมูลระบุตัวตนออกไปตารางอื่น เพื่อให้ประวัติอ่านได้ครบในที่เดียว) ใช้กับทุก Service ที่มีตารางสองตัวนี้ (Identity, Job, Verification, Lifecycle) และมีเทสต์ครอบคลุมทั้งกรณีที่ต้องผ่านและกรณีที่ต้องถูกปฏิเสธ

**ตารางที่เก็บ user id นอก history (PM ตัดสิน 2026-11-16 — Job):** Job แทน `jobs.created_by` และ `job_submissions.submitted_by` ที่ตรงกับ `user_id` ของ `UserDeletionRequested` ด้วย `anonymous_actor_id` ใน transaction เดียวกับ `status_history` — คอลัมน์ยังเป็น `uuid NOT NULL`; เป็น `UPDATE` ธรรมดา (ไม่ผ่าน trigger append-only); **ไม่แตะ `version`/`entity_version` และไม่ส่ง `JobStatusChanged`** เพราะไม่ใช่การเปลี่ยนสถานะ; idempotent (รับซ้ำหรือไม่พบแถวต้องสำเร็จโดยไม่ทำอะไร); ไม่กระทบ id ของประกาศ/การส่งตรวจ, `company_id` และสถานะประกาศ

**Lifecycle เมื่อรับ `UserDeletionRequested` (PM ตัดสิน 2026-11-17):** (1) ใบสมัครที่ยังไม่ถึง `ADVISOR_PENDING` (`PENDING`, `HR_ACCEPTED`) ⇒ `CANCELLED` พร้อมคืนโควตา — ใบสมัครที่ `ADVISOR_PENDING`/`ADVISOR_APPROVED`/`IN_PROGRESS`/`FAIL_DISPUTED`/`REEVALUATION_REQUESTED` ถูกบล็อกตั้งแต่ตอนขอลบแล้ว (`GET /internal/v1/users/{user_id}/deletion-eligibility` ใน api-contract §9); (2) ลบ PII และไฟล์ใน Storage (เรซูเม่ รูปโปรไฟล์ `photo_key` โปรไฟล์ ลิงก์อาจารย์); (3) คอลัมน์ user id ในข้อมูลที่เก็บไว้ (ใบสมัคร ผลประเมิน คำโต้แย้ง ใบรับรอง ฯลฯ) ⇒ `anonymous_actor_id`; ใบรับรองเก็บไว้และชื่อแสดง "ผู้ใช้ที่ลบบัญชีแล้ว"; (4) รีวิว `PUBLISHED` เก็บไว้แบบไม่ระบุตัวตน (ไม่กระทบ `company_review_stats`), รีวิว `SUBMITTED`/`HELD` ⇒ `REMOVED` และล้าง `title`/`body` (E10 ของรีวิวนั้นที่มาทีหลังสถานะไม่ตรง ⇒ ข้ามพร้อม log ตามกติกา E10); (5) `status_history`/`admin_audit_log` ใช้ Authorized Anonymization ข้างต้น; (6) idempotent ผ่าน `processed_events`

### 2.4 สำเนา (Snapshot) ที่แต่ละ Service เก็บได้
ตารางเจ้าของข้อมูลฉบับย่ออยู่ใน README 5.8 — ตารางด้านล่างระบุ **ฟิลด์** ที่ Service อื่นเก็บเป็นสำเนาได้ (Snapshot):

| ข้อมูล | เจ้าของ | สำเนาที่ | ฟิลด์ที่เก็บ | อัปเดตด้วย |
| :--- | :--- | :--- | :--- | :--- |
| ชื่อ/โลโก้/ป้ายบริษัท/สถานะ | identity | job, lifecycle, verification | `company_snapshots` | `CompanyStatusChanged` |
| สิทธิ์ Featured/Fast-Track | identity | job | `company_entitlements` | `CompanyEntitlementChanged` |
| ธง UNDER_REVIEW | verification | job | `company_flags` | `CompanyFlagChanged` |
| ผูกอาจารย์ (`advisor_id`) | identity | lifecycle | `student_advisor_links` | `AdvisorLinkChanged` |
| สถานะประกาศ/`target_majors`/โควตาเพื่อแสดง | job | lifecycle | `job_snapshots` | `JobStatusChanged` (+ ดึง API ตอนสมัคร) |
| คะแนนดาวบริษัท | identity | — | `company_rating_stats` | `ReviewPublished` |

---

## 3. Identity & Organization Service (`identity_db`)

**`universities`**: `id`, `name`, `email_domain` (เช่น `xxx.ac.th`, unique), `active`

**`users`**
| ฟิลด์ | ชนิด | หมายเหตุ |
| :--- | :--- | :--- |
| id | uuid | |
| email | citext unique | |
| password_hash | text null | argon2id — ว่างได้เฉพาะนักศึกษาที่อาจารย์สร้างและยังไม่ตั้งรหัสผ่านผ่านลิงก์คำเชิญ (`PENDING_EMAIL`); login ไม่ผ่านจนกว่าจะตั้ง |
| role | Role | |
| status | UserStatus | |
| email_verified_at | timestamptz null | |
| university_id | uuid null | FK `universities` (ระบุจากโดเมนอีเมล; Student/Advisor) |
| full_name | text | PII — Anonymize ตอนลบ |
| phone | text null | PII |
| failed_login_count / locked_until | int / timestamptz null | Rate limit ระดับบัญชี |
| suspended_reason | text null | |
| deleted_at | timestamptz null | |
| version | int | |

**`student_profiles_identity`** (ข้อมูลระบุตัวตนขั้นต่ำ; เรซูเม่อยู่ที่ Lifecycle): `user_id PK`, `university_id uuid NOT NULL (FK universities)` (สำเนา `users.university_id` ของนักศึกษา ตั้งตอนสร้างโปรไฟล์และต้องตรงกันเสมอ — มีไว้เพราะ unique ข้ามตารางไม่ได้), `student_code` — **`UNIQUE(university_id, student_code)`** (PM ตัดสิน 2026-11-22: กันรหัสซ้ำในสถาบันเดียวกันระดับ DB เป็นด่านสุดท้ายของคำขอพร้อมกัน; API ยังเช็กก่อนเหมือนเดิม และแปลง unique violation เป็น `409 STATE_CONFLICT` / `STUDENT_CODE_ALREADY_USED`; สถาบันต่างกันใช้รหัสเดียวกันได้; ลบบัญชีนักศึกษา = ลบแถวนี้ รหัสจึงกลับมาใช้ได้), `major`, `year_level`, `advisor_id (FK users)`, `advisor_link_status AdvisorLinkStatus` (ตั้งเป็น `LINKED` ตอนอาจารย์สร้างนักศึกษา — ไม่มีขั้นที่นักศึกษาเลือกอาจารย์), `created_by_advisor_id (FK users)` (อาจารย์ที่สร้างบัญชี), `advisor_link_updated_at` — ถอด `pending_advisor_id` (เลิกใช้ ปรับ Requirement 2026-11-21)

**`advisor_profiles`**: `user_id PK`, `department`, `approved_by`, `approved_at`

**`companies`**
| ฟิลด์ | ชนิด |
| :--- | :--- |
| id | uuid |
| name | text |
| registration_no | text unique (เลขนิติบุคคล) |
| email_domain | text |
| website, phone | text null |
| logo_key | text null (Public bucket) |
| status | CompanyStatus |
| review_note | text null (เหตุผล NEED_MORE_INFO / REJECTED / SUSPENDED) |
| university_partner | bool default false |
| featured_enabled | bool default false |
| fast_track_enabled | bool default false |
| version | int |

**`company_members`**: `id`, `company_id`, `user_id` (unique), `member_role CompanyMemberRole`, `categories JobCategory[]` (สายงานของสมาชิก — `MEMBER` ต้องมี 1–3 ค่า, `OWNER` เว้นว่าง = ทุกสายงาน; ใส่ใน JWT เป็น `company_categories`), `invited_by`, `joined_at` — partial unique: **1 OWNER ต่อบริษัท** (`UNIQUE(company_id) WHERE member_role='OWNER'`)

**`company_invitations`**: `id`, `company_id`, `email`, `categories JobCategory[]` (สายงานที่จะให้สมาชิกใหม่ 1–3 ค่า), `token_hash`, `expires_at`, `accepted_at null`, `invited_by` — Owner ยกเลิกคำเชิญ (`DELETE /companies/me/invitations/{id}`) = ตั้ง `expires_at` เป็นเวลาที่ยกเลิก (ลิงก์ใช้ไม่ได้ทันที เก็บแถวไว้ + บันทึก audit `COMPANY_INVITATION_CANCEL`; SA ตัดสิน 2026-11-19)

**`owner_transfers`**: `id`, `company_id`, `from_user_id`, `to_user_id`, `status (PENDING|ACCEPTED|CANCELLED|EXPIRED)`, `requested_at`, `responded_at`

**`company_documents`**: `id`, `company_id`, `doc_type`, `object_key` (Private bucket), `mime`, `size_bytes`, `uploaded_by`, `created_at`

**`email_tokens`**: `id`, `user_id`, `purpose (VERIFY_EMAIL|RESET_PASSWORD|LOGIN_UNLOCK|STUDENT_INVITATION)`, `token_hash`, `expires_at`, `used_at null` — `STUDENT_INVITATION` = คำเชิญที่อาจารย์สร้างให้นักศึกษา (อายุ 7 วัน ใช้ครั้งเดียว; ส่งซ้ำ = ออก token ใหม่และทำให้ token เก่าใช้ไม่ได้)

**`refresh_tokens`**: `id`, `user_id`, `token_hash`, `family_id`, `expires_at`, `rotated_at null`, `revoked_at null`

**`token_denylist`**: `user_id PK`, `reason`, `created_at` (Gateway cache จาก `UserSuspended`)

**`consents`**: `id`, `user_id`, `type (PRIVACY_POLICY|RESUME_SHARE)`, `policy_version`, `target_company_id null` (สำหรับ RESUME_SHARE), `application_id null`, `granted_at`, `revoked_at null`

**`deletion_requests`**: `id`, `user_id`, `status (REQUESTED|BLOCKED|COMPLETED)`, `blocked_reason null`, `requested_at`, `completed_at`

**`company_rating_stats`**: `company_id PK`, `review_count`, `rating_sum`, `entity_version` (จาก `ReviewPublished`; ค่าเฉลี่ยคำนวณตอนอ่าน)

+ ตารางร่วม: `outbox_events`, `processed_events`, `status_history` (entity = COMPANY/USER), `admin_audit_log`

---

## 4. Job Management Service (`job_db`)

**`jobs`**
| ฟิลด์ | ชนิด | หมายเหตุ |
| :--- | :--- | :--- |
| id | uuid | |
| company_id | uuid | `ref:identity` |
| created_by | uuid | `ref:identity` — Anonymize เป็น `anonymous_actor_id` เมื่อลบบัญชี (§2.3) |
| category | JobCategory | |
| job_title | text | **ฟิลด์ข้อความอิสระ** (ต้องตรวจซ้ำเมื่อแก้) |
| description | text | ข้อความอิสระ |
| responsibilities | text | ข้อความอิสระ |
| qualifications | text | ข้อความอิสระ |
| allowance_type | `AMOUNT`/`NONE` | ข้อความอิสระ (ถือเป็นข้อความ) |
| allowance_amount_thb | int null | |
| allowance_text | text null | ข้อความอิสระ — `JobSubmitted.content.allowance_text` เป็น string เสมอ ส่ง `''` เมื่อเป็น NULL |
| location | text | ข้อความอิสระ |
| contact_notes | text null | ข้อความอิสระ ไม่บังคับ (ห้ามใส่ช่องทางติดต่อส่วนตัว — Verification สแกน); เห็นเฉพาะ HR เจ้าของและ Admin ไม่แสดงหน้าสาธารณะ |
| work_mode | WorkMode | |
| hours_per_week | int | |
| internship_period_start / _end | date | ช่วงเวลาฝึกที่ประกาศ |
| target_majors | text[] | **ฟิลด์โครงสร้าง** |
| quota | int | **ฟิลด์โครงสร้าง** — ห้ามแก้ให้ต่ำกว่า `quota_reserved + quota_confirmed` (`422 QUOTA_BELOW_COMMITTED`) |
| quota_reserved | int default 0 | CHECK `quota_reserved + quota_confirmed <= quota` |
| quota_confirmed | int default 0 | |
| application_deadline | date | **ฟิลด์โครงสร้าง** |
| status | JobStatus | |
| suspended_from_status | JobStatus null | สถานะก่อนถูกระงับ (`PUBLISHED` หรือ `CLOSED`) ตั้งตอน `→ SUSPENDED`, ใช้ตอน `RESTORE` (§8.2) **เคลียร์เป็น `NULL` เมื่อ `RESTORE`/`REMOVE` จบรอบ** (PM ตัดสิน 2026-11-18) — ประวัติเก็บใน `report_rounds.suspended_from_status` |
| featured | bool default false | มีผลเมื่อ `PUBLISHED` และบริษัท `featured_enabled` |
| current_submission_id | uuid null | |
| verifying_since | timestamptz null | ไว้ทำ Fail-safe 5 นาที |
| published_at, closed_at | timestamptz null | |
| entity_version | int | เพิ่มทุกการเปลี่ยนสถานะ |
| version | int | optimistic lock |

Index: (`status`, `featured` DESC, `published_at` DESC), GIN `target_majors`

**DRAFT ไม่ครบได้ (PM ตัดสิน 2026-11-15):** `POST /hr/jobs` สร้าง `DRAFT` ได้แม้กรอกไม่ครบ จึงให้ฟิลด์เนื้อหา/โครงสร้างข้างบน (ยกเว้น `id`, `company_id`, `created_by`, `status`, `version`, `entity_version`) เป็น nullable และมี `CHECK (status = 'DRAFT' OR (ฟิลด์ที่ README 5.1.5 บังคับทั้งหมดไม่เป็น NULL))` — ตรวจความครบตอน `actions/submit` (`400 MISSING_REQUIRED_JOB_FIELDS` + `details[]`)

**ฟิลด์ที่ต้องครบก่อนส่งตรวจ (`actions/submit`, PM ตัดสิน 2026-11-15)** — ใช้เป็นเงื่อนไขของ `CHECK` ด้านบนและของ `400 MISSING_REQUIRED_JOB_FIELDS`: `category`, `job_title`, `description`, `responsibilities`, `qualifications`, `location`, `work_mode`, `hours_per_week`, `allowance_type` (ถ้าเป็น `AMOUNT` ต้องมี `allowance_amount_thb` > 0; `NONE` ไม่ต้องมีจำนวนเงิน), `internship_period_start`/`_end`, `target_majors` (≥ 1 สาขา), Tag ทักษะ 1–10 รายการ (`job_tags`), `quota` (≥ 1), `application_deadline` — ส่วน `allowance_text` และ `contact_notes` ไม่บังคับ (README 5.1.5 ไม่ได้ระบุ `description` และ `category` ไว้ แต่ Verification ใช้ `description` ตัดสิน และหน้าค้นหาแยกตาม `category` จึงบังคับ)

**ฟิลด์ที่ต้องตรวจซ้ำเมื่อแก้หลัง `PUBLISHED` (PM ตัดสิน 2026-11-15; ปรับ 2026-11-21: ใช้เฉพาะบริษัทที่ติดธง `UNDER_REVIEW` — บริษัทปกติแก้แล้วคงสถานะ `PUBLISHED`):** หลักการ — ถ้าฟิลด์นั้นเป็นข้อมูลที่ Verification ใช้ตัดสิน (อยู่ใน payload ของ `JobSubmitted`) ต้องตรวจซ้ำ: `job_title`, `description`, `responsibilities`, `qualifications`, `allowance_*`, `location`, `contact_notes`, `work_mode`, `hours_per_week` ⇒ `PUBLISHED → VERIFYING` (กัน Post-Approval Bypass เช่นแก้ชั่วโมงเป็น 60 หลังอนุมัติ) — ฟิลด์ที่ **ไม่ตรวจซ้ำ** (ยังเป็น `PUBLISHED`) มีเฉพาะ `quota`, `application_deadline`, `target_majors`, `internship_period_*`, `featured`

**`category` ล็อกหลังส่งครั้งแรก (PM ตัดสิน 2026-11-22):** แก้ได้เฉพาะ `status = DRAFT`; สถานะอื่นส่งค่าเดิมได้ (ไม่เปลี่ยนอะไร ไม่ส่ง E03) ส่งค่าอื่นใน enum ⇒ `400 VALIDATION_FAILED` (`details[].issue` = `CATEGORY_LOCKED`) — เหตุผล: Lifecycle เก็บ `job_snapshots.category` ไว้จำกัดสิทธิ์ HR Member ตามสายงาน (README 5.6) และการแก้ฟิลด์ที่ไม่เปลี่ยนสถานะไม่มี E03 ไปอัปเดต ถ้าแก้ได้ snapshot จะค้างค่าเก่า (Member สายเดิมยังจัดการใบสมัครได้ สายใหม่ได้ 403) ถ้าจะเปลี่ยนสายงานให้ปิดประกาศแล้วสร้างใหม่

**ค้นหาข้อความ (PM ตัดสิน 2026-11-15):** แยกเป็น migration ภายหลัง (ไม่ต้องอยู่ใน migration แรก) ใช้ **trigram (`pg_trgm`)** ไม่ใช้ `tsvector` เพราะภาษาไทยไม่มีช่องว่างคั่นคำ — GIN index บน `job_title` เป็นหลัก (เพิ่ม `description`/`location` ถ้าจำเป็นหลังวัดผล) ใช้กับ `?q=` ของ `/search/jobs`

**`report_rounds`** (Job — รอบรายงาน, PM ตัดสิน 2026-11-16/18): `id`, `job_id`, `queue_item_id` (ตัวระบุรอบ = `queue_item_id` ของ E04), `status (ACTIVE|CLOSED|DECIDED)`, `reached_at null` (E04; `null` เมื่อเป็น `DECIDED` ที่ E04 ยังไม่มา), `decision null (REMOVE|RESTORE)`, `decided_at null`, `decided_by null (ADMIN|SYSTEM — ค่าเดียวกับ decided_by ของ E02)`, `correlation_id null (uuid — ของ E02 ที่ตัดสิน)`, `suspended_from_status null` (`PUBLISHED`|`CLOSED` ที่ตั้งตอนระงับ — ประวัติหลังเคลียร์ `jobs.suspended_from_status`), `created_at`, `closed_at null` — `UNIQUE (job_id, queue_item_id)` กติกาการใช้ดู event-contract E04 • `decided_by`/`correlation_id` (PM ตัดสิน 2026-11-18) เก็บต้นทางของ E02 ที่มาก่อน E04 เพื่อให้ `status_history` และ E03 ของ `REMOVE` ตรงกับเหตุการณ์ที่ตัดสินจริง (ไม่สมมติ actor ไม่ใช้ correlation ของ E04) ไม่มีข้อมูลส่วนบุคคล และถูกล้างพร้อมแถว `DECIDED`

**`tags`** (Tag ทักษะ — รายการกลาง Admin จัดการ, ปรับ Requirement 2026-11-21): `id`, `name` (เช่น `NextJs`, `NestJs`, `Rust`), `slug` (unique, ตัวพิมพ์เล็ก ใช้กรองด้วย `?tags=`), `active bool` (ปิดแล้วไม่ให้เลือกใหม่ แต่ประกาศเดิมยังแสดง), `created_by`, `updated_by`, `created_at`, `updated_at`

**`job_tags`**: `job_id`, `tag_id` (PK คู่) — 1–10 แถวต่อประกาศที่ไม่ใช่ `DRAFT`; Index (`tag_id`, `job_id`) สำหรับกรองแบบ any-of

**`job_submissions`**: `id (=submission_id)`, `job_id`, `kind (NEW|EDIT|RESUBMIT)`, `changed_fields text[]`, `submitted_by` (Anonymize เป็น `anonymous_actor_id` เมื่อลบบัญชี — §2.3), `submitted_at`, `result_decision null`, `resolved_at null` — ประวัติการส่งตรวจ (ใช้งานจริงเฉพาะบริษัทที่ติดธง `UNDER_REVIEW`; ตัด Rate Limit 5 ครั้ง/วัน ตามปรับ Requirement 2026-11-21)

**`quota_reservations`** (idempotent ด้วย `application_id`)
| ฟิลด์ | ชนิด |
| :--- | :--- |
| application_id | uuid **PK** (`ref:lifecycle`) |
| job_id | uuid FK jobs |
| status | QuotaReservationStatus |
| reserved_at | timestamptz NOT NULL (ตั้งตอนจอง) |
| confirmed_at, released_at | timestamptz null (เป็น NULL จนกว่าจะเกิด confirm/release) |
| release_reason | text null |

การจอง: `UPDATE jobs SET quota_reserved = quota_reserved+1 WHERE id=? AND quota_reserved+quota_confirmed < quota` (affected=0 ⇒ โควตาเต็ม) + `INSERT quota_reservations ON CONFLICT (application_id) DO NOTHING` ใน Transaction เดียว

**`company_snapshots`**: `company_id PK`, `name`, `logo_key`, `status`, `university_partner`, `verified_badge`, `entity_version`

**`company_entitlements`**: `company_id PK`, `featured_enabled`, `fast_track_enabled`, `entity_version`

**`company_flags`**: `company_id PK`, `under_review bool`, `entity_version`

+ ตารางร่วม: `outbox_events`, `processed_events`, `status_history` (entity = JOB) — **ไม่มี `admin_audit_log` ใน migration แรก** เพราะ Job ไม่มี action เขียนของ Admin (`/admin/jobs` อ่านอย่างเดียว; การตัดสินของ Admin ทำผ่าน Verification) เพิ่มเมื่อมี action เขียนจริง

---

## 5. Verification & Trust Service (`verification_db`)

> **ปรับ Requirement 2026-11-21:** ตัดระบบสแกนคำต้องห้ามและคะแนนความเสี่ยงออกทั้งหมด ตาราง `blacklist_terms`, `negation_cues`, `risk_rules` และ `appeals` **ถอดออก** (migration ใหม่ DROP); `evaluations` ถูกเปลี่ยนชื่อเป็น **`job_submission_snapshots`** เหลือเฉพาะสำเนาเนื้อหาที่ Admin อ่านในคิว (`id`, `job_id`, `company_id`, `submission_id` unique, `submission_kind`, `submitted_at`, `content jsonb`, `fast_track`, `created_at`); `queue_items` ถอด `risk_level`/`is_appeal`; ค่า enum เก่า (`JOB_APPEAL`, `REVIEW_HELD`, `EVALUATION`, `APPEAL`, `REVIEW_SCAN`, `AUTO_REJECTED`) คงไว้ในฐานข้อมูลเป็นค่าที่เลิกใช้ Verification เหลือคิว Admin, การรายงาน, ธงบริษัท และการตัดสินรีวิวที่ถูกรายงาน ประกาศของบริษัทที่ติดธง `UNDER_REVIEW` เข้าคิวด้วย `submission_id` จาก `JobSubmitted` โดยไม่มีการให้คะแนน
**`company_snapshots`**: `company_id PK`, `name`, `status`, `entity_version` — ใช้แสดงชื่อบริษัทในคิว Admin และเช็กว่าบริษัท `VERIFIED` (สำเนาจาก `CompanyStatusChanged`)

**`job_snapshots`** *(สไลซ์ 2)*: `job_id PK`, `company_id`, `status text`, `entity_version int`, `updated_at` — สำเนาสถานะประกาศจาก `JobStatusChanged` (เขียนเฉพาะเมื่อ `entity_version` ใหม่กว่า) ใช้ตอบว่า "รายงานได้ไหม" (`PUBLISHED`/`CLOSED`) และหา `company_id` ของประกาศ — Verification ไม่เรียก Job ตรงๆ

**`queue_items`** (Admin Queue)
| ฟิลด์ | ชนิด | หมายเหตุ |
| :--- | :--- | :--- |
| id | uuid | |
| type | QueueItemType | |
| target_type / target_id | text / uuid | job / company / review / problem_report |
| company_id | uuid null | |
| submission_id | uuid null | การส่งตรวจที่รายการนี้ตัดสิน (ใช้ใน `JobVerified` ของ Admin); ว่างได้เมื่อรายการเกิดจาก `VERIFY_TIMEOUT` ที่ยังไม่มี `submission_id` |
| origin | `FLAGGED_COMPANY`/`VERIFY_TIMEOUT`/`REPORT_THRESHOLD`/`REPORT_UNCOUNTED`/`REJECTION_THRESHOLD`/`ADMIN_FLAG`/`REVIEW_REPORT` | ที่มาของรายการ (`FLAGGED_COMPANY` = ประกาศของบริษัทที่ติดธง `UNDER_REVIEW` รอ Admin, `VERIFY_TIMEOUT` = Fail-safe, `REPORT_THRESHOLD` = ประกาศถูกระงับเพราะรายงานครบเกณฑ์, `REPORT_UNCOUNTED` = รายงานที่ไม่นับเข้าเกณฑ์ ประกาศยัง `PUBLISHED`, `REJECTION_THRESHOLD` = ธงบริษัทติดอัตโนมัติ, `ADMIN_FLAG` = Admin ตั้งธงเอง, `REVIEW_REPORT` = รีวิวที่เผยแพร่แล้วถูกรายงาน) |
| priority | `NORMAL`/`FAST_TRACK` | ตาม entitlement ของบริษัท ณ เวลาเข้าคิว |
| due_at | timestamptz | = created_at + 48 ชม. (หรือ 12 ชม. สำหรับ FAST_TRACK) |
| status | QueueItemStatus | |
| assigned_to | uuid null | |
| resolution | text null | รหัสผลการตัดสิน: `ADMIN_APPROVE`, `ADMIN_REJECT`, `SUPERSEDED` (เหตุผลที่ Admin ปฏิเสธเก็บใน `status_history.reason` ของแถว `RESOLVED`) |
| created_at, resolved_at | | |

`OVERDUE` = `status != RESOLVED AND now() > due_at` (คำนวณตอนอ่าน) | Index (`status`, `priority`, `due_at`) | **partial unique index** (`target_id`, `type`) เมื่อ `status <> 'RESOLVED'` — รายการเปิดของ (เป้าหมาย, ชนิด) เดียวกันซ้อนกันไม่ได้ (เขียนมือใน migration)

**`job_reports`**: `id`, `job_id`, `reporter_user_id`, `category`, `detail`, `counted bool` (false เมื่อผู้รายงานถูกยกคำร้องติด 3 ครั้ง), `status (OPEN|DISMISSED|UPHELD)`, `created_at`, `resolved_at` — UNIQUE (`job_id`, `reporter_user_id`) [รายงานได้ครั้งเดียวต่อประกาศ แม้หลังรีเซ็ต] | จำกัด 5 ครั้ง/วัน/ผู้ใช้ (นับจาก `created_at` ตามปฏิทิน `Asia/Bangkok`) | index (`reporter_user_id`, `created_at`) | `category` ค่าตาม api-contract §11 (`JobReportCategory`), `detail` 20–1000 ตัวอักษร (ห้าม log)

**`job_report_counters`**: `job_id PK`, `counted_reports int`, `reset_at null`, `suspended_at null`

**`reporter_stats`**: `user_id PK`, `consecutive_dismissed int` — รีเซ็ตเป็น 0 เมื่อมีรายงานที่ถูกยืนยัน; `>= 3` ⇒ รายงานใหม่ `counted=false`

**`company_rejection_events`**: `id`, `company_id`, `job_id`, `kind (ADMIN_REJECTED|SUSPENDED|REMOVED)` (`AUTO_REJECTED` เลิกใช้ — เหลือในแถวเก่าก่อน migration เท่านั้น), `occurred_at` (= `changed_at` ของ E03), `source_event_id uuid UNIQUE` (= `event_id` ของ E03 ที่ทำให้เกิดเหตุการณ์ — กันนับซ้ำเมื่อ Event ถูกส่งซ้ำ) — นับ 3 ครั้งใน 30 วัน ⇒ ติดธง; นับเฉพาะหลัง `company_flags.cleared_at` (เคลียร์ธงแล้วเริ่มนับใหม่) | index (`company_id`, `occurred_at`)

**`company_flags`**: `company_id PK`, `under_review bool`, `set_by` (`SYSTEM`|`ADMIN`), `set_reason`, `set_at`, `trigger_count int null` (จำนวนเหตุการณ์ปฏิเสธที่ทำให้ติดธงอัตโนมัติ), `cleared_by null`, `cleared_at null`, `entity_version` (เพิ่มทีละ 1 ทุกครั้งที่ธงเปลี่ยน; ใช้เป็น `entity_version` ของ E18) — แถวถูกสร้างเมื่อมีเหตุการณ์/คำสั่งแรกของบริษัท; "เคยติดธง" = `set_at` ไม่ว่าง

**`review_moderations`** *(สไลซ์ 3 — [spec](superpowers/specs/2026-11-15-verification-slice3-design.md))*: `id`, `review_id unique`, `company_id`, `student_user_id`, `rating smallint`, `outcome_label`, `title null`, `body` (สำเนาจาก E09 ที่ผ่าน normalizeText และตัด NUL — ให้ Admin อ่านก่อนตัดสิน **ห้าม log**), `decision` (คำตัดสินล่าสุดใน E10: `PUBLISH|HOLD|ADMIN_PUBLISH|ADMIN_REMOVE`), `reasons jsonb`, `status (PASSED|HELD|ADMIN_PUBLISHED|ADMIN_REMOVED)`, `queue_item_id null`, `created_at`, `updated_at` — "เผยแพร่อยู่" = `PASSED` หรือ `ADMIN_PUBLISHED` (รายงานได้เฉพาะสถานะนี้); **Anonymize (E15):** `student_user_id` → `anonymous_actor_id`; รีวิวที่ `HELD` ล้าง `title`/`body` (อาจมีข้อมูลติดต่อส่วนตัว) แต่คงรายการคิว, รีวิวที่เผยแพร่แล้วคงเนื้อหา (README 5.11)

**`review_reports`**: `id`, `review_id`, `reporter_user_id`, `reason` (10–1000 ตัวอักษร ห้าม log), `created_at` — UNIQUE (`review_id`, `reporter_user_id`); Anonymize (E15): `reporter_user_id` → `anonymous_actor_id` และล้าง `reason`

+ ตารางร่วม: `outbox_events`, `processed_events`, `status_history` (entity = COMPANY_FLAG/QUEUE_ITEM), `admin_audit_log` — `status_history` และ `admin_audit_log` บังคับ append-only ด้วย trigger ใน migration (UPDATE/DELETE ถูกปฏิเสธ; `admin_audit_log.target_id` เป็น text เพราะบางรายการไม่ใช่ uuid เช่น `risk_rules`)

---

## 6. Student Experience & Internship Lifecycle Service (`lifecycle_db`)

**`student_profiles`**: `user_id PK` (`ref:identity`), `headline`, `skills text[]`, `bio`, `portfolio_url null`, `photo_key null` (Private bucket — **ห้ามคืน key ออก API** ใช้ Signed URL เท่านั้น; PM ตัดสิน 2026-11-18), `major`, `year_level`, `updated_at` — *major/year_level สำเนาจาก Identity ตอนสร้าง/เปลี่ยน (ผ่าน API ตอนสมัคร)*

**`resumes`**: `id`, `student_user_id`, `object_key` (Private), `mime = application/pdf`, `size_bytes`, `is_primary`, `uploaded_at`, `deleted_at`

**`student_advisor_links`**: `student_user_id PK`, `advisor_user_id null`, `link_status`, `entity_version`, `updated_at`

**`company_snapshots`**: เหมือน job_db (ชื่อ/โลโก้/สถานะ/partner)

**`job_snapshots`**: `job_id PK`, `company_id`, `status JobStatus`, `category JobCategory null` (เติมจาก Internal job ตอนสมัคร ใช้ตรวจสิทธิ์ HR Member ตามสายงาน — ค่าไม่เปลี่ยนหลังเติมเพราะ Job ล็อก `category` หลังส่งครั้งแรก (§4) — ว่างได้สำหรับ snapshot ที่ E03 สร้างก่อนมีใบสมัคร), `target_majors text[]`, `title`, `entity_version`

**`applications`**
| ฟิลด์ | ชนิด | หมายเหตุ |
| :--- | :--- | :--- |
| id | uuid | = `application_id` ที่ใช้เป็น Idempotency Key ของโควตา |
| job_id | uuid | `ref:job` |
| company_id | uuid | `ref:identity` |
| student_user_id | uuid | `ref:identity` |
| advisor_user_id | uuid | อาจารย์ ณ ตอนสมัคร (ย้ายตาม `AdvisorLinkChanged`) |
| resume_id | uuid null | |
| resume_consent_id | uuid null | `ref:identity.consents` |
| cover_letter | text null | |
| major_mismatch | bool | ธงเมื่อสาขาไม่ตรง `target_majors` |
| status | ApplicationStatus | |
| frozen | bool default false | ถูก Freeze จากสถานะประกาศ (README 5.1.2) — ตัวนับ SLA หยุด |
| frozen_at | timestamptz null | เวลาที่เริ่ม Freeze ล่าสุด |
| sla_paused_seconds | int default 0 | เวลา Freeze สะสมของสถานะปัจจุบัน — Scheduler ใช้ `now − status_changed_at − sla_paused_seconds` (รีเซ็ตเป็น 0 เมื่อเปลี่ยนสถานะ) |
| company_suspended_decision | `PENDING`/`CONTINUE`/`TERMINATE` null | ตั้งเป็น `PENDING` เมื่อบริษัทถูกระงับขณะ `IN_PROGRESS` รออาจารย์ตัดสิน (README 5.2.2) |
| flagged_for_advisor | bool default false | ประกาศถูกปฏิเสธหลังผ่าน ADVISOR_APPROVED |
| start_date, end_date | date null | ตั้งตอน `HR_ACCEPTED`; HR ปรับได้ตอน `IN_PROGRESS` |
| actual_start_date | date null | |
| actual_end_date | date null | วันสิ้นสุดจริง (ครบกำหนด หรือยุติ) |
| quota_reserved | bool default false | |
| status_changed_at | timestamptz | ฐานนับ SLA ของสถานะปัจจุบัน |
| terminated_by | TerminatedBy null | |
| terminate_reason | text null | |
| withdrawn_reason, rescind_reason, advisor_reject_reason | text null | |
| academic_result | AcademicResult null | |
| academic_note | text null | |
| academic_recorded_at | timestamptz null | |
| reevaluation_used | bool default false | ประเมินซ้ำได้ 1 รอบ |
| version | int | |
| entity_version | int | |

Constraint: **ยืนยันได้ทีละ 1 ที่** → partial unique index
`UNIQUE (student_user_id) WHERE status IN ('ADVISOR_PENDING','ADVISOR_APPROVED','IN_PROGRESS')`
Constraint: ไม่ให้สมัครซ้ำประกาศเดิมที่ยังดำเนินอยู่ → `UNIQUE (student_user_id, job_id) WHERE status NOT IN ('HR_REJECTED','STUDENT_DECLINED','ADVISOR_REJECTED','OFFER_RESCINDED','WITHDRAWN','EXPIRED','CANCELLED','TERMINATED','NO_EVALUATION','COMPLETED')` (สมัครประกาศเดิมซ้ำได้หลังถูกปฏิเสธ/ถอน/หมดเวลา)
Index: (`status`, `status_changed_at`) สำหรับ Scheduler, (`advisor_user_id`, `status`), (`company_id`, `status`)

**`evaluations`**: `id`, `application_id`, `round int` (1 หรือ 2), `result (PASS|FAIL)`, `reason null` (บังคับเมื่อ FAIL), `score_note null`, `evaluated_by`, `evaluated_at`

**`fail_disputes`**: `id`, `application_id`, `statement`, `created_by`, `created_at`, `decision (REEVALUATE|UPHOLD) null`, `decided_by null`, `decided_at null`, `decision_note null` — หน้าต่างโต้แย้ง = `evaluated_at + 7 วัน`

**`certificates`**
| ฟิลด์ | ชนิด |
| :--- | :--- |
| id | uuid |
| certificate_code | text unique (Certificate ID ที่แสดง/อยู่ใน QR เช่น `IP-2026-XXXXXX`, สุ่ม ไม่เดาได้) |
| application_id | uuid unique |
| student_user_id / company_id | uuid |
| holder_name_snapshot | text (Anonymize เป็น "ผู้ใช้ที่ลบบัญชีแล้ว") |
| company_name_snapshot, job_title_snapshot | text |
| period_start / period_end | date (ฝึกจริง) |
| actual_days | int (CHECK ≥ 30 — ค่ากำหนดใน config) |
| pdf_object_key | text (Private) |
| pdf_sha256 | char(64) |
| status | CertificateStatus |
| issued_by / issued_at | uuid / timestamptz |
| revoked_by, revoked_by_role, revoke_reason, revoked_at | null ได้ |

**`reviews`**: `id`, `application_id unique` (1 รีวิว/การฝึก), `company_id`, `student_user_id`, `rating 1–5`, `title null`, `body`, `anonymous bool`, `display_major`, `display_year`, `outcome_label (PASS|FAIL|TERMINATED|NO_EVALUATION)`, `status ReviewStatus`, `published_at null`, `created_at`
**`review_replies`**: `id`, `review_id unique` (1 ครั้ง/รีวิว), `company_id`, `replied_by`, `body`, `created_at`
**`company_review_stats`**: `company_id PK`, `review_count`, `rating_sum`, `entity_version` — ตัวนับที่ใช้ส่งใน `ReviewPublished`

**`problem_reports`**: `id`, `application_id`, `student_user_id`, `advisor_user_id`, `category`, `detail`, `status ProblemReportStatus`, `acknowledged_by/at`, `resolved_by/at`, `resolution_note null`, `follow_up_action null (MONITOR_COMPANY|TERMINATE|ESCALATE_COMPANY_REVIEW)`, `due_at` (= created_at + 48 ชม. ตามตาราง SLA README 5.3; `OVERDUE` คำนวณตอนอ่าน), `created_at` — **อยู่ในหน้า Admin ของ Lifecycle ไม่ใช่คิวของ Verification** (README 4.3) — **ห้ามมี API/Query ให้ role `COMPANY_HR`**

**`reapply_unlocks`**: `id`, `student_user_id`, `unlocked_by` (Admin), `reason`, `created_at`, `used_at null`

**`reminder_log`** (Idempotent Scheduler)
`id`, `entity_id`, `type`, `due_date date`, `sent_at` — **UNIQUE (`entity_id`, `type`, `due_date`)** เขียนแถวก่อนส่ง Event

**`config_overrides`** *(optional)*: ปรับ SLA ตอนทดสอบ UAT โดยไม่ต้อง Deploy

+ ตารางร่วม: `outbox_events`, `processed_events`, `status_history` (entity = APPLICATION/CERTIFICATE/REVIEW), `admin_audit_log`

---

## 7. Notification Service (`notification_db`)

**`notifications`** (In-App): `id`, `user_id`, `type`, `title`, `body`, `link`, `data jsonb`, `source_event_id`, `read_at null`, `created_at` — UNIQUE (`source_event_id`, `user_id`, `type`) กันซ้ำ
**`delivery_logs`**: `id`, `notification_id`, `channel NotificationChannel`, `to_user_id`, `status (PENDING|SENT|FAILED)` (PM ตัดสิน 2026-11-18: เขียนแถว `PENDING` ก่อนส่งอีเมลตาม event-contract §6.1 แล้วอัปเดตเป็น `SENT`/`FAILED`; unique ต่อ `notification_id` + `channel`), `error null`, `attempts`, `sent_at` — **ไม่เก็บอีเมลปลายทางถาวร** (ดึงจาก Identity ตอนส่ง; log เก็บแค่ `user_id`)
**`templates`**: `id`, `key` (เช่น `application.ADVISOR_APPROVED`), `channel`, `subject_th`, `body_th`, `active`
**`preferences`** *(optional)*: `user_id`, `channel`, `enabled`

**`recipient_states`**: `recipient_key` (PK, SHA-256 ของ UUID ผู้รับ), `suspended`, `deleted`, `suspension_version`, `advisor_link_version` — เก็บสิทธิ์การรับแจ้งเตือนและเวอร์ชันล่าสุดของ E07/E16 เพื่อไม่สร้างแจ้งเตือนซ้ำจาก Event เก่าหลังยกเลิกบัญชีหรือระงับบัญชี

**`review_notices`**: `review_id` (PK) — กันแจ้ง HR ซ้ำสำหรับ E11 ที่เป็น `PUBLISHED` รวมถึง Event รุ่นเดิมที่ไม่มี `change`

+ `processed_events` สำหรับ deduplicate Event

---

## 8. State Machine

### 8.1 Application (Lifecycle เจ้าของ) — กฎธุรกิจ README 5.2, 5.2.2

```text
                       ┌───────────── HR ปฏิเสธ ────────────► HR_REJECTED
                       │ ┌────────── นักศึกษาถอน ───────────► WITHDRAWN
                       │ │ ┌─────── HR ไม่ตอบ 14 วัน ───────► EXPIRED
  [สมัคร]──► PENDING ──┴─┴─┘
                │ HR ตอบรับ (start/end ห่าง ≥30 วัน; จอง quota)
                ▼
          HR_ACCEPTED ── นักศึกษาปฏิเสธ ──► STUDENT_DECLINED (release)
                │      ── ไม่ยืนยัน 5 วัน ─► EXPIRED          (release)
                │      ── HR ถอนข้อเสนอ ──► OFFER_RESCINDED   (release)
                │ นักศึกษายืนยัน (ใบอื่นที่ HR_ACCEPTED ของคนนี้ → STUDENT_DECLINED)
                ▼
         ADVISOR_PENDING ── อาจารย์ไม่อนุมัติ+เหตุผล ─► ADVISOR_REJECTED (release)
                │          ── นักศึกษาถอน ─────────► WITHDRAWN         (release)
                │          ── HR ถอนข้อเสนอ ───────► OFFER_RESCINDED   (release)
                │ อาจารย์อนุมัติ (ใบอื่นที่ PENDING ของคนนี้ → WITHDRAWN)
                ▼
         ADVISOR_APPROVED ── นักศึกษาถอน ─► WITHDRAWN (release)
                │          ── HR ถอนข้อเสนอ ► OFFER_RESCINDED (release)
                │          ── เกิน 14 วันหลัง start_date ─► EXPIRED (release)
                │ HR ยืนยันเริ่มงาน (confirm quota, บันทึก actual_start_date)
                ▼
           IN_PROGRESS ── ยุติโดย HR/นักศึกษา/อาจารย์/Admin + เหตุผล ─► TERMINATED
                │                      (นักศึกษาไม่มีสิทธิ์ "ถอน" ใน IN_PROGRESS)
                │ ถึง end_date → HR ประเมิน
        ┌───────┴────────┐
        ▼                ▼
  EVALUATED_PASS   EVALUATED_FAIL ── นักศึกษาโต้แย้ง ≤7 วัน ─► FAIL_DISPUTED
        │                │                                        │ อาจารย์สั่งประเมินซ้ำ (1 รอบ)
        │                │                                        ▼
        │                │                              REEVALUATION_REQUESTED
        │                │                                        │ HR ประเมินใหม่
        │                │◄───────────────────────────────────────┘ (→ PASS หรือ FAIL)
        └────────┬───────┘
                 │ อาจารย์บันทึก academic_result
                 ▼
             COMPLETED

  HR ไม่ประเมินครบ 14 วัน + Admin ยืนยัน ─► NO_EVALUATION (จาก IN_PROGRESS / TERMINATED / REEVALUATION_REQUESTED — จุดเริ่มนับดูตาราง)
  ประกาศ ADMIN_REJECTED/REMOVED (ก่อน ADVISOR_APPROVED) ─► CANCELLED (release)
```

**ตารางการเปลี่ยนสถานะ (Transition Table)** — ใช้เป็นแหล่งอ้างอิงตอนเขียนโค้ดและเทส

| จาก | ไป | ผู้กระทำ | เงื่อนไข / Guard | Side effect |
| :--- | :--- | :--- | :--- | :--- |
| — | `PENDING` | STUDENT | อีเมลยืนยันแล้ว, `LINKED`, ไม่ถูกบล็อกจาก `ACADEMIC_PASS` (ยกเว้นมี unlock), ประกาศ `PUBLISHED` & ไม่ `CLOSED` & ยังไม่เลย deadline, ไม่มีใบสมัครซ้ำที่ยังดำเนินอยู่, มี Consent เรซูเม่ | คำนวณ `major_mismatch` |
| `PENDING` | `HR_ACCEPTED` | HR | โควตายังเหลือ (reserve สำเร็จ), นักศึกษาไม่มีใบสมัคร confirm ที่อื่น (`ADVISOR_PENDING`/`ADVISOR_APPROVED`/`IN_PROGRESS`), `end−start ≥ 30` วัน, ประกาศไม่ถูก Freeze | reserve quota |
| `PENDING` | `HR_REJECTED` | HR | — | — |
| `PENDING` | `WITHDRAWN` | STUDENT | — | — |
| `PENDING` | `EXPIRED` | SYSTEM | 14 วันหลังเข้า `PENDING` (ไม่นับช่วง Freeze) | — |
| `PENDING` | `WITHDRAWN` | SYSTEM | นักศึกษาถูกอาจารย์อนุมัติใบอื่น | — |
| `PENDING` | `CANCELLED` | SYSTEM | ประกาศ `ADMIN_REJECTED`/`REMOVED` | — |
| `HR_ACCEPTED` | `ADVISOR_PENDING` | STUDENT | ไม่มีใบ confirm อื่น | ใบอื่นที่ `HR_ACCEPTED` ของนักศึกษา → `STUDENT_DECLINED` + release |
| `HR_ACCEPTED` | `STUDENT_DECLINED` | STUDENT / SYSTEM | — | release |
| `HR_ACCEPTED` | `EXPIRED` | SYSTEM | 5 วัน | release |
| `HR_ACCEPTED` | `OFFER_RESCINDED` | HR | ต้องมีเหตุผล | release |
| `HR_ACCEPTED` | `CANCELLED` | SYSTEM | ประกาศถูกตีกลับ/ลบ | release |
| `ADVISOR_PENDING` | `ADVISOR_APPROVED` | ADVISOR | อาจารย์ของนักศึกษา | ใบอื่นที่ `PENDING` → `WITHDRAWN` |
| `ADVISOR_PENDING` | `ADVISOR_REJECTED` | ADVISOR | **ต้องมีเหตุผล** | release |
| `ADVISOR_PENDING` | `WITHDRAWN` | STUDENT | — | release |
| `ADVISOR_PENDING` | `OFFER_RESCINDED` | HR | ต้องมีเหตุผล | release |
| `ADVISOR_PENDING` | `CANCELLED` | SYSTEM | ประกาศถูกตีกลับ/ลบ | release |
| `ADVISOR_APPROVED` | `IN_PROGRESS` | HR | บันทึก `actual_start_date` (ปรับ start/end ได้); เตือนถ้า `end − actual_start < 30` | confirm quota |
| `ADVISOR_APPROVED` | `WITHDRAWN` | STUDENT | — | release |
| `ADVISOR_APPROVED` | `OFFER_RESCINDED` | HR | ต้องมีเหตุผล | release |
| `ADVISOR_APPROVED` | `EXPIRED` | SYSTEM | เกิน 14 วันหลัง `start_date` | release |
| `ADVISOR_APPROVED` | (ติดธง) | SYSTEM | ประกาศถูกตีกลับ/ลบ | `flagged_for_advisor = true` — **ไม่เปลี่ยนสถานะ** |
| `IN_PROGRESS` | `TERMINATED` | HR / STUDENT / ADVISOR / ADMIN | ต้องมีเหตุผล | บันทึก `terminated_by`, `actual_end_date`, แจ้งอาจารย์; ไม่ release (confirm แล้ว) |
| `IN_PROGRESS` | `EVALUATED_PASS` / `EVALUATED_FAIL` | HR | ถึง `end_date` แล้ว; FAIL ต้องมีเหตุผล | `actual_end_date = end_date` |
| `TERMINATED` | `EVALUATED_PASS` / `EVALUATED_FAIL` *(ทางเลือก)* | HR | ฝึกจริง ≥ 30 วันก่อนยุติเท่านั้น | — |
| `IN_PROGRESS` | `NO_EVALUATION` | ADMIN | ครบ 14 วัน (`SLA_EVALUATION_DAYS`) นับจาก `end_date` & ระบบแจ้งอาจารย์/Admin แล้ว | ไม่มี Certificate |
| `TERMINATED` | `NO_EVALUATION` | ADMIN | ฝึกจริง ≥ 30 วันก่อนยุติ (เข้าสู่การประเมินได้) & ครบ 14 วัน (`SLA_EVALUATION_DAYS`) นับจาก `actual_end_date` & ระบบแจ้งอาจารย์/Admin แล้ว *(PM ตัดสิน 2026-11-18)* | ไม่มี Certificate |
| `REEVALUATION_REQUESTED` | `NO_EVALUATION` | ADMIN | ครบ 14 วัน (`SLA_EVALUATION_DAYS`) นับจาก `status_changed_at` (วันที่อาจารย์สั่งประเมินใหม่) & ระบบแจ้งอาจารย์/Admin แล้ว *(PM ตัดสิน 2026-11-18 — กันใบสมัครค้างและบล็อกการลบบัญชีตลอดไป)* | ไม่มี Certificate |
| `EVALUATED_FAIL` | `FAIL_DISPUTED` | STUDENT | ภายใน 7 วัน; โต้แย้งได้ **1 ครั้งต่อผลประเมิน 1 รอบ** (PM ตัดสิน 2026-11-18) | — |
| `FAIL_DISPUTED` | `REEVALUATION_REQUESTED` | ADVISOR | `reevaluation_used = false` | `reevaluation_used = true` |
| `FAIL_DISPUTED` | `EVALUATED_FAIL` | ADVISOR | ยืนยันผลเดิม | — |
| `REEVALUATION_REQUESTED` | `EVALUATED_PASS` / `EVALUATED_FAIL` | HR | — | `evaluations.round = 2` |
| `EVALUATED_PASS` | `COMPLETED` | ADVISOR | บันทึก `academic_result` | อาจารย์เปลี่ยน PASS เป็น FAIL ได้ไม่ระบุใน README — ให้ถือว่า **บันทึกได้ทั้ง 3 ค่า** |
| `EVALUATED_FAIL` | `COMPLETED` | ADVISOR | หน้าต่างโต้แย้ง 7 วันสิ้นสุดโดยไม่มีการโต้แย้ง หรือการโต้แย้งจบแล้ว; `academic_result ∈ {ACADEMIC_FAIL, REPEAT_REQUIRED}` เท่านั้น | — |
| `TERMINATED` / `NO_EVALUATION` | (บันทึกผล) | ADVISOR | บันทึก `academic_result` โดยไม่เปลี่ยนสถานะ — ได้ทั้ง 3 ค่า และ **บันทึกได้ครั้งเดียว** (PM ตัดสิน 2026-11-18) | — |

\* `TERMINATED` ปกติเป็นปลายทาง ยกเว้นกรณีฝึกจริง ≥ 30 วันก่อนยุติ ซึ่งยังเข้าสู่การประเมินได้ (README 5.2.2) และไปต่อ `NO_EVALUATION` ได้ถ้า HR ไม่ประเมิน

`NO_EVALUATION` ต้องมี Admin ยืนยันเสมอ (`POST /admin/lifecycle/applications/{id}/actions/confirm-no-evaluation`) และนับ "ครบ 14 วัน" แบบ `≥` (วันที่ 14 ยืนยันได้) ใช้ค่า `SLA_EVALUATION_DAYS` เดียวกันทั้งสามเส้นทาง

**บริษัทถูกระงับขณะ `IN_PROGRESS`:** Lifecycle รับ `CompanyStatusChanged(SUSPENDED)` → ตั้ง `company_suspended_decision = PENDING` + แจ้งอาจารย์/นักศึกษาด้วย E14 `ReminderDue` ชนิด `COMPANY_SUSPENDED_DECISION` (ไม่เปลี่ยนสถานะ จึงไม่ใช้ E08) → อาจารย์เลือก `continue` (`CONTINUE`) หรือ `terminate` (`TERMINATED`, `terminated_by = ADVISOR`)

**Release quota** = เรียก `POST /internal/jobs/{id}/quota/release` ด้วย `application_id` (idempotent)

**ข้อควรทำใน Transaction เดียว:** เปลี่ยนสถานะ (`updateMany where status=เดิม`) + เขียน `status_history` + เขียน `outbox_events(ApplicationStatusChanged)`

> **ข้อกำหนดที่ทีมยืนยันแล้ว (ส่วนที่ README ไม่ได้ระบุ):** README ยังไม่ระบุ (1) `TERMINATED` ที่ฝึกครบ ≥30 วันแล้วจะผ่านสถานะ `EVALUATED_*` หรือไม่ (ข้อความ 5.2.2 ว่า "HR ยังประเมินและออกใบรับรองได้" — ตารางนี้ถือว่า **ใช่ ย้อนจาก `TERMINATED` ไป `EVALUATED_*`**) (2) อาจารย์ที่เห็นว่าบริษัทให้ PASS แต่อยากให้ผลวิชาเป็น FAIL ทำได้หรือไม่ (ที่นี่ถือว่าทำได้เพราะ README ห้ามเฉพาะเปลี่ยน FAIL→PASS)

### 8.2 Job Status (Job Management เจ้าของ) — README 5.1, 5.1.1

| จาก | ไป | ที่มา | Event |
| :--- | :--- | :--- | :--- |
| `DRAFT` | `PUBLISHED` | HR เผยแพร่ (ผ่าน Guard ข้อมูลบังคับรวม Tag 1–10, บริษัท `VERIFIED` **และไม่ติดธง `UNDER_REVIEW`**) — Job เปลี่ยนสถานะเอง ไม่รอ Verification | `JobStatusChanged` (`application_effect=NONE`) |
| `DRAFT` | `VERIFYING` | HR ส่ง (ผ่าน Guard ข้อมูลบังคับ, บริษัท `VERIFIED` แต่ **ติดธง `UNDER_REVIEW`**) | `JobStatusChanged` (`application_effect=NONE`) **และ**`JobSubmitted` (kind=NEW) |
| `PUBLISHED` | `VERIFYING` | HR แก้ไข **ฟิลด์ข้อความอิสระ** ของบริษัทที่ติดธง `UNDER_REVIEW` | `JobStatusChanged` (`application_effect=FREEZE`) **และ**`JobSubmitted` (kind=EDIT) |
| `PUBLISHED` | `PUBLISHED` | HR แก้ฟิลด์โครงสร้าง (`quota`, `deadline`, `target_majors`, Tag ทักษะ) หรือแก้ข้อความอิสระของบริษัทที่ไม่ติดธง | ไม่ส่ง |
| `VERIFYING` | `PUBLISHED` | `JobVerified.APPROVE` (ใช้เฉพาะกรณีสงวนไว้ — การส่งของบริษัทที่ติดธงตอบ `PENDING_REVIEW` เสมอ) | `JobStatusChanged` |
| `VERIFYING` | `PENDING_REVIEW` | `JobVerified.PENDING_REVIEW` **หรือ** Fail-safe หมดเวลา 5 นาที (Job ตั้งเอง, `reason_code=VERIFY_TIMEOUT`) | `JobStatusChanged` |
| `PENDING_REVIEW` | `PUBLISHED` | `JobVerified.ADMIN_APPROVE` | `JobStatusChanged` |
| `PENDING_REVIEW` | `ADMIN_REJECTED` | `JobVerified.ADMIN_REJECT` | `JobStatusChanged` |
| `ADMIN_REJECTED` | `PUBLISHED` | HR แก้แล้วส่งใหม่ (บริษัทไม่ติดธง) | `JobStatusChanged` (`NONE`) |
| `ADMIN_REJECTED` | `VERIFYING` | HR แก้แล้วส่งใหม่ (บริษัทติดธง `UNDER_REVIEW`) | `JobStatusChanged` (`NONE`) **และ**`JobSubmitted` (kind=RESUBMIT) |
| `PUBLISHED` | `SUSPENDED` | `ReportThresholdReached` (E04) — ตั้ง `suspended_from_status = PUBLISHED` | `JobStatusChanged` (`FREEZE`, `reason_code=REPORT_THRESHOLD`) |
| `CLOSED` | `SUSPENDED` | `ReportThresholdReached` (E04) — ตั้ง `suspended_from_status = CLOSED` *(PM ตัดสิน 2026-11-15: ประกาศ `CLOSED` รายงานได้ตาม R5-G01)* | `JobStatusChanged` (`FREEZE`, `reason_code=REPORT_THRESHOLD`) |
| `SUSPENDED` | `PUBLISHED` | `JobVerified.RESTORE` เมื่อ `suspended_from_status = PUBLISHED` (และยังไม่เลย deadline) | `JobStatusChanged` (`UNFREEZE`, `reason_code=ADMIN_DISMISSED`) |
| `SUSPENDED` | `CLOSED` | `JobVerified.RESTORE` เมื่อ `suspended_from_status = CLOSED` **หรือ** เลย `application_deadline` ระหว่างระงับ | `JobStatusChanged` (`UNFREEZE`, `reason_code=ADMIN_DISMISSED`) |
| `SUSPENDED` | `REMOVED` | `JobVerified.REMOVE` | `JobStatusChanged` |
| `PUBLISHED` / `CLOSED` | `REMOVED` | `ReportThresholdReached` (E04) ที่มาช้ากว่า `JobVerified.REMOVE` ของ `queue_item_id` เดียวกัน (คำตัดสินที่เก็บไว้ — event-contract E04 ข้อ 5; ไม่ตั้ง `suspended_from_status`) *(PM ตัดสิน 2026-11-18)* | `JobStatusChanged` สองรายการตามลำดับ: `FREEZE` (`REPORT_THRESHOLD`) แล้ว `REMOVE` |
| `PUBLISHED` | `CLOSED` | HR ปิดรับ หรือถึง deadline | `JobStatusChanged` |
| `CLOSED` | `PUBLISHED` | HR เปิดใหม่ (ถ้า deadline/โควตายังอยู่) *(ทีมยืนยันแล้ว; README ไม่ได้ระบุ)* | `JobStatusChanged` |

**ทุกการเปลี่ยนสถานะส่ง `JobStatusChanged` เสมอ** (รวมทุกแถวที่เข้า `VERIFYING` ซึ่งส่งคู่กับ `JobSubmitted` ใน transaction/outbox เดียวกัน โดยส่ง `JobStatusChanged` ก่อน) พร้อม `company_id` และ `entity_version` ที่เพิ่มขึ้นทุกครั้ง — ผู้รับ: Lifecycle (Freeze/Unfreeze ใบสมัครตาม `application_effect`), Verification (`job_snapshots`, นับการปฏิเสธ), Notification (PM ตัดสิน 2026-11-15)

**ข้อยกเว้น (PM ตัดสิน 2026-11-18):** `REMOVE`/`RESTORE` **ไม่ใช้** เงื่อนไข `current_submission_id` — ใช้รอบรายงาน (`queue_item_id` ↔ `report_rounds`) แทน (event-contract E02/E04) เพราะรายการรายงานอาจผูกกับ submission ที่ถูกแทนที่ไปแล้ว คำตัดสินอื่นของ `JobVerified` ยังใช้กติกาด้านล่างตามเดิม

การเปลี่ยนสถานะที่เกิดจาก Event (`JobVerified`) ต้องผ่านทั้งสองเงื่อนไขก่อนรับ: `updateMany where status = <สถานะที่คาดไว้ของการตัดสินนั้น> AND current_submission_id = <submission_id ของ Event>`; ถ้า 0 แถว ⇒ Event เก่า/ซ้ำ ให้ข้ามอย่างเงียบ (log ระดับ `warn`) — ฝั่ง Verification ก็ทิ้งผลของ submission ที่ถูกแทนที่เช่นกัน (E01 รอบเก่าที่มาช้าถูกเก็บไว้เฉยๆ ไม่ส่ง `JobVerified`)

### 8.2.1 สถานะประกาศ × action ของ Verification (OD-06) — [spec สไลซ์ 2](superpowers/specs/2026-11-14-verification-slice2-design.md) §5.6

Verification **ตรวจเฉพาะสิ่งที่ตัวเองบังคับ** (ได้ = ตรวจจากข้อมูลของ Verification; — = ไม่ตรวจ ปล่อยให้ Job ปฏิเสธการเปลี่ยนสถานะเองตาม §8.2)

| สถานะประกาศ | รายงาน | ตรวจ (approve/reject) | ยกคำร้อง/ยืนยัน (dismiss/uphold-report) |
| :--- | :-: | :-: | :-: |
| `DRAFT`, `VERIFYING` | ไม่ได้ | — | — |
| `PUBLISHED` | ได้ (1 คน/ประกาศ) | ไม่ได้ | — (มีเฉพาะรายการ "ไม่นับ") |
| `PENDING_REVIEW` | ไม่ได้ | ได้ มีรายการ `JOB_REVIEW` เปิด (บริษัทที่ติดธง) | ไม่ได้ |
| `AUTO_REJECTED` (เลิกใช้) | ไม่ได้ | ไม่ได้ | ไม่ได้ |
| `ADMIN_REJECTED` | ไม่ได้ | ไม่ได้ | ไม่ได้ |
| `SUSPENDED` | ไม่ได้ (R5-G01) | ไม่ได้ | ได้ มีรายการ `JOB_REPORT` เปิด |
| `REMOVED` | ไม่ได้ | ไม่ได้ | ไม่ได้ |
| `CLOSED` | ได้ | ไม่ได้ | — |

หมายเหตุ: ประกาศ `CLOSED` ที่ถูกรายงานครบเกณฑ์ ⇒ Job ระงับ (`CLOSED → SUSPENDED`) และเก็บ `suspended_from_status`; `RESTORE` คืนสถานะเดิม (§8.2) — ตัดสินแล้ว 2026-11-15

### 8.2.2 บริษัทถูกระงับ (`CompanyStatusChanged` → `SUSPENDED`) — PM ตัดสิน 2026-11-15

- **ไม่เปลี่ยน `jobs.status`** (ไม่ใช้ `CLOSED`/`SUSPENDED` ของประกาศ เพราะแยกไม่ออกว่า HR ปิดเองหรือบริษัทถูกระงับ ทำให้คืนสถานะไม่ได้) — ซ่อนและปิดรับสมัครด้วยเงื่อนไขร่วม: **ประกาศ `PUBLISHED` และบริษัท `VERIFIED`** จาก `company_snapshots` (Job ใช้ในหน้าค้นหา/รายละเอียดสาธารณะ, Lifecycle ใช้ตอน `POST /applications`) บริษัทกลับเป็น `VERIFIED` ⇒ ประกาศกลับมาเห็นและรับสมัครได้เองโดยไม่ต้องคืนสถานะ — เงื่อนไข "บริษัท `VERIFIED`" ใช้กับ `/search/jobs` (รวม `meta.total`) และ `/jobs/{id}` ทั้งประกาศ `PUBLISHED` และ `CLOSED` (ไม่ใช่ `VERIFIED` ⇒ `404`) (PM ตัดสิน 2026-11-18, PJS-01/02)
- **ใบสมัครค้าง:** Lifecycle Freeze ตัวนับ SLA ของใบสมัครที่ยังไม่ `IN_PROGRESS` ขณะบริษัทถูกระงับ (HR ถูกระงับบัญชี ตอบไม่ได้ จึงไม่ให้หมดเวลาโดยไม่ใช่ความผิด) และ Unfreeze เมื่อบริษัทกลับเป็น `VERIFIED`; `IN_PROGRESS` ไม่ถูกตัดอัตโนมัติ ให้อาจารย์ตัดสินฝึกต่อ/ยุติ (README 5.2.2)
- โควตาที่จองไว้ไม่ถูกคืนเพราะการระงับบริษัท

### 8.3 Company Status (Identity) — README 5.6
`PENDING` → (`VERIFIED` | `NEED_MORE_INFO` | `REJECTED`)  •  `NEED_MORE_INFO` → `PENDING` (ส่งเอกสารเพิ่ม)  •  `VERIFIED` ⇄ `SUSPENDED`  •  `REJECTED` สมัครใหม่ได้โดยแก้ข้อมูล → `PENDING`

### 8.4 Advisor Link (Identity) — README 5.6
`NONE` → `LINKED` ตอนอาจารย์สร้างนักศึกษา (ไม่มีขั้น `ADVISOR_LINK_PENDING` — ปรับ Requirement 2026-11-21) • เปลี่ยนอาจารย์: **Admin ย้ายตรงเป็น `LINKED`** กับอาจารย์คนใหม่เท่านั้น (ใบสมัครที่ค้างย้ายตามนักศึกษาด้วย `AdvisorLinkChanged`)

### 8.5 อื่นๆ
- **Review:** `SUBMITTED` → `PUBLISHED` (Verification ตอบให้เผยแพร่ทันที ไม่สแกนเนื้อหา; `HELD` เลิกใช้) ; รีวิวที่เผยแพร่แล้ว → `REMOVED` โดย Admin (จากคิว `REVIEW_REPORT`)
- **Problem Report:** `OPEN` → `ACKNOWLEDGED` → `RESOLVED` (ไม่ย้อน)
- **Certificate:** `VALID` → `REVOKED` (ไม่ย้อน)
- **Queue Item:** `OPEN` → `IN_REVIEW` → `RESOLVED`
