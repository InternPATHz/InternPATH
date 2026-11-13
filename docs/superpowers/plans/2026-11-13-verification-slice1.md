# Verification & Trust สไลซ์ 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ทำให้ `apps/verification` ตรวจประกาศงานครบวงจร: รับ `JobSubmitted` → ตัดสินเขียว/เหลือง/แดง → ส่ง `JobVerified`, คิว Admin, อุทธรณ์ 1 ครั้ง, จัดการ Blacklist/กฎ, ผลตรวจให้ HR, audit

**Architecture:** ตัวตัดสิน `evaluateJob(input, rules)` เป็นฟังก์ชันล้วน (ไม่แตะ DB/Broker); เปลือก NestJS + Prisma เรื่อง I/O รับ Event ผ่าน `EventConsumer` และส่งผ่าน `OutboxWriter` ของ `libs/common` ใน Prisma `$transaction` เดียวกับข้อมูล; กฎ/Blacklist/negation cues อยู่ในตาราง DB (seed ใน migration)

**Tech Stack:** NestJS 12, Prisma 6.19 (`@prisma/client`), PostgreSQL 16, RabbitMQ 3.13, TypeScript strict, Mocha + Chai + Sinon + supertest + c8, `jsonwebtoken` (เฉพาะเทสต์)

**Spec:** [docs/superpowers/specs/2026-11-13-verification-slice1-design.md](../specs/2026-11-13-verification-slice1-design.md) (อ่านคู่กับ [data-schema.md](../../data-schema.md) §5/§8.2, [api-contract.md](../../api-contract.md) §6, [event-contract.md](../../event-contract.md) E01-E03/E05, และ plan messaging [2026-11-13-messaging-outbox.md](2026-11-13-messaging-outbox.md))

## Global Constraints

- โค้ดอยู่ใต้ `apps/verification/src/`; เทสต์ใต้ `apps/verification/test/` (Mocha จับ `test/**/*.spec.ts`; `.mocharc.json` มี `exit: true`)
- ใช้ `MessagingModule`/`OutboxWriter`/`EventConsumer` ของ `@internpath/common` เท่านั้น ห้ามส่ง RabbitMQ ตรงๆ; `libs/common` ห้าม import Prisma — Service นี้ส่ง `Prisma.TransactionClient` เข้าไปเอง
- JSON ทุกฟิลด์ `snake_case`; Pagination `?page=1&page_size=20` (สูงสุด 100) → `{ data, meta:{page,page_size,total} }`; action ใช้ `POST /resource/{id}/actions/{action}`; สถานะไม่ตรง → `409 STATE_CONFLICT` (error รูปแบบเดียวกับ `AppException` ใน `libs/common`)
- Event type ตาม `docs/event-contract.md`; `JobVerified.decision` ที่ส่งในสไลซ์นี้: `APPROVE`, `PENDING_REVIEW`, `AUTO_REJECT`, `APPEAL_ACCEPTED`, `ADMIN_APPROVE`, `ADMIN_REJECT` (ไม่ส่ง `REMOVE`/`RESTORE`)
- เกณฑ์: `score < 20` = `LOW`, `20–69` = `MEDIUM`, `≥ 70` = `HIGH`; ลำดับตัดสินและค่าตั้งต้นตาม spec §5.2–5.3 (ค่าตั้งต้นทั้งหมดคัดลอกจาก spec: 17 คำ `HARD`, 6 คำ `SOFT`, 8 cues, 8 แถว `risk_rules` รวม `NEGATION_WINDOW`)
- SLA คิว: `QUEUE_SLA_HOURS_NORMAL` = 48, `QUEUE_SLA_HOURS_FAST` = 12 (ชั่วโมงจริงจากเวลาสร้างรายการ)
- **ห้ามใส่ใน log**: `content`, `statement`, `matched_text`, `contact_notes` log ได้เฉพาะ `event_id`, `job_id`, `submission_id`, `decision`, `risk_level`, รหัสเหตุผล
- ขอบเขตสไลซ์ 1: ไม่ทำรายงานประกาศ/ตัวนับ/ธง `UNDER_REVIEW`/`company_rejection_events`/ตรวจรีวิว/UI/Gateway; ไม่ใช้สถานะคิว `IN_REVIEW`
- **Env ของเทสต์:** `test/setup.ts` ตั้ง `DISABLE_INFRA=true` (AppModule จึงไม่โหลด `VerificationModule` → เทสต์เดิมรันได้โดยไม่มี DB/Broker); เทสต์ที่ต้องใช้ DB/RabbitMQ ต้อง **ข้ามอัตโนมัติ** เมื่อต่อไม่ได้ และลบฐานข้อมูล/คิวที่สร้างทิ้งตอนจบ
- **Git:** ผู้ใช้เป็นคน commit เอง — **ห้าม commit/push/สร้าง branch** และแผนนี้ไม่มี step commit; ทำต่อบน working tree ปัจจุบัน
- เอกสารเป็นของ PM แก้ได้เอง (ผู้ใช้มอบอำนาจแล้ว)

## Review Focus

1. **Event ซ้ำ/ขนาน:** E01 `submission_id` เดิมถูกส่งซ้ำ (หรือประมวลผลพร้อมกัน) → `evaluations` แถวเดียว และ `JobVerified` ครั้งเดียว — Task 7
2. **ตัวตัดสินขัดข้อง:** ต้องไม่ `APPROVE` เอง; handler throw เพื่อให้ retry/DLQ ทำงาน ไม่มี `JobVerified` หลุดออกไป — Task 7
3. **Admin สองคนกดอนุมัติรายการเดียวกันพร้อมกัน:** ได้ `JobVerified` เพียงหนึ่ง อีกคนได้ `409 STATE_CONFLICT` — Task 9
4. **ข้อความไทยที่มีอักขระความกว้างศูนย์/ตัวพิมพ์ต่าง:** ไฮไลต์ต้องตรงกับ `content` ที่ API คืน และข้อความขนาดใหญ่ (200,000 ตัวอักษร) ต้องจบเร็ว ไม่ค้าง — Task 3, 4
5. **HR คนละบริษัท/ข้อมูลที่ไม่ควรเห็น:** ผลตรวจ/อุทธรณ์ของบริษัทอื่น → `403`; มุมมอง HR ไม่มี `content`/`assigned_to` — Task 10

---

### Task 1: Prisma schema, migrations, seed และตัวช่วยฐานข้อมูลทดสอบ

**Files:**
- Modify: `apps/verification/prisma/schema.prisma`, `apps/verification/package.json` (devDependencies `jsonwebtoken`, `@types/jsonwebtoken`; ใช้เวอร์ชันเดียวกับ `libs/common`), `.github/workflows/ci.yml` (เพิ่ม step `pnpm --filter @internpath/verification prisma:generate` ก่อน Lint)
- Create: `apps/verification/prisma/migrations/<ts>_init/migration.sql` (สร้างด้วย `prisma migrate dev --create-only` แล้วเพิ่ม SQL มือท้ายไฟล์), `apps/verification/prisma/migrations/<ts>_seed_defaults/migration.sql`, `apps/verification/.env` (gitignored; คัดลอกบรรทัด `VERIFICATION_*_URL` จาก `.env` ราก)
- Test: `apps/verification/test/support/db.ts`, `apps/verification/test/db/schema.spec.ts`

