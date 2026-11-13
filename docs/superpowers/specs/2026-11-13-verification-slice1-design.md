# Design: Verification & Trust — สไลซ์ 1 "ตรวจประกาศงานครบวงจร"

- วันที่: 2026-11-13
- เจ้าของ: PM (`apps/verification`)
- สถานะ: **ร่างรออนุมัติ**
- เอกสารต้นทาง (ถ้าขัดกัน ให้ยึดเอกสารเหล่านี้ แล้วแก้เอกสารนี้): [README](../../../README.md) §5.1, [data-schema.md](../../data-schema.md) §5 และ §8.2, [api-contract.md](../../api-contract.md) §6, [event-contract.md](../../event-contract.md) E01-E03/E05
- ใช้ messaging ที่ทำเสร็จแล้ว: [2026-11-13-messaging-outbox-design.md](2026-11-13-messaging-outbox-design.md)

## 1. เจตนาและเหตุผล

Verification เป็น Core Highlight ของโครงงาน: ประกาศงานที่ HR ส่งมาต้องถูกตรวจอัตโนมัติและแยกเป็น 3 ทาง (เขียว ผ่านเลย / เหลือง รอ Admin / แดง ตีกลับพร้อมเหตุผล) ภายใน 5 นาที งานนี้ใหญ่ จึงแบ่งเป็น 3 สไลซ์ตามแผน 4 สัปดาห์ (ตกลงกับ PM แล้ว) เอกสารนี้ครอบคลุม **สไลซ์ 1** ซึ่งเป็น demo ไฮไลต์สัปดาห์ที่ 2: โพสต์งาน 3 รูปแบบแล้วเห็นการแยกคิวเขียว/เหลือง/แดง + อุทธรณ์ + แก้ประกาศแล้วถูกตรวจซ้ำ

| สไลซ์ | เนื้อหา | สถานะ |
| :-: | :--- | :--- |
| **1** | ตรวจประกาศ, คิว Admin (อนุมัติ/ปฏิเสธ), อุทธรณ์, จัดการ Blacklist/กฎ, ผลตรวจให้ HR, audit | **เอกสารนี้** |
| 2 | รายงานประกาศ + ตัวนับ + ระงับอัตโนมัติ, ธง `UNDER_REVIEW`, นับการถูกปฏิเสธ | ภายหลัง |
| 3 | ตรวจรีวิว (`ReviewSubmitted`), รายงานรีวิว | ภายหลัง |

## 2. เป้าหมาย / ไม่ใช่เป้าหมาย / สิ่งที่ถือว่าล้มเหลว

**เป้าหมาย**
1. รับ `JobSubmitted` (E01) แล้วตัดสิน `APPROVE` / `PENDING_REVIEW` / `AUTO_REJECT` ตามกฎ README 5.1 และส่ง `JobVerified` (E02) กลับ
2. ตัวตัดสินเป็น **ฟังก์ชันล้วน** (ไม่แตะ DB/Broker) ทดสอบได้ละเอียด และรองรับกฎ "คำต้องห้ามในประโยคปฏิเสธ"
3. Admin ทำงานกับคิวได้: ดู (พร้อมไฮไลต์คำต้องห้าม), อนุมัติ, ปฏิเสธ (ต้องมีเหตุผล) และเห็น `OVERDUE`
4. HR ดูผลตรวจและอุทธรณ์ได้ 1 ครั้งต่อประกาศ (Verification เป็นผู้บังคับกฎนี้)
5. Admin จัดการ Blacklist และค่าน้ำหนักได้ผ่าน API (มีค่าตั้งต้นใน DB) และมีทางทดสอบกฎก่อนใช้จริง
6. ทุกการกระทำของ Admin ถูกบันทึกและอ่านย้อนหลังได้ (`admin_audit_log` + `GET /admin/audit`)

**ไม่ใช่เป้าหมายในสไลซ์นี้**
- รายงานประกาศ/ตัวนับ/`ReportThresholdReached`/`RESTORE`/`REMOVE`, ธง `UNDER_REVIEW`, `company_rejection_events` (สไลซ์ 2)
- ตรวจรีวิว (สไลซ์ 3), หน้าเว็บ, Gateway routing, การผูก Notification
- ปัจจัยเสี่ยง "ประวัติถูกปฏิเสธล่าสุดของบริษัท" (ต้องใช้ `company_rejection_events` ของสไลซ์ 2)
- สถานะ `IN_REVIEW` ของคิว (ยังไม่มี action "รับงาน")

