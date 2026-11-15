# Verification & Trust สไลซ์ 3 (ตรวจรีวิวและรายงานรีวิว) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (Native) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **ไม่มีขั้น commit** — ผู้ใช้ (PM) commit เอง ปิดแต่ละ Task ด้วยการรันเทสต์ที่ระบุ

**Goal:** Verification รับ E09 สแกนรีวิวแล้วส่ง E10 (`PUBLISH`/`HOLD`), รับรายงานรีวิว, ให้ Admin ตัดสิน `REVIEW_HELD`/`REVIEW_REPORT` (`ADMIN_PUBLISH`/`ADMIN_REMOVE`) และ anonymize ข้อมูลใหม่ตาม E15

**Architecture:** โมดูลใหม่ `src/review/` (สแกนล้วน + service รับ E09 + รายงาน + action ของ Admin) ใช้ `QueueService`, `AuditService`, `OutboxWriter`, `RulesRepository` เดิม; ตารางใหม่ `review_moderations`/`review_reports`; consumer ใหม่ผูกใน `ConsumersModule`; ขยาย `QueueQueryService` (รายละเอียดคิว) และ `UserAnonymizationService` (E15)

**Tech Stack:** NestJS 10, Prisma (Postgres), class-validator, mocha/chai/supertest (เทสต์ใช้ Postgres จริงผ่าน `createTestDatabase`; e2e ใช้ RabbitMQ จริง)

**Spec:** [2026-11-15-verification-slice3-design.md](../specs/2026-11-15-verification-slice3-design.md) (อ้างด้วย "§" ของสเปกนี้)

## Global Constraints

- migration ใหม่เท่านั้น (ห้ามแก้ migration เดิม); `ALTER TYPE … ADD VALUE` ห้ามใช้ค่าใหม่ใน migration เดียวกัน
- E10 ห้ามพกเนื้อรีวิว/ข้อความที่จับได้: `reasons` ใส่ได้เฉพาะ `code` (และ `detail` ของเหตุผล Admin เท่านั้น); log ได้เฉพาะ `event_id`, `review_id`, `company_id`, `queue_item_id`, ผลตัดสิน, รหัสเหตุผล — ห้าม log `title`/`body`/`reason`/`reporter_user_id`
- `priority = NORMAL`, `due_at` = SLA ปกติ (48 ชม. เหมือน `JOB_REPORT`); `target_type = 'review'`, `target_id = review_id`
- `reason` ของรายงาน 10–1000 ตัวอักษร (trim ก่อนนับ); `reason` ของ `remove-review` บังคับ 1–500 ตัวอักษร; `publish-review` ไม่บังคับ
- ข้อความรีวิวที่เก็บต้องผ่าน `normalizeText` และตัดอักขระ NUL (`\u0000`) ออกก่อนเขียน DB
- ชื่อ error: `REVIEW_NOT_REPORTABLE` (422, ใหม่), `ALREADY_REPORTED` (409), `UNSUPPORTED_ITEM_TYPE` (422), `STATE_CONFLICT` (409), `FORBIDDEN_ROLE` (403), `VALIDATION_FAILED` (400), `NOT_FOUND` (404)
- รันเทสต์ทั้งแอป: `cd apps/verification && pnpm test` (ต้องเปิด Postgres: `pnpm infra:up`; ผ่านเดิม 222 ตัว) · รันเฉพาะไฟล์: `pnpm exec mocha --config .mocharc.json --grep '<ชื่อ describe>'` (`.mocharc.json` ใส่ spec ทั้งหมดอยู่แล้ว จึงต้องใช้ `--grep`)

## Review Focus