**Interfaces:**
- Produces:
```ts
// test/support/db.ts
export interface TestDatabase { url: string; prisma: PrismaClient; drop(): Promise<void> }
export function createTestDatabase(): Promise<TestDatabase>; // CREATE DATABASE ver_it_<hex> → `prisma migrate deploy` → PrismaClient
export function dbReachableOrSkip(ctx: Mocha.Context): Promise<void>;
```
- Prisma models (ชื่อตาราง `@@map` snake_case, คอลัมน์ `@map` snake_case, `Timestamptz(6)`, uuid `@db.Uuid`): `Evaluation`, `Appeal`, `QueueItem`, `CompanySnapshot`, `BlacklistTerm`, `RiskRule`, `NegationCue`, `StatusHistory`, `AdminAuditLog` (+ `OutboxEvent`, `ProcessedEvent` เดิม) และ enum `RiskLevel`, `EvaluationDecision(APPROVE|PENDING_REVIEW|AUTO_REJECT)`, `AppealStatus`, `QueueItemType`(ครบ 6 ค่าตาม data-schema), `QueueItemStatus`, `QueuePriority(NORMAL|FAST_TRACK)`, `QueueOrigin(EVALUATION|VERIFY_TIMEOUT|APPEAL)`, `TermSeverity(HARD|SOFT)` ฟิลด์ตาม spec §5.4: `Evaluation` (`submissionId` UNIQUE, `companyId`, `submittedAt`, `submissionKind`, `content Json`, `riskScore`, `riskLevel`, `decision`, `negatedOnly`, `matchedKeywords Json`, `reasons Json`, `companyFlagUnderReview`, `fastTrack`, `evaluatedAt`; index `jobId, submittedAt`), `QueueItem` (`type`, `targetType`, `targetId`, `companyId?`, `submissionId?`, `priority`, `riskLevel?`, `isAppeal`, `origin`, `dueAt`, `status`, `assignedTo?`, `resolution?`, `createdAt`, `resolvedAt?`), `Appeal` (`jobId` UNIQUE), `BlacklistTerm` (`term` UNIQUE, `severity`, `weight?`, `category`, `enabled`), `RiskRule` (`code` PK, `weight`, `params Json`, `enabled`), `NegationCue` (`cue` UNIQUE, `enabled`), `StatusHistory`/`AdminAuditLog` ตาม data-schema §2.2

- [ ] **Step 1: เขียนเทสต์ที่ล้มก่อน** `test/db/schema.spec.ts` (ข้ามเมื่อไม่มี Postgres; ใช้ `createTestDatabase()` ใน `before`, `drop()` ใน `after`):
  - `migrate deploy ผ่านบนฐานข้อมูลเปล่า และตารางครบ` — query `information_schema.tables` ต้องมี 11 ตารางของสไลซ์นี้ (รวม outbox/processed)
  - `seed: 17 HARD + 6 SOFT, negation_cues 8, risk_rules 8 แถว` และ `seed ซ้ำ (รัน SQL seed อีกรอบ) ไม่เพิ่มแถวและไม่ทับค่าที่แก้` (แก้ `risk_rules.weight` ของ `CONTACT_IN_TEXT` เป็น 99 แล้วรัน SQL ของ migration seed ซ้ำ → ยัง 99)
  - `partial unique index: สร้าง queue_items ที่ type/target_id เดียวกันขณะเปิดอยู่ไม่ได้ แต่ได้เมื่อรายการเดิม RESOLVED`
  - `status_history และ admin_audit_log: UPDATE และ DELETE ถูกปฏิเสธ (append-only trigger)`
  - `evaluations.submission_id และ appeals.job_id เป็น UNIQUE`
- [ ] **Step 2:** รัน `pnpm --filter @internpath/verification test` — **Expected:** FAIL (ยังไม่มี schema/helper) หรือ type error ของ helper
- [ ] **Step 3:** เขียน `createTestDatabase`/`dbReachableOrSkip` (ฐานข้อมูลฐานเริ่มต้น `postgresql://internpath:change-me@localhost:5432/postgres`, override ด้วย `VERIFICATION_IT_ADMIN_URL`; ใช้ `pg`/`execFileSync('pnpm', ['exec','prisma','migrate','deploy'])` พร้อม env `VERIFICATION_DATABASE_URL`/`VERIFICATION_DIRECT_URL`; `drop` = `DROP DATABASE ... WITH (FORCE)`)
- [ ] **Step 4:** เขียน schema ตามรายการข้างบน แล้ว `pnpm --filter @internpath/verification exec prisma migrate dev --name init --create-only`; ต่อท้าย SQL มือ: partial unique index `queue_items(target_id, type) WHERE status <> 'RESOLVED'` และ trigger ห้าม UPDATE/DELETE บน `status_history`, `admin_audit_log`; สร้าง migration `seed_defaults` ด้วย SQL `INSERT ... ON CONFLICT DO NOTHING` (ตาราง `blacklist_terms`, `negation_cues`, `risk_rules` ค่าตาม spec §5.3; `risk_rules` มี `NEGATION_WINDOW` params `{"max_gap":12}`); รัน `pnpm --filter @internpath/verification prisma:generate`
- [ ] **Step 5:** รันเทสต์ — **Expected:** `schema.spec.ts` PASS (หรือ pending ถ้าไม่มี Docker) และเทสต์เดิม (`health.spec.ts`) ยัง PASS; ตรวจว่า `docker exec internpath-postgres-1 psql -U internpath -Atc "select datname from pg_database where datname like 'ver_it_%'"` ว่างหลังจบ
- [ ] **Step 6:** `pnpm --filter @internpath/verification lint` และ `build` ผ่าน

---

### Task 2: Wiring — PrismaService, VerificationModule, AppModule, ตัวช่วยทดสอบ API

**Files:**
- Create: `src/prisma/prisma.service.ts`, `src/prisma/prisma.module.ts`, `src/prisma/types.ts`, `src/common/uuid.ts`, `src/verification.module.ts`
- Modify: `src/app.module.ts`, `test/setup.ts`
- Test: `test/support/app.ts`, `test/support/jwt.ts`, `test/wiring.spec.ts`, `test/common/uuid.spec.ts`

**Interfaces:**
- Produces:
```ts
// src/prisma/types.ts
export type Tx = Prisma.TransactionClient;
// src/prisma/prisma.service.ts — อ่าน VERIFICATION_DATABASE_URL จาก ConfigService (datasourceUrl)
export class PrismaService extends PrismaClient implements OnModuleDestroy { constructor(config: ConfigService); onModuleDestroy(): Promise<void> }
// src/common/uuid.ts
export function asUuid(value?: string): string; // คืนค่าเดิมถ้าเป็น UUID ไม่เช่นนั้นสร้างใหม่ (correlation id ที่ไม่ใช่ UUID ห้ามทำให้ Transaction ล้ม)
// test/support/jwt.ts
export function createJwtKit(): { publicKey: string; token(claims: { role: Role; sub?: string; company_id?: string }): string };
// test/support/app.ts — StubMessagingModule (@Global, provide/export OutboxWriter), ConfigModule global (JWT_PUBLIC_KEY, VERIFICATION_DATABASE_URL, QUEUE_SLA_*), PrismaModule, configureApp
export function createTestApp(o: { imports: any[]; db: TestDatabase }): Promise<{ app: INestApplication; token: ReturnType<typeof createJwtKit>['token'] }>;
```
- `VerificationModule` รวม feature module ที่ตามมาทีหลัง และลงทะเบียน `MessagingModule.register<Tx>({ service: 'verification', publishes: { databaseUrlEnv: 'VERIFICATION_DIRECT_URL' }, imports: [PrismaModule], consumes: { inject: [PrismaService], useFactory: (prisma: PrismaService) => ({ runInTransaction: (fn) => prisma.$transaction(fn) }) } })`
- `AppModule`: `imports` เดิม + `...(process.env.DISABLE_INFRA === 'true' ? [] : [VerificationModule])`

