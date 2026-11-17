# Design: Verification & Trust — สไลซ์ 3 "ตรวจรีวิวและรายงานรีวิว"

- วันที่: 2026-11-15
- เจ้าของ: PM (`apps/verification`)
- สถานะ: **อนุมัติ (PM, 2026-11-15)** — ลงมือแล้วตาม [แผน](../plans/2026-11-15-verification-slice3.md)
- ต่อจาก: [สไลซ์ 2](2026-11-14-verification-slice2-design.md) (รายงานประกาศ/ธงบริษัท — merge เข้า `main` แล้ว), [สไลซ์ 1](2026-11-13-verification-slice1-design.md) และ [messaging](2026-11-13-messaging-outbox-design.md)
- เอกสารต้นทาง (ถ้าขัดกัน ให้ยึดเอกสารเหล่านี้แล้วแก้เอกสารนี้): [README](../../../README.md) §5.5 และ §5.11, [data-schema.md](../../data-schema.md) §5, [api-contract.md](../../api-contract.md) §6.1 และ §6.4, [event-contract.md](../../event-contract.md) E09/E10, [diagram.md](../../diagram.md) (ลำดับรีวิว)
- วิธีทำ: **แบบ A** เหมือนสไลซ์ 2 — ยึด contract ในเอกสารและ `libs/contracts` ทดสอบด้วย Event จำลอง/RabbitMQ จริงของเรา ไม่รอ Lifecycle

## 1. เจตนาและเหตุผล

รีวิวบริษัทเป็นข้อมูลสาธารณะที่ส่งผลต่อชื่อเสียงบริษัทและการตัดสินใจของนักศึกษารุ่นต่อไป จึงมีความเสี่ยงสองทาง: รีวิวที่แอบใส่ช่องทางติดต่อส่วนตัวหรือถ้อยคำต้องห้าม และรีวิวที่ถูกใช้กลั่นแกล้งหรือบิดเบือน แต่ README 5.5 กำหนดชัดว่ารีวิวที่ติดการตรวจ **ต้องไม่ถูกตีกลับอัตโนมัติ** (รีวิวอาจกล่าวถึงพฤติกรรมเช่นการเรียกค่ามัดจำโดยชอบธรรม) ผลของสไลซ์นี้คือ: สแกนรีวิวทุกฉบับด้วยตัวสแกนเดิมก่อนเผยแพร่, พักรีวิวที่ติดไว้ให้ Admin ตัดสินด้วยมือ, และเปิดทางให้นักศึกษา/HR รายงานรีวิวที่เผยแพร่ไปแล้วเข้าคิวเดียวกัน

## 2. เป้าหมาย / ไม่ใช่เป้าหมาย / สิ่งที่ถือว่าล้มเหลว

**เป้าหมาย**
1. รับ E09 `ReviewSubmitted` แล้วสแกนหัวข้อ+เนื้อหา: ไม่ติด ⇒ ส่ง E10 `PUBLISH`; ติด ⇒ ส่ง E10 `HOLD` + สร้างรายการคิว `REVIEW_HELD` ใน Transaction เดียวกัน
2. `POST /reviews/{review_id}/reports` (นักศึกษา/HR): รับรายงานรีวิวที่เผยแพร่อยู่ 1 ครั้งต่อผู้ใช้ต่อรีวิว และสร้างรายการคิว `REVIEW_REPORT` ถ้ายังไม่มีรายการเปิดของรีวิวนั้น
3. Admin ตัดสิน `REVIEW_HELD`/`REVIEW_REPORT` ด้วย `publish-review` / `remove-review` ⇒ ส่ง E10 `ADMIN_PUBLISH` / `ADMIN_REMOVE`
4. Admin เห็นเนื้อหารีวิว ผลสแกน (highlights) และรายงานทั้งหมดของรีวิวใน `GET /admin/queue/{id}`
5. ทุกการกระทำของ Admin เขียน `admin_audit_log` + `status_history` เหมือนสไลซ์ 1–2
6. ขยาย handler anonymization ของ E15 (ทำแล้วใน PR ก่อนหน้า) ให้ครอบตารางใหม่ของสไลซ์นี้
7. บันทึกในเอกสารว่า Lifecycle ต้องรับ `ADMIN_REMOVE` กับรีวิวที่เผยแพร่แล้ว และข้าม `ADMIN_PUBLISH` ของรีวิวที่เผยแพร่อยู่แล้ว (ตัดสินแล้ว: แบบ A — ไม่เพิ่ม decision ใหม่ใน E10)

