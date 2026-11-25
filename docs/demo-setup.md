# InternPATH shared demo dataset

ใช้ฐานข้อมูลและบริการแยกสำหรับเดโมบนเครื่องหลักและเครื่องสำรอง Seed ทั้งสองเครื่องจาก Git commit เดียวกัน ข้อมูลและชื่อบัญชีเป็นข้อมูลสมมติชุดเดียวกัน UUID และเลขใบรับรองออกโดยแต่ละระบบ ดูค่าจริงของเครื่องนั้นใน `.internpath-demo/manifest.json`

## เตรียมเครื่อง

- Node.js 20.12 ขึ้นไปและ pnpm 9.15.0 ตามเครื่องมือ local stack ของ repo พร้อม Docker Desktop ที่ใช้ Linux containers
- ใช้ checkout และ Docker volumes สำหรับเดโมเท่านั้น ตรวจพอร์ตและปลายทางก่อนเปิด stack หรือรัน migration
- สร้าง `.env` จาก `.env.example` หากยังไม่มี สร้าง JWT keys ด้วย `pnpm keys:generate` แล้วตั้งค่า service secrets ตาม [Getting Started](getting-started.md) ใช้ค่าที่สร้างเฉพาะเครื่อง
- ตั้ง `DEMO_ENABLED=1` และ `DEMO_PASSWORD` อย่างน้อย 12 ตัวอักษร เก็บรหัสผ่านใน local config และใช้รหัสเดียวกันสำหรับบัญชีสังเคราะห์บนเครื่องนั้น
- ตั้ง URL ฐานข้อมูลและ direct URL ของทั้งห้า Service ให้เป็น loopback และใช้ฐานแยกกัน ตั้ง `POSTGRES_PORT` ให้ตรงกับ URL ทั้งหมด ใช้ RustFS สำหรับ `S3_ENDPOINT` และ Mailpit ตาม Compose ที่ให้มาโดยปิด SMTP relay/forward และไม่มี SMTP username/password ค่าเริ่มต้นของ HTTP Mailpit คือ `http://localhost:8025` เปลี่ยนด้วย `DEMO_MAILPIT_URL` เมื่อใช้พอร์ตเฉพาะ
- ให้ `WEB_BASE_URL` ตรงกับ origin ที่เปิดในเบราว์เซอร์ ใช้ Gateway จริงและเปิด backend ทั้งห้าบริการ ใช้ตัวแปร URL และพอร์ตชุดเดียวกันทุก Service
- คำสั่งด้านล่างใช้ไฟล์ `.env` ร่วมชุดเดียว คำสั่ง seed ตรวจค่าจาก `.env`, `apps/<service>/.env`, ตัวแปร process และ `.env.internpath-current` ตามลำดับ อย่าใช้ไฟล์ override ที่ชี้ไปยัง stack อื่น หากใช้ override กับ local stack ให้ตั้งค่าตรงกันทั้งตอนสตาร์ตและตอน seed

### macOS

เปิด Docker Desktop จากนั้นรันจาก root ของ checkout เดโม

```bash
git rev-parse HEAD
node --version
pnpm --version
pnpm install --frozen-lockfile
docker compose --profile infra up -d --wait
pnpm dev:migrate
pnpm --filter "./apps/*" --if-present prisma:generate
export RABBITMQ_URL="$(node --env-file=.env -p 'process.env.RABBITMQ_URL')"
pnpm infra:topology
pnpm infra:init-buckets
pnpm --filter @internpath/lifecycle exec playwright install chromium
```

เปิดแต่ละคำสั่งใน Terminal แยกกัน เริ่ม Identity ก่อน จากนั้นเปิดอีกสี่ Service และเปิด Gateway หลัง Identity พร้อม

```bash
pnpm --filter @internpath/identity start:dev
pnpm --filter @internpath/job start:dev
pnpm --filter @internpath/verification start:dev
pnpm --filter @internpath/lifecycle start:dev
pnpm --filter @internpath/notification start:dev
pnpm --filter @internpath/gateway start:dev
pnpm --filter @internpath/web dev
```

### Windows PowerShell

เปิด Docker Desktop ด้วย WSL 2 backend และ Linux containers ใช้ PowerShell ที่ root ของ checkout เดโม สร้าง `.env` ด้วย `Copy-Item .env.example .env` หากยังไม่มี แล้วตั้งค่าตามข้างต้น

