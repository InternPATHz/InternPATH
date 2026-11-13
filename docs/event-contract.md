# 📨 Event Contract (InternPath)

> ที่เก็บหลักของ **Event ทั้งหมด** — Envelope, Payload, Routing, Retry/DLQ
> สรุประดับ Service ดู [architecture.md](architecture.md) §2 | กฎธุรกิจที่ทำให้เกิด Event ดู [README.md](../README.md) หัวข้อ 5.x ที่อ้างในแต่ละรายการ
> ชนิดข้อมูล (TypeScript) อยู่ที่ `libs/contracts/events/*.ts` — ต้องตรงกับเอกสารนี้

---

## 1. Envelope (ใช้เหมือนกันทุก Event)

```json
{
  "event_id": "uuid-v4",
  "type": "ApplicationStatusChanged",
  "version": 1,
  "occurred_at": "2026-11-13T08:30:00.000Z",
  "correlation_id": "uuid-v4",
  "producer": "lifecycle",
  "payload": { }
}
```

| ฟิลด์ | ความหมาย |
| :--- | :--- |
| `event_id` | ใช้ทำ Idempotency ฝั่ง Consumer (`processed_events`) |
| `type` | ชื่อ Event (PascalCase) |
| `version` | **เวอร์ชันของ Schema Payload** (integer) เริ่มที่ 1 — เปลี่ยนเมื่อ Payload ไม่เข้ากันย้อนหลัง |
| `occurred_at` | เวลาที่เหตุการณ์เกิดจริง (UTC) |
| `correlation_id` | สืบต่อจาก Request ต้นทาง |
| `producer` | ชื่อ Service ผู้ส่ง |
| `payload` | ข้อมูลเฉพาะ Event |

**ข้อห้ามของ Payload:** ห้ามพกข้อมูลส่วนบุคคล (อีเมล เบอร์โทร ชื่อ-นามสกุล เนื้อเรซูเม่) — พก `user_id` เท่านั้น (README 4.3 Notification, 5.11) ข้อยกเว้น (เนื้อหาที่เป็นสาธารณะหรือจำเป็นต่อการตรวจ): Snapshot ชื่อ/โลโก้ **บริษัท** ใน `CompanyStatusChanged`, เนื้อหาประกาศงานใน `JobSubmitted`, และข้อความรีวิวใน `ReviewSubmitted` (รีวิวอาจมีข้อมูลติดต่อส่วนตัวซึ่งเป็นสิ่งที่ Verification ต้องตรวจ — ห้าม Log เนื้อหานี้)

## 2. Transport

| รายการ | ค่า |
| :--- | :--- |
| Exchange | `internpath.events` (type: `topic`, durable) |
| Routing key | `<producer>.<EventType>` เช่น `lifecycle.ApplicationStatusChanged` |
| Queue ต่อ Consumer | `<consumer>.<EventType>` เช่น `notification.ApplicationStatusChanged` (durable) ผูกกับ routing key ที่ต้องการ |
| Dead Letter Exchange | `internpath.dlx` → queue `<consumer>.<EventType>.dlq` |
| Message | `content_type: application/json`, `delivery_mode: 2` (persistent), `message_id = event_id`, header `x-correlation-id` |
| Ack | Manual ack หลังบันทึก `processed_events` + ผลลัพธ์ใน Transaction เดียวกัน |

## 3. กติกาความทนทาน (ตาม README 5.8)

### 3.1 Outbox (ฝั่งผู้ส่ง)
เขียนแถวลง `outbox_events` **ใน Transaction เดียวกับการเปลี่ยนข้อมูล**; Relay แยกอ่านไปส่ง RabbitMQ แล้ว mark `published_at`

```text
outbox_events(id=event_id, type, version, payload jsonb, correlation_id,
              created_at, published_at NULL, attempts int)
```
- ส่งแบบ at-least-once (อาจซ้ำ) • Relay เรียงตาม `created_at` ต่อ `aggregate_id` เพื่อรักษาลำดับต่อ entity
- `OutboxWriter` เป็นคนกำหนด `created_at` เอง (เพิ่มทีละ ≥ 1 ms ต่อ process) เพราะค่าเริ่มต้นของ DB คือเวลาเริ่ม Transaction ซึ่ง event หลายตัวใน Transaction เดียวกันจะเท่ากัน และ relay ใช้ `id` (สุ่ม) เป็นตัวตัดสินเมื่อเวลาเท่ากัน
- ผู้ส่งไม่ใช้ `mandatory`: ข้อความที่ไม่มีคิวผูกอยู่ถูก broker ทิ้งแต่ถือว่าส่งสำเร็จ — คิวผู้รับถูกประกาศตอน `subscribe` จึงต้องมี Service ผู้รับรันอย่างน้อยหนึ่งครั้งก่อนที่ Event ชนิดนั้นจะถูกส่ง

