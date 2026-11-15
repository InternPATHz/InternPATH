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

### 1.1 ตั้งค่า JWT และ Service secret ก่อนเปิด Gateway

หลังคัดลอก `.env.example` เป็น `.env` ให้สร้างคู่คีย์ RS256 จากราก repo:

```bash
pnpm keys:generate
```

คัดลอกบรรทัด `JWT_PRIVATE_KEY` และ `JWT_PUBLIC_KEY` ที่พิมพ์ออกมาใส่ `.env` ตามเดิม รวมทั้งเครื่องหมายอัญประกาศและ `\n` ในค่า Private Key เมื่อแยก deploy ให้ Identity ถือ Private Key และให้ Gateway/Service ที่ตรวจ access token ถือ Public Key

สร้าง secret แบบสุ่ม 32 ไบต์ (ผลลัพธ์เป็น hex 64 ตัวอักษร) ด้วยคำสั่งนี้หนึ่งครั้งต่อ Service ผู้เรียก:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

ใส่ค่าที่สร้างลง `IDENTITY_SERVICE_SECRET_GATEWAY` ใน `.env` ของ Gateway **และ** Identity ให้ตรงกัน และสร้างค่าใหม่แยกสำหรับ `IDENTITY_SERVICE_SECRET_NOTIFICATION` กับ `IDENTITY_SERVICE_SECRET_LIFECYCLE` เมื่อใช้ Service เหล่านั้น หากเปิด Gateway โดยไม่ตั้ง `IDENTITY_SERVICE_SECRET_GATEWAY` หรือค่าสั้นกว่า 32 ตัวอักษร Gateway จะ log ชื่อตัวแปรและไม่เริ่มรับคำขอ เก็บ `.env` และ Private Key ไว้นอก Git เสมอ

### 1.2 Gateway หลัง proxy

เมื่อวาง Gateway หลัง proxy ให้ตั้ง `EDGE_SHARED_SECRET` เป็นค่าเดียวกันที่ proxy และ Gateway แล้วให้ proxy ส่ง `X-Edge-Secret` พร้อม `x-client-ip` ซึ่งเป็น IP ผู้ใช้จริง โดย proxy ต้องเขียนทับ header ทั้งสองจากคำขอภายนอก และปิดการเข้าถึง Gateway โดยตรงจากอินเทอร์เน็ต

เมื่อกำหนด `EDGE_SHARED_SECRET` แล้ว คำขอที่ไม่มี `X-Edge-Secret` ที่ถูกต้องจะถูกปฏิเสธ (401) สำหรับคำขอที่ผ่าน Gateway จะใช้ `x-client-ip` เมื่อเป็น IP ที่ถูกต้อง หาก proxy ไม่ส่ง `x-client-ip` หรือส่งรูปแบบผิด Gateway จะใช้ IP ของการเชื่อมต่อกับ Gateway ทำให้ผู้ใช้ทุกคนหลัง proxy ใช้ rate limit bucket เดียวกัน

Rate limiter ปัจจุบันเก็บ bucket แบบ LRU ในหน่วยความจำของ Gateway แต่ละ instance หาก deploy หลาย instance และต้องการจำกัดอัตราร่วมกัน ให้ย้าย bucket ไป shared storage

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
9. **ทุก Service ที่ใช้ Prisma ต้องตั้ง `output = "../generated/client"` ใน `generator client` ของ `schema.prisma`** และ import `PrismaClient`/ชนิดจาก `../../generated/client` (ไม่ใช่ `@prisma/client`) — output ค่าตั้งต้นเป็นที่เดียวกันของทุก Service ทำให้ Client เขียนทับกันตอน generate ทั้ง repo ใน CI (`apps/*/generated/` ถูก gitignore) มีเทสต์ตรวจใน `libs/common/test/repo/prisma-outputs.spec.ts` (ยอมให้ใช้ค่าตั้งต้นได้ไม่เกิน 1 Service ระหว่างที่ Service นั้นยังไม่ได้ย้าย — ปัจจุบันคือ `job`)
10. **ส่ง E03 ทุกการเปลี่ยนสถานะประกาศ** พร้อม `company_id` และ `entity_version` ที่เพิ่มขึ้น (รวมทุกแถวที่เข้า `VERIFYING` ซึ่งส่งคู่กับ `JobSubmitted`) และตรวจ `submission_id === current_submission_id` ก่อนรับ `JobVerified` — รายละเอียดใน [data-schema.md](data-schema.md) §8.2

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