```powershell
git rev-parse HEAD
node --version
pnpm --version
pnpm install --frozen-lockfile
docker compose --profile infra up -d --wait
pnpm dev:migrate
pnpm --filter "./apps/*" --if-present prisma:generate
$env:RABBITMQ_URL = node --env-file=.env -p "process.env.RABBITMQ_URL"
pnpm infra:topology
pnpm infra:init-buckets
pnpm --filter @internpath/lifecycle exec playwright install chromium
```

เปิด PowerShell แยกหน้าต่างสำหรับเจ็ดคำสั่ง startup เดียวกับ macOS `pnpm dev:up` ใช้ branch `main` และจะดึงโค้ดจาก origin ให้ใช้ startup แยกเพื่อทดสอบ candidate SHA ที่กำหนด

### Seed และ Verify

```text
pnpm demo:seed
pnpm demo:verify
pnpm demo:seed
pnpm demo:verify
pnpm demo:seed --pack rehearsal-next
pnpm demo:verify --pack rehearsal-next
```

- เริ่มด้วย Display และ A/B/C รายงาน `READY` หมายถึงชุดพร้อมเริ่ม `CONSUMED (...)` ระบุขั้นตอนที่ใช้ไปแล้ว `FAIL` และ `BLOCKED` คืน exit code 1
- ใช้ชื่อ pack ใหม่สำหรับซ้อมเพิ่ม ตัวอักษรตัวแรกต้องเป็น a–z และตัวที่เหลือใช้ตัวพิมพ์เล็ก ตัวเลข หรือขีดกลางได้ สูงสุด 20 ตัวอักษร การรันซ้ำคงประวัติและใบรับรอง
- เก็บ manifest ไว้กับฐานข้อมูลเดิม Manifest มี ID ที่ใช้แยกข้อมูลที่ seed เป็นเจ้าของและใช้ resume เมื่อทำได้ เก็บ Docker volumes ไว้ถ้าต้องใช้ชุดเดิม อย่าลบ manifest เพื่อแก้ collision
- ถ้ารายงาน lock ค้าง ให้ตรวจว่าไม่มี seed process เดิมทำงานก่อนนำเฉพาะไฟล์ `.internpath-demo/seed.lock` ที่ค้างออก จากนั้นรันเดิมซ้ำ
- ถ้าเอกสารหรือรูปดาวน์โหลดไม่ได้ ให้ตรวจ RustFS, bucket และ URL ถ้า projections ไม่ตาม ให้ตรวจ `/ready`, RabbitMQ queues และ consumer logs ถ้าออก PDF ไม่ได้ ให้ตรวจ Chromium ของแพ็กเกจ Lifecycle และ log ของบริการ หลีกเลี่ยงการคัดลอก signed URLs หรือลิงก์เชิญลงรายงาน

## บัญชีและข้อมูล

| บัญชี | อีเมล |
|---|---|
| Admin | `admin@demo.internpath.test` |
| HR Owner บริษัทที่พร้อมใช้งาน | `owner@<pack>-studio.demo.internpath.test` |
| HR Owner บริษัทที่รออนุมัติ | `owner@<pack>-approval.demo.internpath.test` |
| Advisor | `advisor@demo-seed-<pack>.ac.th` |
| Student สำหรับสมัครต่อเนื่อง | `flow@demo-seed-<pack>.ac.th` |
| Student สำหรับใบรับรองและรีวิว | `certificate@demo-seed-<pack>.ac.th` |
| Student สำหรับรายงานปัญหา | `problem@demo-seed-<pack>.ac.th` |
| Student ตัวอย่างใบสมัคร | `offer@demo-seed-<pack>.ac.th` |
| Display HR Member | `member@display-studio.demo.internpath.test` |
| Display Student ที่รอผลประเมิน | `overdue@demo-seed-display.ac.th` |

แทน `<pack>` ด้วย `a` สำหรับซ้อมครั้งแรก `b` สำหรับซ้อมครั้งที่สอง หรือ `c` สำหรับนำเสนอ ชุด `display` ใช้บัญชีบริษัทที่พร้อมใช้งาน, Advisor และนักศึกษา `certificate`, `problem`, `offer`, `overdue` สำหรับเปิดดูข้อมูลประกอบ

