# Verification สไลซ์ 2 (รายงานประกาศ, ระงับอัตโนมัติ, ธงบริษัท) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** เพิ่มการรายงานประกาศโดยนักศึกษา, ตัวนับและระงับอัตโนมัติ (E04), คำตัดสินรายงานของ Admin (`RESTORE`/`REMOVE`), และธง `UNDER_REVIEW` ของบริษัท (E18) ใน `apps/verification`

**Architecture:** ต่อยอดโครงสไลซ์ 1 (`QueueService`, `AuditService`, `emitJobVerified`, `Tx`) สำเนาสถานะประกาศจาก E03 ลง `job_snapshots`; ตัวนับรายงานใช้ upsert + conditional update แบบ atomic; เหตุการณ์ปฏิเสธนับจาก E03 เท่านั้น ทุกการเปลี่ยนแปลงอยู่ใน Transaction เดียวกับ outbox

**Tech Stack:** NestJS 12, Prisma 6 (Postgres), `libs/common` (OutboxWriter/EventConsumer), `libs/contracts`, Mocha + chai + supertest

**Spec:** [2026-11-14-verification-slice2-design.md](../specs/2026-11-14-verification-slice2-design.md) (อ่านคู่กัน; อ้างเป็น "spec §x")

## Global Constraints

- ค่ากำหนดใน config/env: `REPORT_THRESHOLD=3`, `REPORT_DAILY_LIMIT=5`, `REPORTER_DISMISS_STREAK=3`, `REJECTION_THRESHOLD=3`, `REJECTION_WINDOW_DAYS=30`
- ส่ง/รับ Event ผ่าน `OutboxWriter`/`EventConsumer` ของ `libs/common` เท่านั้น; ชนิด Event/DTO import จาก `@internpath/contracts` (มี `ReportThresholdReachedPayload`, `CompanyFlagChangedPayload`, `JobVerifiedPayload`, `ReportJobRequest`, `JobReportCategory` แล้ว) — ห้ามประกาศซ้ำ
- Verification **ไม่แก้สถานะประกาศ** และไม่เรียกข้าม Service; รู้สถานะ/`company_id` ของประกาศจาก E03 (`job_snapshots`) เท่านั้น
- `JOB_REPORT`/`COMPANY_ACCOUNT`: `priority = NORMAL`, `due_at = created_at + 48 ชม.` (OD-10); ประกาศหนึ่งมี `JOB_REPORT` เปิดได้รายการเดียว, บริษัทหนึ่งมี `COMPANY_ACCOUNT` เปิดได้รายการเดียว (partial unique index เดิม)
- ทุก action ของ Admin เขียน `admin_audit_log` (`AuditService.record`) + `status_history` ใน Transaction เดียวกับการเปลี่ยนข้อมูล
- Log ได้เฉพาะ id/ผลตัดสิน/จำนวน — **ห้าม** log `detail` ของรายงาน หรือ `reporter_user_id` คู่กับ `detail`
- `reporter_user_id` และ `detail` ออกได้เฉพาะ `GET /admin/queue/{id}` ของ `JOB_REPORT` (role `PLATFORM_ADMIN`)
- ฟิลด์ snake_case, เวลา ISO-8601 UTC, ข้อความ error ภาษาไทย, รหัส error ตาม api-contract §2
- แผนนี้ **ไม่มี step commit** — ผู้ใช้ commit เอง; ทุก task จบด้วยเทสต์เขียวและ `pnpm --filter @internpath/verification exec tsc --noEmit` ผ่าน
- คำสั่งเทสต์ไฟล์เดียว: `pnpm --filter @internpath/verification exec mocha <path>` (ต้องมี Postgres จาก `pnpm infra:up`; เทสต์จะข้ามเองถ้าต่อไม่ได้); ทั้งชุด: `pnpm --filter @internpath/verification test` (ปัจจุบัน 143 ผ่าน)

## Review Focus

1. **รายงานที่ 3 เข้าพร้อมกัน** (หลาย Transaction ขนาน) → ต้องได้ E04 และรายการ `JOB_REPORT` อย่างละหนึ่ง (Task 4)
2. **E03 ซ้ำ/สลับลำดับ/มาก่อนที่รู้จักประกาศ** → ไม่นับปฏิเสธซ้ำ, snapshot ไม่ถอยหลัง, ไม่ล้ม (Task 3)
3. **รายงานรอบเที่ยงคืน `Asia/Bangkok`** → 5 ครั้ง/วันรีเซ็ตตามปฏิทินไทย ไม่ใช่ UTC (Task 4)
4. **เคลียร์ธงแล้วเหตุการณ์ปฏิเสธเก่า** → ไม่ติดธงกลับทันที; ธงเปิดอยู่แล้วไม่ส่ง E18 ซ้ำ (Task 2)
5. **ผู้รายงานที่ถูกยกคำร้องติด 3 ครั้ง** → รายงานถัดไป `counted=false` เข้าคิวแบบ "ไม่นับ" ไม่ระงับ และ uphold ทำให้นับได้/รีเซ็ต streak (Task 5)
6. ตัวตนผู้รายงานและ `detail` ต้องไม่โผล่ใน endpoint ของ HR/นักศึกษา/Event (Task 5)

---

### Task 1: Schema + migration + config ของสไลซ์ 2

**Files:**
- Modify: `apps/verification/prisma/schema.prisma`
- Create: `apps/verification/prisma/migrations/<timestamp>_slice2_reports_flags/migration.sql`
- Create: `apps/verification/src/limits/limits.config.ts`
- Modify: `apps/verification/test/db/schema.spec.ts`
- Test: `apps/verification/test/limits/limits.config.spec.ts`