1. **E09 ซ้ำด้วย `review_id` เดิมแต่ event_id ต่างกัน/ขนานกัน** → มี `review_moderations` และ E10 อย่างละหนึ่งชุด (Task 3)
2. **เนื้อรีวิวมี `\u0000` หรืออักขระความกว้างศูนย์สอดไส้เบอร์โทร** → handler ไม่ล้ม (ไม่เป็น poison message) และยังจับเบอร์ได้หลังตัดอักขระ (Task 3)
3. **ข้อมูลติดต่อ/คำต้องห้ามอยู่ใน `title` อย่างเดียว** → `HOLD` เหมือนอยู่ใน `body` (Task 2)
4. **Admin สองคนตัดสินรายการเดียวกันพร้อมกัน / รีวิวถูกลบระหว่างมีคนรายงาน** → ได้ E10 ชุดเดียว และไม่มี `201` กับรีวิวที่ถูกลบ (Task 4–5)
5. **`reason` เป็นช่องว่างล้วน หรือยาวเกิน** → `400` ไม่สร้างแถวและไม่สร้างรายการคิว (Task 4–5)

---

### Task 1: Schema และ migration

**Files:**
- Modify: `apps/verification/prisma/schema.prisma`
- Create: `apps/verification/prisma/migrations/20261115140000_slice3_review_moderation/migration.sql`
- Test: `apps/verification/test/db/schema.spec.ts`

**Interfaces:**
- Produces (Prisma): `ReviewModeration` → `tx.reviewModeration` (`id`, `reviewId` unique, `companyId`, `studentUserId`, `rating Int`, `outcomeLabel`, `title String?`, `body`, `decision String`, `reasons Json`, `status ReviewModerationStatus`, `queueItemId String?`, `createdAt`, `updatedAt`); `ReviewReport` → `tx.reviewReport` (`id`, `reviewId`, `reporterUserId`, `reason`, `createdAt`; `@@unique([reviewId, reporterUserId])`); enum `ReviewModerationStatus { PASSED HELD ADMIN_PUBLISHED ADMIN_REMOVED }`; `QueueOrigin` เพิ่ม `REVIEW_SCAN`, `REVIEW_REPORT`

- [ ] **Step 1: เขียนเทสต์ที่ล้ม** ใน `schema.spec.ts`: เพิ่ม `review_moderations`, `review_reports` ใน `EXPECTED_TABLES` (เรียงตามตัวอักษร) และแก้ชื่อเทสต์เป็น "19 ตาราง"; เพิ่ม `it('สไลซ์ 3: review_moderations.review_id UNIQUE, review_reports (review_id, reporter_user_id) UNIQUE, queue_items รับ origin REVIEW_SCAN/REVIEW_REPORT และ type REVIEW_HELD/REVIEW_REPORT')` โดย insert ซ้ำแล้วคาดว่าเกิดข้อผิดพลาดชนิด unique (`/duplicate key/`) และ insert queue_items ด้วยค่าใหม่สำเร็จ
- [ ] **Step 2: รันให้ล้ม:** `pnpm exec mocha --config .mocharc.json --grep 'verification_db schema'` → ล้มเพราะตารางยังไม่มี
- [ ] **Step 3: เพิ่มโมเดลใน `schema.prisma`** ตามชื่อใน Interfaces (`@@map("review_moderations")`, `@@map("review_reports")`, คอลัมน์ snake_case ด้วย `@map` และ `@db.Uuid`/`@db.Timestamptz(6)` แบบโมเดลเดิม; `updatedAt` ใช้ `@updatedAt`; `body`/`title`/`reason` เป็น `String`; enum map เป็น `review_moderation_status`) และเพิ่มสองค่าท้าย `enum QueueOrigin`
- [ ] **Step 4: เขียน `migration.sql`** (`CREATE TYPE review_moderation_status`, `ALTER TYPE queue_origin ADD VALUE 'REVIEW_SCAN'` / `'REVIEW_REPORT'`, `CREATE TABLE` ทั้งสอง + unique index) ให้ตรง schema; ตรวจด้วย `pnpm exec prisma validate && pnpm exec prisma generate`
- [ ] **Step 5: รันเทสต์ schema ให้ผ่าน** (คำสั่งเดียวกับ Step 2) และยืนยันว่า `pnpm exec prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url <URL ฐานว่างชั่วคราว> --exit-code` คืน 0 (ไม่มีส่วนต่าง)

### Task 2: ตัวสแกนรีวิว (ฟังก์ชันล้วน)

**Files:**
- Create: `apps/verification/src/review/review-scan.ts`
- Test: `apps/verification/test/review/review-scan.spec.ts`