**สิ่งที่ถือว่าล้มเหลวแม้โค้ดจะรัน**
- ประกาศที่ตัวตัดสินขัดข้อง/ตอบไม่ได้ถูก `APPROVE` เอง (ต้องไม่ตอบ แล้วปล่อยให้ Fail-safe ของ Job ตั้ง `PENDING_REVIEW`)
- HR อุทธรณ์ได้มากกว่า 1 ครั้งต่อประกาศ หรืออุทธรณ์ประกาศของบริษัทอื่น
- ประกาศเดียวมีรายการคิวเปิดซ้อนกันสองรายการ
- Log มีเนื้อหาประกาศ/ช่องทางติดต่อ (`contact_notes` อาจมีข้อมูลติดต่อ)

## 3. ข้อจำกัด

- ใช้ `MessagingModule`/`OutboxWriter`/`EventConsumer` ของ `libs/common` เท่านั้น ห้ามส่ง RabbitMQ ตรงๆ; Event ใช้ชนิดจาก `libs/contracts`
- Job Management เป็นเจ้าของสถานะประกาศ: Verification **ส่งผลตัดสินอย่างเดียว** ไม่แก้สถานะประกาศเอง
- Fail-safe 5 นาทีเป็นหน้าที่ของ Job (ตั้ง `PENDING_REVIEW` เอง แล้วส่ง `JobStatusChanged` reason `VERIFY_TIMEOUT`) Verification ต้องสร้างรายการคิวจาก Event นั้น และถ้าผลตรวจมาถึงทีหลัง ให้เก็บใน `evaluations` และแนบกับรายการคิว (architecture §7)
- ไม่มีการเรียกข้าม Service แบบ sync; ข้อมูลบริษัทมาจาก Event (`company_snapshots`)
- Prisma migration แรกของโปรเจกต์ ([developer-guide.md](../../developer-guide.md) §6.2 ระบุว่ายังไม่เคยลองรันจริง) ถ้าติดปัญหาให้แก้คู่มือ
- ฐานข้อมูล `verification_db` ใน Docker, ค่า env ตาม `.env.example`

## 4. ทางเลือกที่พิจารณา

| ประเด็น | ตัวเลือก | ที่เลือก |
| :--- | :--- | :--- |
| แบ่งงาน | (1) สไลซ์ตามแผนสัปดาห์ (2) ทำ schema+endpoint ทั้งหมดก่อนแล้วใส่ logic (3) ทำเอนจินเป็นไลบรารีแยก | **(1)** ตกลงกับ PM แล้ว (2) ทิ้งโค้ดว่างและเสี่ยงรื้อ; (3) เป็นส่วนย่อยของ (1) อยู่แล้ว |
| ที่เก็บกฎ/น้ำหนัก/Blacklist | (a) ค่าคงที่ในโค้ด (b) แถวใน DB พร้อม seed แก้ได้ผ่าน API | **(b)** ตรงกับ API §6.3 และ OD-11 (ผิดแล้วปรับได้ ไม่ต้อง deploy) |
| โครงตัวตัดสิน | (a) ปนใน service/Prisma (b) ฟังก์ชันล้วน `evaluateJob(input, rules)` + เปลือกบางเรื่อง I/O | **(b)** ทดสอบกฎโดยไม่ต้องมี DB/Broker |
| การจับ "ประโยคปฏิเสธ" | (a) NLP/ตัดคำไทย (b) กฎ cue + ระยะห่างในประโยคเดียวกัน ตั้งค่าได้ | **(b)** ไม่เพิ่ม dependency และ Admin ปรับ cue ได้; ยอมรับว่าไม่ฉลาดเท่า NLP |

## 5. การออกแบบ

### 5.1 ภาพรวม Event

