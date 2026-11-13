# 🧭 Developer Guide — เพิ่ง clone มา แล้วจะทำต่ออย่างไร

คู่มือสำหรับคนที่เพิ่งเข้าโปรเจกต์และต้องเขียนโค้ดต่อ
ติดตั้ง/รันโปรเจกต์ดูที่ [getting-started.md](getting-started.md) — ไฟล์นี้เน้น **อ่านอะไร ทำงานตรงไหน เพิ่มของใหม่อย่างไร**

---

## 1. เริ่มจากตรงนี้ (30 นาทีแรก)

1. ทำตาม [getting-started.md](getting-started.md) จนรัน `pnpm test` ผ่านและ `pnpm --filter @internpath/<service> start:dev` ได้
2. อ่านเอกสารตามลำดับนี้

| ลำดับ | ไฟล์ | อ่านเพื่อ |
| :-: | :--- | :--- |
| 1 | [README.md](../README.md) หัวข้อ 1–5 | เข้าใจปัญหา, บทบาทผู้ใช้, กฎธุรกิจ (กฎธุรกิจทั้งหมดอยู่ที่นี่) |
| 2 | [architecture.md](architecture.md) | Service ไหนทำอะไร, สื่อสารกันอย่างไร, Security |
| 3 | [data-schema.md](data-schema.md) | ตาราง/Enum ของ Service ที่คุณรับผิดชอบ + **State Machine** |
| 4 | [api-contract.md](api-contract.md) | Endpoint ที่ต้องเขียน (ของ Service คุณ) |
| 5 | [event-contract.md](event-contract.md) | Event ที่ Service คุณส่ง/รับ |

> อ่านเฉพาะหัวข้อของ Service ตัวเองก่อนก็พอ แล้วค่อยอ่านส่วนที่ต้องคุยกับ Service อื่น

## 2. ใครดูแล Service ไหน

| Service | โฟลเดอร์ | เจ้าของ | Port |
| :--- | :--- | :--- | :---: |
| Gateway | `apps/gateway` | SA | 3000 |
| Identity & Organization | `apps/identity` | SA | 3001 |
| Job Management | `apps/job` | Junior Developer | 3002 |
| Verification & Trust | `apps/verification` | PM | 3003 |
| Student Experience & Lifecycle | `apps/lifecycle` | Tester | 3004 |
| Notification | `apps/notification` | Junior Developer | 3005 |
| Web (Next.js) | `apps/web` | ทุกคน แยกหน้าตาม Role | 3100 |

ถ้าต้องแก้ Service ของคนอื่น ให้เปิด PR แล้วให้เจ้าของรีวิว (รายละเอียดทีมดู README หัวข้อ 11)

## 3. โครงภายในของแต่ละ Service

```text
apps/<service>/
├─ src/
│  ├─ main.ts            จุดเริ่ม (เรียก bootstrapService — ไม่ต้องแก้)
│  ├─ app.module.ts      รวม module ทั้งหมดของ Service
│  ├─ modules/<feature>/ โค้ดแต่ละฟีเจอร์ (controller, service, dto)   ← ทำงานหลักที่นี่
│  ├─ events/consumers/  ตัวรับ Event จาก RabbitMQ
│  ├─ events/producers/  ตัวส่ง Event (เขียนลง outbox เท่านั้น)
│  ├─ outbox/            Outbox relay (อ่าน outbox_events ไปส่ง RabbitMQ)
│  ├─ internal/          Endpoint ภายใน /internal/** (ให้ Service อื่นเรียก)
│  ├─ jobs/              งานตั้งเวลา (Scheduler) — เฉพาะ identity/job/lifecycle
│  └─ config/            ค่า config เฉพาะ Service
├─ prisma/
│  ├─ schema.prisma      ตารางของ Service นี้
│  └─ migrations/
└─ test/{unit,integration}/
```

โค้ดที่ **ทุก Service ใช้ร่วมกัน** อยู่ใน `libs/` เท่านั้น:

| แพ็กเกจ | มีอะไร |
| :--- | :--- |
| `@internpath/common` | `AppException`, `JwtAuthGuard`, `RolesGuard`, `@Roles()`, `@Public()`, `@CurrentUser()`, `HealthModule`, `configureApp`, Logging |
| `@internpath/contracts` | ชนิดข้อมูลของ Event (`EventEnvelope`) และ DTO ที่แชร์ — **เฉพาะ TypeScript types** |

> แก้โค้ดใน `libs/*` แล้วต้อง build ก่อนแอปถึงจะเห็น: `pnpm --filter "./libs/*" build`