**Interfaces:**
- Consumes: `normalizeText`, `findTermMatches`, `detectContact`, ชนิด `Rules`/`MatchedKeyword` จาก `src/screening`
- Produces:
  - `export const REVIEW_FIELD = 'review'`
  - `export function reviewText(title: string | null | undefined, body: string): string` — `title` ว่าง ⇒ `body`; มี ⇒ `` `${title}\n${body}` ``
  - `export interface ReviewScan { hold: boolean; reasons: Array<{ code: 'BLACKLIST' | 'PERSONAL_CONTACT' }>; matched: MatchedKeyword[] }`
  - `export function scanReview(text: string, rules: Rules): ReviewScan` — `text` ต้อง normalize แล้ว

- [ ] **Step 1: เขียนเทสต์ที่ล้ม** ใช้ `DEFAULT_RULES` จาก `src/screening/defaults` (หรือ rules ที่สร้างเอง) กรณี: ข้อความสะอาด ⇒ `hold=false, reasons=[]`; คำ HARD ที่ไม่ปฏิเสธ ⇒ `hold=true` + `[{code:'BLACKLIST'}]`; เบอร์โทร `081-234-5678`, อีเมล, `line id: abc123` ⇒ `PERSONAL_CONTACT`; ทั้งสองอย่าง ⇒ สองเหตุผล (เรียง `BLACKLIST` ก่อน); ประโยคปฏิเสธที่มีคำ HARD (เช่น "ไม่เรียกเก็บเงินมัดจำ" ถ้า "มัดจำ" เป็นคำ HARD ในกฎทดสอบ) ⇒ `hold=false`; คำ SOFT อย่างเดียว ⇒ `hold=false`; `reviewText('ติดต่อ 081-234-5678', 'ดีมาก')` ⇒ ผลสแกนเป็น `hold=true` (Review Focus ข้อ 3); `reviewText(null, 'x') === 'x'`; ไม่มี `matched` ที่ `field` อื่นนอกจาก `REVIEW_FIELD`
- [ ] **Step 2: รันให้ล้ม:** `pnpm exec mocha --config .mocharc.json --grep 'scanReview'`
- [ ] **Step 3: Implement** ตามสัญญาข้างต้น: สแกนเฉพาะคำ `HARD` ด้วย `findTermMatches(text, REVIEW_FIELD, hard, rules.negationCues, maxGap)` โดย `maxGap` = `params.max_gap` ของกฎ `NEGATION_WINDOW` (ค่าตั้งต้น 12 เหมือน `evaluateJob`); `BLACKLIST` เมื่อมี match ที่ `negated === false`; `PERSONAL_CONTACT` เมื่อ `detectContact(text).length > 0`; `matched` คืนทุก match (รวมที่ปฏิเสธ เพื่อใช้ทำ highlights)
- [ ] **Step 4: รันให้ผ่าน** (คำสั่ง Step 2)

### Task 3: รับ E09 → สแกน → E10 `PUBLISH`/`HOLD`

**Files:**
- Create: `apps/verification/src/events/review-moderation-result.ts`, `apps/verification/src/review/review-moderation.service.ts`, `apps/verification/src/review/review.module.ts`, `apps/verification/src/consumers/review-submitted.consumer.ts`
- Modify: `apps/verification/src/queue/queue.service.ts`, `apps/verification/src/consumers/consumers.module.ts`, `apps/verification/src/verification.module.ts`, `apps/verification/test/support/events.ts`
- Test: `apps/verification/test/review/review-moderation.spec.ts`