- [ ] **Step 1: เขียนเทสต์ที่ล้มก่อน:**
  - `asUuid`: คืนค่าเดิมเมื่อเป็น UUID; `'abc-123'`/`undefined` → UUID ใหม่ที่ไม่เท่าเดิม
  - `wiring.spec.ts`: `Prisma tx เข้ากับ OutboxTx และ ProcessedEventsTx ของ libs/common` (ตัวแปรที่กำหนดชนิด `const a: OutboxTx = {} as Tx; const b: ProcessedEventsTx = {} as Tx;` — ผ่านเมื่อ ts-node คอมไพล์ได้; ถ้าไม่เข้า ให้ปรับ interface ใน `libs/common` ให้หลวมลงแล้วแก้ที่ต้นเหตุ ไม่ import Prisma เข้า lib) และ `PrismaModule: เปิด app ด้วยฐานข้อมูลทดสอบแล้ว $queryRaw SELECT 1 ได้ และปิดแล้วไม่ค้าง` (ข้ามเมื่อไม่มี Postgres)
- [ ] **Step 2:** รันเทสต์ — **Expected:** FAIL (ยังไม่มีโมดูล)
- [ ] **Step 3:** Implement ตาม Interfaces; `test/setup.ts` เพิ่ม `process.env.DISABLE_INFRA = 'true'`; `createTestApp` ต้องใช้ `JwtAuthGuard` ที่อ่าน `JWT_PUBLIC_KEY` (รูป `\n` ตามที่ guard รองรับ)
- [ ] **Step 4:** รันเทสต์ — **Expected:** PASS ทั้งหมดรวม `health.spec.ts` (ไม่ต้องมี DB/Broker); `lint` และ `build` ผ่าน

---

### Task 3: การสแกนข้อความ (normalize, คำต้องห้าม+ประโยคปฏิเสธ, ช่องทางติดต่อ)

**Files:**
- Create: `src/screening/normalize.ts`, `src/screening/scan.ts`, `src/screening/contact.ts`, `src/screening/types.ts`
- Test: `test/screening/normalize.spec.ts`, `test/screening/scan.spec.ts`, `test/screening/contact.spec.ts`

**Interfaces:**
- Produces:
```ts
export function normalizeText(s: string): string; // Unicode NFC + ตัดอักขระความกว้างศูนย์ (U+200B–U+200D, U+FEFF, U+2060); ไม่เปลี่ยนตัวพิมพ์ (ออฟเซ็ตทั้งหมดอ้างอิงข้อความหลังนี้)
export interface MatchedKeyword { term: string; field: string; negated: boolean; start: number; end: number } // end เป็น exclusive
export function findTermMatches(text: string, field: string, terms: ReadonlyArray<{ term: string }>, cues: readonly string[], maxGap: number): MatchedKeyword[];
export interface ContactMatch { kind: 'PHONE' | 'EMAIL' | 'LINE' | 'SOCIAL_LINK'; start: number; end: number; matched: string }
export function detectContact(text: string): ContactMatch[];
```
- ปฏิเสธ = มี cue **ก่อนคำในประโยคเดียวกัน** และช่องว่างระหว่างท้าย cue ถึงต้นคำ ≤ `maxGap` ตัวอักษร; ประโยคแบ่งด้วยขึ้นบรรทัดใหม่และ `. ! ? ;` (ไม่แบ่งด้วยช่องว่าง); จับ substring ไม่สนตัวพิมพ์ (เทียบด้วย `toLowerCase()` ซึ่งต้องคงความยาว); คืน **ทุกครั้งที่ปรากฏ** แยกกัน; ห้ามใช้ regex ที่ backtrack แบบทวีคูณ

- [ ] **Step 1: เขียนเทสต์ที่ล้มก่อน:**
  - `normalizeText`: `'ก​ข'` → `'กข'`; รูป NFD → NFC; ไม่ lower-case (`'ABC'` คงเดิม)
  - `findTermMatches`: `'ไม่มีค่ามัดจำ'` → 1 ผลที่ `negated=true` และ `start/end` ชี้ `ค่ามัดจำ`; `'เก็บค่ามัดจำ'` → `negated=false`; `'ไม่มีค่าสมัครแต่ต้องโอนเงินก่อน'` → `ค่าสมัคร` negated, `โอนเงินก่อน` ไม่ negated; cue อยู่ไกลเกิน `maxGap` (ตัวอย่าง 13 ตัวอักษร เทียบ `maxGap=12`) → ไม่ negated; cue ข้ามประโยค (`'ไม่มี\nค่ามัดจำ'`) → ไม่ negated; คำเดียวกันปรากฏสองครั้ง (ปฏิเสธครั้งหนึ่ง ไม่ปฏิเสธอีกครั้ง) → ได้ 2 ผลแยกกัน; `'MLM'` กับ term `mlm` → ตรง; ออฟเซ็ตใช้ได้กับข้อความที่ผ่าน `normalizeText` แล้ว (`text.slice(start,end).toLowerCase()` เท่ากับ term)
  - `detectContact`: เบอร์ `081-234-5678`, `0812345678`, `+66 81 234 5678` → `PHONE`; `a@b.co` → `EMAIL`; `line id: abc123`, `ไลน์ @abc123` → `LINE`; `https://line.me/ti/p/x`, `t.me/x`, `facebook.com/x` → `SOCIAL_LINK`; **ต้องไม่จับ:** `5,000-8,000`, `เบี้ยเลี้ยง 15000 บาท`, `สัปดาห์ละ 35 ชั่วโมง`, `https://company.example/about`
  - ประสิทธิภาพ: ข้อความ 200,000 ตัวอักษรที่ซ้ำ `ก` และข้อความที่ซ้ำ `ไม่มี` ผ่าน `findTermMatches`+`detectContact` ได้ภายใน 1 วินาที
- [ ] **Step 2:** รันเทสต์ — **Expected:** FAIL (ยังไม่มีโมดูล)
- [ ] **Step 3:** Implement; ช่องทางติดต่อใช้ regex แบบจำกัดความยาวและไม่ซ้อนตัวบวก
- [ ] **Step 4:** รันเทสต์ — **Expected:** PASS; `lint`/`build` ผ่าน

---

### Task 4: ตัวตัดสิน `evaluateJob` และค่าตั้งต้น

**Files:**
- Create: `src/screening/evaluate.ts`, `src/screening/defaults.ts`
- Modify: `src/screening/types.ts`
- Test: `test/screening/evaluate.spec.ts`

**Interfaces:**
- Consumes: `normalizeText`, `findTermMatches`, `detectContact`, `MatchedKeyword` (Task 3)
- Produces:
```ts
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type Decision = 'APPROVE' | 'PENDING_REVIEW' | 'AUTO_REJECT';
export interface JobContent { job_title: string; description: string; responsibilities: string; qualifications: string; allowance_text: string; location: string; contact_notes?: string }
export interface EvaluationInput { content: JobContent; hours_per_week: number; allowance: { type: 'AMOUNT' | 'NONE'; amount_thb?: number }; company_flag_under_review: boolean }
export interface RiskRule { code: string; weight: number; params: Record<string, number>; enabled: boolean }
export interface Rules { blacklist: Array<{ term: string; severity: 'HARD' | 'SOFT'; weight: number | null }>; negationCues: string[]; riskRules: RiskRule[] }
export interface Evaluation { risk_score: number; risk_level: RiskLevel; decision: Decision; negated_only: boolean; matched_keywords: MatchedKeyword[]; reasons: Array<{ code: string; detail: string; matched_text?: string }>; content: JobContent /* หลัง normalizeText ทุกฟิลด์ */ }
export function evaluateJob(input: EvaluationInput, rules: Rules): Evaluation;
export const DEFAULT_RULES: Rules; // ค่าตั้งต้นตาม spec §5.3 (ต้องตรงกับ seed SQL ของ Task 1)
```
- ลำดับตัดสินตาม spec §5.2 (ข้อ 1–5) กฎน้ำหนักตาม §5.3; `HARD_TERM_OTHER_FIELD` นับครั้งเดียว; `SOFT_TERMS` นับคำไม่ซ้ำและรวมไม่เกินน้ำหนักของกฎ (30); `risk_rules` ที่ `enabled=false` ไม่นับ; `score = min(100, ผลรวม)`; `reasons[].code` ใช้ชื่อกฎ/`BLACKLIST_HARD`/`BLACKLIST_NEGATED`/`BLACKLIST_SOFT`/`SCORE_HIGH`/`COMPANY_UNDER_REVIEW`