**Interfaces:**
- Produces: Prisma models `JobSnapshot`, `JobReport`, `JobReportCounter`, `ReporterStat`, `CompanyRejectionEvent`, `CompanyFlag`; enums `ReportStatus (OPEN|DISMISSED|UPHELD)`, `RejectionKind (AUTO_REJECTED|ADMIN_REJECTED|SUSPENDED|REMOVED)`; `QueueOrigin` เพิ่ม `REPORT_THRESHOLD`, `REPORT_UNCOUNTED`, `REJECTION_THRESHOLD`, `ADMIN_FLAG`
- Produces: `interface LimitsConfig { reportThreshold: number; reportDailyLimit: number; reporterDismissStreak: number; rejectionThreshold: number; rejectionWindowDays: number }`, `const LIMITS_CONFIG = 'VERIFICATION_LIMITS_CONFIG'`, `limitsFromConfig(get: (key: string) => unknown): LimitsConfig` (ค่าตั้งต้น 3/5/3/3/30; ค่าไม่ใช่จำนวนเต็มบวก ⇒ ใช้ค่าตั้งต้น แบบเดียวกับ `slaFromConfig`)

- [ ] **Step 1: เขียนเทสต์ที่ล้ม** — `limits.config.spec.ts`: `limitsFromConfig(() => undefined)` เท่ากับ `{3,5,3,3,30}`; env `REPORT_THRESHOLD=5` ⇒ `reportThreshold=5`; ค่า `'abc'`/`0`/`-1` ⇒ ค่าตั้งต้น. ใน `schema.spec.ts` เพิ่มเคส: ตารางทั้ง 6 มีอยู่; `job_reports` ซ้ำ (`job_id`,`reporter_user_id`) ⇒ error unique; `company_rejection_events.source_event_id` ซ้ำ ⇒ error unique; `queue_items` ใส่ `origin = 'REPORT_THRESHOLD'` ได้
- [ ] **Step 2: รันให้เห็นว่าล้ม** — `pnpm --filter @internpath/verification exec mocha test/limits/limits.config.spec.ts test/db/schema.spec.ts` → FAIL
- [ ] **Step 3: เพิ่ม model/enum ใน `schema.prisma` ตาม spec §5.2** (ชื่อตาราง/ฟิลด์ตาม data-schema §5: `job_reports` เพิ่ม `@@index([reporterUserId, createdAt])`; `company_rejection_events` มี `sourceEventId String @unique @db.Uuid`; `company_flags` มี `clearedAt`) แล้วสร้าง migration ด้วย `prisma migrate dev --create-only --name slice2_reports_flags` (ไม่แก้ migration เดิม) ตรวจ SQL ว่ามี `ALTER TYPE "queue_origin" ADD VALUE` ครบ 4 ค่า; ไม่ต้องแตะ trigger/partial index เดิม
- [ ] **Step 4: เขียน `limits.config.ts`** ตาม Interfaces (key env: `REPORT_THRESHOLD`, `REPORT_DAILY_LIMIT`, `REPORTER_DISMISS_STREAK`, `REJECTION_THRESHOLD`, `REJECTION_WINDOW_DAYS`) และเพิ่มค่าทั้งห้าใน `.env.example` ที่รากพร้อมค่าตั้งต้น
- [ ] **Step 5: รัน** `pnpm --filter @internpath/verification exec prisma generate` แล้วเทสต์ใน Step 2 → PASS; `tsc --noEmit` ผ่าน

---

### Task 2: คิวสำหรับ `JOB_REPORT`/`COMPANY_ACCOUNT` + ธงบริษัท (ติดอัตโนมัติ/ตั้งเคลียร์) + E18

**Files:**
- Modify: `apps/verification/src/queue/queue.service.ts`
- Create: `apps/verification/src/events/company-flag-changed.ts`
- Create: `apps/verification/src/flag/flag.service.ts`, `apps/verification/src/flag/flag.module.ts`
- Test: `apps/verification/test/flag/flag-service.spec.ts`, `apps/verification/test/queue/queue-service-slice2.spec.ts`

**Interfaces:**
- Produces (QueueService เพิ่ม):
  - `createReportItem(tx: Tx, a: { jobId: string; companyId: string; submissionId: string | null; origin: 'REPORT_THRESHOLD' | 'REPORT_UNCOUNTED'; correlationId?: string; now?: Date }): Promise<QueueItem>` — `type='JOB_REPORT'`, `targetType='job'`, `priority='NORMAL'`
  - `createCompanyItem(tx: Tx, a: { companyId: string; origin: 'REJECTION_THRESHOLD' | 'ADMIN_FLAG'; correlationId?: string; now?: Date }): Promise<QueueItem>` — `type='COMPANY_ACCOUNT'`, `targetType='company'`, `targetId=companyId`
  - `findOpenByType(tx: Tx, targetId: string, type: QueueItemType): Promise<QueueItem | null>`
  - `resolveOpenItem(tx: Tx, a: { item: QueueItem; resolution: string; actorId: string | null; actorRole: 'SYSTEM' | 'PLATFORM_ADMIN'; reason?: string; correlationId?: string }): Promise<boolean>` — `updateMany where status <> 'RESOLVED'`, เขียน `status_history`, คืน `false` ถ้าถูกปิดไปแล้ว