### 3.2 Idempotency (ฝั่งผู้รับ)
- ก่อนประมวลผล: `INSERT INTO processed_events(event_id, consumer) ... ON CONFLICT DO NOTHING` ถ้าไม่ได้แถวใหม่ → ข้าม แล้ว Ack
- การเขียนผลกับ `processed_events` อยู่ใน Transaction เดียวกัน

### 3.3 Retry และ DLQ
| ครั้งที่ | หน่วงก่อนลองใหม่ |
| :-: | :-: |
| 1 | 5 วินาที |
| 2 | 30 วินาที |
| 3 | 2 นาที |
| เกิน 3 | ส่งเข้า DLQ + ส่งแจ้งเตือนผู้ดูแล (Log ระดับ `error` + Notification แจ้ง Admin) |

ทำด้วย retry queue + TTL + DLX; Header `x-retry-count` เก็บจำนวนครั้ง

กลไกที่ `libs/common` ใช้ (ทดสอบกับ RabbitMQ 3.13 จริง):
- **retry queue ร่วมต่อ Service 3 คิว** `<service>.retry.1|2|3` ตั้ง `x-message-ttl` = 5 วินาที / 30 วินาที / 2 นาที และ `x-dead-letter-exchange = internpath.retry-return`
- ผู้รับ publish ข้อความลง retry queue พร้อม header **`origin-queue`** = ชื่อคิวต้นทาง แล้วจึง ack ต้นฉบับ
- `internpath.retry-return` เป็น **headers exchange**; คิวผู้รับแต่ละตัวผูกด้วย `x-match=all, origin-queue=<ชื่อคิวตัวเอง>` ข้อความหมด TTL แล้วจึงกลับเข้าคิวต้นทางเอง
- ชื่อ header จับคู่ **ห้ามขึ้นต้นด้วย `x-`** เพราะ RabbitMQ ไม่นำ header `x-*` มาจับคู่ binding (ถ้าใช้ ข้อความจะกลับเข้าทุกคิว)
- คิวผู้รับตั้ง `x-dead-letter-exchange = internpath.dlx`, `x-dead-letter-routing-key = <ชื่อคิว>`; ผู้รับ `nack(requeue=false)` เมื่อครบ 3 ครั้งหรือข้อความเสีย (JSON พัง, ไม่มี `event_id`, `version` ที่ไม่รองรับ) ข้อความจึงเข้า `<ชื่อคิว>.dlq`
- การแจ้ง Admin เมื่อเข้า DLQ: ตอนนี้ log ระดับ `error` (ไม่มี payload) และมี hook `onDeadLetter`; ยังไม่ผูก Notification

> **เพดานแผนฟรีของ CloudAMQP:** จำนวน queue จำกัด (Consumer มีประมาณ 33 คิวตาม §4 และ DLQ อีกต่อคิว) จึงให้ใช้ **retry queue ร่วมต่อ Service** (หนึ่งชุด 5 วินาที / 30 วินาที / 2 นาที ต่อ Service แทนการแยกต่อ `<consumer>.<EventType>`) และตรวจตัวเลขเพดานจริงของแผนก่อนใช้งาน

### 3.4 ลำดับ Event
- Event ที่เป็น "สถานะล่าสุดของ entity" ต้องมี `entity_version` (integer เพิ่มทีละ 1 ต่อ entity ที่ผู้ส่ง) ใน Payload
- ผู้รับเขียนทับเฉพาะเมื่อ `entity_version` ใหม่ > ที่เก็บไว้; ถ้าน้อยกว่าให้ทิ้ง (ไม่ใช่ข้อผิดพลาด) — ใช้กับ Snapshot บริษัท (`CompanyStatusChanged`), สถานะประกาศ (`JobStatusChanged`)