| ทิศทาง | Event | ทำอะไร |
| :--- | :--- | :--- |
| รับ | E01 `JobSubmitted` | ตรวจ → บันทึก `evaluations` → (ถ้า `PENDING_REVIEW`) สร้างรายการคิว → ส่ง E02 (ทั้งหมดใน Transaction เดียว) |
| รับ | E03 `JobStatusChanged` (เฉพาะ `to_status=PENDING_REVIEW` และ `reason_code=VERIFY_TIMEOUT`) | สร้างรายการคิว `JOB_REVIEW` ถ้ายังไม่มีรายการเปิดของประกาศนั้น (ไม่มีผลตรวจ → `risk_level` ว่าง); Event อื่นข้าม (สไลซ์ 2 จะใช้นับการถูกปฏิเสธ) **ต้องเพิ่ม `submission_id?` (ไม่บังคับ) ใน payload ของ E03 เมื่อ `reason_code=VERIFY_TIMEOUT`** เพราะ `JobVerified` ที่ Admin ส่งต้องมี `submission_id` แต่รายการแบบนี้อาจยังไม่เคยมีผลตรวจ (PM ตัดสินแล้ว) |
| รับ | E05 `CompanyStatusChanged` | อัปเดต `company_snapshots` ถ้า `entity_version` ใหม่กว่า (ไว้แสดงชื่อบริษัทในคิว) |
| ส่ง | E02 `JobVerified` | `APPROVE`, `PENDING_REVIEW`, `AUTO_REJECT` (ระบบ); `APPEAL_ACCEPTED`; `ADMIN_APPROVE`, `ADMIN_REJECT` (Admin) — `REMOVE`/`RESTORE` เป็นของสไลซ์ 2 |

ผู้รับ E01 ต้องไม่ล้มเมื่อมีฟิลด์ที่ไม่รู้จัก; ตัวตัดสินขัดข้อง → throw (ให้ retry/DLQ ของ lib) ไม่ส่ง E02 เด็ดขาด

### 5.2 ตัวตัดสิน (ฟังก์ชันล้วน)

`evaluateJob(input, rules) → Evaluation` โดย `input` คือ `content` + `work_mode`, `hours_per_week`, `allowance`, `company_flag_under_review` จาก E01 และ `rules` คือ Blacklist + ค่าน้ำหนัก + negation cues ที่โหลดจาก DB

**ลำดับตัดสิน** (ตามผล README 5.1):
1. พบคำ `HARD` ที่ **ไม่อยู่ในประโยคปฏิเสธ** ใน `job_title` หรือ `description` → `HIGH` / `AUTO_REJECT` (ไม่ขึ้นกับคะแนน)
2. ไม่เช่นนั้น คำนวณ `score = min(100, Σ น้ำหนักที่เข้าเงื่อนไข)`: `score ≥ 70` → `HIGH` / `AUTO_REJECT`
3. ไม่เช่นนั้น ถ้าพบคำ `HARD` ใน `job_title`/`description` **เฉพาะรูปปฏิเสธ** (`negated_only=true`) → `MEDIUM` / `PENDING_REVIEW`
4. ไม่เช่นนั้น `20 ≤ score ≤ 69` → `MEDIUM` / `PENDING_REVIEW`
5. ไม่เช่นนั้น (`score < 20`) → `LOW`: ถ้า `company_flag_under_review` → `PENDING_REVIEW` (ไม่มี Fast-Path) มิฉะนั้น `APPROVE`

ผลลัพธ์: `risk_score`, `risk_level`, `decision`, `negated_only`, `matched_keywords` (`[{term, field, negated, start, end}]`), `reasons` (`[{code, detail, matched_text?}]` ตามรูปแบบใน E02)

**การสแกนข้อความ:** ปรับข้อความให้เป็นรูปมาตรฐาน (Unicode NFC, ตัดอักขระความกว้างศูนย์, ตัวพิมพ์เล็ก) แล้วค้นแบบ substring (ภาษาไทยไม่มีช่องว่างคั่นคำ) ในทุกฟิลด์ข้อความของ `content`

**ประโยคปฏิเสธ:** การปรากฏของคำหนึ่งครั้งเป็น "ปฏิเสธ" เมื่อมี negation cue อยู่ **ก่อนคำนั้นในประโยคเดียวกัน** และระยะห่างระหว่างท้าย cue ถึงต้นคำ ≤ 12 ตัวอักษร (ค่าตั้งต้น ปรับได้) ประโยคแบ่งด้วยขึ้นบรรทัดใหม่และ `. ! ? ;` (ไม่แบ่งด้วยช่องว่าง) คำเดียวกันที่ปรากฏทั้งแบบปฏิเสธและไม่ปฏิเสธ ถือว่า **ไม่ปฏิเสธ**