สำหรับ endpoint ภายในของ Job/Lifecycle/Notification ให้นำ `ServiceTokenGuard`, `ServiceTokenPolicy` และ `InternalCallers` จาก `@internpath/common` ไปใช้ตามตัวอย่างใน `apps/identity/src/internal/internal.controller.ts` และลงทะเบียน guard ใน `providers` ของ module โดยกำหนด `audience` เป็นชื่อ Service ที่รับคำขอ และแมปชื่อผู้เรียกกับ env ของ secret แยกแต่ละคู่ ฝั่งที่เรียกใช้ `signServiceToken({ issuer, audience, secret })` จาก `@internpath/common` (ตัวอย่างจริงอยู่ที่ Gateway denylist) แล้วส่งผลลัพธ์ใน `Authorization: Bearer <token>`

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
> `apps/identity` (2026-11-14): migration แรกสร้างจาก schema ด้วย `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script` แล้วเพิ่ม `citext` ก่อนตาราง, partial unique index ของ Owner และ trigger append-only ด้วย SQL มือ; `test/db/schema.spec.ts` สร้างฐาน `id_it_<hex>` ใหม่แล้ว `migrate deploy` เพื่อตรวจ migration จริงก่อนลบฐานทิ้ง
> Prisma Client ของ Identity generate ไปที่ `apps/identity/generated/client` (gitignore) และ CI generate ทั้ง Identity/Verification ก่อนตรวจ เพราะ output เริ่มต้นของ `@prisma/client` เป็นตำแหน่งร่วมที่ Service หนึ่งจะเขียนทับอีก Service; Service ถัดไปที่เพิ่ม Prisma ต้องกำหนด output ของตัวเองด้วย
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

โครงตอนนี้รันได้และทดสอบผ่านบาง Service แล้ว ส่วนที่ยังต้องทำหรือเชื่อมต่อมีดังนี้:

- [ ] Prisma migration แรกของทุก Service และตารางเฉพาะ Service — **Verification และ Identity ทำแล้ว**; Job, Lifecycle และ Notification ยังมีแค่ `outbox_events` / `processed_events`
- [x] Outbox relay และ Consumer — อยู่ใน `libs/common` (`OutboxWriter`, `OutboxRelay`, `EventConsumer`, `MessagingModule`); แต่ละ Service ต้องผูกกับงานของตนตาม §6.3
- [ ] Service Token สำหรับ `/internal/**` และ allow-list ผู้เรียก — Identity ใช้ `ServiceTokenGuard` จาก `libs/common` แล้ว; Job/Lifecycle/Notification ยังต้องผูกเมื่อเพิ่ม endpoint ภายใน
- [x] Gateway: การ Route/Proxy, ตรวจ Token, Rate Limit, Denylist
- [ ] การลงทะเบียน `JwtAuthGuard` ใน Service ที่เพิ่ม endpoint ซึ่งต้องล็อกอิน (Identity ใช้แล้ว)
- [ ] **ลบบัญชียังใช้ไม่ได้**: `POST /users/me/deletion-request` มีใน [api-contract.md](api-contract.md) §4.2 แต่ยังไม่มี endpoint จริง; ไม่มี production path ที่เรียก `AccountDeletionService.complete()` และตัวตรวจสิทธิ์ลบตั้งให้ fail-closed ระหว่างรอ Lifecycle Internal API จึงไม่ควรแสดงฟังก์ชันลบบัญชีให้ผู้ใช้ใช้งาน
- [ ] Scheduler (SLA, Reconciliation โควตา, Fail-safe 5 นาที)
- [ ] หน้าเว็บของแต่ละ Role (หน้า Auth/Account มีแล้ว)
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
| `Prisma Client did not initialize yet` / `Cannot find module '../../generated/client'` | ยังไม่ได้ generate → `pnpm --filter @internpath/<service> prisma:generate` หรือทั้งหมด `pnpm --filter "./apps/*" --if-present prisma:generate` (CI รันขั้นนี้ก่อน lint/test/build ให้แล้ว); Client ของแต่ละ Service อยู่ที่ `apps/<service>/generated/client` ดูกฎข้อ 9 |
| Event ที่ส่งแล้วไม่ถึงผู้รับ / `/ready` ผ่านแต่ผู้รับไม่ได้ข้อความ | ยังไม่มีคิวของผู้รับ (ผู้ส่งเผยแพร่ก่อนผู้รับเคยเปิด) → รัน `pnpm infra:topology` หลัง `pnpm infra:up` ทุกครั้งที่ตั้ง RabbitMQ ใหม่ |
| เทสต์ที่ใช้ Postgres/RabbitMQ ขึ้น pending หมด | Docker ยังไม่รัน → เปิด Docker Desktop แล้ว `pnpm infra:up` (Mocha ข้ามเทสต์เหล่านี้เองเมื่อต่อไม่ได้ ผลจึงเป็น pending ไม่ใช่ fail) |
| Prisma ขึ้น error แปลกหลังอัปเกรด | โปรเจกต์ล็อก Prisma ไว้ที่ 6.x อย่าอัปเป็น 7+ โดยไม่ย้าย config ก่อน |
| `pnpm install` แล้ว `prepare` ล้ม | ดู error ของ `tsc` ใน `libs/*`; ตรวจว่าใช้ TypeScript 5.6 (ล็อกด้วย `pnpm.overrides`) |