- [ ] **Step 1: เขียนเทสต์ที่ล้มก่อน** (ใช้ `DEFAULT_RULES`; helper สร้าง input ปกติ: เบี้ยเลี้ยง 5,000, 35 ชม./สัปดาห์, description > 100 ตัวอักษร ไม่มีคำเสี่ยง):
  - `ประกาศปกติ → score 0, LOW, APPROVE`
  - `คำ HARD ใน job_title ที่ไม่ปฏิเสธ → HIGH + AUTO_REJECT ไม่ว่าคะแนนเท่าไร` และ `ใน description เช่นเดียวกัน`
  - `README: "ไม่มีค่ามัดจำ" ใน description → MEDIUM, PENDING_REVIEW, negated_only=true`; `"ไม่มีค่ามัดจำ แต่ต้องโอนเงินก่อน" → AUTO_REJECT`
  - `คำ HARD ในฟิลด์อื่น (responsibilities) → +40 (ไม่ใช่ AUTO_REJECT ทันที) ผล MEDIUM`
  - ขอบคะแนนด้วยกฎที่ปรับ weight: 19 → LOW/APPROVE, 20 → MEDIUM/PENDING_REVIEW, 69 → MEDIUM, 70 → HIGH/AUTO_REJECT; คะแนนรวมเกิน 100 ถูกตัดที่ 100
  - ตัวอย่างใน spec: เบอร์โทรใน description → 45 MEDIUM; เบอร์โทร + `amount_thb 40000` → 75 HIGH
  - `company_flag_under_review=true`: LOW → PENDING_REVIEW (reasons มี `COMPANY_UNDER_REVIEW`); คะแนน HIGH → ยัง AUTO_REJECT
  - แต่ละกฎ: `ALLOWANCE_HIGH` (>30000), `HOURS_EXCESSIVE` (49 → +25, 45 → +10, 40 → 0), `DESCRIPTION_TOO_SHORT` (<100), `NO_ALLOWANCE` (+5), `SOFT_TERMS` (7 คำไม่ซ้ำรวมไม่เกิน +30; คำเดียวกันซ้ำนับครั้งเดียว); กฎที่ `enabled=false` ไม่นับ
  - `content` ที่คืนผ่าน `normalizeText` แล้ว และ `matched_keywords[].start/end` ใช้ตัดข้อความใน `content[field]` ได้ตรง (ข้อความมีอักขระความกว้างศูนย์คั่น)
  - `ข้อความ 200,000 ตัวอักษรทุกฟิลด์ จบภายใน 1 วินาที`
- [ ] **Step 2:** รันเทสต์ — **Expected:** FAIL
- [ ] **Step 3:** Implement `evaluateJob` และ `DEFAULT_RULES`; `negation max_gap` อ่านจาก `risk_rules` code `NEGATION_WINDOW` (ไม่มี → 12)
- [ ] **Step 4:** รันเทสต์ — **Expected:** PASS; `lint`/`build` ผ่าน

---

### Task 5: Audit, ตัวโหลดกฎ, `GET /admin/audit`

**Files:**
- Create: `src/audit/audit.service.ts`, `src/audit/audit.controller.ts`, `src/audit/audit.module.ts`, `src/rules/rules.repository.ts`, `src/rules/rules.module.ts`, `src/common/pagination.ts`
- Modify: `src/verification.module.ts`
- Test: `test/audit/audit.spec.ts`, `test/rules/rules-repository.spec.ts`

**Interfaces:**
- Consumes: `Tx`, `PrismaService` (Task 2); `Rules`, `DEFAULT_RULES` (Task 4); `createTestApp`, `createJwtKit` (Task 2)
- Produces:
```ts
// src/common/pagination.ts
export interface Page<T> { data: T[]; meta: { page: number; page_size: number; total: number } }
export class PageQuery { page: number /*1*/; page_size: number /*20, ≤100*/ }  // class-validator + class-transformer
// src/audit/audit.service.ts
export class AuditService {
  record(tx: Tx, e: { adminId: string; action: string; targetType: string; targetId: string; before?: unknown; after?: unknown; reason?: string; correlationId?: string }): Promise<void>; // correlationId ผ่าน asUuid
  list(q: { actor?: string; action?: string; target_type?: string; from?: Date; to?: Date } & PageQuery): Promise<Page<AuditRow>>;
}
// src/rules/rules.repository.ts
export class RulesRepository { load(db: PrismaService | Tx): Promise<Rules> } // เฉพาะแถว enabled; blacklist/cues/riskRules
```
- `GET /admin/audit` (Role `PLATFORM_ADMIN`): query `actor`, `action`, `target_type`, `from`, `to` + Pagination; เรียง `occurred_at` ใหม่ไปเก่า; ฟิลด์ response `snake_case`

- [ ] **Step 1: เขียนเทสต์ที่ล้มก่อน** (ต้องมี Postgres; ข้ามถ้าไม่มี):
  - `RulesRepository.load: ค่าที่ seed ไว้เท่ากับ DEFAULT_RULES` (เทียบเนื้อหาโดยไม่สนลำดับ) และ `แถวที่ enabled=false ไม่ถูกโหลด`
  - `AuditService.record + list: บันทึกแล้วอ่านได้ ตัวกรอง actor/action/target_type/from/to ทำงาน และ Pagination ตาม meta`; `correlationId ที่ไม่ใช่ UUID ไม่ทำให้ record ล้ม`
  - `GET /admin/audit`: ไม่มี token → 401; role `STUDENT`/`COMPANY_HR` → 403; `PLATFORM_ADMIN` → 200 พร้อม `{data, meta}`; `page_size=101` → 400 `VALIDATION_FAILED`
- [ ] **Step 2:** รันเทสต์ — **Expected:** FAIL
- [ ] **Step 3:** Implement; controller ใช้ `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles('PLATFORM_ADMIN')` ระดับ class
- [ ] **Step 4:** รันเทสต์ — **Expected:** PASS; `lint`/`build` ผ่าน

---

### Task 6: API จัดการ Blacklist และกฎ (`/admin/blacklist`, `/admin/risk-rules`)

**Files:**
- Create: `src/rules/rules.service.ts`, `src/rules/rules.controller.ts`, `src/rules/dto.ts`
- Modify: `src/rules/rules.module.ts`
- Test: `test/rules/rules-api.spec.ts`

**Interfaces:**
- Consumes: `RulesRepository`, `AuditService`, `evaluateJob`, `Evaluation` (Task 4–5)
- Produces: endpoint (Role `PLATFORM_ADMIN` ทุกตัว) ตาม spec §5.5 / api-contract §6.3:
  - `GET /admin/blacklist` (Pagination, `?severity=&enabled=&q=`), `POST /admin/blacklist` `{term, severity, weight?, category}` (`HARD` ห้ามมี `weight`; `SOFT` ต้องมี `weight` ≥ 0 จำนวนเต็ม; `term` ซ้ำ → `409 TERM_EXISTS`), `PATCH /admin/blacklist/{id}` `{enabled?, weight?, category?}`, `DELETE /admin/blacklist/{id}` (204)
  - `POST /admin/blacklist/test` `{text}` → `{decision, risk_level, risk_score, matched_keywords, reasons}` (ประเมินข้อความเดียวเป็น `description` ด้วยกฎปัจจุบัน; **ไม่บันทึกอะไร**)
  - `GET /admin/risk-rules` → `{rules:[{code,weight,params,enabled}], negation_cues:[{id,cue,enabled}]}`; `PUT /admin/risk-rules` `{rules?:[{code,weight?,params?,enabled?}], negation_cues?:[{cue,enabled}]}` (ตรวจ: `code` ต้องมีอยู่, `weight` จำนวนเต็ม ≥ 0, `NEGATION_WINDOW.params.max_gap` 0–100)
  - ทุก mutation เขียน `admin_audit_log` (action เช่น `BLACKLIST_CREATE|UPDATE|DELETE`, `RISK_RULES_UPDATE`; `before`/`after`) ใน Transaction เดียวกัน