**การตรวจช่องทางติดต่อส่วนตัว (`CONTACT_IN_TEXT`):** พบเบอร์โทรไทย (`0x-xxx-xxxx`, `+66`), อีเมล, LINE ID (`line id`/`ไลน์` ตามด้วยไอดี หรือ `@handle`), หรือลิงก์ messenger/social (`line.me`, `t.me`, `wa.me`, `m.me`, `facebook.com`, `instagram.com`, `discord.gg`) ในฟิลด์ใดก็ตาม ตัวเลขช่วงเงิน (เช่น `5,000-8,000`) ต้องไม่ถูกจับเป็นเบอร์โทร

### 5.3 ค่าตั้งต้น (ตอบ OD-11) — **ข้อเสนอ รอ PM ปรับ**

ปรับได้ภายหลังผ่าน `/admin/blacklist` และ `/admin/risk-rules` โดยไม่ต้อง deploy

**กฎน้ำหนัก (`risk_rules`)**
| code | เงื่อนไข | น้ำหนัก |
| :--- | :--- | :-: |
| `CONTACT_IN_TEXT` | พบช่องทางติดต่อส่วนตัว (ตามข้างบน) | +45 |
| `HARD_TERM_OTHER_FIELD` | คำ `HARD` (ไม่ปฏิเสธ) อยู่ในฟิลด์อื่นนอกจาก `job_title`/`description` (นับครั้งเดียว) | +40 |
| `ALLOWANCE_HIGH` | `allowance.amount_thb` > 30,000 | +30 |
| `HOURS_EXCESSIVE` | `hours_per_week` > 48 → +25; 41-48 → +10 | +25 / +10 |
| `DESCRIPTION_TOO_SHORT` | `description` สั้นกว่า 100 ตัวอักษร | +15 |
| `SOFT_TERMS` | คำ `SOFT` แต่ละคำที่ไม่ซ้ำ (รวมไม่เกิน +30) | ตามคำ |
| `NO_ALLOWANCE` | `allowance.type = NONE` | +5 |

ตัวอย่างผล: ประกาศปกติ (เบี้ยเลี้ยง 5,000, 35 ชม./สัปดาห์, คำอธิบายยาวพอ) = 0 → เขียว; มีเบอร์โทรในคำอธิบาย = 45 → เหลือง; เบอร์โทร + เบี้ยเลี้ยง 40,000 = 75 → แดง

**Blacklist ตั้งต้น (`blacklist_terms`)** — `HARD` (ปฏิเสธทันที): `ค่ามัดจำ`, `เงินมัดจำ`, `ค่าสมัคร`, `ค่าธรรมเนียม`, `ค่าอบรม`, `ค่าชุด`, `ค่าประกัน`, `โอนเงินก่อน`, `ลงทุน`, `ดาวน์ไลน์`, `ขายตรง`, `แชร์ลูกโซ่`, `การันตีรายได้`, `mlm`, `พนัน`, `บาคาร่า`, `รหัส otp` | `SOFT`: `ด่วน` +10, `รีบสมัคร` +10, `ที่นั่งจำกัด` +10, `รับทันที` +10, `รายได้ดี` +10, `รายได้ไม่จำกัด` +15

**Negation cues ตั้งต้น:** `ไม่มี`, `ไม่เก็บ`, `ไม่ต้อง`, `ไม่คิด`, `ไม่รับ`, `no`, `not`, `without`; ระยะห่างสูงสุด 12 ตัวอักษร

ข้อควรระวัง: การค้นแบบ substring จะเจอคำในคำอื่นได้ (เช่น `ลงทุน` ในคำที่ไม่เกี่ยวกัน) Admin ใช้ `/admin/blacklist/test` ลองก่อนเพิ่มคำ และมีเทสต์ผลบวกลวงของค่าตั้งต้นรวมอยู่ด้วย

### 5.4 ข้อมูล (`verification_db`)