## 9. สิ่งที่ต้องทำตามหลัง merge (บันทึกรายครั้ง)

### 9.1 หลัง merge การตัดสินใจของ PM และการแยก Prisma output (2026-11-15)

**ทุกคนทำหลัง `git pull` main (ตามลำดับ):**
1. `pnpm install` (ถ้าเจอ `Cannot find module 'pg'` ใน Identity คือยังไม่ได้ทำขั้นนี้)
2. `pnpm --filter "./apps/*" --if-present prisma:generate` — Prisma Client ย้ายไป `apps/<service>/generated/client` (ไม่ commit) ไม่ใช่ `@prisma/client` แล้ว (กฎข้อ 9 ข้างบน)
3. `pnpm --filter "./libs/*" build`
4. `pnpm infra:up` แล้วรัน **`pnpm infra:topology` หนึ่งครั้ง** เพื่อสร้างคิวผู้รับ Event ครบทุก Service ล่วงหน้า (32 คิว + DLQ + retry queue; รันซ้ำได้) — ไม่เช่นนั้น Event ที่ Service หนึ่งส่งก่อนที่ผู้รับจะเคยเปิดจะหาย
5. ใครเริ่มใช้ Prisma ใน Service ใหม่ ต้องตั้ง `output = "../generated/client"` และ import จาก `../../generated/client` (ดูตัวอย่าง `apps/verification`) — เทสต์ใน `libs/common/test/repo/prisma-outputs.spec.ts` จะล้มถ้ามี Service ที่ใช้ค่าตั้งต้นเกิน 1 ตัว

**Junior (Job และ Notification):**
- **Job schema:** ตั้ง `output = "../generated/client"` + import จาก `../../generated/client` (ตอนนี้ Job เป็น Service เดียวที่ยังใช้ค่าตั้งต้นได้)
- **ส่ง `JobStatusChanged` ทุกการเปลี่ยนสถานะ** รวมทุกแถวที่เข้า `VERIFYING` (ส่งคู่กับ `JobSubmitted` ใน transaction เดียว ส่ง `JobStatusChanged` ก่อน) พร้อม `company_id` และ `entity_version` ที่เพิ่มขึ้น; `application_effect`: `PUBLISHED → VERIFYING` = `FREEZE` อื่นๆ = `NONE` — ตาราง [data-schema.md](data-schema.md) §8.2
- **รับ `JobVerified` เฉพาะที่ `submission_id = current_submission_id` และสถานะตรงกับที่คาดไว้** ทั้งสองเงื่อนไข
- **`CLOSED → SUSPENDED`:** เมื่อรับ `ReportThresholdReached` จาก `CLOSED` ให้ระงับด้วย เก็บ `jobs.suspended_from_status`; `RESTORE` คืนสถานะเดิม (ถ้าเลย `application_deadline` ระหว่างระงับ ให้กลับเป็น `CLOSED`); `REMOVE` เป็น `REMOVED`
- **บริษัทถูกระงับ (`CompanyStatusChanged = SUSPENDED`):** ไม่เปลี่ยน `jobs.status` ให้ซ่อนและปิดรับสมัครด้วยเงื่อนไข "ประกาศ `PUBLISHED` **และ** บริษัท `VERIFIED`" จาก `company_snapshots` ([data-schema.md](data-schema.md) §8.2.2)
- **ตาราง `jobs` ใน migration แรก:** ฟิลด์เนื้อหา nullable + `CHECK (status = 'DRAFT' OR ฟิลด์บังคับครบ)`, `quota_reservations.reserved_at NOT NULL` ส่วน `confirmed_at`/`released_at` nullable, **ไม่ต้องมี `admin_audit_log`**, ค้นข้อความ (`pg_trgm`) แยกเป็น migration ภายหลัง
- **Notification:** ทำตาม Recipient Matrix ของ E08 ([event-contract.md](event-contract.md) §6.1 — **ยืนยันแล้ว (PM) v2**) และนโยบายอีเมล (เขียน `delivery_logs` สถานะ `PENDING` ก่อนส่ง; retry หลังล้มให้ส่งซ้ำได้); แจ้งผู้ใช้เมื่อรีวิวถูก `HOLD`/`ADMIN_REMOVE` จาก `student_user_id` ใน E10 ไม่ต้องหาเจ้าของรีวิวเอง

