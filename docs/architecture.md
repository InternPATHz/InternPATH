# 🏗️ Architecture (InternPath)

> เอกสารนี้เป็น **ที่เก็บหลัก (Single Source of Truth)** ของโครงสร้างระบบเชิงเทคนิค
> กฎธุรกิจ (Risk Score, SLA, Flow การอนุมัติ ฯลฯ) อยู่ใน [README.md](../README.md) — เอกสารนี้อ้างอิงเลขหัวข้อของ README แทนการคัดลอกซ้ำ

| เอกสาร | เนื้อหา |
| :--- | :--- |
| [getting-started.md](getting-started.md) | วิธีติดตั้งและรันโปรเจกต์ |
| [developer-guide.md](developer-guide.md) | คู่มือสำหรับคนที่จะเขียนโค้ดต่อ (กฎ, สูตรงาน, สิ่งที่ยังไม่มี) |
| [architecture.md](architecture.md) | (ไฟล์นี้) โครงสร้างระบบ, การสื่อสารระหว่าง Service, Security, Deploy |
| [api-contract.md](api-contract.md) | REST Endpoint, Request/Response, Error, สิทธิ์ตาม Role |
| [event-contract.md](event-contract.md) | Event, Envelope, Payload, Routing, Retry/DLQ |
| [data-schema.md](data-schema.md) | ตาราง/ฟิลด์ต่อ Service, Enum สถานะ, **State Machine** |

---

## 1. ภาพรวม (System Context)

```text
                         ┌────────────────────────┐
   Browser ───────────►  │  apps/web (Next.js)    │
                         └───────────┬────────────┘
                                     │ HTTPS (REST, JWT)
                         ┌───────────▼────────────┐
                         │  apps/gateway          │  Routing • ตรวจ JWT • Rate Limit • Denylist
                         └─┬─────┬──────┬──────┬──┘
            ┌──────────────┘     │      │      └───────────────┐
            ▼                    ▼      ▼                      ▼
   ┌─────────────────┐  ┌──────────────┐ ┌─────────────────┐ ┌──────────────┐
   │ identity        │  │ job          │ │ verification    │ │ lifecycle    │
   │ (SA)            │  │ (Junior)     │ │ (PM)            │ │ (Tester)     │
   └───┬─────────────┘  └──────┬───────┘ └────────┬────────┘ └──────┬───────┘
       │ DB                    │ DB               │ DB              │ DB
       ▼                       ▼                  ▼                 ▼
   [Postgres]              [Postgres]         [Postgres]        [Postgres]

        ▲ Outbox ─────────► RabbitMQ (topic exchange) ◄───────── Outbox ▲
                                     │
                              ┌──────▼───────┐
                              │ notification │ (Junior) ── DB ── [Postgres]
                              └──────────────┘ ── SMTP ──► Mailpit
   File Storage: MinIO (dev) / Cloudflare R2 (deploy) — เข้าถึงผ่าน Service เจ้าของข้อมูลเท่านั้น
```

## 2. Service และความเป็นเจ้าของ

หน้าที่เชิงฟังก์ชันของแต่ละ Service ดู README หัวข้อ **4.3** และตารางเจ้าของข้อมูลหัวข้อ **5.8**