**ไม่ใช่เป้าหมาย**
- การเก็บ/แก้สถานะรีวิว, ตัวนับดาวบริษัท, `ReviewPublished` (E11), การตอบกลับของบริษัท — Lifecycle/Identity เป็นเจ้าของ
- เกณฑ์จำนวนรายงานก่อนเข้าคิว (README 5.5 ไม่กำหนด — รายงานแรกเข้าคิวเลย) และการลงโทษผู้รายงานแบบ `reporter_stats` ของรายงานประกาศ
- การแก้รีวิวหลังส่ง (ไม่มีใน README; รีวิวส่งแล้วแก้ไม่ได้)
- หน้าเว็บ, Gateway routing (มี `/reviews/{id}/reports` → verification แล้ว), การผูก Notification
- สถานะ `IN_REVIEW` ของคิว (ยังไม่มี "รับงาน")

**สิ่งที่ถือว่าล้มเหลวแม้โค้ดจะรัน**
- รีวิวที่ติดการตรวจถูกตีกลับหรือลบเองโดยไม่ผ่าน Admin; หรือรีวิวที่มีเบอร์โทร/อีเมล/LINE ID ถูกส่ง `PUBLISH`
- ส่ง E10 ซ้ำ/ขัดกัน (เช่น `PUBLISH` แล้ว `HOLD` ของรีวิวเดียวกัน) เมื่อ E09 ถูกส่งซ้ำ; รีวิวหนึ่งมีรายการ `REVIEW_HELD`/`REVIEW_REPORT` เปิดซ้อนกัน
- รีวิวที่ถูกพักหรือถูกลบถูกรายงานได้; ผู้ใช้รายงานรีวิวเดียวกันได้ 2 ครั้ง; HR รายงานรีวิวของบริษัทอื่นได้
- ตัวตนผู้รายงาน/ข้อความรายงาน/เนื้อหารีวิวรั่วออกนอก `GET /admin/queue/{id}` (Event, log, endpoint ของ HR/นักศึกษา)
- ลบบัญชีนักศึกษาแล้วข้อมูลติดต่อส่วนตัวในรีวิวที่ถูกพักยังค้างอยู่ในฐานข้อมูล

## 3. ข้อจำกัด

- ใช้ `MessagingModule`/`OutboxWriter`/`EventConsumer` ของ `libs/common`; ชนิด Event จาก `libs/contracts` (`ReviewSubmittedPayload` E09, `ReviewModerationResultPayload` E10 มีแล้ว)
- ไม่มีการเรียกข้าม Service แบบ sync: Verification รู้จักรีวิวเฉพาะที่รับผ่าน E09 (สำเนาใน `review_moderations`) และไม่แก้สถานะรีวิวเอง — Lifecycle เป็นเจ้าของ (ผลตัดสินคือ E10 เท่านั้น และ Verification ไม่ตรวจว่า Lifecycle จะรับได้หรือไม่ เหมือน `JobVerified`)
- ใช้ตัวสแกนและกฎของสไลซ์ 1 (`src/screening`: `normalizeText`, `findTermMatches`, `detectContact`, กฎจาก `RulesService`) — ห้ามเขียนตัวสแกนใหม่
- ใช้โครงเดิม: `QueueService` (เพิ่มเมธอดสร้างรายการรีวิวแบบเดียวกับ `createReportItem`), `AuditService`, `Tx`, partial unique index ของ `queue_items` (`target_id`,`type` เปิดได้รายการเดียว), `AppException`, `JwtAuthGuard`/`RolesGuard`
- Event ห้ามพกข้อมูลส่วนบุคคลหรือเนื้อรีวิว (event-contract §1): E10 ส่งได้เฉพาะรหัสเหตุผล
- ค่าที่ไม่ตายตัวอยู่ใน constants ของโมดูล (ไม่เพิ่ม env): ความยาว `reason` ของรายงาน 10–1000 ตัวอักษร; `due_at` ของรายการคิวรีวิว = SLA ปกติของรายการ `JOB_REPORT`/`COMPANY_ACCOUNT` (48 ชม., `priority = NORMAL` — Fast-Track ใช้เฉพาะ `JOB_REVIEW`/`JOB_APPEAL`, OD-10)