Display มี tags สามรายการ ประกาศเผยแพร่ 13 รายการจากสามสายงาน พร้อมร่าง ประกาศปิด และรายการคิวตรวจประกาศ ค้นด้วย `[Demo DISPLAY]` และเลือก 10 รายการต่อหน้าเพื่อทดสอบการเปลี่ยนหน้า เปิดดูใบตอบรับ ผลฝึกงานและใบรับรองที่ออกแล้ว รีวิว คิวรายงานปัญหา รายการเลยกำหนดประเมิน และการแจ้งเตือนของผู้รับจริง

## ลำดับสาธิต

1. ใช้ Admin อนุมัติบริษัท `<pack>-approval` จากหน้า `/admin/companies` ใช้ HR Owner บริษัท `<pack>-studio` ในขั้นตอนงานเพื่อคง scenario ที่เตรียมไว้
2. เปิด HR Jobs เพื่อเผยแพร่ร่าง `Product Studio Trainee` หรือสร้างงานใหม่ ค้นหา `[Demo <PACK>] Digital Internship` ด้วย Student `flow` แล้วส่งใบสมัครพร้อมเรซูเม่ตัวอย่าง
3. เปิดใบสมัครด้วย HR เพื่อตอบรับ จากนั้น Student ยืนยัน Advisor อนุมัติ และ HR เริ่มฝึกงาน เลือกวันเริ่มจริงให้ตรงหรือหลังวันที่อาจารย์อนุมัติ
4. สลับไปใช้ใบสมัครของ Student `certificate` ซึ่งมีประวัติฝึกย้อนหลัง 40 วัน ใช้ HR เปิด `/hr/applicants/item?id=<application_id>` และบันทึกผล PASS จากนั้นออกใบรับรอง Student เปิด `/student/certificates` เพื่อดาวน์โหลด PDF แล้วใช้เลขใบรับรองที่ `/public/certificates?code=<code>`
5. ใช้ Student `certificate` เขียนรีวิวบริษัทจากใบสมัครเดียวกัน ใช้ Student `problem` เปิดใบสมัครประวัติอีกใบเพื่อรายงานปัญหา เปิด Notification inbox ของผู้รับหลัง event processing
6. รัน `pnpm demo:verify` แล้วเลือกชุด `READY` ถัดไป อย่าใช้ชุด Display ซ้อมเปลี่ยนสถานะ

Manifest ใช้ `packs.<pack>.jobs` สำหรับ Job ID, `packs.<pack>.applications.certificate` และ `packs.<pack>.applications.problem` สำหรับใบสมัครย้อนหลัง และ `packs.<pack>.approvalId` สำหรับบริษัทที่รออนุมัติ

## Checklist สำหรับ Tester

- ตรวจ `historical()` ใน `scripts/demo/seed.mjs` ซึ่งเพิ่มเฉพาะ `Application` และ `StatusHistory` ในธุรกรรมเดียว และเก็บ actor, role, correlation ID และเวลาของห้าสถานะตามลำดับ Advisor อนุมัติก่อนเริ่มสองวัน และใบรับรองใช้ช่วง 40 วัน
- ตรวจการผูก resume, consent, advisor, company, job และการเติมชื่อใน Lifecycle snapshot ผ่านใบสมัครที่ส่ง API ตามปกติ ตรวจการ reserve/confirm ผ่าน Job API ตามสัญญาเดิม เวลาสร้างบัญชี, consent, resume และประกาศสะท้อนเวลาที่ seed ผ่าน API ปัจจุบัน วันย้อนหลังอยู่ใน timeline ของใบสมัครเท่านั้น
- ตรวจ `application()`, `certificate()` และ `verifyPack()` ใน `scripts/demo/verify.mjs` ว่าครอบคลุม timeline, reservation, projections, queues, reviews, ผู้รับ Notification, รหัสใบรับรอง และ SHA-256 ของ PDF
- รันบน macOS และ Windows จริงจาก candidate SHA เดียวกัน บันทึก OS, Node.js/pnpm, SHA, ผล seed/verify สองรอบ, ID และจำนวน fixture ก่อนและหลัง พร้อมปัญหาที่พบ เก็บรหัสผ่านและ signed URLs นอกหลักฐานที่แชร์
- ตรวจการออกใบรับรองใน rehearsal pack แล้วตรวจว่า pack ที่ยังไม่ใช้คงสถานะ `READY` ขอผล review ของ Tester ก่อนยืนยันความพร้อมของ PR
