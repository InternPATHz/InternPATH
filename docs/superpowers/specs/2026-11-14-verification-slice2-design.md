# Design: Verification & Trust — สไลซ์ 2 "รายงานประกาศ, ระงับอัตโนมัติ, ธงบริษัท"

- วันที่: 2026-11-14
- เจ้าของ: PM (`apps/verification`)
- สถานะ: **ร่างรออนุมัติ**
- ต่อจาก: [สไลซ์ 1](2026-11-13-verification-slice1-design.md) (ตรวจประกาศ/คิว/อุทธรณ์/กฎ — merge เข้า `main` แล้ว) และ [messaging](2026-11-13-messaging-outbox-design.md)
- เอกสารต้นทาง (ถ้าขัดกัน ให้ยึดเอกสารเหล่านี้แล้วแก้เอกสารนี้): [README](../../../README.md) §5.1.3-5.1.4, [data-schema.md](../../data-schema.md) §5 และ §8.2, [api-contract.md](../../api-contract.md) §6, [event-contract.md](../../event-contract.md) E02/E03/E04/E18
- วิธีทำ: **แบบ A** (PM เลือก) — ทำทั้งสไลซ์โดยยึด contract ในเอกสารและ `libs/contracts` ทดสอบด้วย Event จำลอง/RabbitMQ จริงของเรา ไม่รอ Job Service จริง

## 1. เจตนาและเหตุผล

ประกาศที่ผ่านการตรวจแล้วก็ยังหลอกได้ (แก้หลังอนุมัติ, เนื้อหาที่ระบบจับไม่ได้) สไลซ์ 2 ปิดช่องนี้ด้วยแรงของนักศึกษาและประวัติบริษัท: นักศึกษารายงานประกาศ → ครบ 3 บัญชีระงับทันทีแล้วให้ Admin ชี้ขาด; บริษัทที่ประกาศถูกตีกลับ/ระงับ/ลบซ้ำๆ ถูกติดธง `UNDER_REVIEW` และประกาศใหม่ทุกฉบับต้องผ่าน Admin (กลไกฝั่งตรวจประกาศมีอยู่แล้วจากสไลซ์ 1 ที่อ่าน `company_flag_under_review` จาก E01) เป็น demo ไฮไลต์สัปดาห์ที่ 3: รายงาน 3 บัญชี → ประกาศถูกระงับ → Admin ยกคำร้อง/ยืนยัน

## 2. เป้าหมาย / ไม่ใช่เป้าหมาย / สิ่งที่ถือว่าล้มเหลว

**เป้าหมาย**
1. `POST /jobs/{job_id}/reports` (นักศึกษา): รับรายงานตามกติกา README 5.1.3 — 1 ครั้ง/ประกาศ/คน, ไม่เกิน 5 ครั้ง/วัน/คน, ต้องมีหมวดและรายละเอียด
2. นับรายงานแบบ "บัญชีที่นับเข้าเกณฑ์"; ครบ 3 บัญชี ⇒ ส่ง E04 `ReportThresholdReached` (Job ระงับประกาศ) + เข้าคิว Admin (`JOB_REPORT`) ใน Transaction เดียว และไม่ส่งซ้ำ แม้รายงานเข้าพร้อมกัน
3. Admin ตัดสินรายงานได้: `dismiss-report` ⇒ `JobVerified(RESTORE)`; `uphold-report` ⇒ `JobVerified(REMOVE)`; รีเซ็ตตัวนับ/นับ "ยกคำร้องติดกัน" ของผู้รายงาน (กันรายงานเท็จ — ครบ 3 ครั้งติด รายงานถัดไปของคนนั้นไม่นับเข้าเกณฑ์แต่ยังเข้าคิว)
4. นับการถูกตีกลับ/ระงับ/ลบของบริษัทจาก E03 (`company_rejection_events`) ครบ 3 ครั้งใน 30 วัน ⇒ ติดธง `UNDER_REVIEW` + ส่ง E18 + เข้าคิว `COMPANY_ACCOUNT`
5. Admin ตั้ง/เคลียร์ธงเองได้ (`PUT /admin/flags/companies/{id}/under-review`, `GET /admin/flags/companies`, action `company-clear-flag` ในคิว)
6. ตาราง "สถานะประกาศ × action" ในเอกสาร (OD-06) และกติกา Fast-Track เฉพาะคิวตรวจประกาศ/อุทธรณ์ (OD-10) เป็นลายลักษณ์อักษร
7. ทุกการกระทำของ Admin เขียน `admin_audit_log` + `status_history` เหมือนสไลซ์ 1