## 4. ทางเลือกที่พิจารณา

| ประเด็น | ตัวเลือก | ที่เลือก |
| :--- | :--- | :--- |
| ขอบเขต/ลำดับ | (A) ทำทั้งสไลซ์ยึด contract + Event จำลอง (B) รอ Lifecycle ก่อน | **(A)** เหมือนสไลซ์ 2 — contract ล็อกแล้ว ทดสอบกับ RabbitMQ จริงได้ |
| Admin ลบรีวิวที่เผยแพร่แล้ว (`REVIEW_REPORT`) | (A) ใช้ E10 เดิม (`ADMIN_REMOVE`/`ADMIN_PUBLISH`) แล้วเขียนกติกาให้ Lifecycle (B) เพิ่ม decision ใหม่ใน E10 | **(A)** PM เลือก — ไม่เพิ่ม Event/ชนิดใหม่; ต้องแจ้ง Lifecycle ว่า `ADMIN_REMOVE` ใช้กับ PUBLISHED ได้ และ `ADMIN_PUBLISH` ของที่เผยแพร่แล้วต้องข้ามเงียบ |
| Admin อ่านเนื้อรีวิวจากที่ไหน | (a) เรียก Lifecycle (b) เก็บสำเนาเนื้อหาใน `review_moderations` (c) ไม่แสดงเนื้อหา | **(b)** ห้ามเรียกข้าม Service sync และ Admin ต้องอ่านก่อนตัดสิน (c) ตัดสินไม่ได้; ผลข้างเคียง (ข้อมูลส่วนบุคคลในสำเนา) จัดการใน §5.7 |
| เกณฑ์เข้าคิวของรายงานรีวิว | (a) รายงานแรกเข้าคิว (b) ครบ N บัญชีแบบรายงานประกาศ | **(a)** README 5.5 ระบุเพียง "กด Report ได้ และ Admin พิจารณาในคิว" ไม่มีเกณฑ์; รีวิวถูกกดรายงานจึงไม่ถูกซ่อนอัตโนมัติ (ซ่อน/ลบเฉพาะเมื่อ Admin ตัดสิน) จึงไม่มีความเสี่ยงจากการรายงานเท็จหลายบัญชี |
| ใครรายงานรีวิวได้ | (a) `S` และ `H` ทุกคน (b) `S` ทุกคน, `H` เฉพาะรีวิวของบริษัทตน | **(b)** contract ให้ `S,H`; จำกัด HR ตามบริษัทกันคู่แข่งใช้รายงานกดรีวิวบริษัทอื่น (ข้อสมมติของผู้เขียน §8) |
| รีวิวติดตัวสแกนระดับไหนถึง `HOLD` | (a) เจอคำ HARD หรือข้อมูลติดต่อ (b) รวมคำ SOFT ด้วย | **(a)** SOFT เป็นตัวถ่วงคะแนนเสี่ยงของประกาศงาน ไม่ใช่คำต้องห้ามของรีวิว (ข้อสมมติของผู้เขียน §8) |

## 5. การออกแบบ

### 5.1 Event

| ทิศทาง | Event | ทำอะไร |
| :--- | :--- | :--- |
| รับ | E09 `ReviewSubmitted` | สแกน → บันทึก `review_moderations` → ส่ง E10 (`PUBLISH`/`HOLD`) (+ รายการ `REVIEW_HELD` เมื่อ `HOLD`) ใน Transaction เดียว |
| ส่ง | E10 `ReviewModerationResult` | `PUBLISH`/`HOLD` (`decided_by=SYSTEM`) จากการสแกน; `ADMIN_PUBLISH`/`ADMIN_REMOVE` (`decided_by=ADMIN`) จากการตัดสินของ Admin — ผู้รับ: Lifecycle, Notification |
| รับ | E15 `UserDeletionRequested` | มีอยู่แล้ว — เพิ่มการแก้ตารางของสไลซ์นี้ (§5.7) |

E09 ที่มาซ้ำ (event_id เดียวกัน) ถูกกันโดย `processed_events` ของ lib; E09 ที่มี `review_id` ซ้ำแต่ event_id ต่างกัน ถูกข้ามเงียบพร้อม log ระดับ `warn` (ไม่ส่ง E10 ซ้ำ — §5.8 ข้อ 2)