**SA (Identity และ Gateway):**
- **Gateway:** เพิ่ม route `/admin/audit` → Verification และเทสต์ Routing ตามตารางใน [api-contract.md](api-contract.md) §3 (เพิ่มแถวนี้ในเอกสารแล้ว — ตรวจใน branch Gateway ของ SA ว่ามี route และเทสต์ตามแล้วหรือยัง)
- **Anonymization:** trigger append-only ของ `status_history`/`admin_audit_log` ต้องยอมให้แก้เฉพาะ `actor_id`/`admin_id` ใน transaction ที่ตั้ง `internpath.anonymize` และ `internpath.anonymous_actor_id` ([data-schema.md](data-schema.md) §2.3) — Identity (`20261115120000_authorized_history_anonymization`) และ Verification (`20261115130000_authorized_history_anonymization` + handler `UserAnonymizationService`) ทำแล้ว ส่วน Service อื่นที่มีสองตารางนี้ (Job, Lifecycle) ต้องเพิ่ม migration แบบเดียวกัน พร้อมเทสต์ทั้งกรณีที่ผ่านและกรณีที่ต้องถูกปฏิเสธ และ handler ของ `UserDeletionRequested`
- **Identity:** Public Key ใช้ `JWT_PUBLIC_KEY` จาก env (ตัดสินแล้ว) และ SA ใช้ชนิด `AuthUser`/`UserMeResponse` ใน `libs/contracts` ได้

**Tester (Lifecycle):**
- ตรวจ Recipient Matrix ของ E08 v2 (PM ยืนยันแล้ว — [event-contract.md](event-contract.md) §6.1) ถ้ามีเหตุผลด้านโดเมนที่ต้องแก้ ให้แก้ตารางในเอกสารและแจ้งเจ้าของ Notification
- **บริษัทถูกระงับ:** Freeze ตัวนับ SLA ของใบสมัครที่ยังไม่ `IN_PROGRESS` ขณะบริษัทถูกระงับ และ Unfreeze เมื่อกลับเป็น `VERIFIED`; `IN_PROGRESS` ให้อาจารย์ตัดสินต่อ ([data-schema.md](data-schema.md) §8.2.2)
- **รีวิว (E09):** payload ต้องมี `student_user_id`; รับ `ReviewModerationResult` (E10) ที่มี `student_user_id` กลับมา — **กติกาสไลซ์ 3 (event-contract §E10):** `ADMIN_REMOVE` ต้องรับได้จาก `PUBLISHED` ด้วย (เปลี่ยนเป็น `REMOVED` แล้วส่ง `ReviewPublished` ใหม่ให้ตัวนับคะแนนตรง), `ADMIN_PUBLISH` ของรีวิวที่เผยแพร่อยู่แล้วต้องข้ามเงียบ, E10 ที่สถานะไม่ตรงให้ข้ามพร้อม log ไม่ throw; เมื่อผู้เขียนรีวิวลบบัญชี Verification ล้างเนื้อหารีวิวที่ยัง `HELD` ของตน (Lifecycle ตัดสินเองว่าจะลบ/ไม่เผยแพร่รีวิวนั้น)
- ตั้ง `output` ของ Prisma ตามกฎข้อ 9 เมื่อเริ่มเขียน schema (ตั้งไว้ให้แล้วในไฟล์ `schema.prisma` ของ Lifecycle)