**Interfaces:**
- Consumes: Task 1 (`tx.reviewModeration`), Task 2 (`scanReview`, `reviewText`), `RulesRepository.load(db)`, `OutboxWriter.add(tx, {type, aggregateId, correlationId, payload})`
- Produces:
  - `emitReviewModerationResult(outbox: OutboxWriter, tx: Tx, a: { payload: ReviewModerationResultPayload; correlationId: string }): Promise<string>` — `type: 'ReviewModerationResult'`, `aggregateId: payload.review_id`
  - `QueueService.createReviewItem(tx: Tx, a: { type: 'REVIEW_HELD' | 'REVIEW_REPORT'; reviewId: string; companyId: string; origin: 'REVIEW_SCAN' | 'REVIEW_REPORT'; correlationId?: string; now?: Date }): Promise<QueueItem | null>` — ใช้ `createMany({ skipDuplicates: true })` กันรายการเปิดซ้ำ (partial unique index) คืน `null` เมื่อมีรายการเปิดอยู่แล้ว (และไม่เขียน `status_history`); มิฉะนั้นเขียน `status_history` OPEN แบบ `createGenericItem` (`targetType 'review'`, `submissionId null`) — ขยายชนิด union ของ `createGenericItem` ให้รับค่าใหม่
  - `ReviewModerationService.handleReviewSubmitted(env: EventEnvelope<'ReviewSubmitted', ReviewSubmittedPayload>, tx: Tx): Promise<void>`
  - `ReviewModule` (provide/export `ReviewModerationService`; imports `QueueModule`, `RulesModule`, `AuditModule`)
  - test helper `reviewSubmitted(over?: Partial<ReviewSubmittedPayload>): ReviewSubmittedPayload` ใน `test/support/events.ts`

- [ ] **Step 1: เขียนเทสต์ที่ล้ม** (`describe('ReviewModerationService (Postgres จริง)')`, สร้างแอปด้วย `createTestApp({ imports: [ReviewModule], db })`, เรียก `svc.handleReviewSubmitted` ใน `prisma.$transaction`): (a) รีวิวสะอาด ⇒ แถว `review_moderations` `status='PASSED'`, `decision='PUBLISH'`, ไม่มีรายการคิว, outbox มี `ReviewModerationResult` 1 รายการ `decision='PUBLISH'`, `decided_by='SYSTEM'`, `reasons=[]`, `student_user_id` ตรงกับ E09; (b) มีเบอร์โทร ⇒ `HELD`, รายการ `REVIEW_HELD` (`origin REVIEW_SCAN`, `priority NORMAL`, `target_type 'review'`, `target_id=review_id`, `due_at` = ตอนนี้ + 48 ชม. ±1 นาที), `queue_item_id` ผูกกัน, E10 `HOLD` พร้อม `reasons=[{code:'PERSONAL_CONTACT'}]` และ **payload ทั้งก้อนเมื่อแปลงเป็น JSON ไม่มีเบอร์โทร/เนื้อรีวิว**; (c) เรียกซ้ำด้วย E09 ที่ `review_id` เดิมแต่ `event_id` ใหม่ ⇒ ยังมีแถว/รายการ/E10 อย่างละหนึ่ง; เรียกพร้อมกัน 10 ครั้ง (`Promise.all`) ก็เช่นกัน (Review Focus ข้อ 1); (d) `body` มี `\u0000` ⇒ ไม่ throw และข้อความที่เก็บไม่มี NUL; `body` ที่สอดอักขระความกว้างศูนย์ในเบอร์ (`081-234​-5678`) ⇒ ยัง `HOLD` (ข้อ 2); (e) หัวข้ออย่างเดียวมีเบอร์ ⇒ `HOLD`; (f) ข้อความที่เก็บเป็นรูป normalize แล้ว (`title`/`body` ไม่มีอักขระความกว้างศูนย์)
- [ ] **Step 2: รันให้ล้ม:** `pnpm exec mocha --config .mocharc.json --grep 'ReviewModerationService'`
- [ ] **Step 3: Implement `QueueService.createReviewItem`** และ `emitReviewModerationResult` ตาม Interfaces
- [ ] **Step 4: Implement `ReviewModerationService.handleReviewSubmitted`**: โหลดกฎด้วย `RulesRepository.load(tx)`; ทำ `title`/`body` เป็น `normalizeText(...).replaceAll('\u0000','')` (title ว่างหลัง trim ⇒ `null`); สแกน `reviewText`; `createMany({ skipDuplicates: true })` ของ `review_moderations` — `count === 0` ⇒ `Logger.warn` (เฉพาะ `review_id`) แล้วจบโดยไม่ส่ง E10; ถ้า `hold` สร้างรายการด้วย `createReviewItem({ type:'REVIEW_HELD', origin:'REVIEW_SCAN' })` แล้ว `update` `queue_item_id`; ส่ง E10 (`PUBLISH`+`reasons: []` หรือ `HOLD`+`reasons` จากสแกน, `decided_by: 'SYSTEM'`, `decided_at` = ตอนนี้, `student_user_id` จาก E09, `correlationId` = `env.correlation_id`); ค่า `status/decision` ตาม §5.2–5.3
- [ ] **Step 5: ต่อสาย:** `ReviewSubmittedConsumer` (`producer: 'lifecycle'`, `type: 'ReviewSubmitted'`) แบบเดียวกับ `CompanyStatusChangedConsumer`; เพิ่มใน `ConsumersModule` (imports `ReviewModule`) และเพิ่ม `ReviewModule` ใน `VerificationModule`
- [ ] **Step 6: รันให้ผ่าน** (คำสั่ง Step 2) แล้วรัน `pnpm exec mocha --config .mocharc.json --grep 'wiring|Queue'` ยืนยันว่าเทสต์เดิมของคิว/การต่อสายไม่พัง

