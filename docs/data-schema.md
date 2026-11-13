# 🗄️ Data Schema & State Machine (InternPath)

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
| `UserStatus` | `PENDING_EMAIL`, `PENDING_APPROVAL` (อาจารย์), `ACTIVE`, `SUSPENDED`, `DELETED` | identity |
| `CompanyStatus` | `PENDING`, `NEED_MORE_INFO`, `VERIFIED`, `REJECTED`, `SUSPENDED` | identity |
| `CompanyMemberRole` | `OWNER`, `MEMBER` | identity |
| `AdvisorLinkStatus` | `NONE`, `ADVISOR_LINK_PENDING`, `LINKED` | identity |
| `JobStatus` | `DRAFT`, `VERIFYING`, `PUBLISHED`, `PENDING_REVIEW`, `AUTO_REJECTED`, `ADMIN_REJECTED`, `SUSPENDED`, `REMOVED`, `CLOSED` (ความหมายดู README 5.1.1) | job |
| `WorkMode` | `ONSITE`, `REMOTE`, `HYBRID` | job |
| `JobCategory` | `TECH_IT`, `BUSINESS_MARKETING`, `CORPORATE_SERVICES` | job |
| `QuotaReservationStatus` | `RESERVED`, `CONFIRMED`, `RELEASED` | job |
| `RiskLevel` | `LOW`, `MEDIUM`, `HIGH` | verification |
| `QueueItemType` | `JOB_REVIEW`, `JOB_APPEAL`, `COMPANY_ACCOUNT` (ตรวจบัญชีบริษัทที่ติดธง `UNDER_REVIEW` — **ไม่ใช่** การอนุมัติบัญชีสมัครใหม่ ซึ่งอยู่ที่หน้า Admin ของ Identity), `JOB_REPORT`, `REVIEW_HELD`, `REVIEW_REPORT` | verification |
| `QueueItemStatus` | `OPEN`, `IN_REVIEW`, `RESOLVED` | verification |
| `ApplicationStatus` | `PENDING`, `HR_ACCEPTED`, `ADVISOR_PENDING`, `ADVISOR_APPROVED`, `IN_PROGRESS`, `EVALUATED_PASS`, `EVALUATED_FAIL`, `FAIL_DISPUTED`, `REEVALUATION_REQUESTED`, `COMPLETED`, `TERMINATED`, `NO_EVALUATION`, `HR_REJECTED`, `STUDENT_DECLINED`, `ADVISOR_REJECTED`, `OFFER_RESCINDED`, `WITHDRAWN`, `EXPIRED`, `CANCELLED` (ความหมายดู README 5.2.1) | lifecycle |
| `AcademicResult` | `ACADEMIC_PASS`, `ACADEMIC_FAIL`, `REPEAT_REQUIRED` | lifecycle |
| `TerminatedBy` | `COMPANY`, `STUDENT`, `ADVISOR`, `ADMIN` | lifecycle |
| `CertificateStatus` | `VALID`, `REVOKED` | lifecycle |
| `ReviewStatus` | `SUBMITTED`, `PUBLISHED`, `HELD`, `REMOVED` | lifecycle |
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

### 2.4 สำเนา (Snapshot) ที่แต่ละ Service เก็บได้
ตารางเจ้าของข้อมูลฉบับย่ออยู่ใน README 5.8 — ตารางด้านล่างระบุ **ฟิลด์** ที่ Service อื่นเก็บเป็นสำเนาได้ (Snapshot):

| ข้อมูล | เจ้าของ | สำเนาที่ | ฟิลด์ที่เก็บ | อัปเดตด้วย |
| :--- | :--- | :--- | :--- | :--- |
| ชื่อ/โลโก้/ป้ายบริษัท/สถานะ | identity | job, lifecycle, verification | `company_snapshots` | `CompanyStatusChanged` |
| สิทธิ์ Featured/Fast-Track | identity | job, verification | `company_entitlements` | `CompanyEntitlementChanged` |
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
| password_hash | text | argon2id |
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

**`student_profiles_identity`** (ข้อมูลระบุตัวตนขั้นต่ำ; เรซูเม่อยู่ที่ Lifecycle): `user_id PK`, `student_code`, `major`, `year_level`, `advisor_id (FK users)`, `advisor_link_status AdvisorLinkStatus`, `pending_advisor_id null`, `advisor_link_updated_at`

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