- [ ] **Step 1: เขียนเทสต์ที่ล้มก่อน** (supertest ผ่าน `createTestApp`; ฐานข้อมูลทดสอบ):
  - `สิทธิ์: ทุก endpoint ไม่มี token 401, HR/นักศึกษา 403`
  - `POST blacklist HARD ที่มี weight → 400`; `SOFT ไม่มี weight → 400`; `term ซ้ำ → 409`; สำเร็จ → 201 และมีแถว audit `BLACKLIST_CREATE`
  - `PATCH enabled=false แล้ว /admin/blacklist/test ที่มีคำนั้น → ไม่เจอคำนั้น`; `DELETE → 204 และหาย`
  - `POST /admin/blacklist/test`: `"ไม่มีค่ามัดจำ"` → `PENDING_REVIEW` พร้อม `matched_keywords[0].negated=true`; ไม่มีแถวใหม่ในตารางใดๆ (นับ `evaluations`/`queue_items`/`outbox_events` ก่อน-หลังเท่ากัน)
  - `PUT /admin/risk-rules`: แก้ `CONTACT_IN_TEXT.weight=10` แล้ว `/test` กับเบอร์โทรได้ score เปลี่ยนตาม; `code` ที่ไม่มี → 400; `weight` ติดลบ → 400; มีแถว audit `RISK_RULES_UPDATE` ที่มี `before`/`after`
- [ ] **Step 2:** รันเทสต์ — **Expected:** FAIL
- [ ] **Step 3:** Implement; DTO ใช้ class-validator (`whitelist`+`forbidNonWhitelisted` มาจาก `configureApp`)
- [ ] **Step 4:** รันเทสต์ — **Expected:** PASS; `lint`/`build` ผ่าน

---

### Task 7: รับ `JobSubmitted` → ตัดสิน → `JobVerified` (แกนหลัก)

**Files:**
- Create: `libs/contracts/src/events/job.ts`, `libs/contracts/src/events/identity.ts`, `src/evaluation/evaluation.service.ts`, `src/evaluation/job-submitted.consumer.ts`, `src/evaluation/evaluation.module.ts`, `src/queue/queue.service.ts`, `src/queue/sla.ts`, `src/queue/queue.module.ts`, `src/events/job-verified.ts`
- Modify: `libs/contracts/src/events/index.ts`, `src/verification.module.ts`
- Test: `test/evaluation/sla.spec.ts`, `test/evaluation/evaluation-service.spec.ts`

**Interfaces:**
- Consumes: `evaluateJob`, `RulesRepository`, `OutboxWriter`, `Tx`, `asUuid`
- Produces:
```ts
// libs/contracts: ตามรูปแบบใน event-contract (ฟิลด์ snake_case ตรงเอกสาร)
export interface JobSubmittedPayload { job_id: string; company_id: string; submission_id: string; submission_kind: 'NEW'|'EDIT'|'RESUBMIT'; changed_fields?: string[]; content: JobContent; work_mode: 'ONSITE'|'REMOTE'|'HYBRID'; hours_per_week: number; allowance: { type: 'AMOUNT'|'NONE'; amount_thb?: number /* ต่อเดือน */ }; company_flag_under_review: boolean; fast_track: boolean; submitted_at: string }
export interface JobVerifiedPayload { job_id: string; submission_id: string; decision: 'APPROVE'|'PENDING_REVIEW'|'AUTO_REJECT'|'APPEAL_ACCEPTED'|'ADMIN_APPROVE'|'ADMIN_REJECT'|'REMOVE'|'RESTORE'; risk_score?: number; risk_level?: 'LOW'|'MEDIUM'|'HIGH'; reasons: Array<{ code: string; detail: string; matched_text?: string }>; is_appeal: boolean; decided_by: 'SYSTEM'|'ADMIN'; decided_at: string }
export interface JobStatusChangedPayload { job_id: string; company_id: string; from_status: string; to_status: string; reason_code?: string; reason?: string; submission_id?: string /* ใช้กับ VERIFY_TIMEOUT */; entity_version: number; changed_at: string; application_effect?: string }
export interface CompanyStatusChangedPayload { company_id: string; status: string; previous_status?: string; snapshot: { name: string; logo_key?: string; university_partner: boolean; verified_badge: boolean }; owner_user_id?: string; reason?: string; entity_version: number; changed_at: string }
// src/queue/sla.ts
export interface SlaConfig { normalHours: number; fastHours: number }
export function computeDueAt(createdAt: Date, priority: 'NORMAL'|'FAST_TRACK', cfg: SlaConfig): Date;
export function isOverdue(item: { status: string; dueAt: Date }, now: Date): boolean; // status ≠ RESOLVED และ now > dueAt
// src/queue/queue.service.ts
export class QueueService {
  createItem(tx: Tx, a: { type: 'JOB_REVIEW'|'JOB_APPEAL'; jobId: string; companyId: string; submissionId: string | null; riskLevel: 'LOW'|'MEDIUM'|'HIGH' | null; fastTrack: boolean; origin: 'EVALUATION'|'VERIFY_TIMEOUT'|'APPEAL'; now?: Date; correlationId?: string }): Promise<QueueItem>; // priority/due_at ตาม SLA; เขียน status_history (null → OPEN, actor SYSTEM)
}
// src/events/job-verified.ts
export function emitJobVerified(outbox: OutboxWriter, tx: Tx, a: { payload: JobVerifiedPayload; correlationId: string }): Promise<string>; // type 'JobVerified', aggregateId = job_id
// src/evaluation/evaluation.service.ts
export class EvaluationService { handleJobSubmitted(env: EventEnvelope<'JobSubmitted', JobSubmittedPayload>, tx: Tx): Promise<void> }
```
- `handleJobSubmitted`: ถ้ามี `evaluations.submission_id` นี้แล้ว → return เงียบ; โหลดกฎ → `evaluateJob` (ขัดข้อง = throw ปล่อยขึ้นไป ไม่จับ) → บันทึก `evaluations` (ฟิลด์ `content` = ผลหลัง normalize, `fast_track`, `submitted_at`, `submission_kind`) → `decision=PENDING_REVIEW` สร้างรายการ `JOB_REVIEW` (`origin=EVALUATION`, `risk_level`) → `emitJobVerified` (`decided_by:'SYSTEM'`, `is_appeal:false`, `decided_at` = เวลาตัดสิน)
- `JobSubmittedConsumer implements OnModuleInit` → `consumer.subscribe({ producer:'job', type:'JobSubmitted', handler: (env, tx) => evaluation.handleJobSubmitted(env, tx) })` (เปิดเฉพาะใน `VerificationModule`)