**ไม่ใช่เป้าหมาย**
- รายงานรีวิว (`POST /reviews/{id}/reports`), ตรวจรีวิว (E09/E10), หน้าเว็บ, Gateway routing, การผูก Notification — สไลซ์ 3 / ทีมอื่น
- การเปลี่ยนสถานะประกาศ (Job เป็นเจ้าของ), การแจ้งอาจารย์ที่ปรึกษา (Lifecycle ทำเมื่อรับ E03 `to=SUSPENDED`)
- ปัจจัยเสี่ยง "ประวัติถูกปฏิเสธล่าสุดของบริษัท" ในตัวตัดสิน: **ตัดออกถาวร** — README ไม่ได้กำหนดกฎนี้ (กำหนดเพียงธง `UNDER_REVIEW` ซึ่งมีผลอยู่แล้ว) ใช้ธงแทน (ตัดสินแล้ว; spec สไลซ์ 1 §2 ที่เคยเลื่อนมาไว้ที่นี่ให้ถือว่าปิด)
- สถานะ `IN_REVIEW` ของคิว (ยังไม่มี "รับงาน")

**สิ่งที่ถือว่าล้มเหลวแม้โค้ดจะรัน**
- ส่ง E04 ซ้ำ หรือไม่ส่งเลยเมื่อรายงานที่ 3 เข้าพร้อมกัน; ประกาศหนึ่งมีรายการ `JOB_REPORT` เปิดซ้อนกัน
- นักศึกษารายงานประกาศเดียวกันได้ 2 ครั้ง หรือเกิน 5 ครั้ง/วัน
- HR หรือบริษัทเห็นว่าใครรายงาน (ตัวตนผู้รายงานออกได้เฉพาะ Admin)
- นับเหตุการณ์ปฏิเสธซ้ำเมื่อ E03 ถูกส่งซ้ำ (retry) หรือสลับลำดับ
- ธงติดซ้ำ/E18 ซ้ำเมื่อธงเปิดอยู่แล้ว; เคลียร์ธงแล้วถูกติดกลับทันทีด้วยเหตุการณ์เก่าที่ Admin เพิ่งตรวจไปแล้ว
- Log มี `detail` ของรายงาน

## 3. ข้อจำกัด

- ใช้ `MessagingModule`/`OutboxWriter`/`EventConsumer` ของ `libs/common` เท่านั้น; Event ใช้ชนิดจาก `libs/contracts` (E04/E18 และ `ReportJobRequest`/`JobReportCategory` มีแล้ว)
- Job เป็นเจ้าของสถานะประกาศ: Verification ส่งผลตัดสิน (`REMOVE`/`RESTORE`) และ E04 เท่านั้น ไม่แก้สถานะเอง และ **ไม่ตรวจว่า Job จะรับเปลี่ยนสถานะได้หรือไม่** (Job ใช้ `updateMany where status = <ที่คาด>` — data-schema §8.2)
- ไม่มีการเรียกข้าม Service แบบ sync; สถานะประกาศ/`company_id` มาจาก E03 เท่านั้น (สำเนา `job_snapshots`)
- สถานะที่ Job ระงับได้ตาม §8.2 คือ `PUBLISHED → SUSPENDED` เท่านั้น (ดู §5.8 ข้อ 1 เรื่องประกาศ `CLOSED`)
- ค่ากำหนดทั้งหมดอยู่ใน config/env: `REPORT_THRESHOLD=3`, `REPORT_DAILY_LIMIT=5`, `REPORTER_DISMISS_STREAK=3`, `REJECTION_THRESHOLD=3`, `REJECTION_WINDOW_DAYS=30`
- ใช้โครงเดิมของสไลซ์ 1: `QueueService`, `AuditService`, `emitJobVerified`, `Tx`, partial unique index ของ `queue_items` (ประกาศหนึ่งมี `JOB_REPORT` เปิดได้รายการเดียว; บริษัทหนึ่งมี `COMPANY_ACCOUNT` เปิดได้รายการเดียว)

