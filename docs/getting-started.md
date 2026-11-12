# 🚀 Getting Started

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

## 3. รัน

```bash
pnpm infra:up                                   # Postgres, RabbitMQ, MinIO, Mailpit
pnpm --filter @internpath/identity start:dev    # รัน Service เดียวแบบ watch (แทน identity ด้วย job, verification, ...)
pnpm --filter @internpath/web dev               # เว็บ http://localhost:3100
```

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
- Mailpit UI: http://localhost:8025 • RabbitMQ UI: http://localhost:15672 • MinIO Console: http://localhost:9001

จะเริ่มเขียนโค้ดต่อ → อ่าน [developer-guide.md](developer-guide.md)

รันบน Docker ทั้งชุด: `docker compose --profile all up --build` หรือเลือกทีละ Service ด้วย `--profile infra --profile identity`

## 4. คำสั่งที่ใช้บ่อย

| คำสั่ง | ทำอะไร |
| :--- | :--- |
| `pnpm build` | build ทุกแพ็กเกจ (libs ก่อน apps) |
| `pnpm test` | Mocha + Chai ทุกแพ็กเกจ |
| `pnpm --filter @internpath/<name> test:cov` | Coverage ด้วย c8 |
| `pnpm lint` / `pnpm format` | ESLint / Prettier |
| `pnpm --filter @internpath/<name> prisma:generate` | สร้าง Prisma Client (ต้องตั้ง `<PREFIX>_DATABASE_URL` และ `<PREFIX>_DIRECT_URL`) |

## 5. หมายเหตุ

- Prisma ล็อกที่ **6.x** (Prisma 7+ เปลี่ยนวิธีตั้งค่า ต้องย้ายก่อนอัปเกรด) และ TypeScript ล็อกที่ 5.6 ผ่าน `pnpm.overrides`
- `libs/common` และ `libs/contracts` ต้อง build ก่อน (`dist/`) แอปถึง import ได้ — `pnpm install` ทำให้อัตโนมัติ ถ้าแก้โค้ดใน libs ให้รัน `pnpm --filter "./libs/*" build`
- Migration ของ Prisma ยังไม่มี (รอเขียน schema ตาม [data-schema.md](data-schema.md))