- Produces: `emitCompanyFlagChanged(outbox: OutboxWriter, tx: Tx, a: { payload: CompanyFlagChangedPayload; correlationId: string }): Promise<string>` (aggregate = `company_id`)
- Produces `FlagService`: `recordRejection(tx: Tx, a: { companyId: string; jobId: string; kind: RejectionKind; occurredAt: Date; sourceEventId: string; correlationId: string }): Promise<void>` (บันทึกเหตุการณ์ — ซ้ำด้วย `sourceEventId` ข้ามเงียบ — แล้วตรวจเกณฑ์ตาม spec §5.5), `setFlag(tx: Tx, a: { companyId: string; active: boolean; setBy: 'SYSTEM' | 'ADMIN'; reason?: string; triggerCount?: number; adminId?: string; correlationId: string }): Promise<{ changed: boolean }>` (ค่าเดิมอยู่แล้ว ⇒ `changed=false` ไม่เขียน/ไม่ส่งอะไร; เปลี่ยนจริง ⇒ อัปเดต `company_flags` + `entity_version+1` + `status_history` entity `COMPANY_FLAG` + E18; `active=false` ตั้ง `clearedAt=now` และปิด `COMPANY_ACCOUNT` ที่เปิดอยู่ด้วย resolution `ADMIN_CLEAR_FLAG`)
- Consumes: `LimitsConfig` (Task 1), `QueueService` เดิม

- [ ] **Step 1: เขียนเทสต์ที่ล้ม** — `queue-service-slice2.spec.ts`: `createReportItem` ได้ `priority NORMAL` และ `dueAt = createdAt + 48h` แม้ `fastTrack` ของบริษัทเป็นจริง; สร้าง `JOB_REPORT` ซ้อนประกาศเดียวกันขณะเปิด ⇒ error unique; `resolveOpenItem` ครั้งที่ 2 คืน `false`. `flag-service.spec.ts` (Postgres จริง): ① `recordRejection` 3 ครั้งใน 30 วัน (ขอบ: 3 ครั้งที่ `occurredAt` ห่าง 29 วัน ⇒ ติด, ครั้งที่เก่าสุดห่าง 31 วัน ⇒ ไม่ติด) ⇒ `company_flags.under_review=true`, มี `COMPANY_ACCOUNT` ใหม่ 1 รายการ, outbox มี `CompanyFlagChanged` `{active:true, trigger_count:3, set_by:'SYSTEM'}` 1 ตัว ② เหตุการณ์ที่ 4 ขณะธงเปิด ⇒ ไม่มีรายการ/Event เพิ่ม ③ `sourceEventId` เดิมซ้ำ ⇒ ไม่นับเพิ่ม ④ `setFlag(active:false)` ⇒ `under_review=false`, `clearedAt` ตั้ง, รายการ `COMPANY_ACCOUNT` ถูกปิด, E18 `active:false`; จากนั้นเหตุการณ์ปฏิเสธเก่า 3 ครั้ง (ก่อน `clearedAt`) + 1 ครั้งใหม่ ⇒ **ไม่** ติดซ้ำ; ครบ 3 ครั้งหลัง `clearedAt` ⇒ ติดใหม่ ⑤ `setFlag` ซ้ำค่าเดิม ⇒ `changed=false` ไม่มี Event ⑥ `entity_version` ของ E18 เพิ่มทีละ 1
- [ ] **Step 2: รันให้เห็นว่าล้ม** — `pnpm --filter @internpath/verification exec mocha test/queue/queue-service-slice2.spec.ts test/flag/flag-service.spec.ts` → FAIL
- [ ] **Step 3: เพิ่มเมธอดใน `QueueService`** ตาม Interfaces (ใช้ `computeDueAt(now, 'NORMAL', sla)`; `createCompanyItem`/`createReportItem` เขียน `status_history` แบบเดียวกับ `createItem`; ไม่แก้พฤติกรรมของ `createItem`/`findOpenItem`/`supersedeOpenItems` เดิม)
- [ ] **Step 4: เขียน `company-flag-changed.ts` และ `FlagService` + `FlagModule`** (imports `PrismaModule`, `QueueModule`, `AuditModule`; exports `FlagService`; `LIMITS_CONFIG` provider ตามแบบ `SLA_CONFIG` ใน `queue.module.ts` — ประกาศใน `FlagModule` และ export) การนับ: `occurred_at > max(now − rejectionWindowDays, clearedAt)` เมื่อ `now` = `occurredAt` ของเหตุการณ์ที่เพิ่งเข้า ใช้ `company_flags` เป็นตัวล็อก (upsert แถวบริษัทแล้ว `SELECT … FOR UPDATE` หรือ `updateMany where under_review=false` เป็นตัวตัดสินผู้ชนะ) เพื่อไม่ให้ E03 สองตัวขนานติดธงซ้ำ
- [ ] **Step 5: รันเทสต์ Step 2 → PASS; `tsc --noEmit` ผ่าน**

---

### Task 3: รับ E03 ทุกตัว — `job_snapshots` + นับการปฏิเสธ

**Files:**
- Create: `apps/verification/src/job/job-snapshot.service.ts`, `apps/verification/src/job/job-events.service.ts`, `apps/verification/src/job/job.module.ts`
- Modify: `apps/verification/src/consumers/job-status-changed.consumer.ts`, `apps/verification/src/consumers/consumers.module.ts`
- Test: `apps/verification/test/job/job-events.spec.ts`