## 4. ทางเลือกที่พิจารณา

| ประเด็น | ตัวเลือก | ที่เลือก |
| :--- | :--- | :--- |
| ขอบเขต/ลำดับ | (A) ทำทั้งสไลซ์ยึด contract + Event จำลอง (B) ทำเฉพาะส่วนที่ไม่พึ่ง Event ของ Job ก่อน | **(A)** PM เลือก — contract ล็อกแล้ว ทดสอบกับ RabbitMQ จริงได้ ไม่ต้องรอ Job |
| รู้สถานะ/`company_id` ของประกาศตอนรับรายงาน | (a) เรียก Job ตรงๆ (b) สำเนาจาก E03 `job_snapshots` (c) ใช้ `evaluations` อย่างเดียว | **(b)** ห้ามเรียกข้าม Service sync (c) ไม่รู้สถานะ `PUBLISHED/CLOSED` และไม่ครอบคลุมประกาศที่ไม่เคยผ่านตรวจ |
| ตัวนับรายงาน | (a) นับสดจาก `job_reports` ทุกครั้ง (b) ตาราง `job_report_counters` + `UPDATE … RETURNING` แบบ atomic | **(b)** ตาม data-schema; เงื่อนไข `suspended_at IS NULL` ในคำสั่งเดียวเป็นตัวกัน E04 ซ้ำ ไม่ต้องล็อกแถวยาว |
| นับการถูกปฏิเสธ | (a) นับจากคำตัดสินที่ Verification ส่งเอง (b) นับจาก E03 ที่ Job ยืนยันแล้ว | **(b)** สถานะจริงเป็นของ Job (ถ้า Job ข้าม Event เพราะสถานะไม่ตรง จะไม่เกิดเหตุการณ์ที่ไม่จริง) และนับ `REMOVED`/`SUSPENDED` ได้โดยไม่ต้องรู้ที่มา |

## 5. การออกแบบ

### 5.1 Event

| ทิศทาง | Event | ทำอะไร |
| :--- | :--- | :--- |
| รับ | E03 `JobStatusChanged` (ทุกตัว) | ① upsert `job_snapshots` (`company_id`, `to_status`, เฉพาะ `entity_version` ใหม่กว่า) ② ถ้า `to_status ∈ {AUTO_REJECTED, ADMIN_REJECTED, SUSPENDED, REMOVED}` ⇒ บันทึก `company_rejection_events` แล้วตรวจเกณฑ์ธง (§5.4) ③ พฤติกรรมเดิมของสไลซ์ 1 (`VERIFY_TIMEOUT` → สร้างคิว) คงเดิม |
| ส่ง | E04 `ReportThresholdReached` | รายงานที่นับเข้าเกณฑ์ครบ `REPORT_THRESHOLD` บัญชี (ครั้งเดียวต่อรอบรีเซ็ต) |
| ส่ง | E02 `JobVerified` | `RESTORE` (ยกคำร้อง), `REMOVE` (ยืนยันระงับถาวร) — `decided_by=ADMIN`, `is_appeal=false` |
| ส่ง | E18 `CompanyFlagChanged` | ธงเปลี่ยนจริง (ติด/เคลียร์) — ไม่ส่งเมื่อค่าเดิมอยู่แล้ว |

ผู้รับ E03 ต้องไม่ล้มเมื่อมีฟิลด์ที่ไม่รู้จัก และ E03 เดียวกันที่มาซ้ำต้องไม่นับซ้ำ (idempotency ของ lib + unique `source_event_id` ใน `company_rejection_events`)

### 5.2 ข้อมูล (เพิ่มใน `verification_db`)