**`company_members`**: `id`, `company_id`, `user_id` (unique), `member_role CompanyMemberRole`, `invited_by`, `joined_at` — partial unique: **1 OWNER ต่อบริษัท** (`UNIQUE(company_id) WHERE member_role='OWNER'`)

**`company_invitations`**: `id`, `company_id`, `email`, `token_hash`, `expires_at`, `accepted_at null`, `invited_by`

**`owner_transfers`**: `id`, `company_id`, `from_user_id`, `to_user_id`, `status (PENDING|ACCEPTED|CANCELLED|EXPIRED)`, `requested_at`, `responded_at`

**`company_documents`**: `id`, `company_id`, `doc_type`, `object_key` (Private bucket), `mime`, `size_bytes`, `uploaded_by`, `created_at`

**`email_tokens`**: `id`, `user_id`, `purpose (VERIFY_EMAIL|RESET_PASSWORD)`, `token_hash`, `expires_at`, `used_at null`

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
| created_by | uuid | `ref:identity` |
| category | JobCategory | |
| job_title | text | **ฟิลด์ข้อความอิสระ** (ต้องตรวจซ้ำเมื่อแก้) |
| description | text | ข้อความอิสระ |
| responsibilities | text | ข้อความอิสระ |
| qualifications | text | ข้อความอิสระ |
| allowance_type | `AMOUNT`/`NONE` | ข้อความอิสระ (ถือเป็นข้อความ) |
| allowance_amount_thb | int null | |
| allowance_text | text null | ข้อความอิสระ |
| location | text | ข้อความอิสระ |
| work_mode | WorkMode | |
| hours_per_week | int | |
| internship_period_start / _end | date | ช่วงเวลาฝึกที่ประกาศ |
| target_majors | text[] | **ฟิลด์โครงสร้าง** |
| quota | int | **ฟิลด์โครงสร้าง** — ห้ามแก้ให้ต่ำกว่า `quota_reserved + quota_confirmed` (`422 QUOTA_BELOW_COMMITTED`) |
| quota_reserved | int default 0 | CHECK `quota_reserved + quota_confirmed <= quota` |
| quota_confirmed | int default 0 | |
| application_deadline | date | **ฟิลด์โครงสร้าง** |
| status | JobStatus | |
| featured | bool default false | มีผลเมื่อ `PUBLISHED` และบริษัท `featured_enabled` |
| current_submission_id | uuid null | |
| verifying_since | timestamptz null | ไว้ทำ Fail-safe 5 นาที |
| published_at, closed_at | timestamptz null | |
| entity_version | int | เพิ่มทุกการเปลี่ยนสถานะ |
| version | int | optimistic lock |

Index: (`status`, `featured` DESC, `published_at` DESC), GIN `target_majors`, ค้นหาข้อความ: `tsvector`/trigram

**`job_submissions`**: `id (=submission_id)`, `job_id`, `kind (NEW|EDIT|RESUBMIT)`, `changed_fields text[]`, `submitted_by`, `submitted_at`, `result_decision null`, `resolved_at null` — ใช้นับ Rate Limit **5 ครั้ง/วัน/บริษัท** (นับตามวัน `Asia/Bangkok`)

**`quota_reservations`** (idempotent ด้วย `application_id`)
| ฟิลด์ | ชนิด |
| :--- | :--- |
| application_id | uuid **PK** (`ref:lifecycle`) |
| job_id | uuid FK jobs |
| status | QuotaReservationStatus |
| reserved_at, confirmed_at, released_at | timestamptz |
| release_reason | text null |

การจอง: `UPDATE jobs SET quota_reserved = quota_reserved+1 WHERE id=? AND quota_reserved+quota_confirmed < quota` (affected=0 ⇒ โควตาเต็ม) + `INSERT quota_reservations ON CONFLICT (application_id) DO NOTHING` ใน Transaction เดียว

**`company_snapshots`**: `company_id PK`, `name`, `logo_key`, `status`, `university_partner`, `verified_badge`, `entity_version`

**`company_entitlements`**: `company_id PK`, `featured_enabled`, `fast_track_enabled`, `entity_version`