### 5.2 ข้อมูล (เพิ่มใน `verification_db`)

migration ใหม่ (ไม่แก้ migration เดิม):
- **`review_moderations`** (ตาม data-schema §5 + ส่วนเพิ่ม): `id`, `review_id uuid UNIQUE`, `company_id`, **`student_user_id`**, **`rating smallint`**, **`outcome_label text`**, **`title text null`**, **`body text`**, `decision` (`PUBLISH|HOLD|ADMIN_PUBLISH|ADMIN_REMOVE` — คำตัดสินล่าสุดที่ส่งใน E10), `reasons jsonb`, `status` (`PASSED|HELD|ADMIN_PUBLISHED|ADMIN_REMOVED`), `queue_item_id null`, `created_at`, **`updated_at`** — เพิ่ม index (`company_id`) ไม่จำเป็น
- **`review_reports`**: `id`, `review_id`, `reporter_user_id`, `reason`, `created_at` — UNIQUE (`review_id`, `reporter_user_id`); `reason` ห้าม log
- `QueueOrigin` เพิ่ม `REVIEW_SCAN` (รีวิวติดตัวสแกน) และ `REVIEW_REPORT` (มีรายงาน); `QueueItemType` มี `REVIEW_HELD`/`REVIEW_REPORT` อยู่แล้ว
- `status_history` entity `QUEUE_ITEM` ตามเดิม (ไม่มี entity ใหม่)

ความหมายของ `status`: `PASSED` = ผ่านการสแกน (เผยแพร่ตาม E10 `PUBLISH`); `HELD` = รอ Admin; `ADMIN_PUBLISHED` = Admin เผยแพร่/ยืนยันให้คงอยู่; `ADMIN_REMOVED` = Admin ลบ ("รีวิวเผยแพร่อยู่" = `PASSED` หรือ `ADMIN_PUBLISHED`)

### 5.3 การสแกนรีวิว (E09)

1. ต่อ `title` (ถ้ามี) กับ `body` ด้วยบรรทัดใหม่ แล้วสแกนด้วย `normalizeText` + `findTermMatches` (กฎ/คำปัจจุบัน รวมการตรวจประโยคปฏิเสธ) และ `detectContact`
2. **`HOLD`** เมื่อพบคำระดับ `HARD` อย่างน้อยหนึ่งคำ (ที่ไม่ถูกประโยคปฏิเสธล้าง) **หรือ** พบข้อมูลติดต่อส่วนตัว (เบอร์โทร/อีเมล/LINE ID) — เหตุผล `BLACKLIST` และ/หรือ `PERSONAL_CONTACT` (ไม่มี `detail` เพราะห้ามพกเนื้อรีวิว); คำ `SOFT` ไม่ทำให้ `HOLD`
3. มิฉะนั้น **`PUBLISH`** (`reasons: []`)
4. ใน Transaction เดียว: insert `review_moderations` (ชน unique ⇒ ข้ามตาม §5.1) → ถ้า `HOLD` สร้างรายการ `REVIEW_HELD` (`target_type='review'`, `target_id=review_id`, `company_id`, `origin=REVIEW_SCAN`, `priority=NORMAL`, `due_at` ตาม §3, `status_history` OPEN) แล้วเก็บ `queue_item_id` → ส่ง E10 ผ่าน outbox (`decided_by=SYSTEM`, `student_user_id` จาก E09)
5. ใช้กฎ ณ เวลาที่ประมวลผล (ไม่สแกนซ้ำเมื่อกฎเปลี่ยนภายหลัง)

### 5.4 การรายงานรีวิว