ตารางตาม [data-schema.md](../../data-schema.md) §5 พร้อม **ส่วนที่เพิ่ม/เปลี่ยน** (ต้องแก้ data-schema ให้ตรง):
- **`job_snapshots`** (ใหม่): `job_id PK`, `company_id`, `status text`, `entity_version int`, `updated_at` — สำเนาจาก E03 (ใช้ตอบ "รายงานได้ไหม" และหา `company_id` ของประกาศ)
- **`job_reports`**: ตามเอกสาร (`counted`, `status OPEN|DISMISSED|UPHELD`, UNIQUE (`job_id`,`reporter_user_id`)) เพิ่ม index (`reporter_user_id`, `created_at`) สำหรับนับ 5 ครั้ง/วัน
- **`job_report_counters`**: ตามเอกสาร (`counted_reports`, `reset_at`, `suspended_at`)
- **`reporter_stats`**: ตามเอกสาร (`consecutive_dismissed`)
- **`company_rejection_events`**: ตามเอกสาร + `source_event_id uuid UNIQUE` (กันนับซ้ำ), index (`company_id`, `occurred_at`); `occurred_at` = `changed_at` ของ E03
- **`company_flags`**: ตามเอกสาร; ใช้ `entity_version` เพิ่มทีละ 1 ทุกครั้งที่ธงเปลี่ยน
- `queue_items.origin`: เพิ่มค่า `REPORT_THRESHOLD`, `REPORT_UNCOUNTED`, `REJECTION_THRESHOLD`, `ADMIN_FLAG`
- migration ใหม่ (ไม่แก้ `init`) — รวม partial unique index/trigger ที่จำเป็น; ค่า config ไม่อยู่ใน DB

### 5.3 การรายงานประกาศ

`POST /jobs/{job_id}/reports` — role `S`, body `{category: JobReportCategory, detail}` (`detail` 20–1000 ตัวอักษร; ผิดรูป ⇒ `400 VALIDATION_FAILED`) ลำดับตรวจ:
1. ไม่มี `job_snapshots` ของประกาศ ⇒ `404 NOT_FOUND`; สถานะไม่ใช่ `PUBLISHED`/`CLOSED` ⇒ `422 JOB_NOT_REPORTABLE` (R5-G01)
2. เคยรายงานประกาศนี้แล้ว (ไม่ว่าสถานะรายงาน) ⇒ `409 ALREADY_REPORTED`
3. นับรายงานของผู้ใช้ตั้งแต่เที่ยงคืน `Asia/Bangkok` ของวันนี้ ≥ 5 ⇒ `429 RATE_LIMITED` (+ `Retry-After` ถึงเที่ยงคืน)
4. `counted = (reporter_stats.consecutive_dismissed < 3)`; ใน Transaction เดียว: insert `job_reports` (ชนกับ unique ⇒ `409`) → ถ้า `counted`: `UPDATE job_report_counters SET counted_reports = counted_reports + 1` (สร้างแถวถ้ายังไม่มี) → ถ้า `counted_reports ≥ 3` ลอง `UPDATE … SET suspended_at = now() WHERE job_id = ? AND suspended_at IS NULL AND counted_reports >= 3`; **ได้ 1 แถว = ผู้ชนะ** ทำต่อ: เตรียมรายการคิว `JOB_REPORT` (origin `REPORT_THRESHOLD`; ถ้ามีรายการเปิดอยู่แล้วจากรายงานที่ไม่นับ ให้อัปเกรด origin แทนสร้างใหม่) → เขียน E04 (`queue_item_id` = รายการนั้น) ทั้งหมดใน Transaction เดียวกัน
5. ถ้า `counted=false`: เข้าคิวให้ Admin พิจารณาแต่ไม่ระงับ — ถ้ายังไม่มีรายการ `JOB_REPORT` เปิดของประกาศนี้ สร้าง (origin `REPORT_UNCOUNTED`)
6. ตอบ `201 {id, status: 'OPEN'}` — **ไม่บอก** ผู้รายงานว่านับหรือไม่นับ