**`company_flags`**: `company_id PK`, `under_review bool`, `entity_version`

+ ตารางร่วม: `outbox_events`, `processed_events`, `status_history` (entity = JOB)

---

## 5. Verification & Trust Service (`verification_db`)

**`blacklist_terms`** (คำต้องห้าม — แก้ได้ผ่าน API; ค่าตั้งต้น seed ใน migration แบบ insert-if-missing): `id`, `term unique` (เก็บตัวพิมพ์เล็ก; จับแบบ substring ไม่สนตัวพิมพ์), `severity (HARD|SOFT)` (`HARD` = ปฏิเสธทันทีเมื่อพบใน `job_title`/`description` โดยไม่อยู่ในประโยคปฏิเสธ; `SOFT` = เพิ่มคะแนนตาม `weight`), `weight int null` (เฉพาะ `SOFT`), `category`, `enabled`, `created_by null`, `created_at`

**`negation_cues`**: `id`, `cue unique` (เช่น `ไม่มี`, `ไม่เก็บ`, `ไม่ต้อง`, `no`, `not`, `without`), `enabled` — ตรวจคำต้องห้ามในประโยคปฏิเสธ (README 5.1): cue ต้องอยู่ก่อนคำในประโยคเดียวกันและห่างไม่เกิน `NEGATION_WINDOW.max_gap` ตัวอักษร

**`risk_rules`** (กฎให้คะแนน): `code PK`, `weight`, `params jsonb`, `enabled`, `updated_by null`, `updated_at` — `CONTACT_IN_TEXT`, `HARD_TERM_OTHER_FIELD`, `ALLOWANCE_HIGH`, `HOURS_EXCESSIVE`, `DESCRIPTION_TOO_SHORT`, `SOFT_TERMS`, `NO_ALLOWANCE`, `NEGATION_WINDOW` (ค่าตั้งต้นและความหมายดู `docs/superpowers/specs/2026-11-13-verification-slice1-design.md` §5.3)

**`evaluations`** (ผลตรวจประกาศแต่ละ submission)
`id`, `job_id`, `company_id`, `submission_id unique`, `submission_kind`, `submitted_at` (จาก E01 — ใช้ตัดสินว่า "ผลตรวจล่าสุด" คือแถวไหน ไม่ใช้เวลาที่ประมวลผล), `content jsonb` (ข้อความที่สแกนหลัง normalize — ไฮไลต์อ้างอิงข้อความนี้; **ห้าม log**), `risk_score int`, `risk_level`, `matched_keywords jsonb` (`[{term, field, negated, start, end}]`), `negated_only bool`, `reasons jsonb`, `decision (APPROVE|PENDING_REVIEW|AUTO_REJECT)`, `company_flag_under_review bool`, `fast_track bool` (snapshot ณ ตอนส่ง), `evaluated_at` | Index (`job_id`, `submitted_at`)

**`appeals`**: `id`, `job_id unique` (1 ครั้ง/ประกาศ — **Verification เป็นผู้บังคับกฎนี้** README 5.1.5), `submission_id`, `statement text`, `status (OPEN|APPROVED|DENIED)`, `created_at`, `decided_by null`, `decided_at null` — ผล Admin เป็นที่สิ้นสุด

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
| origin | `EVALUATION`/`VERIFY_TIMEOUT`/`APPEAL`/`REPORT_THRESHOLD`/`REPORT_UNCOUNTED`/`REJECTION_THRESHOLD`/`ADMIN_FLAG` | ที่มาของรายการ (ใช้แยก "ผลตรวจที่มาหลัง Fail-safe"; `REPORT_THRESHOLD` = ประกาศถูกระงับเพราะรายงานครบเกณฑ์, `REPORT_UNCOUNTED` = รายงานที่ไม่นับเข้าเกณฑ์ ประกาศยัง `PUBLISHED`, `REJECTION_THRESHOLD` = ธงบริษัทติดอัตโนมัติ) |
| priority | `NORMAL`/`FAST_TRACK` | ตาม entitlement ของบริษัท ณ เวลาเข้าคิว |
| risk_level | RiskLevel null | สำหรับแถบสี เขียว/เหลือง/แดง |
| is_appeal | bool | ป้าย APPEAL |
| due_at | timestamptz | = created_at + 48 ชม. (หรือ 12 ชม. สำหรับ FAST_TRACK) |
| status | QueueItemStatus | |
| assigned_to | uuid null | |
| resolution | text null | รหัสผลการตัดสิน: `ADMIN_APPROVE`, `ADMIN_REJECT`, `SUPERSEDED` (เหตุผลที่ Admin ปฏิเสธเก็บใน `status_history.reason` ของแถว `RESOLVED`) |
| created_at, resolved_at | | |