## 4. กฎที่ห้ามฝ่าฝืน

1. **ห้าม import โค้ดข้าม Service** (`apps/a` import จาก `apps/b`) — แชร์ได้เฉพาะ `libs/*`
2. **ห้ามอ่านตารางข้าม Service และห้ามมี Foreign Key ข้ามฐานข้อมูล** — อ้างอิงด้วย ID เท่านั้น ถ้าต้องการข้อมูลของ Service อื่นให้ใช้ Event (เก็บสำเนา) หรือ Internal API
3. **แก้เอกสารก่อนหรือพร้อมโค้ด** — ถ้าเปลี่ยน endpoint/ตาราง/event ต้องอัปเดตไฟล์ใน `docs/` ใน PR เดียวกัน
4. **การเปลี่ยนสถานะ** ต้องทำใน Transaction เดียวกับ: เขียน `status_history` + เขียน `outbox_events` และใช้ `updateMany({ where: { id, status: <สถานะเดิม> } })` ตรวจจำนวนแถว (ถ้า 0 → `409 STATE_CONFLICT`)
5. **ห้ามใส่ข้อมูลส่วนบุคคลใน Event** (ใส่แค่ `user_id`) และห้าม Log รหัสผ่าน/Token/เนื้อหาเรซูเม่
6. **ห้าม commit** `.env`, คีย์ JWT, รหัสผ่านจริง (มีแค่ `.env.example`)
7. ตรวจสิทธิ์ที่ **ทุก Service** ด้วย Guard (อย่าพึ่ง Gateway อย่างเดียว) และตรวจความเป็นเจ้าของข้อมูล เช่น `company_id` ใน Token ต้องตรงกับทรัพยากร
8. **Contract ล็อกแล้ว — ใช้ชนิดข้อมูลจาก `@internpath/contracts` เท่านั้น** (Event E01-E18 ทุกตัวและ Enum ใน `data-schema.md` §2.1 อยู่ใน `libs/contracts/src/`) ห้ามประกาศ payload/enum ซ้ำในแอป การเปลี่ยนชื่อ/ชนิด/ความหมายของฟิลด์หรือค่า Enum ต้องบอกใน PR (ติดป้าย "contract change"), แก้ `docs/` และ `libs/contracts` พร้อมกัน และให้ PM อนุมัติ — เพิ่มฟิลด์ที่ไม่บังคับ (`?`) ได้โดยไม่ต้องรออนุมัติ แต่ต้องบอกใน PR

## 5. Workflow การทำงาน

```text
git switch -c feature/<service>-<สั้นๆ>   # แตก branch จาก main
… เขียนโค้ด + เทสต์ + อัปเดต docs …
pnpm lint && pnpm test                      # ต้องผ่านก่อน push
git push -u origin <branch>                 # เปิด Pull Request
```

- CI (GitHub Actions) รัน lint → test → build เฉพาะแพ็กเกจที่เปลี่ยน
- ชื่อ commit สั้นๆ บอกว่าทำอะไร ใน Service ไหน เช่น `identity: add student registration`
- ทุก PR ต้องมีเทสต์ของสิ่งที่เพิ่ม โดยเฉพาะ State Machine, โควตา (รวมกรณียิงพร้อมกัน), Idempotency ของ Consumer, Risk Score (README หัวข้อ 6)

## 6. สูตรงานที่ต้องทำบ่อย

### 6.1 เพิ่ม Endpoint ใหม่
1. หา endpoint ใน [api-contract.md](api-contract.md) (สัญญา: path, Role, error code)
2. สร้าง `src/modules/<feature>/` ประกอบด้วย controller / service / dto แล้วใส่เข้า `imports` ของ `app.module.ts`
3. ใช้ `class-validator` ใน DTO (ระบบแปลง error เป็นรูปแบบมาตรฐานให้เอง)
4. โยน error ด้วย `throw new AppException('QUOTA_FULL', 'โควตาตำแหน่งเต็มแล้ว', 409)` — `code` ต้องตรงกับในเอกสาร
5. ใส่ Guard ที่ controller:

```ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, JwtClaims, Roles, RolesGuard } from '@internpath/common';

@Controller('hr/jobs')                       // ระบบใส่ prefix /v1 ให้อัตโนมัติ
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('COMPANY_HR')
export class HrJobsController {
  @Get()
  list(@CurrentUser() user: JwtClaims) {
    // ใช้ user.company_id กรองข้อมูลเสมอ
  }
}
```
> `JwtAuthGuard` ต้องมี `JWT_PUBLIC_KEY` ใน `.env` (สร้างด้วย `pnpm keys:generate`) • Endpoint ภายในให้อยู่ใต้ `/internal/**` (ไม่ผ่าน Gateway)