### 3.5 Schema Evolution
- เพิ่มฟิลด์ **ที่ไม่บังคับ** = ไม่ต้องเปลี่ยน `version`
- ลบ/เปลี่ยนชนิดฟิลด์ = เพิ่ม `version` และผู้ส่งส่งทั้ง 2 เวอร์ชันชั่วคราวจนกว่าผู้รับครบ
- Consumer ต้อง **ไม่ล้มเมื่อเจอฟิลด์ที่ไม่รู้จัก**

---

## 4. สรุป Event ทั้งหมด

| # | Event | ผู้ส่ง | ผู้รับ | กฎธุรกิจ (README) |
| :-: | :--- | :--- | :--- | :--- |
| E01 | `JobSubmitted` | job | verification | 5.1 |
| E02 | `JobVerified` | verification | job | 5.1, 5.1.3, 5.1.4 |
| E03 | `JobStatusChanged` | job | lifecycle, notification, verification | 5.1.1, 5.1.2 |
| E04 | `ReportThresholdReached` | verification | job, notification | 5.1.3 |
| E05 | `CompanyStatusChanged` | identity | job, lifecycle, verification, notification | 5.6 |
| E06 | `CompanyEntitlementChanged` | identity | job, verification | 3, 5.6 |
| E07 | `AdvisorLinkChanged` | identity | lifecycle, notification | 5.6 |
| E08 | `ApplicationStatusChanged` | lifecycle | notification | 5.2 |
| E09 | `ReviewSubmitted` | lifecycle | verification | 5.5 |
| E10 | `ReviewModerationResult` | verification | lifecycle, notification | 5.5 |
| E11 | `ReviewPublished` | lifecycle | identity, notification | 5.5 |
| E12 | `CertificateIssued` | lifecycle | notification | 5.4 |
| E13 | `CertificateRevoked` | lifecycle | notification | 5.4 |
| E14 | `ReminderDue` | lifecycle | notification | 5.3 |
| E15 | `UserDeletionRequested` | identity | lifecycle, job, verification, notification | 5.11 |
| E16 | `UserSuspended` *(เพิ่มใหม่)* | identity | gateway (cache denylist), notification | 5.7 |
| E17 | `ProblemReportCreated` *(เพิ่มใหม่)* | lifecycle | notification | 5.2.2 |
| E18 | `CompanyFlagChanged` *(เพิ่มใหม่)* | verification | job, notification | 5.1.4 |

> **E03 รับโดย verification เพิ่ม** เพื่อรู้ว่าประกาศถูกตั้ง `PENDING_REVIEW` โดย Fail-safe (สร้างรายการคิว Admin) และเพื่อนับการถูกปฏิเสธ/ระงับ/ลบ (เกณฑ์ `UNDER_REVIEW`)
> **E16–E18** ทีมยืนยันแล้วและได้เพิ่มในตารางสรุป README 5.8 แล้ว (Denylist ทันที, แจ้งอาจารย์/Admin เมื่อมีรายงานปัญหา, ธงบริษัทมีผลกับ Job)

---

## 5. Payload รายตัว

ทุก `*_at` เป็น ISO-8601 UTC | `?` = ไม่บังคับ | `entity_version` ดู §3.4

### E01 `JobSubmitted`  (job → verification)
```ts
{
  job_id: string
  company_id: string
  submission_id: string            // 1 ครั้งที่ส่งตรวจ (idempotency ของการตรวจ)
  submission_kind: 'NEW' | 'EDIT' | 'RESUBMIT'   // RESUBMIT = แก้หลัง AUTO_REJECTED/ADMIN_REJECTED แล้วส่งใหม่
  changed_fields?: string[]        // กรณี EDIT
  content: {                       // เฉพาะฟิลด์ข้อความที่ต้องสแกน
    job_title: string
    description: string
    responsibilities: string
    qualifications: string
    allowance_text: string
    location: string
    contact_notes?: string
  }
  work_mode: 'ONSITE' | 'REMOTE' | 'HYBRID'
  hours_per_week: number
  allowance: { type: 'AMOUNT' | 'NONE', amount_thb?: number }   // amount_thb = จำนวนเงินต่อเดือน (บาท)
  company_flag_under_review: boolean   // snapshot ณ ตอนส่ง
  fast_track: boolean                  // snapshot ณ ตอนส่ง
  submitted_at: string
}
```
*(เนื้อหาประกาศงานเป็นข้อมูลสาธารณะอยู่แล้ว ไม่ใช่ข้อมูลส่วนบุคคล)*