`POST /reviews/{review_id}/reports` — role `S` หรือ `H`, body `{reason}` (10–1000 ตัวอักษร; ผิดรูป ⇒ `400 VALIDATION_FAILED`) ลำดับตรวจ:
1. ไม่มี `review_moderations` ของรีวิว ⇒ `404 NOT_FOUND`
2. role `H`: JWT ต้องมี `company_id` และเท่ากับ `company_id` ของรีวิว ไม่เช่นนั้น `403 FORBIDDEN_ROLE`
3. สถานะไม่ใช่ "เผยแพร่อยู่" (`HELD` หรือ `ADMIN_REMOVED`) ⇒ `422 REVIEW_NOT_REPORTABLE`
4. เคยรายงานรีวิวนี้แล้ว (ผู้ใช้เดียวกัน) ⇒ `409 ALREADY_REPORTED`
5. ใน Transaction เดียว: insert `review_reports` (ชน unique ⇒ `409`) → ถ้ายังไม่มีรายการ `REVIEW_REPORT` เปิดของรีวิวนี้ สร้างรายการ (`origin=REVIEW_REPORT`, `priority=NORMAL`, `due_at` ตาม §3; ชน partial unique index ⇒ ถือว่ามีอยู่แล้ว ไม่ error)
6. ตอบ `201 {id, status: 'OPEN'}`

ไม่มีการจำกัดจำนวนครั้ง/วันของผู้รายงาน (contract ไม่กำหนด) และไม่ส่ง Event

### 5.5 การตัดสินของ Admin

`POST /admin/queue/{id}/actions/{publish-review|remove-review}` — role `PLATFORM_ADMIN`, body `{reason?}` (`remove-review` **ต้องมี `reason`** 1–500 ตัวอักษร ไม่มี ⇒ `400 VALIDATION_FAILED`), `204`; ชนิดรายการไม่ใช่ `REVIEW_HELD`/`REVIEW_REPORT` ⇒ `422 UNSUPPORTED_ITEM_TYPE`; `RESOLVED` แล้ว ⇒ `409 STATE_CONFLICT`; ปิดรายการด้วย `updateMany where status <> 'RESOLVED'` แบบสไลซ์ 1 (ผู้ตัดสินคนที่สอง ⇒ 0 แถว ⇒ `409` และ rollback ทั้งก้อน) ผลตามชนิดรายการ:

| รายการ | `publish-review` | `remove-review` |
| :--- | :--- | :--- |
| **`REVIEW_HELD`** (รีวิวถูกพัก) | `status` → `ADMIN_PUBLISHED` · E10 `ADMIN_PUBLISH` | `status` → `ADMIN_REMOVED` · E10 `ADMIN_REMOVE` |
| **`REVIEW_REPORT`** (รีวิวเผยแพร่แล้ว) | **ยืนยันให้คงอยู่:** `status` → `ADMIN_PUBLISHED` · E10 `ADMIN_PUBLISH` (Lifecycle ข้ามเงียบเพราะเผยแพร่อยู่แล้ว) | `status` → `ADMIN_REMOVED` · E10 `ADMIN_REMOVE` (Lifecycle เปลี่ยน PUBLISHED → REMOVED และส่ง `ReviewPublished` ใหม่) |

- `reasons` ของ E10: `[{code:'ADMIN', detail: <reason ถ้ามี>}]` และเพิ่ม `{code:'REPORTED'}` เมื่อเป็นรายการ `REVIEW_REPORT`; `decided_by='ADMIN'`; `student_user_id` จาก `review_moderations`
- การเปลี่ยน `review_moderations.status` ใช้ `updateMany where review_id = ? AND status IN (<สถานะที่คาด>)` เช่นเดียวกัน; ได้ 0 แถว ⇒ `409 STATE_CONFLICT` (เช่น รีวิวถูกลบไปแล้วโดยรายการอื่น)
- รายงานที่ถูกปิดไปพร้อมรายการ **ไม่มีสถานะ** (`review_reports` ไม่มีฟิลด์ `status`): หลัง `publish-review` ผู้ใช้ **คนใหม่** รายงานรีวิวเดิมได้อีก (สร้างรายการใหม่) ส่งผู้ที่เคยรายงานแล้วยังได้ `409 ALREADY_REPORTED`; หลัง `remove-review` รายงานไม่ได้อีก (`422`)
- ทุก action เขียน `status_history` (entity `QUEUE_ITEM`, `reason` = เหตุผลของ Admin) + `admin_audit_log` (`REVIEW_PUBLISH`, `REVIEW_REMOVE`; `target_type='review'`, `target_id=review_id`) ใน Transaction เดียว

### 5.6 หน้าคิวของ Admin