`due_at` ของ `JOB_REPORT`/`COMPANY_ACCOUNT` = 48 ชม. เสมอ, `priority = NORMAL` (OD-10: Fast-Track ใช้เฉพาะ `JOB_REVIEW`/`JOB_APPEAL`) `submission_id` ของรายการ = `submission_id` ของผลตรวจล่าสุดของประกาศ (ถ้ามี) ใช้เป็น `submission_id` ใน `JobVerified` และให้ Admin เห็นเนื้อหาประกาศที่ถูกรายงาน

### 5.4 ผลตัดสินรายงานของ Admin

`POST /admin/queue/{id}/actions/{dismiss-report|uphold-report}` (เฉพาะ `JOB_REPORT`; ชนิดอื่น ⇒ `422 UNSUPPORTED_ITEM_TYPE`; `RESOLVED` แล้ว ⇒ `409 STATE_CONFLICT`; `204`) ปิดรายการด้วย `updateMany where status <> 'RESOLVED'` แบบสไลซ์ 1 แล้วทำตามชนิดรายการ:

| รายการ | `dismiss-report` | `uphold-report` |
| :--- | :--- | :--- |
| **ระงับแล้ว** (`REPORT_THRESHOLD`) | `JobVerified(RESTORE)` · รายงานของประกาศ → `DISMISSED` · ตัวนับรีเซ็ต (`counted_reports=0`, `reset_at=now`, `suspended_at=null`) · `consecutive_dismissed +1` ของผู้รายงานแต่ละคน (คนละหนึ่งครั้ง) | `JobVerified(REMOVE)` · รายงาน → `UPHELD` และ `counted=true` · `consecutive_dismissed = 0` ของผู้รายงานทุกคน |
| **ไม่นับ** (`REPORT_UNCOUNTED`, ประกาศยังไม่ถูกระงับ) | รายงานของประกาศ → `DISMISSED` · ตัวนับรีเซ็ต · streak `+1` · **ไม่ส่ง Event** | รายงาน → `UPHELD` และ `counted=true` · streak = 0 · คำนวณตัวนับใหม่ ถ้าครบเกณฑ์ ⇒ ระงับตามปกติ (ขั้น 4 ของ §5.3: E04 + รายการใหม่) · **ไม่ส่ง `REMOVE` และไม่มี manual suspend** (R5-G02) |

`422 SUBMISSION_UNKNOWN` เมื่อต้องส่ง `JobVerified` แต่รายการไม่มี `submission_id` (ประกาศไม่เคยมีผลตรวจ — เหมือนสไลซ์ 1) ทุก action เขียน `status_history` + `admin_audit_log` (`REPORT_DISMISS`, `REPORT_UPHOLD`) ใน Transaction เดียว; เหตุผลการตัดสิน ถ้า Admin ส่งมา เก็บใน `status_history.reason`

### 5.5 ธงบริษัท `UNDER_REVIEW`

**ติดอัตโนมัติ** (จาก E03 ตาม §5.1 ② ใน Transaction เดียวกับการบันทึกเหตุการณ์): นับ `company_rejection_events` ของบริษัทที่ `occurred_at > max(now − REJECTION_WINDOW_DAYS, company_flags.cleared_at)` ถ้า `≥ REJECTION_THRESHOLD` และ `company_flags.under_review = false` ⇒ ตั้งธง (`set_by=SYSTEM`, `entity_version+1`) + รายการคิว `COMPANY_ACCOUNT` (origin `REJECTION_THRESHOLD`) + E18 (`active=true`, `trigger_count`) — ถ้าธงเปิดอยู่แล้วไม่ทำอะไร การนับเริ่มหลัง `cleared_at` เพื่อไม่ให้เคลียร์แล้วถูกติดกลับทันทีด้วยเหตุการณ์ที่ Admin เพิ่งตรวจไปแล้ว