| Service | โฟลเดอร์ | Port (dev) | เจ้าของ | DB | Consume | Publish |
| :--- | :--- | :---: | :--- | :--- | :--- | :--- |
| Gateway | `apps/gateway` | 3000 | SA | — | `UserSuspended` (อัปเดต Denylist) | — |
| Identity & Organization | `apps/identity` | 3001 | SA | `identity_db` | `ReviewPublished` | `CompanyStatusChanged`, `CompanyEntitlementChanged`, `AdvisorLinkChanged`, `UserSuspended`, `UserDeletionRequested` |
| Job Management | `apps/job` | 3002 | Junior | `job_db` | `JobVerified`, `ReportThresholdReached`, `CompanyStatusChanged`, `CompanyEntitlementChanged`, `CompanyFlagChanged`, `UserDeletionRequested` | `JobSubmitted`, `JobStatusChanged` |
| Verification & Trust | `apps/verification` | 3003 | PM | `verification_db` | `JobSubmitted`, `JobStatusChanged`, `ReviewSubmitted`, `CompanyStatusChanged`, `CompanyEntitlementChanged`, `UserDeletionRequested` | `JobVerified`, `ReportThresholdReached`, `ReviewModerationResult`, `CompanyFlagChanged` |
| Student Experience & Lifecycle | `apps/lifecycle` | 3004 | Tester | `lifecycle_db` | `JobStatusChanged`, `CompanyStatusChanged`, `AdvisorLinkChanged`, `ReviewModerationResult`, `UserDeletionRequested` | `ApplicationStatusChanged`, `ReviewSubmitted`, `ReviewPublished`, `CertificateIssued`, `CertificateRevoked`, `ReminderDue`, `ProblemReportCreated` |
| Notification | `apps/notification` | 3005 | Junior | `notification_db` | ทุก Event ที่ต้องแจ้งเตือน (ดู [event-contract.md](event-contract.md) §6) | — |
| Web | `apps/web` | 3100 | ทุกคน (แยกหน้าตาม Role) | — | — | — |

> ตารางนี้เป็นมุมมอง "ใครส่ง/ใครรับ" ระดับ Service รายละเอียด Payload อยู่ใน [event-contract.md](event-contract.md)

## 3. โครงสร้าง Monorepo

```text
InternPATH/
├─ apps/
│  ├─ web/            Next.js + Tailwind (UI Kit, Admin Layout)
│  ├─ gateway/        NestJS บางๆ
│  ├─ identity/       NestJS + Prisma (schema.prisma, Dockerfile, package.json ของตัวเอง)
│  ├─ job/
│  ├─ verification/
│  ├─ lifecycle/
│  └─ notification/
├─ libs/
│  ├─ contracts/      ชนิดข้อมูล Event Envelope/Payload, DTO ที่แชร์ (TypeScript types เท่านั้น)
│  └─ common/         JWT Guard, Role Guard, Logger, Correlation ID, Error filter, Outbox publisher
├─ docs/
├─ docker-compose.yml (profiles ต่อ Service)
└─ .github/workflows/ (lint • test • build เฉพาะ Service ที่เปลี่ยน)
```

กฎ (อ้างจาก README 4.4): ห้าม import ข้าม Service • แชร์ได้เฉพาะ `libs/*` • ไม่มี FK ข้ามฐานข้อมูล อ้างด้วย ID เท่านั้น

## 4. รูปแบบการสื่อสาร

| ประเภท | ใช้เมื่อ | เทคโนโลยี |
| :--- | :--- | :--- |
| **Client → Gateway → Service** | คำขอจากผู้ใช้ | REST + JWT ผู้ใช้ |
| **Service → Service (Sync)** | ต้องการคำตอบทันทีและต้อง Atomic เช่น จอง/ยืนยัน/คืนโควตา, ตรวจสถานะใบสมัครตอน Reconciliation, ดึงอีเมลจาก `user_id` | REST ภายใน + **Service Token** (ดู §5) |
| **Service → Service (Async)** | แจ้งการเปลี่ยนแปลงสถานะ ไม่ต้องรอคำตอบ | RabbitMQ + Outbox (ดู [event-contract.md](event-contract.md)) |

ข้อจำกัด: การเรียก Sync ข้าม Service ให้ใช้ timeout 3 วินาที + retry 2 ครั้ง และ **ห้ามวนเป็นวงกลม** (A→B→A)

Sync Call ภายในทั้งหมดที่มี (รายละเอียดใน [api-contract.md](api-contract.md) §9):

| ผู้เรียก | ผู้รับ | จุดประสงค์ |
| :--- | :--- | :--- |
| Lifecycle | Job | reserve / confirm / release โควตา, อ่านสถานะ/โควตา/deadline ของประกาศตอนสมัคร |
| Job | Lifecycle | (Reconciliation) ถามว่าใบสมัครของแต่ละการจองควรถือโควตาอยู่หรือไม่ |
| Lifecycle | Identity | ดึงสาขา/ชั้นปี/สถานะผูกอาจารย์ตอนสมัคร, ตรวจ Consent, ดึงรายชื่อ HR ของบริษัท |
| Notification | Identity | ดึงอีเมลปลายทางด้วย `user_id`, รายชื่อ Admin |
| Gateway | Identity | ดึง Denylist ตอนเริ่มระบบ/ทุก 30 วินาที |