- [ ] **Step 1: เขียนเทสต์ที่ล้มก่อน:**
  - `sla.spec.ts`: `computeDueAt(NORMAL) = createdAt+48h`, `FAST_TRACK = +12h`, ใช้ค่าจาก config; `isOverdue`: เกิน due_at และยังไม่ RESOLVED → true; RESOLVED → false; ก่อนถึง → false
  - `evaluation-service.spec.ts` (Postgres จริงผ่าน `createTestDatabase`; เรียก `handleJobSubmitted` ภายใน `prisma.$transaction` + `OutboxWriter` จริง; envelope สร้างด้วย helper):
    - `ประกาศสะอาด → evaluations 1 แถว (APPROVE, LOW), outbox 1 แถว type JobVerified decision APPROVE, ไม่มีรายการคิว`
    - `ประกาศมีเบอร์โทร → PENDING_REVIEW, queue_items 1 แถว JOB_REVIEW (risk_level MEDIUM, priority NORMAL, due_at = +48h) และ status_history 1 แถว, outbox decision PENDING_REVIEW`
    - `fast_track=true → priority FAST_TRACK, due_at = +12h`
    - `คำต้องห้าม → AUTO_REJECT, ไม่มีรายการคิว, outbox มี reasons ที่มี matched_text`
    - `ส่ง E01 submission_id เดิมซ้ำ → evaluations ยังแถวเดียว และ outbox ยังแถวเดียว` และ `เรียกพร้อมกัน 2 ครั้ง (Promise.all) → ไม่เกิน 1 แถว/1 outbox และไม่มี unhandled rejection ที่ไม่ใช่การชนของ unique`
    - `ตัวตัดสินขัดข้อง (stub RulesRepository.load ให้ throw / ให้กฎที่ทำให้ evaluateJob throw) → handleJobSubmitted reject, ไม่มี evaluations และไม่มี outbox (Transaction rollback)`
    - `ฟิลด์ที่ไม่รู้จักใน payload ไม่ทำให้ล้ม`
    - `ไม่มีข้อความ log ใดที่มี content` (stub `Logger.prototype.*` ตรวจ)
- [ ] **Step 2:** รันเทสต์ — **Expected:** FAIL
- [ ] **Step 3:** Implement (เพิ่ม `export` ของชนิดใหม่ใน `libs/contracts` แล้ว `pnpm --filter @internpath/contracts build`); คอลัมน์ uuid ของ `status_history`/audit ใช้ `asUuid`; รับมือการชนของ unique `submission_id` ภายใน Transaction (จับ `P2002` ของ `evaluations.submission_id` แล้วถือว่าซ้ำ → return) หรือใช้ `createMany skipDuplicates`
- [ ] **Step 4:** รันเทสต์ — **Expected:** PASS; `lint`/`build` ผ่าน (รวม `pnpm --filter @internpath/contracts build`)

---

### Task 8: `VERIFY_TIMEOUT`, `CompanyStatusChanged` และกรณีขอบของ E01

**Files:**
- Create: `src/evaluation/job-status.consumer.ts`, `src/company/company-snapshot.service.ts`, `src/company/company-snapshot.consumer.ts`, `src/company/company.module.ts`
- Modify: `src/evaluation/evaluation.service.ts`, `src/queue/queue.service.ts`, `src/evaluation/evaluation.module.ts`, `src/verification.module.ts`
- Test: `test/evaluation/edge-cases.spec.ts`, `test/company/company-snapshot.spec.ts`

**Interfaces:**
- Consumes: Task 7 (`EvaluationService`, `QueueService`, `emitJobVerified`, payload types)
- Produces:
```ts
// QueueService เพิ่ม
supersedeOpenItems(tx: Tx, jobId: string, reason: 'SUPERSEDED', correlationId?: string): Promise<number>; // ปิดรายการเปิดของประกาศ → RESOLVED, resolution 'SUPERSEDED', status_history; ไม่ส่ง Event; คืนจำนวนที่ปิด
findOpenItem(tx: Tx, jobId: string, type: 'JOB_REVIEW'|'JOB_APPEAL'): Promise<QueueItem | null>;
// EvaluationService เพิ่ม
handleJobStatusChanged(env: EventEnvelope<'JobStatusChanged', JobStatusChangedPayload>, tx: Tx): Promise<void>; // เฉพาะ to_status='PENDING_REVIEW' && reason_code='VERIFY_TIMEOUT'; อื่นๆ return เงียบ
// CompanySnapshotService
handleCompanyStatusChanged(env: EventEnvelope<'CompanyStatusChanged', CompanyStatusChangedPayload>, tx: Tx): Promise<void>; // upsert เมื่อ entity_version ใหม่กว่าเท่านั้น
```
- กติกา (spec §5.8): (1) E01 ใหม่ของประกาศที่มีรายการ `JOB_REVIEW`/`JOB_APPEAL` เปิดอยู่ → `supersedeOpenItems` **ก่อน** ตรวจรอบใหม่; (2) `handleJobStatusChanged`: สร้าง `JOB_REVIEW` (`origin=VERIFY_TIMEOUT`, `risk_level` จากผลตรวจล่าสุดของประกาศ (`submitted_at` มากสุด) ถ้ามี, `submission_id` = `payload.submission_id` ?? `submission_id` ของผลตรวจล่าสุด ?? null, `fast_track` จากผลตรวจล่าสุดถ้ามีไม่เช่นนั้น false) ถ้ายังไม่มีรายการเปิด; (3) E01 ที่มาถึงเมื่อมีรายการ `origin=VERIFY_TIMEOUT` เปิดอยู่: บันทึก `evaluations`, เติม `risk_level`/`submission_id` ให้รายการนั้น และ **ไม่ส่ง `JobVerified`**, ไม่สร้างรายการใหม่; (4) ผลตรวจที่เป็น `PENDING_REVIEW` เมื่อมีรายการเปิดของประกาศแล้ว (ไม่ใช่ timeout) ใช้ซ้ำไม่สร้างใหม่

- [ ] **Step 1: เขียนเทสต์ที่ล้มก่อน** (`edge-cases.spec.ts`, Postgres จริง):
  - `E01 EDIT ใหม่ขณะมีรายการ JOB_REVIEW เปิด → รายการเดิม RESOLVED(SUPERSEDED) ไม่มี outbox จากการปิด; ผลตรวจใหม่ PENDING_REVIEW สร้างรายการใหม่ได้ (ไม่ชน partial unique)`
  - `VERIFY_TIMEOUT ไม่มีผลตรวจ → รายการ JOB_REVIEW origin VERIFY_TIMEOUT, risk_level null, submission_id = ค่าจาก E03`
  - `VERIFY_TIMEOUT ซ้ำ (Event ซ้ำคนละ event_id) → ยังรายการเดียว`
  - `E03 อื่น (to_status PUBLISHED, หรือ PENDING_REVIEW ที่ reason_code อื่น) → ไม่มีผลอะไร`
  - `ผลตรวจมาทีหลัง timeout (APPROVE) → evaluations เพิ่ม, รายการเดิมถูกเติม risk_level/submission_id, ไม่มี outbox JobVerified เพิ่ม`; `(AUTO_REJECT) เช่นเดียวกัน`; `(PENDING_REVIEW) เช่นเดียวกัน และรายการยังเดียว`
  - `ผลตรวจที่ตัดสิน PENDING_REVIEW ก่อน แล้ว timeout E03 มาทีหลัง → ใช้รายการเดิม ไม่ซ้ำ`
  - `company-snapshot.spec.ts`: `E05 version 2 → upsert; version 1 มาหลัง (เก่ากว่า) → ไม่เขียนทับ; version เท่ากัน → ไม่เขียนทับ`
- [ ] **Step 2:** รันเทสต์ — **Expected:** FAIL
- [ ] **Step 3:** Implement; ลงทะเบียน consumer เพิ่ม: `JobStatusChanged` (producer `job`), `CompanyStatusChanged` (producer `identity`)
- [ ] **Step 4:** รันเทสต์ — **Expected:** PASS (รวมเทสต์ Task 7); `lint`/`build` ผ่าน

---

### Task 9: API คิว Admin (รายการ, รายละเอียด+ไฮไลต์, อนุมัติ/ปฏิเสธ)

**Files:**
- Create: `src/queue/queue.controller.ts`, `src/queue/queue-actions.service.ts`, `src/queue/dto.ts`, `src/queue/highlights.ts`
- Modify: `src/queue/queue.module.ts`, `src/queue/queue.service.ts`
- Test: `test/queue/queue-api.spec.ts`, `test/queue/highlights.spec.ts`