ตารางตาม [data-schema.md](../../data-schema.md) §5 พร้อม **ส่วนที่เพิ่ม/เปลี่ยน** (ต้องแก้ data-schema ให้ตรง):
- `evaluations`: เพิ่ม `submitted_at` (จาก E01; ใช้ตัดสินว่า "ผลตรวจล่าสุด" คือตัวไหน เพราะ Event อาจมาถึงสลับลำดับ — ไม่ใช้เวลาที่ประมวลผล) และ `company_id` (ตรวจสิทธิ์อุทธรณ์/ผลตรวจ); `submission_id` เป็น UNIQUE (ส่งซ้ำ → ข้าม), `content jsonb` (ข้อความที่สแกน ไว้ไฮไลต์และให้ Admin เห็น; ห้าม log), `fast_track bool` (snapshot ณ ตอนส่ง), `submission_kind`, `reasons`/`matched_keywords` ตามรูปแบบข้างบน
- `queue_items`: เพิ่ม `submission_id null`; **partial unique index** (`target_id`, `type`) เมื่อ `status <> 'RESOLVED'` เพื่อไม่ให้มีรายการเปิดซ้อน
- ใหม่: `blacklist_terms` (`id`, `term`, `severity HARD|SOFT`, `weight null`, `category`, `enabled`, `created_by`, `created_at`), `risk_rules` (`code PK`, `weight`, `params jsonb`, `enabled`, `updated_by`, `updated_at`), `negation_cues` (`id`, `cue`, `enabled`) + ค่า `negation_max_gap` อยู่ใน `risk_rules` (code `NEGATION_WINDOW`)
- ใช้ที่มีอยู่แล้ว: `appeals` (UNIQUE `job_id`), `company_snapshots`, `status_history` (entity = `QUEUE_ITEM`), `admin_audit_log`, `outbox_events`, `processed_events`
- seed ค่าตั้งต้นด้านบนตอน migrate (idempotent)

### 5.5 API (สไลซ์ 1)

| Endpoint | Role | หมายเหตุ |
| :--- | :---: | :--- |
| `GET /admin/queue` | AD | ตาม §6.1 ใช้ Pagination มาตรฐาน (`page`, `page_size` ≤ 100); เรียงค่าเริ่มต้น `priority` (FAST_TRACK ก่อน) แล้ว `due_at` น้อยไปมาก; `overdue` คำนวณตอนอ่าน — **ปิด api-contract §10 ข้อ 2** |
| `GET /admin/queue/{id}` | AD | รายละเอียด + `reasons` + เนื้อหาประกาศ + `highlights:[{field,start,end,keyword,negated}]` + ชื่อบริษัท (จาก snapshot) |
| `POST /admin/queue/{id}/actions/{approve\|reject}` | AD | `reject` ต้องมี `reason`; ส่ง `JobVerified(ADMIN_APPROVE\|ADMIN_REJECT, is_appeal)`; `409 STATE_CONFLICT` ถ้ารายการ `RESOLVED` แล้ว |
| `GET/POST /admin/blacklist`, `PATCH/DELETE /admin/blacklist/{id}`, `POST /admin/blacklist/test` | AD | `test` รับ `{text}` คืนผลสแกน (ไม่บันทึก) |
| `GET/PUT /admin/risk-rules` | AD | ดู/ปรับน้ำหนักและ cues; ตรวจค่า (เช่น น้ำหนักเป็นจำนวนเต็ม ≥ 0) |
| `GET /admin/audit` | AD | `?actor=&action=&target_type=&from=&to=` — **เพิ่มตาม OD-04** |
| `GET /verification/jobs/{job_id}/result` | H (เจ้าของ), AD | ตาม §6.5; เจ้าของ = `company_id` ใน JWT ตรงกับ `evaluations.company_id` |
| `POST /verification/jobs/{job_id}/appeal` | H (เจ้าของ) | `{statement}` เงื่อนไขและผลด้านล่าง |