### E02 `JobVerified`  (verification → job)
```ts
{
  job_id: string
  submission_id: string
  decision: 'APPROVE' | 'PENDING_REVIEW' | 'AUTO_REJECT'     // ผลตรวจอัตโนมัติ
          | 'APPEAL_ACCEPTED'                                // HR อุทธรณ์ถูกต้อง → AUTO_REJECTED→PENDING_REVIEW
          | 'ADMIN_APPROVE' | 'ADMIN_REJECT'                 // คำตัดสิน Admin (รวมผลอุทธรณ์)
          | 'REMOVE' | 'RESTORE'                             // ผลตัดสินคำร้อง Report (RESTORE = ยกคำร้อง)
  risk_score?: number               // 0–100
  risk_level?: 'LOW' | 'MEDIUM' | 'HIGH'
  reasons: Array<{ code: string, detail: string, matched_text?: string }>
  is_appeal: boolean
  decided_by: 'SYSTEM' | 'ADMIN'
  decided_at: string
}
```
การระงับชั่วคราว (`SUSPENDED`) เกิดจาก E04 `ReportThresholdReached` ไม่ใช่ `JobVerified`
Job ใช้ `UPDATE ... WHERE status = <สถานะที่คาดไว้>` ตามตาราง Map ใน [data-schema.md](data-schema.md) §8.2

### E03 `JobStatusChanged`  (job → lifecycle, notification, verification)
```ts
{
  job_id: string
  company_id: string
  from_status: JobStatus
  to_status: JobStatus
  reason_code?: string             // เช่น VERIFY_TIMEOUT (Fail-safe), REPORT_THRESHOLD, ADMIN_DISMISSED
  reason?: string
  submission_id?: string           // ต้องส่งเมื่อ reason_code = VERIFY_TIMEOUT: การส่งตรวจ (E01) ที่หมดเวลา — Verification ใช้ใส่ใน JobVerified ที่ Admin ตัดสินรายการ Fail-safe ซึ่งอาจยังไม่เคยมีผลตรวจ
  entity_version: number
  changed_at: string
  application_effect?: 'FREEZE' | 'UNFREEZE' | 'CANCEL_PRE_APPROVAL' | 'FLAG_POST_APPROVAL' | 'NONE'
}
```
`application_effect` เป็นคำแนะนำให้ Lifecycle ตามตาราง README 5.1.2 (Lifecycle เป็นผู้ตัดสินใจเปลี่ยนใบสมัครเอง)

### E04 `ReportThresholdReached`  (verification → job, notification)
```ts
{
  job_id: string
  company_id: string
  report_count: number          // นับเฉพาะรายงานที่นับเข้าเกณฑ์
  queue_item_id: string         // รายการคิว Admin ที่สร้างแล้ว
  reached_at: string
}
```
> **หมายเหตุ:** การแจ้ง "อาจารย์ที่ปรึกษาของนักศึกษาที่มีใบสมัครกับประกาศนั้น" ทำโดย Lifecycle เมื่อรับ `JobStatusChanged` (to=`SUSPENDED`) เพราะ Lifecycle รู้ใบสมัคร Notification ที่รับ E04 แจ้งเฉพาะ Admin

### E05 `CompanyStatusChanged`  (identity → job, lifecycle, verification, notification)
```ts
{
  company_id: string
  status: 'PENDING' | 'NEED_MORE_INFO' | 'VERIFIED' | 'REJECTED' | 'SUSPENDED'
  previous_status?: string
  snapshot: {
    name: string
    logo_key?: string
    university_partner: boolean
    verified_badge: boolean
  }
  owner_user_id?: string
  reason?: string
  entity_version: number
  changed_at: string
}
```
ส่งทุกครั้งที่ **สถานะ หรือ Snapshot (ชื่อ/โลโก้/ป้าย Partner)** เปลี่ยน

### E06 `CompanyEntitlementChanged`  (identity → job, verification)
```ts
{ company_id: string, featured_enabled: boolean, fast_track_enabled: boolean,
  entity_version: number, changed_at: string }
```

### E07 `AdvisorLinkChanged`  (identity → lifecycle, notification)
```ts
{
  student_user_id: string
  old_advisor_id?: string
  new_advisor_id?: string
  link_status: 'ADVISOR_LINK_PENDING' | 'LINKED' | 'UNLINKED'
  changed_by: 'STUDENT' | 'ADVISOR' | 'ADMIN'
  entity_version: number
  changed_at: string
}
```
Lifecycle ย้าย `advisor_id` ของใบสมัครที่ยังไม่สิ้นสุดเมื่อ `link_status = LINKED`