**Admin**
- `PUT /admin/flags/companies/{company_id}/under-review` `{active, reason}` (`reason` บังคับทั้งสองทิศ): ตั้ง/เคลียร์ (`set_by=ADMIN`); ค่าเดิมอยู่แล้ว ⇒ `200` ไม่ส่ง Event; เคลียร์ ⇒ ปิดรายการ `COMPANY_ACCOUNT` ที่เปิดอยู่ (`resolution='ADMIN_CLEAR_FLAG'`); ตั้งเอง **ไม่สร้างรายการคิว**
- `GET /admin/flags/companies` `?active=&q=` + Pagination มาตรฐาน → `{company_id, company_name, active, set_by, set_reason, set_at, cleared_at, trigger_count}`
- `POST /admin/queue/{id}/actions/company-clear-flag` (เฉพาะ `COMPANY_ACCOUNT`; `reason` ไม่บังคับ): เคลียร์ธง + ปิดรายการ + E18 — พฤติกรรมเดียวกับ PUT clear
- ทุกการเปลี่ยนเขียน `status_history` (entity `COMPANY_FLAG`) + `admin_audit_log` (`FLAG_SET`, `FLAG_CLEAR`)

### 5.6 ตาราง สถานะประกาศ × action (OD-06)

Verification **ตรวจเฉพาะสิ่งที่ตัวเองบังคับ** (✓ = Verification ตรวจจาก snapshot/ข้อมูลของตน; — = ไม่ตรวจ ปล่อยให้ Job ปฏิเสธการเปลี่ยนสถานะเอง ตาม data-schema §8.2)

| สถานะประกาศ | รายงาน | ตรวจ (approve/reject) | อุทธรณ์ | ยกคำร้อง/ยืนยัน (dismiss/uphold) |
| :--- | :-: | :-: | :-: | :-: |
| `DRAFT`, `VERIFYING` | ✗ | — | ✗ | — |
| `PUBLISHED` | ✓ ครั้งละ 1 คน/ประกาศ | ✗ | ✗ | — (มีเฉพาะรายการ "ไม่นับ") |
| `PENDING_REVIEW` | ✗ | ✓ มีรายการ `JOB_REVIEW`/`JOB_APPEAL` เปิด | ✗ | ✗ |
| `AUTO_REJECTED` | ✗ | ✗ | ✓ ผลล่าสุดเป็น `AUTO_REJECT` + ยังไม่เคยอุทธรณ์ | ✗ |
| `ADMIN_REJECTED` | ✗ | ✗ | ✗ | ✗ |
| `SUSPENDED` | ✗ (R5-G01) | ✗ | ✗ | ✓ มีรายการ `JOB_REPORT` เปิด |
| `REMOVED` | ✗ | ✗ | ✗ | ✗ |
| `CLOSED` | ✓ | ✗ | ✗ | — |

เก็บตารางนี้ใน data-schema §8 (ต่อจาก §8.2) และชี้ไปที่เอกสารนี้

### 5.7 ความปลอดภัยและ log

- `JwtAuthGuard` + `RolesGuard` ของ `libs/common`: รายงาน = `STUDENT`; ธง/คิว = `PLATFORM_ADMIN`
- ตัวตนผู้รายงาน (`reporter_user_id`) และ `detail` ออกได้เฉพาะ `GET /admin/queue/{id}` ของรายการ `JOB_REPORT` (เพิ่ม `reports:[{id, reporter_user_id, category, detail, counted, status, created_at}]`) — ห้ามมีใน endpoint ของ HR (ผลตรวจ/อุทธรณ์) และใน Event
- Log ได้เฉพาะ `event_id`, `job_id`, `company_id`, `queue_item_id`, ผลตัดสิน, จำนวนที่นับ — **ห้าม** log `detail`, `reporter_user_id` พร้อม `detail`

### 5.8 กรณีขอบ / การตัดสินใจของผู้เขียน (ตรวจได้)