**Interfaces:**
- Produces: `JobSnapshotService.apply(env: EventEnvelope<'JobStatusChanged', JobStatusChangedPayload>, tx: Tx): Promise<void>` — upsert `job_snapshots` `{job_id, company_id, status = to_status, entity_version}` เฉพาะ `entity_version` ใหม่กว่า (แบบ `CompanySnapshotService`: `updateMany` มีเงื่อนไข + `createMany skipDuplicates`)
- Produces: `JobEventsService.handleJobStatusChanged(env, tx): Promise<void>` — เรียก `snapshot.apply` → ถ้า `to_status ∈ {AUTO_REJECTED, ADMIN_REJECTED, SUSPENDED, REMOVED}` เรียก `flag.recordRejection(tx, { …, kind: to_status, occurredAt: new Date(changed_at), sourceEventId: env.event_id })` → แล้ว `evaluation.handleJobStatusChanged(env, tx)` (พฤติกรรม `VERIFY_TIMEOUT` เดิมคงเดิม)
- Consumes: `FlagService.recordRejection` (Task 2), `EvaluationService.handleJobStatusChanged` (เดิม)

- [ ] **Step 1: เขียนเทสต์ที่ล้ม** — `job-events.spec.ts` (Postgres จริง เรียก service ตรงใน `$transaction`): ① E03 `to=PUBLISHED` ⇒ `job_snapshots` มีแถว `{status:'PUBLISHED', company_id}` และไม่มี rejection event ② `entity_version` เก่ากว่ามาทีหลัง ⇒ snapshot ไม่ถอย แต่ E03 `to=REMOVED` ที่ `entity_version` เก่ากว่า **ยังนับ** เป็นเหตุการณ์ปฏิเสธ (spec §5.8 ข้อ 2) ③ E03 เดียวกัน (`event_id` เดิม) ประมวลผลสองครั้ง ⇒ rejection event แถวเดียว ④ E03 ของประกาศที่ไม่เคยรู้จักมาก่อนและ `to=SUSPENDED` ⇒ สร้าง snapshot + นับปฏิเสธ ไม่ล้ม ⑤ 3 เหตุการณ์ (`AUTO_REJECTED`, `ADMIN_REJECTED`, `SUSPENDED` ต่างประกาศของบริษัทเดียวกัน) ⇒ ติดธง + `COMPANY_ACCOUNT` + E18 ⑥ `to=SUSPENDED` แล้ว `REMOVED` ของประกาศเดียว นับ 2 ครั้ง (spec §5.8 ข้อ 3) ⑦ `VERIFY_TIMEOUT` ยังสร้าง `JOB_REVIEW` เหมือนเดิม และ `to=PENDING_REVIEW` ปกติ **ไม่**นับเป็นปฏิเสธ
- [ ] **Step 2: รันให้เห็นว่าล้ม** — `pnpm --filter @internpath/verification exec mocha test/job/job-events.spec.ts` → FAIL
- [ ] **Step 3: เขียน `JobSnapshotService`, `JobEventsService`, `JobModule`** (exports ทั้งสอง; imports `FlagModule`, `EvaluationModule`) ตาม Interfaces
- [ ] **Step 4: เปลี่ยน `JobStatusChangedConsumer`** ให้เรียก `JobEventsService.handleJobStatusChanged` แทน `EvaluationService` ตรงๆ และเพิ่ม `JobModule` ใน `ConsumersModule.imports`; ปรับเทสต์เดิมที่อ้างถึง consumer นี้ (ถ้ามี) ให้ผ่าน
- [ ] **Step 5: รันเทสต์ Step 2 และ `test/evaluation` ทั้งโฟลเดอร์ → PASS; `tsc --noEmit` ผ่าน**

---

### Task 4: รายงานประกาศ `POST /jobs/{job_id}/reports` + ตัวนับ + E04

**Files:**
- Create: `apps/verification/src/report/report.service.ts`, `apps/verification/src/report/report.controller.ts`, `apps/verification/src/report/dto.ts`, `apps/verification/src/report/report.module.ts`, `apps/verification/src/report/bangkok-day.ts`, `apps/verification/src/events/report-threshold.ts`
- Modify: `apps/verification/src/verification.module.ts` (เพิ่ม `ReportModule`, `FlagModule`, `JobModule` ใน imports)
- Test: `apps/verification/test/report/report-api.spec.ts`, `apps/verification/test/report/bangkok-day.spec.ts`, `apps/verification/test/report/report-concurrency.spec.ts`

**Interfaces:**
- Produces: `startOfBangkokDay(now: Date): Date` และ `startOfNextBangkokDay(now: Date): Date` (ปฏิทิน `Asia/Bangkok` UTC+7 ไม่มี DST)
- Produces: `emitReportThresholdReached(outbox: OutboxWriter, tx: Tx, a: { payload: ReportThresholdReachedPayload; correlationId: string }): Promise<string>` (aggregate = `job_id`)
- Produces: `ReportDto { category: JobReportCategory; detail: string }` (`@IsIn` ค่าจาก `JobReportCategory`, `detail` trim แล้ว 20–1000 ตัวอักษร)
- Produces: `ReportService.report(jobId: string, dto: ReportDto, user: JwtClaims, correlationId?: string, now = new Date()): Promise<{ id: string; status: 'OPEN' }>`
- Produces: `POST /jobs/:job_id/reports` role `STUDENT` → `201 {id, status:'OPEN'}`
- Consumes: `LIMITS_CONFIG`, `QueueService.createReportItem/findOpenByType` (Task 2), `job_snapshots` (Task 3)