**อุทธรณ์:** ผลตรวจล่าสุดของประกาศต้องเป็น `AUTO_REJECT` และยังไม่มีแถว `appeals` ของประกาศนั้น (`409 APPEAL_ALREADY_USED`; ผลล่าสุดไม่ใช่ `AUTO_REJECT` → `409 STATE_CONFLICT`) → ใน Transaction เดียวสร้าง `appeals(OPEN)`, รายการคิว `JOB_APPEAL` (`is_appeal=true`) และ `JobVerified(APPEAL_ACCEPTED)` Admin อนุมัติ → `APPROVED` + `ADMIN_APPROVE`; ปฏิเสธ → `DENIED` + `ADMIN_REJECT` (ผลเป็นที่สุด)

**คิว/SLA:** `priority = FAST_TRACK` เมื่อ E01 `fast_track=true` (Fast-Track ใช้เฉพาะคิว `JOB_REVIEW`/`JOB_APPEAL` — OD-10); `due_at = created_at + 48 ชม.` (FAST_TRACK 12 ชม.) ค่าอยู่ใน config (`QUEUE_SLA_HOURS_NORMAL`, `QUEUE_SLA_HOURS_FAST`)

**บันทึก:** ทุก action ของ Admin (คิว, blacklist, risk-rules) เขียน `admin_audit_log` และเปลี่ยนสถานะคิวเขียน `status_history` ใน Transaction เดียวกับการเปลี่ยนข้อมูล

### 5.6 ความปลอดภัยและ log

- `JwtAuthGuard` + `RolesGuard` ของ `libs/common` ต่อทุก controller; HR ต้องมี `company_id` ตรงกับประกาศ มิฉะนั้น `403` — อ่านจาก `request.user.company_id` ที่ `JwtAuthGuard` ตรวจลายเซ็นแล้ว **ไม่ใช้** header `X-Company-Id` (ปลอมได้ถ้าเรียกตรง)
- Log ได้เฉพาะ `event_id`, `job_id`, `submission_id`, `decision`, `risk_level`, รหัสเหตุผล — **ห้าม** log `content`/`statement`/`matched_text`

### 5.7 การทดสอบ

- **ตัวตัดสิน (unit, ไม่ใช้ DB):** ทุกสาขาของลำดับตัดสิน, ขอบคะแนน 19/20/69/70, ตัวอย่างใน README ("ไม่มีค่ามัดจำ" → เหลือง; "ไม่มีค่ามัดจำ แต่ต้องโอนเงินก่อน" → แดง), ธง `UNDER_REVIEW` กับคะแนนต่ำ, ช่องทางติดต่อ (เบอร์/อีเมล/LINE/ลิงก์) และช่วงเงินที่ต้อง **ไม่** ถูกจับเป็นเบอร์, ผลบวกลวงของ Blacklist ตั้งต้น
- **Service (Prisma + Postgres จริง):** consumer E01 → `evaluations` + คิว + outbox, idempotency, กฎอุทธรณ์ 1 ครั้งและสิทธิ์เจ้าของ, action Admin + audit, คิวเปิดซ้อนไม่ได้, E03 `VERIFY_TIMEOUT` สร้างคิวและผลที่มาทีหลังถูกแนบ
- **End-to-end (RabbitMQ จริง):** ส่ง E01 สามแบบ → ได้ E02 `APPROVE` / `PENDING_REVIEW` / `AUTO_REJECT` (demo ไฮไลต์) ข้ามอัตโนมัติถ้าไม่มี Docker เหมือนชุดของ messaging
- ขั้นแรกของงานต้องพิสูจน์ว่า Prisma `tx` ของ Service นี้เข้ากับ `OutboxTx`/`ProcessedEventsTx` ของ `libs/common` ได้จริง (ความเสี่ยงที่ยังค้างจากงาน messaging) ถ้าไม่เข้า ให้ปรับ interface ใน lib ให้หลวมลง ไม่ import Prisma เข้า lib

### 5.8 กรณีขอบ (ผลจากการให้ builder ตรวจเอกสาร — PM มอบให้ตัดสิน)