1. **ประกาศ `CLOSED` ถูกรายงานครบเกณฑ์:** ตาม R5-G01 รายงานได้ และเรานับ/ส่ง E04/สร้างรายการคิวตามปกติ แต่ data-schema §8.2 ให้ Job ระงับได้เฉพาะจาก `PUBLISHED` จึงอาจไม่เปลี่ยนสถานะ ⇒ รายการนั้นอาจค้างโดยประกาศไม่ `SUSPENDED` (ผล `RESTORE`/`REMOVE` จะถูก Job ข้าม) **ต้องแจ้ง/ตัดสินกับ Job**: ขอให้ Job รับ E04 ตอน `CLOSED` (`CLOSED → SUSPENDED`) หรือยกเลิกให้รายงานได้เฉพาะ `PUBLISHED` — ไม่บล็อกการทำสไลซ์นี้
2. **E03 สลับลำดับ/ซ้ำ:** `job_snapshots` เขียนเมื่อ `entity_version` ใหม่กว่าเท่านั้น; เหตุการณ์ปฏิเสธนับตาม `source_event_id` โดยไม่ดู `entity_version` (เหตุการณ์เก่าที่มาช้าก็ยังเป็นเหตุการณ์จริง) ดังนั้นต้องไม่พังเมื่อ E03 ของประกาศนั้นมาถึงก่อนที่เราจะรู้จักประกาศ
3. **ประกาศหนึ่งถูกนับหลายครั้ง:** เช่น `SUSPENDED` แล้ว `REMOVED` นับ 2 ครั้ง ตาม README ("รวมกัน ครบ 3 ครั้ง") — ตั้งใจ ไม่ใช่บั๊ก
4. **รายงานของผู้ใช้ที่ถูกลบบัญชี (E15):** อยู่นอกขอบเขตสไลซ์นี้ (anonymize ทำเป็นงานรวมภายหลัง) — ห้ามออกแบบให้ขวาง
5. **ผู้รายงานคนเดียวกันรายงานหลายประกาศของบริษัทเดียวกัน:** ได้ตามปกติ (จำกัดแค่ 1 ครั้ง/ประกาศและ 5 ครั้ง/วัน)
6. **คำตัดสิน R5-G02 ที่ตีความ:** "uphold ทำให้รายงานกลายเป็นนับ ไม่เพิ่ม manual suspend" = เมื่อ Admin ยืนยัน รายงานนั้น (รวมที่เคยไม่นับ) กลายเป็น `counted=true` และเข้าเกณฑ์ระงับตามปกติ โดยไม่มี action ระงับด้วยมือแยกต่างหาก — **PM ตรวจการตีความนี้**

### 5.9 การทดสอบ

- **Service (Prisma + Postgres จริง):** รายงานผ่าน/ซ้ำ (`409`)/เกิน 5 ครั้ง (`429`, ขอบเที่ยงคืน Bangkok)/สถานะไม่ถูกต้อง (`422`)/ไม่รู้จักประกาศ (`404`); รายงานที่ 3 พร้อมกัน (หลาย Transaction ขนาน) ได้ E04 **ครั้งเดียว** และรายการคิวเดียว; `counted=false` หลังยกคำร้องติด 3 ครั้ง และเข้าคิวแบบ "ไม่นับ"; ทุกแถวของตารางใน §5.4; `SUBMISSION_UNKNOWN`; ซ้อนทับกับรายการคิวเปิดเดิม
- **ธง:** นับ 3 ใน 30 วัน (ขอบ 29/30/31 วัน), ไม่ติดซ้ำ, เคลียร์แล้วเหตุการณ์เก่าไม่ติดกลับ, E03 ซ้ำ/สลับลำดับ, ตั้ง/เคลียร์ด้วยมือ (idempotent, ไม่ส่ง E18 ซ้ำ), `company-clear-flag`
- **สิทธิ์/ความเป็นส่วนตัว:** HR/นักศึกษาเรียก endpoint Admin ไม่ได้ (`403`), `reports[]` ไม่โผล่ใน endpoint อื่น
- **End-to-end (RabbitMQ จริง, ข้ามถ้าไม่มี Docker):** ส่ง E03 `PUBLISHED` → รายงานจาก 3 บัญชี → ได้ E04; Admin dismiss → E02 `RESTORE`; ส่ง E03 ปฏิเสธ 3 ครั้ง → ได้ E18 และ E01 ถัดไปที่ `company_flag_under_review=true` ได้ผลเหลือง
- ชนิดของ Event/DTO ตรวจตอนคอมไพล์ด้วย `@internpath/contracts`