- [ ] **Step 1: เขียนเทสต์ที่ล้ม** — `bangkok-day.spec.ts`: `2026-11-14T16:59:59Z` (23:59:59 ไทย) ⇒ เริ่มวัน `2026-11-14T00:00+07` = `2026-11-13T17:00:00Z`; `2026-11-14T17:00:00Z` (เที่ยงคืนไทย) ⇒ วันใหม่. `report-api.spec.ts` (HTTP + Postgres จริง; seed `job_snapshots` ตรงๆ): สถานะ `PUBLISHED` และ `CLOSED` ⇒ `201`; `VERIFYING`/`SUSPENDED`/`REMOVED` ⇒ `422 JOB_NOT_REPORTABLE`; ไม่มีประกาศ ⇒ `404`; `detail` 19/1001 ตัวอักษร, `category` นอก enum ⇒ `400 VALIDATION_FAILED`; รายงานซ้ำ (แม้ `status` เป็น `DISMISSED`) ⇒ `409 ALREADY_REPORTED`; HR/Admin/ไม่มี token ⇒ `403`/`401`; ผู้ใช้รายงานประกาศต่างกัน 5 ฉบับแล้วฉบับที่ 6 ในวันเดียวกัน ⇒ `429` (รายงานก่อนเที่ยงคืนไทย 5 ฉบับแล้วหลังเที่ยงคืนไทยฉบับที่ 6 ผ่าน โดยส่ง `now` เข้า service); รายงานที่ 1-2 ⇒ `counted_reports` 1/2 ไม่มี outbox/คิว; รายงานที่ 3 จากบัญชีต่างกัน ⇒ outbox `ReportThresholdReached` `{job_id, company_id, report_count:3, queue_item_id}` 1 ตัว + `JOB_REPORT` origin `REPORT_THRESHOLD` `submission_id` = ผลตรวจล่าสุดของประกาศ (หรือ null ถ้าไม่เคยมี) + `suspended_at` ตั้ง; รายงานผู้ใช้ที่ `reporter_stats.consecutive_dismissed = 3` ⇒ `counted=false`, ตัวนับไม่เพิ่ม, สร้าง `JOB_REPORT` origin `REPORT_UNCOUNTED` (หรือใช้รายการเปิดเดิม ไม่ซ้อน), ไม่มี E04, response เหมือนกรณีนับ (ไม่เปิดเผยว่านับหรือไม่); มีรายการ `REPORT_UNCOUNTED` เปิดอยู่แล้วตอนครบ 3 ⇒ อัปเกรด origin เป็น `REPORT_THRESHOLD` ไม่สร้างใหม่ และ E04 อ้าง `queue_item_id` เดิม; ไม่มี `detail` ใน log (spy `Logger` ไม่พบสตริง `detail`). `report-concurrency.spec.ts`: ผู้ใช้ต่างกัน 6 คนรายงานประกาศเดียวพร้อมกัน (`Promise.all`) ⇒ **E04 หนึ่งตัว**, `JOB_REPORT` หนึ่งรายการ, `counted_reports` = จำนวนรายงานที่นับสำเร็จ, ไม่มี Transaction ล้ม (ยกเว้นที่ควรเป็น `409`)
- [ ] **Step 2: รันให้เห็นว่าล้ม** — `pnpm --filter @internpath/verification exec mocha test/report` → FAIL
- [ ] **Step 3: เขียน `bangkok-day.ts`, `report-threshold.ts`, `dto.ts`**
- [ ] **Step 4: Implement `ReportService.report`** ตามลำดับ spec §5.3 ข้อ 1-6 ใน `prisma.$transaction`: ตรวจ snapshot → ซ้ำ → โควตารายวัน (`count job_reports where reporter_user_id and created_at >= startOfBangkokDay(now)`; `429 RATE_LIMITED`) → insert (ชน unique ⇒ `409`) → ตัวนับ: `INSERT … ON CONFLICT (job_id) DO UPDATE SET counted_reports = counted_reports + 1 RETURNING` แล้ว `UPDATE job_report_counters SET suspended_at = now() WHERE job_id = $1 AND suspended_at IS NULL AND counted_reports >= $2` (`$queryRaw`/`$executeRaw`) **ผู้ชนะ = ได้ 1 แถว** เท่านั้นที่สร้าง/อัปเกรดรายการคิวและเขียน E04. จัดการ `Retry-After`: ถ้า exception filter ของ `libs/common` รองรับ header ให้ตั้งเป็นวินาทีถึง `startOfNextBangkokDay(now)`, มิฉะนั้นใส่ `retry_after_seconds` ใน `details` (ผู้ลงมือเลือก และบันทึกลง api-contract)
- [ ] **Step 5: Implement `ReportController` + `ReportModule`** (imports `FlagModule` เพื่อได้ `LIMITS_CONFIG`, `QueueModule`, `AuditModule`; `@Controller('jobs')`, `@Post(':job_id/reports')`, `@Roles('STUDENT')`, `ParseUUIDPipe`, `@HttpCode(201)`) และเพิ่ม module ใน `VerificationModule`
- [ ] **Step 6: รันเทสต์ Step 2 → PASS; `tsc --noEmit` ผ่าน**

---

### Task 5: คำตัดสินรายงานของ Admin (`dismiss-report`/`uphold-report`) + รายละเอียดคิว

**Files:**
- Modify: `apps/verification/src/queue/queue-actions.service.ts`, `apps/verification/src/queue/queue.controller.ts`, `apps/verification/src/queue/queue-query.service.ts`, `apps/verification/src/queue/queue.module.ts`
- Create: `apps/verification/src/report/report-resolution.service.ts`
- Test: `apps/verification/test/report/report-resolution.spec.ts`, `apps/verification/test/queue/queue-api-reports.spec.ts`