`OVERDUE` = `status != RESOLVED AND now() > due_at` (คำนวณตอนอ่าน) | Index (`status`, `priority`, `due_at`) | **partial unique index** (`target_id`, `type`) เมื่อ `status <> 'RESOLVED'` — รายการเปิดของ (เป้าหมาย, ชนิด) เดียวกันซ้อนกันไม่ได้ (เขียนมือใน migration)

**`job_reports`**: `id`, `job_id`, `reporter_user_id`, `category`, `detail`, `counted bool` (false เมื่อผู้รายงานถูกยกคำร้องติด 3 ครั้ง), `status (OPEN|DISMISSED|UPHELD)`, `created_at`, `resolved_at` — UNIQUE (`job_id`, `reporter_user_id`) [รายงานได้ครั้งเดียวต่อประกาศ แม้หลังรีเซ็ต] | จำกัด 5 ครั้ง/วัน/ผู้ใช้ (นับจาก `created_at` ตามปฏิทิน `Asia/Bangkok`) | index (`reporter_user_id`, `created_at`) | `category` ค่าตาม api-contract §11 (`JobReportCategory`), `detail` 20–1000 ตัวอักษร (ห้าม log)

**`job_report_counters`**: `job_id PK`, `counted_reports int`, `reset_at null`, `suspended_at null`

**`reporter_stats`**: `user_id PK`, `consecutive_dismissed int` — รีเซ็ตเป็น 0 เมื่อมีรายงานที่ถูกยืนยัน; `>= 3` ⇒ รายงานใหม่ `counted=false`

**`company_rejection_events`**: `id`, `company_id`, `job_id`, `kind (AUTO_REJECTED|ADMIN_REJECTED|SUSPENDED|REMOVED)`, `occurred_at` (= `changed_at` ของ E03), `source_event_id uuid UNIQUE` (= `event_id` ของ E03 ที่ทำให้เกิดเหตุการณ์ — กันนับซ้ำเมื่อ Event ถูกส่งซ้ำ) — นับ 3 ครั้งใน 30 วัน ⇒ ติดธง; นับเฉพาะหลัง `company_flags.cleared_at` (เคลียร์ธงแล้วเริ่มนับใหม่) | index (`company_id`, `occurred_at`)

**`company_flags`**: `company_id PK`, `under_review bool`, `set_by` (`SYSTEM`|`ADMIN`), `set_reason`, `set_at`, `trigger_count int null` (จำนวนเหตุการณ์ปฏิเสธที่ทำให้ติดธงอัตโนมัติ), `cleared_by null`, `cleared_at null`, `entity_version` (เพิ่มทีละ 1 ทุกครั้งที่ธงเปลี่ยน; ใช้เป็น `entity_version` ของ E18) — แถวถูกสร้างเมื่อมีเหตุการณ์/คำสั่งแรกของบริษัท; "เคยติดธง" = `set_at` ไม่ว่าง

**`company_entitlements`**: (สำเนา) `company_id PK`, `fast_track_enabled`, `entity_version`

**`review_moderations`**: `id`, `review_id unique`, `company_id`, `decision`, `reasons jsonb`, `status (PASSED|HELD|ADMIN_PUBLISHED|ADMIN_REMOVED)`, `queue_item_id null`, `created_at`

**`review_reports`**: `id`, `review_id`, `reporter_user_id`, `reason`, `created_at` — UNIQUE (`review_id`, `reporter_user_id`)

+ ตารางร่วม: `outbox_events`, `processed_events`, `status_history` (entity = COMPANY_FLAG/QUEUE_ITEM), `admin_audit_log` — `status_history` และ `admin_audit_log` บังคับ append-only ด้วย trigger ใน migration (UPDATE/DELETE ถูกปฏิเสธ; `admin_audit_log.target_id` เป็น text เพราะบางรายการไม่ใช่ uuid เช่น `risk_rules`)