### E08 `ApplicationStatusChanged`  (lifecycle → notification)
```ts
{
  application_id: string
  job_id: string
  company_id: string
  student_user_id: string
  advisor_user_id?: string
  hr_user_ids?: string[]          // ผู้รับแจ้งฝั่งบริษัท (ถ้าเจาะจง)
  from_status: ApplicationStatus
  to_status: ApplicationStatus
  actor_user_id?: string          // null = SYSTEM
  actor_role: 'STUDENT' | 'COMPANY_HR' | 'ADVISOR' | 'PLATFORM_ADMIN' | 'SYSTEM'
  reason?: string
  terminated_by?: 'COMPANY' | 'STUDENT' | 'ADVISOR' | 'ADMIN'
  entity_version: number
  changed_at: string
}
```

### E09 `ReviewSubmitted`  (lifecycle → verification)
```ts
{
  review_id: string
  application_id: string
  company_id: string
  content: { title?: string, body: string }     // สแกน Blacklist + ข้อมูลติดต่อส่วนตัว
  rating: 1 | 2 | 3 | 4 | 5
  outcome_label: 'PASS' | 'FAIL' | 'TERMINATED' | 'NO_EVALUATION'
  submitted_at: string
}
```

### E10 `ReviewModerationResult`  (verification → lifecycle, notification)
```ts
{
  review_id: string
  decision: 'PUBLISH' | 'HOLD' | 'ADMIN_PUBLISH' | 'ADMIN_REMOVE'
  reasons: Array<{ code: 'BLACKLIST' | 'PERSONAL_CONTACT' | 'REPORTED' | 'ADMIN', detail?: string }>
  decided_by: 'SYSTEM' | 'ADMIN'
  decided_at: string
}
```
`HOLD` ⇒ รีวิวถูกพักและเข้าคิว Admin ไม่ถูกตีกลับ (README 5.5)

### E11 `ReviewPublished`  (lifecycle → identity, notification)
```ts
{
  review_id: string
  company_id: string
  rating: number
  company_review_count: number     // จำนวนรีวิวที่เผยแพร่รวมของบริษัท หลังรวมรีวิวนี้
  company_rating_sum: number       // ผลรวมคะแนน (Identity คำนวณค่าเฉลี่ยเอง)
  entity_version: number           // เวอร์ชันของ "ชุดสถิติบริษัท" ที่ Lifecycle นับ
  published_at: string
}
```
ส่งสถิติรวมแบบ absolute (ไม่ใช่ delta) เพื่อให้ Idempotent และรองรับลำดับสลับ

### E12 `CertificateIssued`  (lifecycle → notification)
```ts
{ certificate_id: string, application_id: string, student_user_id: string,
  company_id: string, issued_by_user_id: string, issued_at: string }
```

### E13 `CertificateRevoked`  (lifecycle → notification)
```ts
{ certificate_id: string, application_id: string, student_user_id: string,
  revoked_by_user_id: string, revoked_by_role: 'COMPANY_HR' | 'PLATFORM_ADMIN',
  reason: string, revoked_at: string }
```

### E14 `ReminderDue`  (lifecycle → notification)
```ts
{
  reminder_type: string            // ดูรายการด้านล่าง
  entity_type: 'APPLICATION' | 'CERTIFICATE' | 'PROBLEM_REPORT'
  entity_id: string
  due_date: string                 // YYYY-MM-DD (Asia/Bangkok) — ส่วนหนึ่งของ unique key ใน reminder_log
  audience: Array<{ user_id: string, role: string }>
  context: { application_id?: string, days_overdue?: number, deadline_at?: string }
}
```
`reminder_type` ที่ใช้ (ตาม README 5.3): `HR_RESPOND_PENDING_D3`, `HR_RESPOND_PENDING_D7`, `STUDENT_CONFIRM_D3`, `ADVISOR_APPROVE_D3`, `ADVISOR_APPROVE_ESCALATE_ADMIN_D7`, `HR_START_CONFIRM_ON_START`, `HR_START_CONFIRM_D3`, `START_CONFIRM_ESCALATE_D7`, `HR_EVALUATE_D3`, `EVALUATE_ESCALATE_D14`, `HR_ISSUE_CERT_D3`, `ISSUE_CERT_ESCALATE_D14`, `ADVISOR_DISPUTE_D3`, `DISPUTE_ESCALATE_D7`