- `GET /admin/queue` (รายการ): รองรับ `type=REVIEW_HELD|REVIEW_REPORT` อยู่แล้วตามฟิลเตอร์ของสไลซ์ 1; `target_id` = `review_id`, `company_name` จาก `company_snapshots`
- `GET /admin/queue/{id}` ของ `REVIEW_*` เพิ่ม `review: {review_id, rating, outcome_label, title, body, moderation_status, highlights}` (`highlights` คำนวณจากเนื้อหาด้วยกฎ ณ ตอนอ่านด้วยตัวเดียวกับของประกาศ) และ `review_reports: [{id, reporter_user_id, reason, created_at}]` (เฉพาะ `REVIEW_REPORT`)
- ฟิลด์ของประกาศ (`risk_score`, `content`, `appeal_statement`, `reports`) เป็นค่าว่างเมื่อเป็นรายการรีวิว

### 5.7 ความปลอดภัย ความเป็นส่วนตัว และ log

- สิทธิ์: รายงาน = `STUDENT`, `COMPANY_HR`; ตัดสิน/ดูคิว = `PLATFORM_ADMIN` (`403` สำหรับ role อื่น, `401` ไม่มี token)
- เนื้อรีวิว, `reason` ของรายงาน และ `reporter_user_id` ออกได้เฉพาะ `GET /admin/queue/{id}` — ห้ามมีใน Event, log และ endpoint อื่น; log ได้เฉพาะ `event_id`, `review_id`, `company_id`, `queue_item_id`, ผลตัดสิน, รหัสเหตุผล
- **E15 (ขยาย handler เดิม ในสไลซ์นี้):**
  - `review_moderations.student_user_id` → `anonymous_actor_id` ของผู้ใช้นั้น
  - `review_reports.reporter_user_id` → `anonymous_actor_id` และล้าง `reason` เป็นข้อความว่าง (UNIQUE ยังไม่ชนเพราะรหัสนิรนามแยกต่อผู้ใช้)
  - ถ้ารีวิวของผู้ใช้นั้น `status = HELD`: ล้าง `title`/`body` เป็นค่าว่าง (รีวิวที่ติดมักมีข้อมูลติดต่อส่วนตัว และยังไม่เผยแพร่) แต่ **คงรายการคิวและสถานะไว้** เพื่อให้ Admin ปิดรายการได้ตามปกติ; รีวิวที่เผยแพร่แล้ว (`PASSED`/`ADMIN_PUBLISHED`) คงเนื้อหาไว้ตาม README 5.11 ("รีวิวที่เผยแพร่แล้ว" เก็บแต่ไม่ระบุตัวตน) — ข้อสมมติของผู้เขียน §8

### 5.8 กรณีขอบ / การตัดสินใจของผู้เขียน (ตรวจได้)

1. **รีวิวถูกพักแล้วผู้เขียนลบบัญชี:** ดู §5.7; Lifecycle ตัดสินเองว่าจะลบ/ไม่เผยแพร่รีวิวนั้น Verification ไม่ส่ง E10 เพิ่ม
2. **E09 ซ้ำด้วย `review_id` เดิม:** ถือว่ารีวิวไม่แก้ได้ ข้ามเงียบพร้อม `warn` ไม่สแกน/ไม่ส่ง E10 ซ้ำ
3. **รีวิวหนึ่งถูกรายงานหลายคนพร้อมกัน:** ผลคือแถว `review_reports` ครบทุกคนและมีรายการ `REVIEW_REPORT` เปิดเพียงรายการเดียว (partial unique index)
4. **Admin ตัดสินรายการรีวิวที่ถูกลบ/เผยแพร่ไปแล้วโดยรายการอื่น:** ได้ `409 STATE_CONFLICT` (เงื่อนไขสถานะใน §5.5) ไม่ส่ง E10 ซ้ำ
5. **รีวิวถูกรายงานระหว่างที่รอ Lifecycle รับ E10 `PUBLISH`:** รายงานได้ตามสถานะของเรา (`PASSED`); ถ้า Lifecycle ยังไม่ได้เปลี่ยนเป็น PUBLISHED ผลตัดสิน `ADMIN_REMOVE` มาถึงทีหลังก็ยังถูกต้อง (Lifecycle ต้องรับได้จากทั้ง SUBMITTED และ PUBLISHED — ระบุใน §6)
6. **ผู้เขียนรีวิวรายงานรีวิวตัวเอง:** ทำได้ ไม่มีกฎห้าม (ไม่มีผลเสีย; นับเป็นรายงานปกติ)
7. **ข้อมูลของบริษัทที่ถูกระงับ/ธง `UNDER_REVIEW`:** ไม่กระทบการตรวจรีวิว