---

## 6. Student Experience & Internship Lifecycle Service (`lifecycle_db`)

**`student_profiles`**: `user_id PK` (`ref:identity`), `headline`, `skills text[]`, `bio`, `portfolio_url null`, `major`, `year_level`, `updated_at` — *major/year_level สำเนาจาก Identity ตอนสร้าง/เปลี่ยน (ผ่าน API ตอนสมัคร)*

**`resumes`**: `id`, `student_user_id`, `object_key` (Private), `mime = application/pdf`, `size_bytes`, `is_primary`, `uploaded_at`, `deleted_at`

**`student_advisor_links`**: `student_user_id PK`, `advisor_user_id null`, `link_status`, `entity_version`, `updated_at`

**`company_snapshots`**: เหมือน job_db (ชื่อ/โลโก้/สถานะ/partner)

**`job_snapshots`**: `job_id PK`, `company_id`, `status JobStatus`, `target_majors text[]`, `title`, `entity_version`

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
**`delivery_logs`**: `id`, `notification_id`, `channel NotificationChannel`, `to_user_id`, `status (SENT|FAILED)`, `error null`, `attempts`, `sent_at` — **ไม่เก็บอีเมลปลายทางถาวร** (ดึงจาก Identity ตอนส่ง; log เก็บแค่ `user_id`)
**`templates`**: `id`, `key` (เช่น `application.ADVISOR_APPROVED`), `channel`, `subject_th`, `body_th`, `active`
**`preferences`** *(optional)*: `user_id`, `channel`, `enabled`

+ `processed_events`, `status_history` ไม่จำเป็น

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

  IN_PROGRESS/หลังสิ้นสุด end_date ที่ HR ไม่ประเมิน >14 วัน + Admin ยืนยัน ─► NO_EVALUATION
  ประกาศ AUTO_REJECTED/ADMIN_REJECTED/REMOVED (ก่อน ADVISOR_APPROVED) ─► CANCELLED (release)
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
| `PENDING` | `CANCELLED` | SYSTEM | ประกาศ `AUTO_REJECTED`/`ADMIN_REJECTED`/`REMOVED` | — |
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
| `IN_PROGRESS` | `NO_EVALUATION` | ADMIN | เกิน `end_date` 14 วัน & ระบบแจ้งอาจารย์/Admin แล้ว | ไม่มี Certificate |
| `EVALUATED_FAIL` | `FAIL_DISPUTED` | STUDENT | ภายใน 7 วัน | — |
| `FAIL_DISPUTED` | `REEVALUATION_REQUESTED` | ADVISOR | `reevaluation_used = false` | `reevaluation_used = true` |
| `FAIL_DISPUTED` | `EVALUATED_FAIL` | ADVISOR | ยืนยันผลเดิม | — |
| `REEVALUATION_REQUESTED` | `EVALUATED_PASS` / `EVALUATED_FAIL` | HR | — | `evaluations.round = 2` |
| `EVALUATED_PASS` | `COMPLETED` | ADVISOR | บันทึก `academic_result` | อาจารย์เปลี่ยน PASS เป็น FAIL ได้ไม่ระบุใน README — ให้ถือว่า **บันทึกได้ทั้ง 3 ค่า** |
| `EVALUATED_FAIL` | `COMPLETED` | ADVISOR | หน้าต่างโต้แย้ง 7 วันสิ้นสุดโดยไม่มีการโต้แย้ง หรือการโต้แย้งจบแล้ว; `academic_result ∈ {ACADEMIC_FAIL, REPEAT_REQUIRED}` เท่านั้น | — |
| `TERMINATED` / `NO_EVALUATION` | (บันทึกผล) | ADVISOR | บันทึก `academic_result` โดยไม่เปลี่ยนสถานะ | — |

\* `TERMINATED` ปกติเป็นปลายทาง ยกเว้นกรณีฝึกจริง ≥ 30 วันก่อนยุติ ซึ่งยังเข้าสู่การประเมินได้ (README 5.2.2)