### Task 4: `POST /reviews/{review_id}/reports`

**Files:**
- Create: `apps/verification/src/review/review-report.service.ts`, `apps/verification/src/review/review-report.controller.ts`, `apps/verification/src/review/dto.ts`
- Modify: `apps/verification/src/review/review.module.ts`
- Test: `apps/verification/test/review/review-report-api.spec.ts`

**Interfaces:**
- Consumes: `tx.reviewModeration`, `tx.reviewReport`, `QueueService.createReviewItem`, `JwtClaims` (`sub`, `role`, `company_id?`)
- Produces: `ReviewReportDto { reason: string }` (trim; `@MinLength(10) @MaxLength(1000)`); `ReviewReportService.report(reviewId: string, dto: ReviewReportDto, user: JwtClaims, correlationId?: string): Promise<{ id: string; status: 'OPEN' }>`; `ReviewReportController` (`@Controller('reviews')`, `POST :review_id/reports`, `@Roles('STUDENT', 'COMPANY_HR')`, `201`)

- [ ] **Step 1: เขียนเทสต์ที่ล้ม** (supertest + token ผ่าน `t.token`; seed `review_moderations` ด้วย `prisma.reviewModeration.create`): นักศึกษารายงานรีวิว `PASSED` ⇒ `201 {id, status:'OPEN'}` + `review_reports` 1 แถว + รายการ `REVIEW_REPORT` 1 รายการ (`origin REVIEW_REPORT`); คนที่สองรายงาน ⇒ `201` แต่ยังมีรายการเปิดรายการเดียว; รีวิว `ADMIN_PUBLISHED` ⇒ `201`; ไม่รู้จักรีวิว ⇒ `404`; `HELD`/`ADMIN_REMOVED` ⇒ `422 REVIEW_NOT_REPORTABLE` และไม่มีแถวใหม่; ซ้ำโดยผู้ใช้เดียวกัน ⇒ `409 ALREADY_REPORTED`; HR บริษัทเดียวกัน ⇒ `201`, HR คนละบริษัทหรือ token ไม่มี `company_id` ⇒ `403`; ADVISOR/ADMIN ⇒ `403`, ไม่มี token ⇒ `401`; `reason` 9 ตัว / 1001 ตัว / ช่องว่างล้วน / ไม่ใช่ string ⇒ `400` และไม่มีแถว/รายการ (ข้อ 5); 10 ผู้ใช้รายงานพร้อมกัน ⇒ 10 แถว รายการเปิด 1 รายการ; **หลัง Admin ลบรีวิว (อัปเดต `status` เป็น `ADMIN_REMOVED` ก่อนเรียก) รายงานได้ `422`** และ log ไม่มีข้อความ `reason` (ใช้ `Logger` spy แบบ `report-api.spec.ts`)
- [ ] **Step 2: รันให้ล้ม:** `pnpm exec mocha --config .mocharc.json --grep 'POST /reviews'`
- [ ] **Step 3: Implement service** ตามลำดับตรวจใน §5.4 (404 → 403 HR → 422 → 409 → insert); ใน Transaction เดียว: อ่านสถานะด้วย `SELECT … FOR SHARE` ของแถว `review_moderations` (ผ่าน `$queryRaw`) เพื่อไม่ให้แข่งกับ Admin ที่ลบรีวิว; insert `review_reports` (`P2002` ⇒ `409 ALREADY_REPORTED` แบบ `ReportService`); `createReviewItem({ type:'REVIEW_REPORT', origin:'REVIEW_REPORT', companyId: <ของรีวิว> })` (ผล `null` ถือว่ามีรายการอยู่แล้ว); ห้าม log `reason`
- [ ] **Step 4: Controller/DTO/โมดูล** ตาม Interfaces (`JwtAuthGuard`, `RolesGuard`, `ParseUUIDPipe`) แล้ว **รันให้ผ่าน** (คำสั่ง Step 2)