**Interfaces:**
- Consumes: `QueueService`, `emitJobVerified`, `AuditService`, `isOverdue`, `computeDueAt`, `createTestApp` (Task 2–8)
- Produces:
```ts
export function buildHighlights(matched: MatchedKeyword[]): Array<{ field: string; start: number; end: number; keyword: string; negated: boolean }>;
export class QueueActionsService {
  approve(id: string, admin: { sub: string }, correlationId?: string): Promise<void>;
  reject(id: string, admin: { sub: string }, reason: string, correlationId?: string): Promise<void>;
}
```
- Endpoint (Role `PLATFORM_ADMIN`): `GET /admin/queue` (`?type=&priority=&risk_level=&overdue=true&status=` + Pagination; เรียงค่าเริ่มต้น `priority` (FAST_TRACK ก่อน) แล้ว `due_at` น้อยไปมาก; แต่ละรายการมี `id,type,target_id,company_id,company_name,priority,risk_level,is_appeal,due_at,overdue,status,created_at`), `GET /admin/queue/{id}` (+ `reasons`, `content`, `highlights`, `submission_id`, ผลอุทธรณ์ `statement` ถ้ามี, `company_name` จาก `company_snapshots`), `POST /admin/queue/{id}/actions/{approve|reject}` (`reject` ต้องมี `reason`)
- action: ใน Transaction เดียว — `updateMany where id AND status != 'RESOLVED'` (0 แถว → `409 STATE_CONFLICT`); ถ้า `submission_id` ของรายการว่าง → `422 SUBMISSION_UNKNOWN` (ไม่ส่ง Event); `emitJobVerified` (`ADMIN_APPROVE|ADMIN_REJECT`, `is_appeal` ตามรายการ, `decided_by:'ADMIN'`, `risk_*`/`reasons` จากผลตรวจที่ผูกกับ `submission_id`, ถ้า reject เพิ่ม reason `{code:'ADMIN_REASON', detail: reason}`); `appeals.status` → `APPROVED`/`DENIED` + `decided_by/at` เมื่อ `JOB_APPEAL`; เขียน `status_history` (OPEN → RESOLVED, actor admin) และ `admin_audit_log` (`QUEUE_APPROVE|QUEUE_REJECT`)

- [ ] **Step 1: เขียนเทสต์ที่ล้มก่อน:**
  - `highlights.spec.ts`: map `{term,field,negated,start,end}` → `{field,start,end,keyword,negated}`; ข้อความที่มีอักขระความกว้างศูนย์: `content[field].slice(start,end)` ที่คืนจาก `GET /admin/queue/{id}` เท่ากับคำ (เทียบแบบไม่สนตัวพิมพ์)
  - `queue-api.spec.ts` (Postgres จริง + `createTestApp`): สิทธิ์ (401/403); list: filter ทั้ง 5 ตัว, `overdue=true` คืนเฉพาะรายการเลยกำหนด (สร้างรายการที่ `due_at` เป็นอดีต), เรียง FAST_TRACK ก่อน, Pagination; detail: มี `highlights` และ `company_name` (จาก snapshot) และ 404 เมื่อไม่มี id
  - `approve → 204, รายการ RESOLVED, outbox JobVerified ADMIN_APPROVE (decided_by ADMIN), status_history และ audit 1 แถวต่อ action`; `reject ไม่มี reason → 400`; `reject → ADMIN_REJECT มี reasons รวม ADMIN_REASON`
  - `ทำซ้ำบนรายการ RESOLVED → 409 STATE_CONFLICT`; `Admin สองคนกด approve พร้อมกัน (Promise.all) → หนึ่ง 204 หนึ่ง 409 และ outbox JobVerified เพียง 1 แถว`
  - `รายการ submission_id ว่าง (timeout ไม่มีผลตรวจ) → 422 SUBMISSION_UNKNOWN, รายการยังเปิด, ไม่มี outbox`
  - `JOB_APPEAL: approve → appeals APPROVED + JobVerified ADMIN_APPROVE is_appeal=true; reject → DENIED + ADMIN_REJECT`
- [ ] **Step 2:** รันเทสต์ — **Expected:** FAIL
- [ ] **Step 3:** Implement
- [ ] **Step 4:** รันเทสต์ — **Expected:** PASS; `lint`/`build` ผ่าน

---

### Task 10: ผลตรวจให้ HR และอุทธรณ์

**Files:**
- Create: `src/appeal/appeal.service.ts`, `src/appeal/appeal.controller.ts`, `src/appeal/dto.ts`, `src/appeal/appeal.module.ts`
- Modify: `src/verification.module.ts`
- Test: `test/appeal/appeal-api.spec.ts`

**Interfaces:**
- Consumes: `QueueService.createItem`, `emitJobVerified`, `Evaluation` rows (Task 7–9)
- Produces: endpoint (Role `COMPANY_HR`; `AuditService` ไม่เกี่ยว):
  - `GET /verification/jobs/{job_id}/result` — Role `COMPANY_HR` (เจ้าของ) หรือ `PLATFORM_ADMIN` → ผลตรวจ **ล่าสุด** (`submitted_at` มากสุด) `{risk_level, risk_score, reasons, matched_keywords, is_appeal, can_appeal}` บวก `admin_reason` เมื่อรายการล่าสุดถูก Admin ปฏิเสธ; HR ไม่ได้ `content`/`assigned_to`/`submission_id`; ไม่พบ → 404; HR คนละ `company_id` → 403 (ไม่เปิดเผยว่ามีผลหรือไม่นอกจาก 403)
  - `POST /verification/jobs/{job_id}/appeal` `{statement}` (`statement` 20–2000 ตัวอักษร) — เฉพาะ HR เจ้าของ: ผลล่าสุดต้อง `AUTO_REJECT` (ไม่ใช่ → `409 STATE_CONFLICT`); มีแถว `appeals` ของประกาศนี้แล้ว → `409 APPEAL_ALREADY_USED`; สำเร็จ → 201 และ Transaction เดียวสร้าง `appeals(OPEN)`, รายการ `JOB_APPEAL` (`is_appeal=true`, `origin=APPEAL`, `risk_level=HIGH`, `fast_track` ตามผลตรวจ) และ outbox `JobVerified(APPEAL_ACCEPTED, is_appeal:true, decided_by:'SYSTEM')` ด้วย `submission_id` ของผลล่าสุด
  - `can_appeal` = ผลล่าสุด `AUTO_REJECT` และยังไม่มี `appeals` ของประกาศนั้น

- [ ] **Step 1: เขียนเทสต์ที่ล้มก่อน** (Postgres จริง + `createTestApp`):
  - `HR เจ้าของ: result คืนรูปแบบตามสัญญา; ไม่มี content/assigned_to/submission_id ใน body; Admin เห็นผลเดียวกัน`
  - `HR คนละบริษัท → 403 ทั้ง result และ appeal`; `ไม่มี token → 401`; `นักศึกษา → 403`; `ประกาศที่ไม่เคยถูกตรวจ → 404`
  - `appeal สำเร็จ → 201; appeals 1 แถว; queue_items JOB_APPEAL; outbox APPEAL_ACCEPTED; result แสดง can_appeal=false หลังนั้น`
  - `appeal ครั้งที่สอง → 409 APPEAL_ALREADY_USED` (ไม่เพิ่มแถว); `ผลล่าสุดเป็น APPROVE/PENDING_REVIEW → 409 STATE_CONFLICT`; `statement สั้นเกิน → 400`
  - `ส่งใหม่หลังอุทธรณ์ไม่ผ่าน: Admin reject อุทธรณ์ แล้ว E01 ใหม่ถูก AUTO_REJECT อีก → result.can_appeal=false และ appeal → 409 APPEAL_ALREADY_USED` (spec §5.8 ข้อ 4)
  - `ผลล่าสุดเลือกจาก submitted_at ไม่ใช่เวลาบันทึก: แทรกผลที่ submitted_at เก่ากว่าแต่บันทึกทีหลัง → result ยังเป็นผลที่ submitted_at ใหม่กว่า`
  - `หลัง Admin reject: result มี admin_reason`