**บริษัทถูกระงับขณะ `IN_PROGRESS`:** Lifecycle รับ `CompanyStatusChanged(SUSPENDED)` → ตั้ง `company_suspended_decision = PENDING` + แจ้งอาจารย์/นักศึกษา (ไม่เปลี่ยนสถานะ) → อาจารย์เลือก `continue` (`CONTINUE`) หรือ `terminate` (`TERMINATED`, `terminated_by = ADVISOR`)

**Release quota** = เรียก `POST /internal/jobs/{id}/quota/release` ด้วย `application_id` (idempotent)

**ข้อควรทำใน Transaction เดียว:** เปลี่ยนสถานะ (`updateMany where status=เดิม`) + เขียน `status_history` + เขียน `outbox_events(ApplicationStatusChanged)`

> **ข้อกำหนดที่ทีมยืนยันแล้ว (ส่วนที่ README ไม่ได้ระบุ):** README ยังไม่ระบุ (1) `TERMINATED` ที่ฝึกครบ ≥30 วันแล้วจะผ่านสถานะ `EVALUATED_*` หรือไม่ (ข้อความ 5.2.2 ว่า "HR ยังประเมินและออกใบรับรองได้" — ตารางนี้ถือว่า **ใช่ ย้อนจาก `TERMINATED` ไป `EVALUATED_*`**) (2) อาจารย์ที่เห็นว่าบริษัทให้ PASS แต่อยากให้ผลวิชาเป็น FAIL ทำได้หรือไม่ (ที่นี่ถือว่าทำได้เพราะ README ห้ามเฉพาะเปลี่ยน FAIL→PASS)

### 8.2 Job Status (Job Management เจ้าของ) — README 5.1, 5.1.1

| จาก | ไป | ที่มา | Event |
| :--- | :--- | :--- | :--- |
| `DRAFT` | `VERIFYING` | HR ส่งตรวจ (ผ่าน Guard ข้อมูลบังคับ, Rate limit 5/วัน, บริษัท `VERIFIED`) | ส่ง `JobSubmitted` |
| `PUBLISHED` | `VERIFYING` | HR แก้ไข **ฟิลด์ข้อความอิสระ** | ส่ง `JobSubmitted` (kind=EDIT) |
| `PUBLISHED` | `PUBLISHED` | HR แก้ฟิลด์โครงสร้าง (`quota`, `deadline`, `target_majors`) | ไม่ส่ง |
| `VERIFYING` | `PUBLISHED` | `JobVerified.APPROVE` | `JobStatusChanged` |
| `VERIFYING` | `PENDING_REVIEW` | `JobVerified.PENDING_REVIEW` **หรือ** Fail-safe หมดเวลา 5 นาที (Job ตั้งเอง, `reason_code=VERIFY_TIMEOUT`) | `JobStatusChanged` |
| `VERIFYING` | `AUTO_REJECTED` | `JobVerified.AUTO_REJECT` | `JobStatusChanged` |
| `AUTO_REJECTED` | `PENDING_REVIEW` | HR อุทธรณ์ผ่าน Verification (ครั้งเดียว/ประกาศ — Verification ตรวจและบันทึก `appeals`) → `JobVerified(APPEAL_ACCEPTED)` | `JobStatusChanged` |
| `AUTO_REJECTED` | `VERIFYING` | HR แก้ไขแล้วส่งใหม่ | `JobSubmitted` |
| `PENDING_REVIEW` | `PUBLISHED` | `JobVerified.ADMIN_APPROVE` | `JobStatusChanged` |
| `PENDING_REVIEW` | `ADMIN_REJECTED` | `JobVerified.ADMIN_REJECT` | `JobStatusChanged` |
| `ADMIN_REJECTED` | `VERIFYING` | HR แก้แล้วส่งใหม่ | `JobSubmitted` |
| `PUBLISHED` | `SUSPENDED` | `ReportThresholdReached` (E04) | `JobStatusChanged` |
| `SUSPENDED` | `PUBLISHED` | `JobVerified.RESTORE` | `JobStatusChanged` |
| `SUSPENDED` | `REMOVED` | `JobVerified.REMOVE` | `JobStatusChanged` |
| `PUBLISHED` | `CLOSED` | HR ปิดรับ หรือถึง deadline | `JobStatusChanged` |
| `CLOSED` | `PUBLISHED` | HR เปิดใหม่ (ถ้า deadline/โควตายังอยู่) *(ทีมยืนยันแล้ว; README ไม่ได้ระบุ)* | `JobStatusChanged` |