### Task 5: Admin `publish-review` / `remove-review`

**Files:**
- Create: `apps/verification/src/review/review-actions.service.ts`, `apps/verification/src/review/review-actions.controller.ts`
- Modify: `apps/verification/src/review/dto.ts` (เพิ่ม `PublishReviewDto`, `RemoveReviewDto`), `apps/verification/src/review/review.module.ts`
- Test: `apps/verification/test/review/review-actions.spec.ts`

**Interfaces:**
- Consumes: `emitReviewModerationResult`, `AuditService.record(tx, {adminId, action, targetType, targetId, before, after, reason, correlationId})`, `tx.queueItem`, `tx.reviewModeration`
- Produces: `PublishReviewDto { reason?: string }` (ไม่บังคับ, สูงสุด 500 หลัง trim) และ `RemoveReviewDto { reason: string }` (บังคับ 1–500 หลัง trim); `ReviewActionsService.publish(id: string, admin: { sub: string }, reason: string | undefined, correlationId?: string): Promise<void>` และ `.remove(id: string, admin: { sub: string }, reason: string, correlationId?: string): Promise<void>`; `ReviewActionsController` (`@Controller('admin/queue')`, `POST :id/actions/publish-review` และ `…/remove-review`, `@Roles('PLATFORM_ADMIN')`, `204`)

- [ ] **Step 1: เขียนเทสต์ที่ล้ม** ตามตาราง §5.5: (a) `REVIEW_HELD` + publish ⇒ รายการ `RESOLVED` (`resolution 'ADMIN_PUBLISH'`), `status='ADMIN_PUBLISHED'`, E10 `ADMIN_PUBLISH` (`decided_by 'ADMIN'`, `reasons=[{code:'ADMIN'}]` หรือพร้อม `detail` เมื่อมี reason), `status_history` + `admin_audit_log` (`REVIEW_PUBLISH`, `target_type 'review'`, `target_id` = review_id); (b) `REVIEW_HELD` + remove ⇒ `ADMIN_REMOVED`, E10 `ADMIN_REMOVE` พร้อม `detail` = reason; (c) `REVIEW_REPORT` + publish ⇒ `ADMIN_PUBLISHED`, E10 `ADMIN_PUBLISH` `reasons` มี `REPORTED` และ `ADMIN`; (d) `REVIEW_REPORT` + remove ⇒ `ADMIN_REMOVED`, E10 `ADMIN_REMOVE`, `reasons` มี `REPORTED`; หลังนั้น `POST /reviews/{id}/reports` ⇒ `422`; (e) หลัง (c): ผู้ใช้ใหม่รายงาน ⇒ `201` + รายการใหม่ ผู้เดิม ⇒ `409`; (f) `remove-review` ไม่มี/ว่าง/501 ตัว ⇒ `400` และรายการไม่เปลี่ยน; (g) ชนิดรายการอื่น (`JOB_REVIEW`) ⇒ `422 UNSUPPORTED_ITEM_TYPE`; รายการ `RESOLVED` แล้ว ⇒ `409`; ไม่รู้จัก id ⇒ `404`; (h) ตัดสินพร้อมกัน 2 คน (`Promise.all` publish กับ remove) ⇒ หนึ่งคน `204` อีกคน `409` และ E10 มีชุดเดียว; (i) role STUDENT/HR ⇒ `403`, ไม่มี token ⇒ `401`
- [ ] **Step 2: รันให้ล้ม:** `pnpm exec mocha --config .mocharc.json --grep 'ReviewActions'`
- [ ] **Step 3: Implement** ตามแบบ `QueueActionsService.resolve`: ใน Transaction เดียว — โหลดรายการ (404/422) → `queueItem.updateMany where status <> 'RESOLVED'` (0 แถว ⇒ 409) → `reviewModeration.updateMany where reviewId AND status IN (<HELD สำหรับ REVIEW_HELD | PASSED, ADMIN_PUBLISHED สำหรับ REVIEW_REPORT>)` (0 แถว ⇒ `409 STATE_CONFLICT`, rollback ทั้งก้อน) → อัปเดต `status`/`decision`/`reasons` → E10 → `status_history` (reason = เหตุผลของ Admin) → `audit.record` (`REVIEW_PUBLISH`/`REVIEW_REMOVE`)
- [ ] **Step 4: Controller/DTO/โมดูล** แล้ว **รันให้ผ่าน** (คำสั่ง Step 2)

