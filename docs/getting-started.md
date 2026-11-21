# Getting Started

วิธีตั้งค่าเครื่องพัฒนาและรันโปรเจกต์ | โครงสร้างระบบดู [architecture.md](architecture.md)

## 1. สิ่งที่ต้องมี

| เครื่องมือ | เวอร์ชัน | หมายเหตุ |
| :--- | :--- | :--- |
| Node.js | 20 ขึ้นไป (`.nvmrc` = 20) | |
| pnpm | 9.15.0 | `npm i -g pnpm@9.15.0` (ล็อกไว้ใน `packageManager`) |
| Docker | Docker Desktop | Windows Home ต้องเปิด **WSL2** ก่อน: PowerShell (Administrator) `wsl --install --no-distribution` แล้วรีสตาร์ต |

## 2. ติดตั้ง

```bash
git clone <repo> && cd InternPATH
cp .env.example .env          # แล้วแก้รหัสผ่านตามต้องการ
pnpm install                  # ติดตั้ง + build libs/* อัตโนมัติ (hook `prepare`)
pnpm keys:generate            # พิมพ์ JWT_PRIVATE_KEY / JWT_PUBLIC_KEY → วางลง .env
```

จากนั้นสร้าง Service secret ทุกคู่ใน `.env` ตาม [developer-guide.md §1.1](developer-guide.md#11-ตั้งค่า-jwt-และ-service-secret-ก่อนเปิด-gateway) (แต่ละค่า ≥ 32 ตัวอักษร ใช้ค่าเดียวกันทั้งฝั่งผู้เรียกและผู้รับ เพราะอยู่ใน `.env` ไฟล์เดียว) — ถ้าเว้นว่าง Service จะไม่เริ่มหรือตอบ 503 ในฟีเจอร์ที่เกี่ยวข้อง:

| ตัวแปร | ใช้ตอน | ขาดแล้วเป็นอย่างไร |
| :--- | :--- | :--- |
| `IDENTITY_SERVICE_SECRET_GATEWAY` | Gateway ดึง denylist จาก Identity | Gateway ไม่เริ่ม |
| `IDENTITY_SERVICE_SECRET_LIFECYCLE`, `JOB_SERVICE_SECRET_LIFECYCLE` | Lifecycle เรียก Identity (ชื่อ/ติดต่อ) และ Job (โควตา) | Lifecycle ไม่เริ่ม |
| `LIFECYCLE_SERVICE_SECRET_JOB` | Job ถาม Lifecycle ตอนกระทบยอดโควตา | กระทบยอดโควตาไม่ทำงาน |
| `LIFECYCLE_SERVICE_SECRET_IDENTITY` | Identity ถาม Lifecycle ก่อนลบบัญชี | ลบบัญชีตอบ 503 |
| `IDENTITY_SERVICE_SECRET_NOTIFICATION` | Notification หาผู้รับและอีเมลจาก Identity | Event ที่ต้องหาผู้รับล้มซ้ำจนเข้า DLQ ไม่มีแจ้งเตือน |
| `JOB_SERVICE_SECRET_IDENTITY` | Identity ถาม Job ว่าบริษัทไหนมีประกาศในสายงาน (Directory `?category=`) | ตัวกรองสายงานใน Company Directory ตอบ 503 |

## 3. รัน

```bash
pnpm infra:up                                   # Postgres, RabbitMQ, RustFS (S3), Mailpit
pnpm infra:init-buckets                         # ครั้งแรกเท่านั้น: สร้าง bucket ใน RustFS (ไฟล์เรซูเม่/โลโก้)
pnpm storage:check                              # (ไม่บังคับ) ตรวจ storage: อัปโหลด Signed URL หมดอายุ ลบ โลโก้สาธารณะ; กับ R2: pnpm storage:check -- --env .env.r2
pnpm infra:topology                             # สร้างคิวผู้รับ Event ทุก Service ล่วงหน้า (รันซ้ำได้)
pnpm --filter @internpath/identity start:dev    # รัน Service เดียวแบบ watch (แทน identity ด้วย job, verification, ...)
pnpm --filter @internpath/web dev               # เว็บ http://localhost:3100
```

**สร้างตารางในฐานข้อมูล** (ครั้งแรก และทุกครั้งที่ `git pull` แล้วมีโฟลเดอร์ใหม่ใน `apps/*/prisma/migrations`) — Postgres สร้างฐานข้อมูลว่างให้ 5 ตัวตอน `pnpm infra:up` ครั้งแรก แต่ตารางต้องสร้างด้วย migration ของแต่ละ Service; Prisma CLI ไม่อ่าน `.env` ที่ราก repo จึงต้อง export URL ของฐานข้อมูลก่อน (Git Bash):

```bash
export $(grep -E '^[A-Z]+_(DATABASE|DIRECT)_URL=' .env | xargs)
for s in identity job verification lifecycle notification; do pnpm --filter @internpath/$s exec prisma migrate deploy; done
```

**ลำดับการเปิด Service:** Identity ก่อน แล้ว Job, Verification, Lifecycle, Notification และ **Gateway เป็นตัวท้าย** — Gateway ปฏิเสธคำขอที่ล็อกอินด้วย `503 UPSTREAM_UNAVAILABLE` จนกว่าจะดึง denylist จาก Identity สำเร็จ (fail-closed) ถ้าเปิด Gateway ก่อน Identity จะได้ 503 ไปจนถึงรอบดึงถัดไป (ทุก 30 วินาที) • เปิดผู้รับ Event ให้ครบก่อนสร้างข้อมูล ไม่เช่นนั้น Event ที่ส่งก่อนผู้รับมีคิวจะหาย (ป้องกันได้ด้วย `pnpm infra:topology` ข้างบน)

| Service | Port | Health | API Docs (dev) |
| :--- | :---: | :--- | :--- |
| gateway | 3000 | `/health` | `/docs` |
| identity | 3001 | `/health`, `/ready` | `/docs` |
| job | 3002 | `/health`, `/ready` | `/docs` |
| verification | 3003 | `/health`, `/ready` | `/docs` |
| lifecycle | 3004 | `/health`, `/ready` | `/docs` |
| notification | 3005 | `/health`, `/ready` | `/docs` |
| web | 3100 | — | — |

- `/health` = liveness (ไม่ต้องมี DB) • `/ready` = ตรวจ Postgres + RabbitMQ (ตอบ 503 ถ้ายังไม่ได้รัน `pnpm infra:up`)
- Mailpit UI: http://localhost:8025 • RabbitMQ UI: http://localhost:15672 • RustFS: S3 http://localhost:9000 • Console http://localhost:9001/rustfs/console/index.html

จะเริ่มเขียนโค้ดต่อ → อ่าน [developer-guide.md](developer-guide.md)

รันบน Docker ทั้งชุด: `docker compose --profile all up --build` หรือเลือกทีละ Service ด้วย `--profile infra --profile identity`

## 3.1 สาธิตผ่าน Cloudflare (Front บน Cloudflare, Backend บนเครื่องคุณ)

ใช้เมื่ออยากให้คนอื่นเปิดลิงก์เว็บได้ ส่วนตอนพัฒนาและเทสเองในเครื่องไม่ต้องทำขั้นตอนนี้ — แผนภาพและข้อกำหนดดู [architecture.md](architecture.md) §8.1

> **สถานะ:** โค้ด Worker proxy ยังไม่มีใน repo ขั้นตอนด้านล่างคือแนวทางที่ตกลงไว้ ยังไม่ได้ทดลองรันจริง

1. รัน backend: `pnpm infra:up` แล้วเปิด Service ที่ต้องใช้ (หรือ `docker compose --profile all up --build`)
2. เปิด tunnel ไปที่ gateway ตัวเดียว: `cloudflared tunnel --url http://localhost:3000` จะได้ URL แบบ `https://xxxx.trycloudflare.com` (เปลี่ยนทุกครั้งที่รัน)
3. ตั้งตัวแปรของ Worker: `API_ORIGIN` = URL จากข้อ 2 และ `EDGE_SHARED_SECRET` = ค่าเดียวกับใน `.env` ของ gateway (ตั้งผ่าน `npx wrangler secret put` หรือหน้า Cloudflare Dashboard)
4. เปิด URL `*.workers.dev` ของ Front ถ้า API ไม่ตอบ หน้าเว็บควรแสดงข้อความ "ระบบหลังบ้านออฟไลน์"

ทุกครั้งที่เปิด tunnel ใหม่ ต้องอัปเดต `API_ORIGIN` ให้ตรง • ก่อนวันนำเสนอควรทดสอบทั้งชุดล่วงหน้าและเตรียมวิดีโอ/ภาพหน้าจอสำรอง

## 4. คำสั่งที่ใช้บ่อย

| คำสั่ง | ทำอะไร |
| :--- | :--- |
| `pnpm build` | build ทุกแพ็กเกจ (libs ก่อน apps) |
| `pnpm test` | Mocha + Chai ทุกแพ็กเกจ |
| `pnpm --filter @internpath/<name> test:cov` | Coverage ด้วย c8 |
| `pnpm lint` / `pnpm format` | ESLint / Prettier |
| `pnpm --filter @internpath/<name> prisma:generate` | สร้าง Prisma Client (ต้องตั้ง `<PREFIX>_DATABASE_URL` และ `<PREFIX>_DIRECT_URL`) |
| `pnpm infra:topology` | สร้างคิวผู้รับ Event ทุกตัว (+ DLQ + retry queue) ใน RabbitMQ ล่วงหน้า รันซ้ำได้ |

## 5. หมายเหตุ

- Prisma ล็อกที่ **6.x** (Prisma 7+ เปลี่ยนวิธีตั้งค่า ต้องย้ายก่อนอัปเกรด) และ TypeScript ล็อกที่ 5.6 ผ่าน `pnpm.overrides`
- `libs/common` และ `libs/contracts` ต้อง build ก่อน (`dist/`) แอปถึง import ได้ — `pnpm install` ทำให้อัตโนมัติ ถ้าแก้โค้ดใน libs ให้รัน `pnpm --filter "./libs/*" build`
- Migration ของ Prisma: ทุก Service มีแล้ว (Identity, Job, Verification, Lifecycle, Notification) — รันด้วยคำสั่งใน §3 "สร้างตารางในฐานข้อมูล"; เพิ่ม/แก้ตารางตาม [data-schema.md](data-schema.md) และขั้นตอนใน [developer-guide.md](developer-guide.md) §6.2
- Prisma Client ของแต่ละ Service generate ไป `apps/<service>/generated/client` (ไม่ commit) — รัน `pnpm --filter "./apps/*" --if-present prisma:generate` หลัง `pnpm install` และทุกครั้งที่ `schema.prisma` เปลี่ยน
- เพิ่ง `git pull` แล้วเจอ error เรื่อง Prisma/คิว/โมดูลหาย → ดูขั้นตอนใน [developer-guide.md](developer-guide.md) §9 (สิ่งที่ต้องทำตามหลัง merge รายครั้ง)
- หลัง `pnpm infra:up` ให้รัน `pnpm infra:topology` หนึ่งครั้ง เพื่อสร้างคิวผู้รับ Event ของทุก Service ล่วงหน้า (ไม่เช่นนั้น Event ที่ Service หนึ่งส่งก่อนที่ผู้รับจะเคยเปิดจะหาย)
- หน้า HR Jobs ของเว็บใช้ข้อมูลจำลองอยู่จนกว่า HR Jobs API ของ Job (#92) จะ merge — หลังจากนั้นค่าเริ่มต้นเรียก API จริง และตั้ง `NEXT_PUBLIC_HR_JOBS_MOCK=true` เมื่ออยากใช้ข้อมูลจำลอง