> `EXPIRED` **ไม่ส่งเป็น `ReminderDue`** — เป็นการเปลี่ยนสถานะโดย Lifecycle แล้วส่ง `ApplicationStatusChanged`

### E15 `UserDeletionRequested`  (identity → lifecycle, job, verification, notification)
```ts
{ user_id: string, role: string, company_id?: string, requested_at: string,
  mode: 'DELETE_AND_ANONYMIZE', anonymous_actor_id: string }
```
`anonymous_actor_id` คือรหัสนิรนามที่ทุก Service ใช้แทน `actor_id` ใน `status_history` / `admin_audit_log` (README 5.11) ผู้รับตอบกลับด้วย Log เท่านั้น (ไม่ต้องมี Event ตอบรับ ในเฟสนี้)

### E16 `UserSuspended`  (identity → gateway, notification)
```ts
{ user_id: string, suspended: boolean, reason?: string, entity_version: number, at: string }
```
Gateway ใช้อัปเดต Denylist ทันที (`suspended=false` = ถอดออก)

### E17 `ProblemReportCreated`  (lifecycle → notification)
```ts
{ problem_report_id: string, application_id: string, student_user_id: string,
  advisor_user_id: string, category: string, created_at: string }
```
**ห้ามแจ้ง HR/บริษัท** (README 5.2.2)

### E18 `CompanyFlagChanged`  (verification → job, notification)
```ts
{ company_id: string, flag: 'UNDER_REVIEW', active: boolean,
  trigger_count?: number, set_by: 'SYSTEM' | 'ADMIN', entity_version: number, at: string }
```
Job เก็บค่าไว้เพื่อใส่ใน `JobSubmitted.company_flag_under_review`

---

## 6. ตารางผู้รับ → การแจ้งเตือน (Notification)

| Event | ผู้ได้รับแจ้ง | เงื่อนไข |
| :--- | :--- | :--- |
| `JobStatusChanged` | HR ของบริษัท | to ∈ {`PUBLISHED`, `PENDING_REVIEW`, `AUTO_REJECTED`, `ADMIN_REJECTED`, `SUSPENDED`, `REMOVED`} |
| `ReportThresholdReached` | Admin | เสมอ |
| `CompanyStatusChanged` | HR Owner | เมื่อสถานะ = `VERIFIED` / `NEED_MORE_INFO` / `REJECTED` / `SUSPENDED` |
| `AdvisorLinkChanged` | อาจารย์ใหม่ (`LINKED` รอยืนยัน), นักศึกษา | ตาม `link_status` |
| `ApplicationStatusChanged` | ตามตาราง Template ใน Notification Service (แยกตาม `to_status`) | ผู้รับ: นักศึกษา, HR, อาจารย์ ตามสถานะ |
| `ReviewModerationResult` | นักศึกษา (เมื่อ `HOLD`/`ADMIN_REMOVE`), Admin (เมื่อ `HOLD`) | — |
| `ReviewPublished` | HR ของบริษัท | มีรีวิวใหม่ |
| `CertificateIssued` / `CertificateRevoked` | นักศึกษา | — |
| `ReminderDue` | `audience` ใน Payload | — |
| `ProblemReportCreated` | อาจารย์ + Admin | เสมอ |
| `CompanyFlagChanged` | Admin | `active=true` |
| `UserDeletionRequested` | — | ลบกล่องข้อความ/บันทึกส่ง |
| `UserSuspended` | — | บันทึกเท่านั้น |

---

## 7. Checklist เมื่อเพิ่ม Event ใหม่
1. เพิ่มแถวใน §4 และ Payload ใน §5
2. เพิ่ม Type ที่ `libs/contracts/events`
3. ผู้ส่งเขียนผ่าน Outbox เท่านั้น • ผู้รับทำ Idempotency + `entity_version` (ถ้าเป็นสถานะ)
4. อัปเดตคอลัมน์ Consume/Publish ใน [architecture.md](architecture.md) §2
5. เพิ่มเทสต์: ส่งซ้ำ, ส่งสลับลำดับ, Consumer ล้มเหลวจน DLQ