6. เขียนเทสต์ใน `test/integration/` (ดูตัวอย่างโครงที่ `test/health.spec.ts`: สร้างแอปด้วย `Test.createTestingModule` + `configureApp(app)` + `supertest`)

### 6.2 เพิ่ม/แก้ตารางฐานข้อมูล
1. ดูโครงตารางของ Service คุณใน [data-schema.md](data-schema.md) แล้วเพิ่ม `model` ใน `prisma/schema.prisma` (ใช้ `@map("snake_case")` ให้ชื่อคอลัมน์ตรงเอกสาร)
2. เปิด infra: `pnpm infra:up`
3. สร้าง migration:
```bash
cd apps/<service>
# Prisma CLI ไม่อ่าน .env ที่ราก repo — ตั้งตัวแปรในเชลล์ หรือคัดลอกบรรทัดของ Service นี้ไปไว้ใน apps/<service>/.env (ถูก gitignore)
npx prisma migrate dev --name <ชื่อการเปลี่ยนแปลง>
```
4. Commit โฟลเดอร์ `prisma/migrations/` ด้วย
5. รัน `pnpm --filter @internpath/<service> prisma:generate` เมื่อ schema เปลี่ยน
> ลองรันจริงแล้วกับ `apps/verification` (2026-11-13): `prisma migrate dev --name init --create-only` ได้ migration แรก แล้วเพิ่ม **SQL มือต่อท้ายไฟล์** สำหรับสิ่งที่ Prisma ไม่รองรับ (partial unique index, trigger append-only ของ `status_history`/`admin_audit_log`) — `prisma migrate diff --from-migrations … --to-schema-datamodel …` รายงาน "No difference" จึงไม่ต้องกลัว drift แต่ห้ามลบ SQL มือเมื่อสร้าง migration ใหม่
> - ค่าตั้งต้น (seed) ใส่ใน migration แยก (`*_seed_defaults`) แบบ `INSERT … ON CONFLICT DO NOTHING` เพื่อไม่ทับค่าที่ Admin แก้
> - เทสต์ที่ต้องใช้ DB สร้างฐาน `ver_it_<hex>` ใหม่ต่อรอบ แล้วรัน `prisma migrate deploy` (ดู `apps/verification/test/support/db.ts`) และลบทิ้งตอนจบ
> - เทสต์พื้นฐานตั้ง `DISABLE_INFRA=true` ใน `test/setup.ts` ให้ `AppModule` ไม่โหลดส่วนที่ต้องใช้ DB/RabbitMQ (CI จึงไม่ต้องมี infra)

### 6.3 เพิ่ม Event ใหม่ / ส่ง-รับ Event
ทำตามรายการใน [event-contract.md](event-contract.md) §7:
1. เพิ่มแถวและ Payload ในเอกสาร
2. เพิ่ม type ใน `libs/contracts/src/events/` (ใช้ `EventEnvelope<'ชื่อEvent', Payload>`)
3. **ผู้ส่ง:** เรียก `OutboxWriter.add(tx, …)` ภายใน `$transaction` เดียวกับการเปลี่ยนข้อมูล (ห้ามส่ง RabbitMQ ตรงๆ) — relay ของ `libs/common` ส่งให้เอง
   ```ts
   // AppModule: MessagingModule.register({ service: 'job', publishes: { databaseUrlEnv: 'JOB_DIRECT_URL' } })
   await this.prisma.$transaction(async (tx) => {
     const job = await tx.job.update({ /* … */ });
     await this.outbox.add(tx, { type: 'JobSubmitted', aggregateId: job.id, correlationId, payload });
   });
   ```
   `correlationId` ที่ไม่ใช่ UUID จะถูกแทนด้วย UUID ใหม่ (คอลัมน์เป็น `uuid`)