### Task 6: หน้ารายละเอียดคิวของรีวิว

**Files:**
- Modify: `apps/verification/src/queue/queue-query.service.ts`, `apps/verification/src/queue/queue.module.ts`
- Test: `apps/verification/test/queue/queue-api-reviews.spec.ts`

**Interfaces:**
- Consumes: `RulesRepository.load`, `scanReview`, `reviewText`, `buildHighlights`
- Produces: `QueueDetail` เพิ่ม `review: { review_id: string; rating: number; outcome_label: string; title: string | null; body: string; moderation_status: string; highlights: Highlight[] } | null` และ `review_reports: Array<{ id: string; reporter_user_id: string; reason: string; created_at: Date }>` (ว่างเมื่อไม่ใช่ `REVIEW_REPORT`); `QueueModule` imports `RulesModule`

- [ ] **Step 1: เขียนเทสต์ที่ล้ม:** `GET /admin/queue/{id}` ของ `REVIEW_HELD` คืน `review` ครบ + `highlights` ชี้ตำแหน่งของคำ/เบอร์ที่จับได้ในข้อความ `reviewText` (`start`/`end` ตรงกับ substring) + `review_reports: []` + `content: null`, `risk_score: null`, `reports: []`; `REVIEW_REPORT` คืน `review_reports` ครบทุกคน (มี `reporter_user_id`, `reason`); `JOB_REVIEW` เดิมไม่เปลี่ยนรูป (`review: null`); `GET /admin/queue?type=REVIEW_HELD` กรองได้และมี `company_name` เมื่อมี snapshot; STUDENT/HR ⇒ `403`; `review_reports`/`review` ไม่โผล่ใน response ของ endpoint อื่น (เช่น `GET /verification/jobs/{id}/result`)
- [ ] **Step 2: รันให้ล้ม:** `pnpm exec mocha --config .mocharc.json --grep 'queue.*review|REVIEW_HELD'`
- [ ] **Step 3: Implement** ใน `detail()`: เมื่อ `item.type` เป็น `REVIEW_HELD|REVIEW_REPORT` โหลด `reviewModeration` (ตาม `reviewId = item.targetId`) และ `reviewReport` (เฉพาะ `REVIEW_REPORT`, เรียง `createdAt` เก่า→ใหม่) และคำนวณ `highlights` ด้วยกฎปัจจุบัน; ชนิดอื่นคืน `review: null`, `review_reports: []`
- [ ] **Step 4: รันให้ผ่าน** (คำสั่ง Step 2) แล้ว `pnpm exec mocha --config .mocharc.json --grep 'queue'` ให้เทสต์คิวเดิมยังผ่าน

### Task 7: ขยาย anonymization (E15)

**Files:**
- Modify: `apps/verification/src/anonymization/user-anonymization.service.ts`
- Test: `apps/verification/test/anonymization/user-anonymization.spec.ts`

**Interfaces:**
- Consumes: `tx.reviewModeration`, `tx.reviewReport`