## 6. เอกสารที่ต้องอัปเดตใน PR เดียวกัน

1. `data-schema.md` §5: `job_snapshots`, `source_event_id`, ค่า `origin` ใหม่, `cleared_at` ของธง; §8: ตารางสถานะ × action (§5.6)
2. `api-contract.md` §6: `POST /jobs/{id}/reports` (รหัส error `JOB_NOT_REPORTABLE`, `404`, ค่า `category` จาก §11), `GET /admin/queue/{id}` ของ `JOB_REPORT` มี `reports[]`, `PUT/GET /admin/flags/...` ตามที่ตัดสิน, `company-clear-flag`; ลบ `POST /reviews/{id}/reports` ออกจากสไลซ์นี้ (คงไว้ในเอกสารเป็นของสไลซ์ 3)
3. `event-contract.md`: E03 ระบุว่า Verification รับ **ทุกตัว** (เก็บ snapshot + นับการปฏิเสธ) — หมายเหตุ §4 เดิมบอกว่า "เพื่อนับการถูกปฏิเสธ/ระงับ/ลบ" อยู่แล้ว; E04/E18 ชนิดอยู่ใน `libs/contracts` แล้ว
4. `developer-guide.md`: ติ๊กงาน Verification สไลซ์ 2
5. **แจ้งเจ้าของ Job:** E03 ต้องส่งทุกการเปลี่ยนสถานะ (รวม `SUSPENDED`/`REMOVED`/`AUTO_REJECTED`/`ADMIN_REJECTED` และ `company_id`), เรื่อง `CLOSED` (§5.8 ข้อ 1), และให้ใช้ `ReportThresholdReached` เพื่อระงับ

## 7. ปล่อยให้ผู้ลงมือตัดสิน

- โครงโฟลเดอร์ใหม่ใน `apps/verification/src` (เช่น `report/`, `flag/`, `job/` สำหรับ snapshot) และชื่อ class/DTO
- ชื่อ migration, วิธีเขียน SQL ของ `UPDATE … RETURNING` (Prisma raw หรือ `updateMany` + นับแถว) ตราบที่ผ่านเทสต์ขนาน §5.9
- รูปแบบ response ของ `GET /admin/flags/companies` ส่วนที่ไม่ได้ระบุ (ชื่อฟิลด์ตามตัวอย่าง §5.5)

## 8. ข้อสมมติที่ผู้เขียนตัดสินเอง (ตรวจได้)

- ตัดปัจจัยเสี่ยง "ประวัติถูกปฏิเสธล่าสุด" ออกถาวร (§2) — ถ้าต้องการให้มี ต้องกำหนดน้ำหนักและเงื่อนไขใหม่
- รายงานที่ไม่นับเข้าคิวเป็นรายการ `REPORT_UNCOUNTED` ที่ประกาศยัง `PUBLISHED` อยู่ (ตีความจาก README "แต่ยังเข้าคิว Admin ให้พิจารณา")
- นับ "วัน" ของ 5 ครั้ง/วันตามปฏิทิน `Asia/Bangkok` (README ไม่ระบุ; สอดคล้องกับ rate limit ฝั่ง Job)
- เคลียร์ธงแล้วเริ่มนับ 30 วันใหม่จาก `cleared_at` (§5.5)
- `dismiss-report` ของรายการ "ไม่นับ" ปิดรายงาน OPEN **ทั้งหมด**ของประกาศและรีเซ็ตตัวนับ (รวมรายงานที่นับแล้ว 1-2 ฉบับ) เพื่อให้มีกติกาเดียวกับกรณีระงับแล้ว
- Admin ตั้งธงด้วยมือไม่สร้างรายการคิว; เคลียร์ปิดรายการเปิดให้เอง
- `due_at` 48 ชม./`priority=NORMAL` ของ `JOB_REPORT` และ `COMPANY_ACCOUNT` ตาม OD-10
- ค่าตั้งต้นของ `category`/เกณฑ์ใน §3 เป็นของที่ PM ตัดสินใน api-contract §11 / README 5.1.3-5.1.4