**Interfaces:**
- Produces: `ReportResolutionService.dismiss(itemId: string, admin: { sub: string }, correlationId?: string): Promise<void>` และ `.uphold(itemId, admin, correlationId?): Promise<void>` ตามตารางใน spec §5.4
- Produces: `POST /admin/queue/:id/actions/dismiss-report` และ `.../uphold-report` → `204` (`PLATFORM_ADMIN`; ชนิดไม่ใช่ `JOB_REPORT` ⇒ `422 UNSUPPORTED_ITEM_TYPE`; ปิดแล้ว ⇒ `409 STATE_CONFLICT`; ต้องส่ง `JobVerified` แต่ `submission_id` ว่าง ⇒ `422 SUBMISSION_UNKNOWN`; รับ `{reason?}` ไม่บังคับ)
- Produces: `QueueDetail` เพิ่ม `reports: Array<{ id: string; reporter_user_id: string; category: string; detail: string; counted: boolean; status: 'OPEN' | 'DISMISSED' | 'UPHELD'; created_at: Date }>` (มีเฉพาะ `type='JOB_REPORT'`; ชนิดอื่นเป็น `[]`)
- Consumes: `QueueService.resolveOpenItem/createReportItem`, `emitJobVerified`, `emitReportThresholdReached` (Task 2/4), `AuditService.record`

**ขอบเขต "รายงานของรอบนี้"** (การตัดสินของแผน สอดคล้อง spec §5.4): รายงานที่ `status ∈ {OPEN, UPHELD}` และ `created_at >= coalesce(counter.reset_at, 'epoch')`; ตัวนับที่คำนวณใหม่ = จำนวนรายงานรอบนี้ที่ `counted = true` และ `status <> 'DISMISSED'`

- [ ] **Step 1: เขียนเทสต์ที่ล้ม** — `report-resolution.spec.ts` (Postgres จริง; จัด fixture ด้วย `ReportService` ของ Task 4): **ระงับแล้ว (`REPORT_THRESHOLD`)** — `dismiss`: outbox `JobVerified` `{decision:'RESTORE', decided_by:'ADMIN', is_appeal:false, submission_id}` 1 ตัว, รายงานรอบนี้ทั้งหมด `DISMISSED`, ตัวนับ `{counted_reports:0, suspended_at:null, reset_at:ตั้ง}`, `consecutive_dismissed +1` ของผู้รายงานแต่ละคน (คนละ 1 แม้มีหลายรายงาน), รายการ `RESOLVED`, มี `status_history` + audit `REPORT_DISMISS`; จากนั้นผู้รายงานคนเดิมรายงานประกาศเดิมอีก ⇒ `409`, ผู้รายงานใหม่ 3 คนรายงาน ⇒ ระงับรอบใหม่ได้ (E04 ตัวที่สอง). `uphold`: `JobVerified` `{decision:'REMOVE'}` 1 ตัว, รายงานเป็น `UPHELD` + `counted=true`, `consecutive_dismissed = 0` ของผู้รายงานทุกคน, audit `REPORT_UPHOLD`. **"ไม่นับ" (`REPORT_UNCOUNTED`)** — `dismiss`: รายงาน `DISMISSED`, ตัวนับรีเซ็ต, streak +1, **ไม่มี outbox**; `uphold`: รายงานเป็น `UPHELD`/`counted=true`, streak=0, **ไม่มี `REMOVE`**; ถ้าตัวนับที่คำนวณใหม่ ≥ 3 ⇒ ระงับ (E04 + รายการ `REPORT_THRESHOLD` ใหม่หลังปิดรายการเดิม), ถ้าไม่ถึง ⇒ ไม่มี Event. **streak ครบ 3**: ผู้ใช้ถูก `dismiss` 3 ประกาศติด ⇒ รายงานที่ 4 `counted=false`; หลัง `uphold` ของรายงานนั้น ⇒ streak 0 และรายงานถัดไป `counted=true`. ข้อผิดพลาด: ชนิดไม่ใช่ `JOB_REPORT` ⇒ 422, ปิดแล้วเรียกซ้ำ ⇒ `409` (ไม่มี Event ที่สอง), สองคนกดพร้อมกัน ⇒ ผ่านหนึ่งคน `409` หนึ่งคน, ไม่มี `submission_id` (ไม่เคยมีผลตรวจ) ⇒ `422 SUBMISSION_UNKNOWN` และไม่เปลี่ยนอะไร (rollback ทั้งก้อน). `queue-api-reports.spec.ts` (HTTP): Admin เห็น `reports[]` ใน `GET /admin/queue/{id}` ของ `JOB_REPORT`; รายการชนิดอื่นไม่มี; **นักศึกษา/HR เรียก `GET /admin/queue/{id}`, `POST …/actions/dismiss-report` ⇒ `403`; `GET /verification/jobs/{job_id}/result` ของ HR ไม่มี `reports`/`reporter_user_id`/`detail`**; Event ใน outbox ทุกตัวไม่มีสตริง `reporter_user_id` และ `detail`
- [ ] **Step 2: รันให้เห็นว่าล้ม** — `pnpm --filter @internpath/verification exec mocha test/report/report-resolution.spec.ts test/queue/queue-api-reports.spec.ts` → FAIL
- [ ] **Step 3: Implement `ReportResolutionService`** ใน Transaction เดียวต่อ action ตามแบบ `QueueActionsService.resolve` ของสไลซ์ 1 (ตรวจชนิด → ตรวจ `RESOLVED` → ตรวจ `submission_id` เมื่อต้องส่ง `JobVerified` → `resolveOpenItem` เป็นตัวกันกดพร้อมกัน → อัปเดตรายงาน/ตัวนับ/`reporter_stats` → Event → audit); `reasons` ของ `JobVerified` = `[{code:'REPORT_DISMISSED'|'REPORT_UPHELD', detail:<reason ถ้ามี>}]`; การระงับหลัง `uphold` ของ "ไม่นับ" ใช้ตรรกะเดียวกับ Task 4 (แยกเป็นเมธอดร่วมใน `ReportService` ที่ `ReportResolutionService` เรียกได้ — ปรับ Task 4 โดยไม่เปลี่ยนพฤติกรรม)
- [ ] **Step 4: เพิ่ม route ใน `QueueController`** (`@Post(':id/actions/dismiss-report')`, `@Post(':id/actions/uphold-report')`, `@HttpCode(204)`, body `ReportResolutionDto { reason?: string }` — ไม่บังคับ `MaxLength(1000)`) และขยาย `QueueQueryService.detail` เพิ่ม `reports[]`; ลงทะเบียน provider ใน `QueueModule`
- [ ] **Step 5: รันเทสต์ Step 2 และ `test/queue` ทั้งโฟลเดอร์ → PASS (เทสต์เดิมของสไลซ์ 1 ต้องไม่เสีย); `tsc --noEmit` ผ่าน**