- [ ] **Step 1: เขียนเทสต์ที่ล้ม** (เพิ่มใน describe เดิม): ผู้ใช้ที่เป็นเจ้าของรีวิว 3 ฉบับ (`HELD`, `PASSED`, `ADMIN_PUBLISHED`) + เป็นผู้รายงานรีวิวคนอื่น 1 ฉบับ ⇒ หลัง `apply`: `student_user_id` ของทั้ง 3 = รหัสนิรนาม; `HELD` มี `title = null` และ `body = ''`; `PASSED`/`ADMIN_PUBLISHED` คง `title`/`body` เดิม; `review_reports.reporter_user_id` = รหัสนิรนาม และ `reason = ''`; รายการคิว `REVIEW_HELD` ที่เปิดอยู่ยังอยู่และไม่เปลี่ยนสถานะ; ข้อมูลของผู้ใช้อื่นไม่เปลี่ยน; ประมวลผลซ้ำได้ผลเท่าเดิม; ผู้ใช้สองคนรายงานรีวิวเดียวกันแล้วถูกลบทั้งคู่ ⇒ ไม่ชน UNIQUE
- [ ] **Step 2: รันให้ล้ม:** `pnpm exec mocha --config .mocharc.json --grep 'UserAnonymizationService'`
- [ ] **Step 3: Implement** เพิ่มการแก้ใน `handleUserDeletionRequested` ภายใน Transaction เดิม ตาม §5.7 (ล้าง `HELD` ก่อนเปลี่ยน `student_user_id` เพราะต้องหาแถวด้วย `studentUserId = userId`); อัปเดตคอมเมนต์ของคลาสให้ตรง
- [ ] **Step 4: รันให้ผ่าน** (คำสั่ง Step 2)

### Task 8: End-to-end และเอกสาร

**Files:**
- Create: `apps/verification/test/e2e/review-moderation.e2e.spec.ts`
- Modify: `docs/data-schema.md`, `docs/api-contract.md`, `docs/event-contract.md`, `docs/diagram.md`, `docs/developer-guide.md`

- [ ] **Step 1: เขียน e2e** ตามแบบ `test/e2e/report-flag.e2e.spec.ts` (RabbitMQ จริง, ข้ามเมื่อไม่มี Docker): ส่ง E09 สะอาดเข้าคิวของ lifecycle ⇒ ได้ E10 `PUBLISH`; ส่ง E09 ที่มีเบอร์โทร ⇒ ได้ `HOLD` และมีรายการ `REVIEW_HELD` ⇒ Admin `publish-review` ⇒ ได้ E10 `ADMIN_PUBLISH`; ส่ง E15 ของผู้เขียน ⇒ ข้อมูลถูกล้างตาม Task 7
- [ ] **Step 2: รัน e2e:** `pnpm exec mocha --config .mocharc.json --grep 'review-moderation e2e'` ต้องผ่าน (เปิด Postgres+RabbitMQ ด้วย `pnpm infra:up`)
- [ ] **Step 3: อัปเดตเอกสารตาม §6** ข้อ 1–5 ของสเปก (data-schema: ฟิลด์เพิ่มของ `review_moderations`, `review_reports`, ค่า `origin` ใหม่, กติกา anonymize; api-contract §6.1/§6.4 + รหัส `REVIEW_NOT_REPORTABLE` ในตาราง §2 + รูปแบบ `GET /admin/queue/{id}` ของรีวิว; event-contract E10 กติกาแบบ A; diagram.md ลำดับรีวิวกรณีรายงาน→ลบ/ยืนยัน; developer-guide ติ๊กสไลซ์ 3 + กติกาถึง Tester) และบันทึกในสเปกว่า **สถานะ: อนุมัติ**
- [ ] **Step 4: ตรวจทั้งแอป:** `cd apps/verification && pnpm test && pnpm lint && pnpm build` ผ่านทั้งหมด (เทสต์ไม่น้อยกว่า 222 + ของสไลซ์นี้); `cd ../../libs/common && pnpm exec mocha test/repo/*.spec.ts` ผ่าน (เทสต์ guard เอกสาร)
- [ ] **Step 5: สรุปให้ผู้ใช้:** รายการไฟล์ที่เปลี่ยน, ข้อสมมติใน §8 ของสเปกที่ยังรอตรวจ, และงานที่ต้องแจ้ง Tester (§6 ข้อ 6)