1. **ส่งประกาศใหม่ขณะมีรายการคิวเปิดอยู่:** E01 ที่มี `submission_id` ใหม่ของประกาศเดียวกัน ⇒ ใน Transaction เดียวกัน ปิดรายการเปิดเดิมเป็น `RESOLVED` (`resolution = 'SUPERSEDED'`, ไม่ส่ง `JobVerified`, เขียน `status_history`) **ก่อน** แล้วจึงตรวจรอบใหม่ตามปกติ (เพราะ Job ย้ายประกาศไป `VERIFYING` แล้ว รายการเก่าไม่มีความหมาย) ตรงนี้ทำให้ partial unique index ไม่ชนกัน
2. **ผลตรวจที่มาทีหลัง `VERIFY_TIMEOUT`:** ถ้าตอนประมวลผล E01 มีรายการคิว `JOB_REVIEW` ที่เกิดจาก `VERIFY_TIMEOUT` ของประกาศนั้นเปิดอยู่ ⇒ บันทึก `evaluations` แล้ว **แนบกับรายการนั้น** (เติม `risk_level`/`submission_id`) และ **ไม่ส่ง `JobVerified`** (Job ตั้ง `PENDING_REVIEW` แล้วและจะข้าม Event เก่า) ให้ Admin ตัดสิน — ผลตรวจที่เป็น `PENDING_REVIEW` เองก็ใช้รายการเดิม ไม่สร้างซ้ำ
3. **`submission_id` ของคำตัดสิน Admin/อุทธรณ์:** ใช้ `queue_items.submission_id` ซึ่งตั้งจากผลตรวจ หรือจาก `submission_id` ใน E03 (`VERIFY_TIMEOUT`); ถ้ายังว่างอยู่ตอนสั่ง action ⇒ ตอบ `422 SUBMISSION_UNKNOWN` และไม่ส่ง Event (ไม่เดา) "ผลตรวจล่าสุด" ของประกาศ = แถวที่ `submitted_at` มากที่สุด
4. **ส่งใหม่หลังอุทธรณ์ไม่ผ่าน:** ทำได้ตามปกติ (README 5.1.5) ผลตรวจรอบใหม่เป็นอิสระ แต่ถ้าถูก `AUTO_REJECT` อีกครั้งจะอุทธรณ์ไม่ได้เพราะใช้สิทธิ์ของประกาศนั้นไปแล้ว (ตั้งใจ)
5. **มุมมองของ HR ต่อผลตรวจ:** `GET /verification/jobs/{job_id}/result` คืนเฉพาะ `{risk_level, risk_score, reasons[], matched_keywords[], is_appeal, can_appeal}` ตาม §6.5 บวก `admin_reason` เมื่อ Admin เป็นผู้ปฏิเสธ (HR ต้องเห็นเหตุผล) — ไม่คืน `content`, `assigned_to`, audit; Admin เห็นเพิ่มตามหน้าคิว
6. **SLA:** นับเป็นชั่วโมงจริง (ไม่ผูกเขตเวลา) จากเวลา **สร้างรายการคิว** (UTC) รวมรายการที่เกิดจาก `VERIFY_TIMEOUT`
7. **Seed:** อยู่ใน SQL ของ migration แบบ `INSERT ... ON CONFLICT DO NOTHING` (insert-if-missing) เพื่อไม่ทับค่าที่ Admin แก้ และทำให้ DB ทดสอบมีค่าตั้งต้นเหมือนกัน; ไม่มีฟังก์ชัน "รีเซ็ตเป็นค่าตั้งต้น" ในสไลซ์นี้

8. **E01 ของรอบเก่าที่มาถึงช้ากว่ารอบใหม่ (stale, เช่นถูก retry):** ถ้ามีผลตรวจของประกาศเดียวกันที่ `submitted_at` ใหม่กว่าอยู่แล้ว ⇒ บันทึกผลรอบเก่าไว้เฉยๆ **ไม่แตะรายการคิว ไม่ส่ง `JobVerified`** (ไม่เช่นนั้นจะปิดรายการของรอบใหม่ทิ้งและส่งผลเก่าที่ Job ข้าม)
9. **E03 `VERIFY_TIMEOUT` ที่ไม่ระบุ `submission_id`:** ไม่เดาจากผลตรวจล่าสุด — รายการไม่ผูกกับผลตรวจใด (`submission_id`/`risk_level` ว่าง, priority ปกติ) จนกว่า E01 ของรอบนั้นจะมาแนบ; จึงสั่ง action ไม่ได้ (`422 SUBMISSION_UNKNOWN`)
10. **อุทธรณ์ขณะมีรายการคิวเปิดอยู่:** `can_appeal=false` และ `POST appeal` ตอบ `409 STATE_CONFLICT` โดยไม่ใช้สิทธิ์ (เช่นรายการ Fail-safe ที่ผลตรวจมาทีหลังเป็น `AUTO_REJECT`) — การอ่านผลล่าสุดและการสร้างอุทธรณ์ทำใน Transaction เดียว
11. **ขนาดผลสแกน:** ผลต่อคำจำกัด 100 ครั้งต่อฟิลด์ ต่อแบบ (ปฏิเสธ/ไม่ปฏิเสธ — ทั้งสองแบบเหลือเสมอ) และ `reasons` ต่อ "คำ" ไม่ใช่ต่อครั้งที่ปรากฏ