การเปลี่ยนสถานะที่เกิดจาก Event ใช้ `updateMany where status = <สถานะที่คาดไว้ของการตัดสินนั้น>`; ถ้า 0 แถว ⇒ Event เก่า/ซ้ำ ให้ข้ามอย่างเงียบ (log ระดับ `warn`) และให้ Verification ตรวจ `submission_id` เทียบ `current_submission_id` เพื่อทิ้งผลของ submission ที่ถูกแทนที่

### 8.2.1 สถานะประกาศ × action ของ Verification (OD-06) — [spec สไลซ์ 2](superpowers/specs/2026-11-14-verification-slice2-design.md) §5.6

Verification **ตรวจเฉพาะสิ่งที่ตัวเองบังคับ** (✓ = ตรวจจากข้อมูลของ Verification; — = ไม่ตรวจ ปล่อยให้ Job ปฏิเสธการเปลี่ยนสถานะเองตาม §8.2)

| สถานะประกาศ | รายงาน | ตรวจ (approve/reject) | อุทธรณ์ | ยกคำร้อง/ยืนยัน (dismiss/uphold-report) |
| :--- | :-: | :-: | :-: | :-: |
| `DRAFT`, `VERIFYING` | ✗ | — | ✗ | — |
| `PUBLISHED` | ✓ (1 คน/ประกาศ) | ✗ | ✗ | — (มีเฉพาะรายการ "ไม่นับ") |
| `PENDING_REVIEW` | ✗ | ✓ มีรายการ `JOB_REVIEW`/`JOB_APPEAL` เปิด | ✗ | ✗ |
| `AUTO_REJECTED` | ✗ | ✗ | ✓ ผลล่าสุดเป็น `AUTO_REJECT` และยังไม่เคยอุทธรณ์ | ✗ |
| `ADMIN_REJECTED` | ✗ | ✗ | ✗ | ✗ |
| `SUSPENDED` | ✗ (R5-G01) | ✗ | ✗ | ✓ มีรายการ `JOB_REPORT` เปิด |
| `REMOVED` | ✗ | ✗ | ✗ | ✗ |
| `CLOSED` | ✓ | ✗ | ✗ | — |

หมายเหตุ: §8.2 ให้ Job ระงับได้เฉพาะจาก `PUBLISHED` — ประกาศ `CLOSED` ที่ถูกรายงานครบเกณฑ์จะได้ E04 และรายการคิวแต่ Job อาจไม่เปลี่ยนสถานะ (ต้องตกลงกับ Job: ให้รับ E04 ตอน `CLOSED` หรือจำกัดให้รายงานได้เฉพาะ `PUBLISHED`)

### 8.3 Company Status (Identity) — README 5.6
`PENDING` → (`VERIFIED` | `NEED_MORE_INFO` | `REJECTED`)  •  `NEED_MORE_INFO` → `PENDING` (ส่งเอกสารเพิ่ม)  •  `VERIFIED` ⇄ `SUSPENDED`  •  `REJECTED` สมัครใหม่ได้โดยแก้ข้อมูล → `PENDING`

### 8.4 Advisor Link (Identity) — README 5.6
`NONE` → (`ADVISOR_LINK_PENDING`: นักศึกษาเลือก) → (`LINKED`: อาจารย์ยืนยัน) • เปลี่ยนอาจารย์: `LINKED` → `ADVISOR_LINK_PENDING` (เลือกคนใหม่ ขณะที่ใบสมัครที่ค้างยังอยู่กับอาจารย์เดิมจนกว่าอาจารย์ใหม่ยืนยัน) หรือ Admin ย้ายตรงเป็น `LINKED`

### 8.5 อื่นๆ
- **Review:** `SUBMITTED` → (`PUBLISHED` | `HELD`) ; `HELD` → (`PUBLISHED` | `REMOVED`) โดย Admin
- **Problem Report:** `OPEN` → `ACKNOWLEDGED` → `RESOLVED` (ไม่ย้อน)
- **Certificate:** `VALID` → `REVOKED` (ไม่ย้อน)
- **Queue Item:** `OPEN` → `IN_REVIEW` → `RESOLVED`