> คะแนนดาวบริษัทไม่ถูกดึงใน Job — หน้าเว็บเรียก Directory (Identity) แยกต่างหาก (README 4.3) • ธง `UNDER_REVIEW` ตั้ง/เคลียร์โดย Admin ผ่านหน้าเว็บ → API ของ Verification ตรง (ไม่ใช่การเรียกระหว่าง Service)

## 5. Security Architecture

รายละเอียดกติกา: README **5.7**

| เรื่อง | การออกแบบ |
| :--- | :--- |
| Access Token | JWT RS256 อายุ 15 นาที ออกโดย Identity ด้วย Private Key; ทุก Service/Gateway ตรวจด้วย **Public Key** (โหลดจาก env หรือ JWKS endpoint ของ Identity) |
| Claims | `sub` (user_id), `role`, `company_id?`, `company_role?` (`OWNER`/`MEMBER`), `advisor_id?`, `university_id`, `iat`, `exp`, `jti` |
| Refresh Token | สุ่มค่าเก็บ Hash ใน `identity_db` ใช้ครั้งเดียว (Rotation) ตอนต่ออายุอ่านข้อมูลล่าสุดแล้วออก Claim ใหม่ |
| Denylist | Identity เผยแพร่รายการ `user_id` ที่ถูกระงับ; Gateway เก็บ Cache (in-memory + ดึงใหม่ทุก 30 วินาที หรืออัปเดตทันทีจาก Event `CompanyStatusChanged` / ผู้ใช้ถูกระงับ) |
| Service Token | JWT แยก (`typ: service`, `iss`, `aud`) ออกโดยแต่ละ Service ด้วย secret/คีย์ของตนเอง หรือใช้ shared secret ต่อคู่ Service ใน `.env` — Endpoint ภายในอยู่ใต้ prefix `/internal/**` และ **Gateway ไม่ Route `/internal/**` ออกสู่ภายนอก** |
| RBAC | ตรวจที่ทุก Service ด้วย `RolesGuard` จาก `libs/common` และตรวจความเป็นเจ้าของข้อมูลเสมอ (เช่น `company_id` ใน Token ต้องตรงกับทรัพยากร) — ไม่พึ่ง Gateway อย่างเดียว |
| Rate Limit | ที่ Gateway ตามตาราง README 5.7 (login, register, reset password, หน้าตรวจ E-Certificate ต่อ IP) |
| Password | argon2id |
| Secrets | `.env` / Secret ของที่ Deploy; มี `.env.example` ใน repo |
| File | อัปโหลดผ่าน Service เจ้าของข้อมูลเท่านั้น; Signed URL อายุ ~10 นาที (README 5.9) |

## 6. ข้อตกลงร่วมของทุก Service (Cross-cutting)

| หัวข้อ | ข้อตกลง |
| :--- | :--- |
| Base path | `/api/v1` ที่ Gateway (Service เองเสิร์ฟที่ `/v1` และ `/internal`) |
| Error format | ดู [api-contract.md](api-contract.md) §2 |
| Correlation ID | Header `X-Correlation-Id` สร้างที่ Gateway ถ้าไม่มี; ส่งต่อทุก Request และใส่ใน Event Envelope และ Log ทุกบรรทัด |
| Log | JSON (pino) ฟิลด์ขั้นต่ำ: `ts`, `level`, `service`, `correlation_id`, `msg` — ห้าม Log รหัสผ่าน Token เนื้อหาเรซูเม่ |
| เวลา | เก็บ UTC (`timestamptz`) แสดงผล/คำนวณ SLA ตาม `Asia/Bangkok` |
| ID | UUID v4 ทุกตาราง (ยกเว้นระบุ) |
| Config | ค่า SLA/เกณฑ์ทั้งหมดอยู่ใน config กลาง (`libs/common/config`) อ่านจาก env ได้ — ค่าเริ่มต้นตาม README 5.3, 5.1.4, 5.2.2 |
| Health | ทุก Service มี `GET /health` (liveness) และ `GET /ready` (เช็ก DB + Broker) |
| API Docs | OpenAPI สร้างจาก NestJS Swagger ที่ `/docs` (dev เท่านั้น); [api-contract.md](api-contract.md) เป็นสเปกที่ตกลงกันก่อนเขียนโค้ด |
| Testing | Mocha + Chai + Sinon + c8, `supertest` กับ Test DB ใน Docker (README 4.4, 6) |
| Migration | Prisma Migrate ใช้ connection string แบบ direct; รันจริงใช้ pooled (README 4.4) |