**PM (Verification) — งานที่ยังค้าง:** Minor ของ review สไลซ์ 2 (#5 `dismiss` พลิกรายงานที่เคย uphold, #6 ธงอาจติดผิดจาก E03 เก่ามาก, #7 ลำดับล็อกของ clear-flag, #8 `PUT` ธงไม่เช็กว่าบริษัทมีจริง, #10 เทสต์ไม่ log `detail`) · ~~สไลซ์ 3 (ตรวจรีวิว E09/E10 และรายงานรีวิว)~~ **ทำแล้ว** ([spec](superpowers/specs/2026-11-15-verification-slice3-design.md)) — รอ PM ตรวจ

### 9.2 เพิ่มเติมจากการตรวจ contract ฝั่ง Job (2026-11-15) — สำหรับ Junior

ตัดสินแล้วและแก้ในเอกสารกับ `libs/contracts` แล้ว (ข้อ 1–5 กระทบ migration แรกของ Job):
1. **เพิ่มคอลัมน์ `jobs.contact_notes text null`** (ข้อความอิสระ ไม่บังคับ; เห็นเฉพาะ HR เจ้าของและ Admin) — `JobSubmitted.content.contact_notes` มีอยู่แล้วแต่ตารางเดิมไม่มีคอลัมน์
2. **ฟิลด์ที่บังคับก่อน `submit`** (ใช้เป็นเงื่อนไข `CHECK` และ `MISSING_REQUIRED_JOB_FIELDS`): `category`, `job_title`, `description`, `responsibilities`, `qualifications`, `location`, `work_mode`, `hours_per_week`, `allowance_type` (`AMOUNT` ต้องมีจำนวนเงิน > 0), `internship_period_start/_end`, `target_majors` (≥ 1), `quota` (≥ 1), `application_deadline`; ไม่บังคับ: `allowance_text`, `contact_notes` ([data-schema.md](data-schema.md) §4)
3. **ฟิลด์ที่แก้แล้วต้องตรวจซ้ำ** (`PUBLISHED → VERIFYING` + `JobSubmitted(kind=EDIT)`): ทุกฟิลด์ที่ Verification ใช้ตัดสิน = `job_title`, `description`, `responsibilities`, `qualifications`, `allowance_*`, `location`, `contact_notes`, `work_mode`, `hours_per_week` — ฟิลด์ที่ **ไม่ตรวจซ้ำ**: `quota`, `application_deadline`, `target_majors`, `internship_period_*`, `category`, `featured`
4. **`allowance_text` ใน E01 เป็น string เสมอ** ส่ง `''` เมื่อใน DB เป็น NULL
5. **`PATCH /hr/jobs/{id}` แก้ได้เมื่อสถานะ** `DRAFT`/`PUBLISHED`/`AUTO_REJECTED`/`ADMIN_REJECTED` (และ `CLOSED` เฉพาะ `quota`, `application_deadline`, `target_majors`, ช่วงฝึก) สถานะอื่นตอบ `409 STATE_CONFLICT`; `submit` ทำได้จาก `DRAFT`/`AUTO_REJECTED`/`ADMIN_REJECTED` และคืน Job Object ที่ `status=VERIFYING`; body ของ `POST`/`PATCH` คือ `CreateJobRequest`/`UpdateJobRequest` ใน `@internpath/contracts` ([api-contract.md](api-contract.md) §5.1)
6. **ชนิดใน `libs/contracts` เข้มขึ้น:** `JobStatusChangedPayload.from_status/to_status` เป็น `JobStatus` (ไม่ใช่ `string`) และ `application_effect` เป็น `ApplicationEffect` — ถ้าโค้ดของ JR ส่งสตริงทั่วไป TypeScript จะ error ให้ใช้ค่าจาก enum
7. **ผู้รับ E06 (`CompanyEntitlementChanged`) มีแค่ Job** — Verification ไม่รับแล้ว เพราะใช้ `fast_track` ที่ Job ใส่ใน E01 เป็น snapshot ณ ตอนส่งตรวจ ดังนั้น Job ต้องใส่ `fast_track` จากสิทธิ์ล่าสุดทุกครั้งที่ส่ง `JobSubmitted` (มีเทสต์เทียบแคตตาล็อกกับเอกสาร ตอนนี้ 32 คิว)
8. **Enum กลางตรวจอัตโนมัติ:** `libs/common/test/repo/contracts-docs.spec.ts` เทียบ `enums.ts` กับ data-schema §2.1 ถ้าเพิ่มค่า enum ต้องแก้ทั้งสองที่