4. **ผู้รับ:** ลงทะเบียน handler กับ `EventConsumer` — lib จัดการ `processed_events` (กันซ้ำด้วย `event_id`), manual ack, retry 3 ครั้ง (5 วินาที / 30 วินาที / 2 นาที) แล้วเข้า DLQ ให้เอง; handler ต้อง **ทำงานกับ `tx` ที่ได้รับเท่านั้น** และ **throw เมื่อล้มเหลว** (Transaction จะ rollback แล้วลองใหม่) ส่วนการเทียบ `entity_version` ถ้าเป็นสถานะเป็นหน้าที่ของ handler
   ```ts
   // AppModule: PrismaService เป็น provider ที่ฉีดผ่าน DI จึงต้องใช้รูปแบบ { inject, useFactory } (และ imports โมดูลของมัน)
   MessagingModule.register({
     service: 'job',
     imports: [PrismaModule],
     consumes: {
       inject: [PrismaService],
       useFactory: (prisma: PrismaService) => ({ runInTransaction: (fn) => prisma.$transaction(fn) }),
     },
   })
   // ใน provider ของ Service (inject EventConsumer):
   await consumer.subscribe({
     producer: 'verification', type: 'JobVerified',   // supportedVersions เริ่มต้น [1]
     handler: async (envelope, tx) => { /* เขียนผลด้วย tx */ },
   });
   ```
   ตั้ง `RABBITMQ_URL` (ใน dev ชี้ RabbitMQ ใน Docker; ตอนสาธิตชี้ CloudAMQP โดยไม่ต้องแก้โค้ด) และ `<PREFIX>_DIRECT_URL` ของ Service ที่ publish

   ข้อควรรู้:
   - **Event จะไปถึงผู้รับก็ต่อเมื่อคิวของผู้รับถูกประกาศแล้ว** (ผู้รับประกาศคิวตอน `subscribe`) ผู้ส่งไม่ใช้ `mandatory` จึงไม่รู้ว่าไม่มีคิว: ข้อความที่ส่งก่อนที่ Service ผู้รับเคยรันจะหายเงียบ ตอน dev/สาธิตให้รันผู้รับให้ครบก่อนสร้างข้อมูล
   - log ของ lib ไม่ใส่ข้อความ error ของ handler (Prisma ฝังค่าใน query ไว้ในข้อความ) มีแค่ชื่อ/รหัส; ถ้าต้องดูรายละเอียดให้ log ใน handler เองโดยระวังข้อมูลอ่อนไหว (`ReviewSubmitted`)
   - `onDeadLetter` เป็น hook เสริม (log ระดับ `error` ทำเสมออยู่แล้ว); hook ที่ throw จะถูก log และไม่กระทบการเข้า DLQ
5. อัปเดตคอลัมน์ Consume/Publish ใน [architecture.md](architecture.md) §2

### 6.4 เรียก Service อื่น
- ต้องการ **ข้อมูลที่เปลี่ยนไม่บ่อย** (ชื่อบริษัท, สิทธิ์) → รับ Event แล้วเก็บ Snapshot ในตารางของตัวเอง
- ต้องการ **คำตอบทันที/ต้อง Atomic** (เช่น จองโควตา) → เรียก Internal API ตาม [api-contract.md](api-contract.md) §9 (timeout 3 วินาที, retry 2 ครั้ง, ห้ามเรียกวนกลับ)

## 7. ยังไม่มีอะไรบ้าง (รู้ไว้จะได้ไม่งง)

โครงตอนนี้ **รันได้และทดสอบผ่าน แต่ยังไม่มีโค้ดธุรกิจ** สิ่งที่ยังต้องสร้าง:

- [ ] Prisma migration แรกของทุก Service และตารางเฉพาะ Service — **Verification ทำแล้ว (สไลซ์ 1 และ 2: รายงานประกาศ, ตัวนับ/ระงับอัตโนมัติ, ธง `UNDER_REVIEW`; ค่า env `REPORT_THRESHOLD`, `REPORT_DAILY_LIMIT`, `REPORTER_DISMISS_STREAK`, `REJECTION_THRESHOLD`, `REJECTION_WINDOW_DAYS` ใน `.env.example`)**; Service อื่นยังมีแค่ `outbox_events` / `processed_events`
- [x] Outbox relay และ Consumer — อยู่ใน `libs/common` (`OutboxWriter`, `OutboxRelay`, `EventConsumer`, `MessagingModule`); เหลือให้แต่ละ Service เรียกใช้ตาม §6.3 (โฟลเดอร์ `outbox/`, `events/` ของแต่ละ Service ยังว่าง)
- [ ] Service Token สำหรับ `/internal/**` และ allow-list ผู้เรียก
- [ ] Gateway: การ Route/Proxy, ตรวจ Token, Rate Limit, Denylist (ตอนนี้มีแค่ health)
- [ ] การลงทะเบียน `JwtAuthGuard` เป็น Guard ของแต่ละ Service (ตอนนี้เป็น class ให้ใช้ต่อ controller)
- [ ] Scheduler (SLA, Reconciliation โควตา, Fail-safe 5 นาที)
- [ ] หน้าเว็บของแต่ละ Role (มีแค่หน้าแรกและ Tailwind theme)
- [ ] Dockerfile ของ Service ยังไม่เคยรัน; `docker compose --profile infra up -d postgres rabbitmq mailpit` รันผ่านแล้ว (2026-11-13) แต่ **MinIO ดึง image ไม่ได้** (`minio/minio` บน Docker Hub ใช้ไม่ได้ และ `quay.io/minio/minio` ตอบ 401) ต้องเปลี่ยนไปใช้ตัวแทนที่รองรับ S3
- [ ] การสาธิตผ่าน Cloudflare ([architecture.md](architecture.md) §8.1): Worker proxy `/api/*` + `API_ORIGIN`, ตรวจ `X-Edge-Secret` / CORS / IP ผู้ใช้ที่ Gateway, ข้อความ "ระบบหลังบ้านออฟไลน์" ใน Front, ลิงก์อีเมลจาก `WEB_BASE_URL`
- [x] `docker-compose.yml`: Postgres / RabbitMQ / MinIO bind เฉพาะ `127.0.0.1` และมี `restart: unless-stopped`
- [x] Retry queue ร่วมต่อ Service (3 คิวต่อ Service) เพื่ออยู่ในเพดาน queue ของ CloudAMQP แผนฟรี ([event-contract.md](event-contract.md) §3.3) — ยังต้องตรวจตัวเลขเพดานจริงกับ CloudAMQP (ดู [architecture.md](architecture.md) §8.1)

เลือกงานจาก Work Plan ใน README หัวข้อ 9 ตามสัปดาห์ แล้วตรวจกับ Open Decisions ท้าย [architecture.md](architecture.md) ก่อนเริ่ม

## 8. แก้ปัญหาเบื้องต้น

| อาการ | สาเหตุ / วิธีแก้ |
| :--- | :--- |
| `Cannot find module '@internpath/common'` | libs ยังไม่ถูก build → `pnpm --filter "./libs/*" build` |
| แก้ `libs/common` แล้วแอปไม่เปลี่ยน | ลืม build libs (ดูข้างบน) แล้วรัน Service ใหม่ |
| `/ready` ตอบ 503 | ยังไม่ได้รัน `pnpm infra:up` หรือรหัสผ่านใน `.env` ไม่ตรงกับ Postgres/RabbitMQ — `/health` ยังตอบ 200 ได้ปกติ |
| `Environment variable not found: *_DATABASE_URL` (Prisma) | Prisma ไม่อ่าน `.env` ที่ราก — ตั้งตัวแปรในเชลล์ หรือสร้าง `apps/<service>/.env` |
| Port ชน (`EADDRINUSE`) | ตั้ง `PORT=xxxx` ก่อนรัน หรือปิดโปรเซสเดิม |
| `docker` ใช้ไม่ได้บน Windows | เปิด WSL2: PowerShell (Administrator) `wsl --install --no-distribution` แล้วรีสตาร์ต |
| ต่อ Postgres/RabbitMQ ช้า (~2 วินาทีต่อการเชื่อมต่อ) หรือ Prisma ขึ้น `Unable to start a transaction in the given time` | `docker-compose.yml` bind พอร์ตเฉพาะ `127.0.0.1` แต่ `localhost` บน Windows ถูกแปลงเป็น IPv6 (`::1`) ก่อน จึงต้องรอ timeout ก่อนถอยมา IPv4 → ใช้ `127.0.0.1` ใน `.env` (`.env.example` ปรับแล้ว; ถ้าคัดลอก `.env` ไว้ก่อนหน้า ให้แทน `localhost` เป็น `127.0.0.1` ใน URL ของ Postgres/RabbitMQ/MinIO) |
| `Prisma Client did not initialize yet` / import `@prisma/client` ไม่ได้ | ยังไม่ได้ generate → `pnpm --filter @internpath/<service> prisma:generate` (CI รันขั้นนี้ก่อน lint/test/build ให้แล้ว) |
| Prisma ขึ้น error แปลกหลังอัปเกรด | โปรเจกต์ล็อก Prisma ไว้ที่ 6.x อย่าอัปเป็น 7+ โดยไม่ย้าย config ก่อน |
| `pnpm install` แล้ว `prepare` ล้ม | ดู error ของ `tsc` ใน `libs/*`; ตรวจว่าใช้ TypeScript 5.6 (ล็อกด้วย `pnpm.overrides`) |