## 7. Background Jobs

| งาน | Service | ความถี่ | หมายเหตุ |
| :--- | :--- | :--- | :--- |
| Outbox Relay | ทุก Service ที่ Publish | ทุก 2 วินาทีเมื่อมีงาน / พักเมื่อไม่มี | อ่าน `outbox_events` ที่ `published_at IS NULL` → ส่ง RabbitMQ → mark |
| SLA Scheduler | Lifecycle | ทุก 15 นาที | เขียน `reminder_log` ก่อนส่ง (README 5.3) |
| Quota Reconciliation | Job | ทุก 30 นาที | README 5.8 |
| Verification Fail-safe | Job | ทุก 1 นาที | งาน `VERIFYING` เกิน 5 นาที → `PENDING_REVIEW` (`reason_code = VERIFY_TIMEOUT`) |
| Admin Queue OVERDUE | Verification | คำนวณตอนอ่านคิว (ไม่ต้องมี Job) | เปรียบ `due_at` กับเวลาปัจจุบัน |
| Token cleanup | Identity | รายวัน | ลบ Refresh/Email token หมดอายุ |

> ผู้รับผิดชอบ Fail-safe 5 นาทีคือ **Job Management** (เป็นเจ้าของสถานะประกาศ): ถ้าไม่ได้รับ `JobVerified` ภายใน 5 นาทีหลังส่ง `JobSubmitted` ให้ตั้งเป็น `PENDING_REVIEW` เอง แล้วส่ง `JobStatusChanged` (`reason_code = VERIFY_TIMEOUT`) ให้ Verification สร้างรายการในคิว Admin
> **Race:** ถ้าผลตรวจมาถึงหลัง Fail-safe แล้ว `JobVerified` จะถูก Job ข้าม (สถานะไม่ใช่ `VERIFYING`) แต่ Verification เก็บผลไว้ใน `evaluations` และแนบให้ Admin เห็นในรายการคิว

## 8. สภาพแวดล้อม

| Env | DB | Broker | Storage | Mail | NestJS รันที่ |
| :--- | :--- | :--- | :--- | :--- | :--- |
| dev (Docker Compose) | Postgres (1 container, DB ต่อ Service) | RabbitMQ | MinIO | Mailpit | เครื่องนักพัฒนา |
| test (CI) | Postgres (service container) | Mock / RabbitMQ container | Mock | — | GitHub Actions |
| deploy (demo) | Neon (pooled runtime / direct migrate) | CloudAMQP | Cloudflare R2 | Mailpit | **ยังไม่ตัดสินใจ** (Heroku หรือเครื่องทีม — README 4.4, 5.12) |

Docker Compose Profiles: `infra` (Postgres, RabbitMQ, MinIO, Mailpit) + `identity` `job` `verification` `lifecycle` `notification` `gateway` `web`

## 9. ประเด็นที่ยังเปิดอยู่ (Open Decisions)

| # | หัวข้อ | ผู้ตัดสินใจ | กำหนด |
| :-: | :--- | :--- | :--- |
| 1 | ที่รัน NestJS ตอน Deploy | ทีม (PM) | ต้นสัปดาห์ที่ 3 |
| 2 | JWT Public Key: ฝัง env หรือ JWKS endpoint | SA | สัปดาห์ที่ 1 |
| 3 | ค่าน้ำหนัก Risk Score และ Blacklist เริ่มต้น | PM | สัปดาห์ที่ 1 |
| 4 | แผนฟรีของ Neon ให้กี่โปรเจกต์ (1 โปรเจกต์/Service หรือแยก Schema) | SA | สัปดาห์ที่ 1 |