เทสต์ของสไลซ์ต้องครอบคลุมข้อ 1, 2, 3 (422), 4, 8, 9, 10, 11 และสิทธิ์ของข้อ 5 ด้วย

## 6. เอกสารที่ต้องอัปเดตใน PR เดียวกัน

1. `data-schema.md` §5: ส่วนที่เพิ่ม/เปลี่ยนใน 5.4
2. `api-contract.md` §6: `highlights` มี `field`/`negated`, `GET /admin/audit`, ผลของ OD-10/11; §10 ข้อ 2 ปิดแล้ว (ใช้ Pagination มาตรฐาน)
3. `developer-guide.md` §6.2/§7: บันทึกผลการลอง migration แรก และติ๊กงานที่เกี่ยวข้อง
4. `event-contract.md` E03: เพิ่มฟิลด์ `submission_id?` (ใช้กับ `VERIFY_TIMEOUT`) และ E01: ระบุว่า `amount_thb` เป็นต่อเดือน; `libs/contracts` ให้ตรง — Job เป็นผู้ส่ง จึงแจ้งเจ้าของ Job หลังแก้

## 7. ปล่อยให้ผู้ลงมือตัดสิน

- โครงโฟลเดอร์ใน `apps/verification/src/modules/*`, ชื่อ class/DTO, รูปแบบ seed (script หรือ migration SQL) ตราบที่ idempotent
- ชนิดข้อมูลของ `matched_keywords.start/end` (ออฟเซ็ตในฟิลด์หลังปรับรูปมาตรฐาน — ต้องให้ไฮไลต์ตรงกับข้อความที่ Admin เห็น)
- รูปแบบ regex ละเอียดของเบอร์โทร/LINE ตราบที่ผ่านเทสต์ใน 5.7

## 8. ข้อสมมติที่ผู้เขียนตัดสินเอง (ตรวจได้)

- **PM ตัดสินแล้ว (ไม่ต้องรอเจ้าของ Service อื่น เอกสารเป็นของ PM):** (1) `allowance.amount_thb` คือ **ต่อเดือน** — ระบุหน่วยใน E01 และ data-schema ของ Job (2) เพิ่ม `submission_id?` ใน E03 เมื่อ `VERIFY_TIMEOUT` — แก้ event-contract และ `libs/contracts` แล้วแจ้งเจ้าของ Job ให้ส่งตาม
- ค่าตั้งต้นทั้งหมดใน 5.3 (น้ำหนัก, คำ, ระยะ 12 ตัวอักษร) เป็นข้อเสนอของผู้เขียน รอ PM ปรับ
- ช่องทางติดต่อส่วนตัวให้ +45 (เข้าคิวเหลือง) ไม่ใช่ปฏิเสธทันที เพื่อไม่ลงโทษ HR ที่เผลอใส่เบอร์; README ไม่ระบุผลของการพบช่องทางติดต่อ
- คำ `HARD` ในฟิลด์นอกเหนือ `job_title`/`description` ให้ +40 (README กำหนดปฏิเสธทันทีเฉพาะสองฟิลด์นั้น)
- รายการคิวเปิดได้ครั้งละหนึ่งรายการต่อ (ประกาศ, ประเภท) ด้วย partial unique index
- ไม่ใช้สถานะ `IN_REVIEW` ในสไลซ์นี้
- `E03` อื่นนอกจาก `VERIFY_TIMEOUT` ข้ามในสไลซ์นี้
- Pagination ของคิวใช้ค่ามาตรฐานของ API (ไม่ต้องรอ UI)