---

### Task 6: API ธงบริษัทของ Admin

**Files:**
- Create: `apps/verification/src/flag/flag.controller.ts`, `apps/verification/src/flag/dto.ts`
- Modify: `apps/verification/src/flag/flag.service.ts`, `apps/verification/src/flag/flag.module.ts`, `apps/verification/src/queue/queue.controller.ts`
- Test: `apps/verification/test/flag/flag-api.spec.ts`

**Interfaces:**
- Produces: `PUT /admin/flags/companies/:company_id/under-review` body `SetFlagDto { active: boolean; reason: string }` (`reason` บังคับทั้งสองทิศ ไม่ว่าง ≤ 1000) → `200 { company_id, active, changed }`; เขียน audit `FLAG_SET`/`FLAG_CLEAR` เฉพาะเมื่อ `changed`
- Produces: `GET /admin/flags/companies` query `FlagListQuery extends PageQuery { active?: boolean; q?: string }` → `Page<{ company_id; company_name: string | null; active: boolean; set_by: 'SYSTEM' | 'ADMIN'; set_reason: string | null; set_at: Date | null; cleared_at: Date | null; trigger_count: number | null }>` (ชื่อจาก `company_snapshots`; `q` ค้นชื่อไม่สนตัวพิมพ์)
- Produces: `POST /admin/queue/:id/actions/company-clear-flag` → `204` (เฉพาะ `COMPANY_ACCOUNT` ที่เปิด; ชนิดอื่น ⇒ `422 UNSUPPORTED_ITEM_TYPE`; ปิดแล้ว ⇒ `409 STATE_CONFLICT`) ทำเหมือน `setFlag(active:false)` + audit `FLAG_CLEAR`
- Consumes: `FlagService.setFlag` (Task 2)

- [ ] **Step 1: เขียนเทสต์ที่ล้ม** — `flag-api.spec.ts` (HTTP + Postgres จริง): `PUT active:true` ⇒ `200 {changed:true}`, `company_flags` ตั้ง `set_by='ADMIN'`, outbox `CompanyFlagChanged` `{active:true, set_by:'ADMIN'}` 1 ตัว และ **ไม่สร้างรายการคิว**; `PUT` ซ้ำค่าเดิม ⇒ `200 {changed:false}` ไม่มี Event/audit เพิ่ม; `PUT` ไม่มี `reason` ⇒ `400`; `PUT active:false` ขณะมี `COMPANY_ACCOUNT` เปิด ⇒ รายการ `RESOLVED` resolution `ADMIN_CLEAR_FLAG`; `company-clear-flag` บนรายการที่ระบบสร้างจากเหตุการณ์ปฏิเสธ ⇒ `204`, ธงถูกเคลียร์, E18 `active:false`, เรียกซ้ำ ⇒ `409`; ชนิดอื่น ⇒ `422`; `GET` กรอง `active=true`, ค้น `q`, Pagination, เรียงใหม่สุดก่อน; HR/นักศึกษา ⇒ `403` ทุก endpoint
- [ ] **Step 2: รันให้เห็นว่าล้ม** — `pnpm --filter @internpath/verification exec mocha test/flag/flag-api.spec.ts` → FAIL
- [ ] **Step 3: Implement controller/DTO/เมธอดอ่านรายการใน `FlagService`** (`listFlags(q: FlagListQuery): Promise<Page<…>>`) และ action `company-clear-flag` ใน `QueueController` (ใช้ `FlagService.setFlag` ภายใน `prisma.$transaction`; เหตุผล ถ้าไม่ส่งมา ใช้ `'ADMIN_CLEAR_FLAG'`)
- [ ] **Step 4: รันเทสต์ Step 2 → PASS; `tsc --noEmit` ผ่าน**

---

### Task 7: End-to-end (RabbitMQ จริง) และเอกสาร