- [ ] **Step 2:** รันเทสต์ — **Expected:** FAIL
- [ ] **Step 3:** Implement
- [ ] **Step 4:** รันเทสต์ — **Expected:** PASS; `lint`/`build` ผ่าน

---

### Task 11: End-to-end กับ RabbitMQ จริง และเอกสาร

**Files:**
- Test: `test/e2e/job-verification.e2e.spec.ts`, `test/support/amqp.ts`
- Modify: `docs/event-contract.md` (E01: `amount_thb` ต่อเดือน; E03: `submission_id?` เมื่อ `VERIFY_TIMEOUT`), `docs/data-schema.md` §5, `docs/api-contract.md` §6 (+ §10 ข้อ 2 ปิด), `docs/developer-guide.md` §6.2/§7

**Interfaces:**
- `test/support/amqp.ts`: `brokerReachableOrSkip(ctx)`, `purgeVerificationQueues()` (ลบคิว `verification.JobSubmitted|JobStatusChanged|CompanyStatusChanged` + `.dlq` + `verification.retry.1|2|3`), `collectJobVerified(...)` (คิวชั่วคราวผูก `verification.JobVerified` เพื่อรับผล)
- e2e boot: `VerificationModule` จริง (รวม `MessagingModule` และ relay) ด้วย config ชี้ฐานข้อมูลทดสอบ (`VERIFICATION_DATABASE_URL` และ `VERIFICATION_DIRECT_URL` เป็น URL เดียวกัน) และ RabbitMQ ในเครื่อง; ข้ามถ้า `RABBITMQ_URL` ถูกตั้งเป็นโฮสต์ที่ไม่ใช่ localhost (กันลบคิวบน broker ที่ใช้ร่วมกัน)

- [ ] **Step 1: เขียนเทสต์ที่ล้มก่อน** `job-verification.e2e.spec.ts` (`this.timeout(30000)`; ข้ามเมื่อไม่มี Postgres/RabbitMQ):
  - **demo สามสี:** publish E01 สามฉบับ (สะอาด / มีเบอร์โทร / `ค่ามัดจำ`) ผ่าน exchange `internpath.events` routing key `job.JobSubmitted` → ได้ `JobVerified` `APPROVE` / `PENDING_REVIEW` / `AUTO_REJECT` ตามลำดับและ `GET /admin/queue` เห็นรายการเหลืองหนึ่งรายการ
  - **อุทธรณ์ครบวงจร:** ประกาศแดง → HR `POST appeal` → ได้ `APPEAL_ACCEPTED` → Admin approve รายการ `JOB_APPEAL` → ได้ `ADMIN_APPROVE`
  - **แก้ประกาศแล้วตรวจซ้ำ:** E01 `kind=EDIT` ใหม่ของประกาศเหลืองที่ยังเปิดคิว → รายการเก่า `SUPERSEDED` และผลใหม่ออกตามปกติ
  - **Event เสียไม่ทำให้ service หยุด:** publish ข้อความ JSON พัง แล้ว E01 ปกติตามมา → ถูกประมวลผล และข้อความเสียอยู่ใน `verification.JobSubmitted.dlq`
- [ ] **Step 2:** รันเทสต์ — **Expected:** FAIL ถ้ามี Docker (ยังไม่ครบการต่อสาย) หรือ pending ถ้าไม่มี Docker; แก้การต่อสาย (`VerificationModule`, ลงทะเบียน consumer, `MessagingModule` publishes) จนผ่านโดยแก้ที่ต้นเหตุ ไม่ใช่ปรับเทสต์
- [ ] **Step 3:** อัปเดตเอกสารตามรายการ Files: data-schema §5 (ตาราง/ฟิลด์ที่เพิ่มตาม spec §5.4: `evaluations` เพิ่มคอลัมน์, `queue_items.submission_id/origin`, ตารางใหม่ `blacklist_terms`/`risk_rules`/`negation_cues`); api-contract §6 (`highlights` มี `field`/`negated`; `GET /admin/audit`; `422 SUBMISSION_UNKNOWN`; ผลตรวจฝั่ง HR มี `admin_reason`; ปิด §10 ข้อ 2); developer-guide (บันทึกว่า migration แรกรันได้จริงและขั้นตอนที่ใช้ รวม `prisma:generate` ใน CI และ `DISABLE_INFRA`)
- [ ] **Step 4:** ตรวจรวม: `pnpm test`, `pnpm lint`, `pnpm build` ที่รากต้อง exit 0; ตรวจว่าไม่มีฐานข้อมูล `ver_it_*` และคิว `verification.*` ค้างใน Docker; ปิด Docker แล้วรัน `pnpm --filter @internpath/verification test` ชุดที่ใช้ DB/Broker ต้องถูกข้าม (pending) และชุดอื่นผ่าน

---

## Self-Review

- **ครอบคลุม spec:** เป้าหมาย 1 (รับ E01/ส่ง E02) → Task 7; 2 (ฟังก์ชันล้วน+ประโยคปฏิเสธ) → Task 3–4; 3 (คิว Admin) → Task 9; 4 (ผลตรวจ+อุทธรณ์) → Task 10; 5 (Blacklist/กฎผ่าน API+test) → Task 6; 6 (audit) → Task 5 และ audit ใน Task 6/9; §5.1 รับ E03/E05 → Task 8; §5.3 ค่าตั้งต้น → Task 1 (seed) + Task 4 (`DEFAULT_RULES`) + Task 5 (เทียบเท่ากัน); §5.4 ข้อมูล → Task 1; §5.5 API → Task 5/6/9/10; §5.6 ความปลอดภัย/log → guards ใน Task 5–10, เทสต์ log ใน Task 7; §5.7 การทดสอบ → ทุก Task + e2e Task 11; §5.8 กรณีขอบทั้ง 7 ข้อ → Task 8 (1,2), Task 9 (3), Task 10 (4,5), Task 1/9 (SLA/seed); §6 เอกสาร → Task 11 (และ pagination มาตรฐานใน Task 5)
- **ส่วนที่เพิ่มจาก spec:** `QueueOrigin` และคอลัมน์ `origin` (จำเป็นเพื่อแยกรายการที่เกิดจาก `VERIFY_TIMEOUT` ตามกติกา §5.8 ข้อ 2); env `DISABLE_INFRA` (ให้เทสต์เดิมรันได้โดยไม่ต้องมี DB/Broker); trigger append-only (data-schema §2.2 กำหนดไว้แล้ว)
- **ความสอดคล้องของชนิด:** `Tx`, `Evaluation`, `MatchedKeyword`, `JobVerifiedPayload`, `QueueService.createItem` ใช้ชื่อเดียวกันใน Task 3–10; `emitJobVerified` ใช้ใน Task 7, 9, 10
- **ความเสี่ยงที่ยังเปิด:** (1) `prisma migrate dev` กับ partial index/trigger ที่เขียนมือ: ถ้า Prisma รายงาน drift ให้ใช้ `migrate deploy` และบันทึกไว้ใน developer-guide; (2) การจับการชนของ unique ในการรับ Event ขนานขึ้นกับพฤติกรรม Prisma `P2002` ใน `$transaction` — เทสต์ใน Task 7 ครอบคลุม; (3) ค่าตั้งต้นของ Blacklist/น้ำหนักเป็นข้อเสนอ ปรับได้ผ่าน API โดยไม่แก้โค้ด
