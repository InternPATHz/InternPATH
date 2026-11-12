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
> ขั้นตอน migration นี้ยังไม่เคยถูกลองรันจริงในโปรเจกต์ (ยังไม่มี migration แรก) ถ้าติดปัญหาให้แจ้งทีมและอัปเดตคู่มือนี้

### 6.3 เพิ่ม Event ใหม่ / ส่ง-รับ Event
ทำตามรายการใน [event-contract.md](event-contract.md) §7:
1. เพิ่มแถวและ Payload ในเอกสาร
2. เพิ่ม type ใน `libs/contracts/src/events/` (ใช้ `EventEnvelope<'ชื่อEvent', Payload>`)
3. **ผู้ส่ง:** เขียนแถวลง `outbox_events` ใน Transaction เดียวกับการเปลี่ยนข้อมูล (ห้ามส่ง RabbitMQ ตรงๆ)
4. **ผู้รับ:** บันทึก `processed_events` ก่อนประมวลผล (กันซ้ำด้วย `event_id`) และเทียบ `entity_version` ถ้าเป็นสถานะ
5. อัปเดตคอลัมน์ Consume/Publish ใน [architecture.md](architecture.md) §2

### 6.4 เรียก Service อื่น
- ต้องการ **ข้อมูลที่เปลี่ยนไม่บ่อย** (ชื่อบริษัท, สิทธิ์) → รับ Event แล้วเก็บ Snapshot ในตารางของตัวเอง
- ต้องการ **คำตอบทันที/ต้อง Atomic** (เช่น จองโควตา) → เรียก Internal API ตาม [api-contract.md](api-contract.md) §9 (timeout 3 วินาที, retry 2 ครั้ง, ห้ามเรียกวนกลับ)

## 7. ยังไม่มีอะไรบ้าง (รู้ไว้จะได้ไม่งง)

โครงตอนนี้ **รันได้และทดสอบผ่าน แต่ยังไม่มีโค้ดธุรกิจ** สิ่งที่ยังต้องสร้าง:

- [ ] Prisma migration แรกของทุก Service และตารางเฉพาะ Service (ตอนนี้มีแค่ `outbox_events` / `processed_events`)
- [ ] Outbox relay และ Consumer (โฟลเดอร์ `outbox/`, `events/` ยังว่าง)
- [ ] Service Token สำหรับ `/internal/**` และ allow-list ผู้เรียก
- [ ] Gateway: การ Route/Proxy, ตรวจ Token, Rate Limit, Denylist (ตอนนี้มีแค่ health)
- [ ] การลงทะเบียน `JwtAuthGuard` เป็น Guard ของแต่ละ Service (ตอนนี้เป็น class ให้ใช้ต่อ controller)
- [ ] Scheduler (SLA, Reconciliation โควตา, Fail-safe 5 นาที)
- [ ] หน้าเว็บของแต่ละ Role (มีแค่หน้าแรกและ Tailwind theme)
- [ ] ยังไม่เคยรัน Dockerfile / `docker compose up` จริง (Docker engine ยังไม่ผ่านการทดสอบ)

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
| Prisma ขึ้น error แปลกหลังอัปเกรด | โปรเจกต์ล็อก Prisma ไว้ที่ 6.x อย่าอัปเป็น 7+ โดยไม่ย้าย config ก่อน |
| `pnpm install` แล้ว `prepare` ล้ม | ดู error ของ `tsc` ใน `libs/*`; ตรวจว่าใช้ TypeScript 5.6 (ล็อกด้วย `pnpm.overrides`) |