**Files:**
- Modify: `apps/verification/test/support/amqp.ts` (เพิ่มตัวเก็บ Event ทั่วไป `collectOutbound(types: string[]): Promise<Collector>` ถ้าตัวเดิมเก็บได้เฉพาะ `JobVerified`)
- Create: `apps/verification/test/e2e/report-flag.e2e.spec.ts`
- Modify: `docs/data-schema.md` (§5, §8), `docs/api-contract.md` (§6), `docs/event-contract.md` (หมายเหตุ E03/E04/E18), `docs/developer-guide.md`

- [ ] **Step 1: เขียน e2e ที่ล้ม** (`VerificationModule` เต็มระบบ ข้ามอัตโนมัติถ้าไม่มี Docker เหมือน `job-verification.e2e.spec.ts`): ① เผยแพร่ E03 `to=PUBLISHED` ของประกาศหนึ่ง → รายงานจาก 3 นักศึกษา (HTTP) → ได้ `ReportThresholdReached` ที่ exchange `internpath.events` routing `verification.ReportThresholdReached` → Admin `dismiss-report` → ได้ `JobVerified` `RESTORE` ② เผยแพร่ E03 ปฏิเสธ 3 ครั้ง (`AUTO_REJECTED`/`ADMIN_REJECTED`/`SUSPENDED`) ของบริษัทเดียว → ได้ `CompanyFlagChanged` `active:true` → เผยแพร่ E01 ของบริษัทนั้นที่ `company_flag_under_review:true` คะแนนต่ำ ⇒ ได้ `JobVerified` `PENDING_REVIEW` (เหลือง) ③ Admin `company-clear-flag` → ได้ `CompanyFlagChanged` `active:false`
- [ ] **Step 2: รัน** `pnpm --filter @internpath/verification exec mocha test/e2e/report-flag.e2e.spec.ts` → FAIL (หรือ SKIP ถ้าไม่มี broker — ต้องรันด้วย `pnpm infra:up` ให้ผ่านจริงก่อนปิด task)
- [ ] **Step 3: แก้ให้ผ่าน** (เพิ่ม `collectOutbound` ใน `amqp.ts` ถ้าจำเป็น; ตรวจว่า `ConsumersModule` ผูก E03 ใหม่ครบ)
- [ ] **Step 4: อัปเดตเอกสารตาม spec §6** — data-schema §5: `job_snapshots`, `company_rejection_events.source_event_id`, ค่า `origin` ใหม่ 4 ค่า, `company_flags.cleared_at`; §8: ตาราง "สถานะประกาศ × action" จาก spec §5.6 (OD-06); api-contract §6: `POST /jobs/{id}/reports` (`404`, `422 JOB_NOT_REPORTABLE`, `201 {id,status}`, `Retry-After`/ที่ Task 4 เลือก), `GET /admin/queue/{id}` ของ `JOB_REPORT` มี `reports[]`, `PUT/GET /admin/flags/...` ตามที่ทำจริง, `company-clear-flag`; event-contract §4: บันทึกว่า Verification รับ E03 **ทุกตัว**; developer-guide: ติ๊กสไลซ์ 2 และเพิ่มค่า env 5 ตัว; **ต้องแจ้ง Junior** ในบันทึกส่งมอบ (ไม่ใช่ไฟล์) ตาม spec §6 ข้อ 5
- [ ] **Step 5: รันทั้งชุด** `pnpm --filter @internpath/verification test` (ไม่น้อยกว่า 143 + เทสต์ใหม่ทั้งหมดผ่าน), `pnpm --filter @internpath/verification exec tsc --noEmit`, `pnpm --filter @internpath/verification lint`, `pnpm --filter "./libs/*" build` ผ่านทั้งหมด

---

## Self-Review

- **Spec coverage:** §5.1 Event → Task 3 (รับ E03), Task 4 (E04), Task 5 (E02 RESTORE/REMOVE), Task 2/6 (E18); §5.2 ข้อมูล → Task 1; §5.3 → Task 4; §5.4 → Task 5; §5.5 ธง → Task 2, 6; §5.6 ตาราง OD-06 → Task 7 (เอกสาร); §5.7 ความปลอดภัย/log → Task 4-6 (เทสต์ log/สิทธิ์/รั่ว) และ Global Constraints; §5.8 กรณีขอบ ข้อ 2/3 → Task 3, ข้อ 1 (`CLOSED`) → Task 4 (`CLOSED` รายงานได้) + บันทึกแจ้ง Junior (Task 7), ข้อ 6 (R5-G02) → Task 5; §5.9 การทดสอบ → ทุก task + e2e Task 7; §6 เอกสาร → Task 7
- **ประเด็นที่แผนตัดสินเพิ่ม (spec เงียบ):** (1) "รายงานของรอบนี้" ของ `dismiss` = `OPEN`/`UPHELD` ตั้งแต่ `reset_at` เพื่อให้สอดคล้องกับนิยามตัวนับ (หัว Task 5); (2) `Retry-After` ให้ผู้ลงมือเลือกตามความสามารถของ exception filter ใน `libs/common` (Task 4); (3) `company-clear-flag` ที่ไม่มี `reason` ใช้ค่า `'ADMIN_CLEAR_FLAG'`
- **ความสม่ำเสมอของชนิด:** `QueueService.createReportItem/createCompanyItem/findOpenByType/resolveOpenItem` (Task 2) ถูกใช้ใน Task 4-6 ด้วยชื่อ/พารามิเตอร์เดียวกัน; `FlagService.setFlag/recordRejection` (Task 2) ใช้ใน Task 3, 6; `LimitsConfig` (Task 1) ใช้ใน Task 2, 4