### 5.9 การทดสอบ

- **ตัวสแกนรีวิว (Postgres จริง):** ผ่านปกติ ⇒ `PUBLISH`; เจอคำ HARD ⇒ `HOLD` + `BLACKLIST`; เจอเบอร์/อีเมล/LINE ID ⇒ `HOLD` + `PERSONAL_CONTACT`; ทั้งสองอย่าง ⇒ สองเหตุผล; ประโยคปฏิเสธ (เช่น "ไม่เรียกเก็บเงินมัดจำ") ⇒ `PUBLISH`; คำ SOFT อย่างเดียว ⇒ `PUBLISH`; `HOLD` สร้างรายการ `REVIEW_HELD` และ E10 ใน outbox หนึ่งชุดพอดี; E09 ซ้ำ ⇒ ไม่มี E10/รายการซ้ำ; payload ของ E10 ไม่มีเนื้อรีวิว/ข้อความที่จับได้
- **รายงานรีวิว:** ผ่าน (`201`, รายการ `REVIEW_REPORT` หนึ่งรายการ); ไม่รู้จักรีวิว `404`; รีวิว `HELD`/`ADMIN_REMOVED` ⇒ `422`; ซ้ำ ⇒ `409`; HR คนละบริษัท ⇒ `403`, HR บริษัทเดียวกัน ⇒ `201`; หลายผู้ใช้พร้อมกัน ⇒ รายการเปิดหนึ่งรายการ; `reason` สั้น/ยาวเกิน ⇒ `400`
- **ตัดสินของ Admin:** ทั้ง 2 ชนิดรายการ × 2 action ตามตาราง §5.5 (E10, `status`, `reasons`, `status_history`, `admin_audit_log`); `remove-review` ไม่มี `reason` ⇒ `400`; ชนิดรายการอื่น ⇒ `422`; ตัดสินซ้ำ/พร้อมกัน ⇒ `409` และมี E10 เพียงชุดเดียว; หลัง `publish-review` ผู้ใช้ใหม่รายงานซ้ำได้ ผู้เดิม `409`; หลัง `remove-review` รายงานไม่ได้
- **สิทธิ์/ความเป็นส่วนตัว:** นักศึกษา/HR เรียก endpoint Admin ⇒ `403`; `review`/`review_reports` ไม่โผล่นอก `GET /admin/queue/{id}`; log ไม่มีเนื้อรีวิว/`reason`
- **E15:** ขยายเทสต์ `UserAnonymizationService` ตาม §5.7 (รีวิว `HELD` ล้างเนื้อหา, รีวิวเผยแพร่คงเนื้อหา, รายงานล้าง `reason`, ประมวลผลซ้ำได้)
- **End-to-end (RabbitMQ จริง, ข้ามถ้าไม่มี Docker):** ส่ง E09 สะอาด ⇒ ได้ E10 `PUBLISH`; ส่ง E09 ที่มีเบอร์โทร ⇒ ได้ `HOLD` + รายการคิว → Admin `publish-review` ⇒ ได้ `ADMIN_PUBLISH`
- ชนิดของ Event/DTO ตรวจตอนคอมไพล์ด้วย `@internpath/contracts`

## 6. เอกสารที่ต้องอัปเดตใน PR เดียวกัน

1. `data-schema.md` §5: `review_moderations` (ฟิลด์ที่เพิ่ม), `review_reports`, ค่า `origin` ใหม่ (`REVIEW_SCAN`, `REVIEW_REPORT`), กติกา anonymize ของสองตารางนี้
2. `api-contract.md` §6.4: `POST /reviews/{id}/reports` (`reason` 10–1000, `201 {id,status}`, `404`, `403` สำหรับ HR คนละบริษัท, `422 REVIEW_NOT_REPORTABLE`, `409 ALREADY_REPORTED`); §6.1: `publish-review|remove-review` (`reason` บังคับสำหรับ remove, `204`, `422 UNSUPPORTED_ITEM_TYPE`, `409 STATE_CONFLICT`) และรูปแบบ `GET /admin/queue/{id}` ของรายการรีวิว (§5.6)
3. `event-contract.md` E10: ใส่กติกาแบบ A — `ADMIN_REMOVE` ใช้กับรีวิวที่ `SUBMITTED`, `HELD` หรือ `PUBLISHED` (จาก PUBLISHED ⇒ Lifecycle เปลี่ยนเป็น REMOVED และส่ง `ReviewPublished` ใหม่ให้ตัวนับคะแนนตรง), `ADMIN_PUBLISH` ของรีวิวที่ `PUBLISHED` อยู่แล้ว ⇒ ผู้รับข้ามเงียบ; ผู้รับต้องไม่ล้มเมื่อได้ E10 ที่สถานะไม่ตรง (ข้ามพร้อม log)
4. `diagram.md` ลำดับรีวิว: เพิ่มกรณีรายงาน → Admin ลบ/ยืนยัน
5. `developer-guide.md`: ติ๊กงาน Verification สไลซ์ 3; บันทึกกติกา Lifecycle ใน §6 ข้อ 3 ในรายการของ Tester
6. **แจ้งเจ้าของ Lifecycle (Tester):** กติกาใน §6 ข้อ 3, E10 ต้องรับซ้ำได้และข้ามเมื่อสถานะไม่ตรง, และเรื่อง anonymization ของรีวิวที่ถูกพัก (§5.7)

## 7. ปล่อยให้ผู้ลงมือตัดสิน

- โครงโฟลเดอร์ใหม่ใน `apps/verification/src` (เช่น `review/` สำหรับการสแกน/รายงาน/ตัดสิน) และชื่อ class/DTO
- ชื่อ migration, วิธีเขียนการสร้างรายการคิวแบบไม่ซ้ำ (ดักชน partial unique index หรือ `ON CONFLICT DO NOTHING`) ตราบที่ผ่านเทสต์ขนานใน §5.9
- วิธีประกอบ `highlights` ของเนื้อรีวิว (ใช้ `buildHighlights` เดิมหรือปรับเล็กน้อย) และรูปแบบ response ของส่วนที่ไม่ได้ระบุใน §5.6
- รหัส error ของส่วนที่ไม่ได้ระบุ ให้ใช้รหัสที่มีอยู่ใน api-contract §2 ก่อน (`REVIEW_NOT_REPORTABLE` เป็นรหัสใหม่ที่ต้องเพิ่มในตารางนั้น)

## 8. ข้อสมมติที่ผู้เขียนตัดสินเอง (ตรวจได้)

- `HOLD` เฉพาะ HARD หรือข้อมูลติดต่อ — คำ SOFT ไม่ทำให้พัก (§4)
- HR รายงานได้เฉพาะรีวิวของบริษัทตน (`403` นอกเหนือจากนั้น) — contract เดิมไม่ระบุ
- `reason` ของรายงาน 10–1000 ตัวอักษร และ `reason` ของ `remove-review` บังคับ 1–500 ตัวอักษร — contract เดิมไม่ระบุ
- รายงานแรกเข้าคิวเลย ไม่มีเกณฑ์จำนวนและไม่มีการจำกัดจำนวนครั้ง/วัน ไม่มี streak ของผู้รายงาน
- `publish-review` ของ `REVIEW_REPORT` เปลี่ยนสถานะเป็น `ADMIN_PUBLISHED` และส่ง E10 `ADMIN_PUBLISH` เพื่อให้มีร่องรอยว่า Admin ตรวจแล้ว (ผู้รับข้าม)
- เก็บสำเนาหัวข้อ/เนื้อหา/ดาว/ป้ายผลการฝึกของรีวิวใน Verification เพื่อให้ Admin อ่านและเพื่อคำนวณ highlights
- เมื่อผู้เขียนรีวิวลบบัญชี: รีวิวที่ถูกพักล้างเนื้อหา (อาจมีข้อมูลติดต่อส่วนตัว), รีวิวที่เผยแพร่แล้วคงเนื้อหา (§5.7) — **PM ควรตรวจข้อนี้** — **PM ยืนยัน 2026-11-17:** Lifecycle เปลี่ยนรีวิว `SUBMITTED`/`HELD` ของผู้ลบบัญชีเป็น `REMOVED` และล้าง `title`/`body` เช่นกัน (data-schema §2.3)
- รีวิวไม่สามารถแก้ไขหลังส่ง จึงไม่มี E09 ฉบับที่สอง (§5.8 ข้อ 2)
