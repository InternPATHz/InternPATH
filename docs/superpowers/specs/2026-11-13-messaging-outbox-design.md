# Design: Messaging กลาง (Outbox relay + Consumer + Retry/DLQ) ใน `libs/common`

- วันที่: 2026-11-13
- เจ้าของ: PM (รับทำก่อน Verification เพราะทุก Service พึ่งส่วนนี้)
- สถานะ: **ร่างรออนุมัติ**
- เอกสารต้นทางที่ต้องไม่ขัด: [event-contract.md](../../event-contract.md) §1-3, [architecture.md](../../architecture.md) §3/§6/§7, [data-schema.md](../../data-schema.md) §2.2

## 1. เจตนาและเหตุผล

ทุก Service ต้องส่ง/รับ Event ผ่าน RabbitMQ ด้วยกติกาเดียวกัน (Outbox ฝั่งส่ง, Idempotency ฝั่งรับ, Retry/DLQ) ตอนนี้ `libs/common/src/outbox` และ `messaging` ว่างเปล่า ทำให้ Job, Verification, Notification และ Lifecycle ยังเชื่อมกันไม่ได้ และ Verification (ของ PM) เริ่มส่วน event ไม่ได้ จึงทำส่วนกลางนี้ก่อน เพื่อให้ทุกคนใช้โค้ดเดียวกัน ไม่เขียนเองคนละแบบ

## 2. เป้าหมาย / ไม่ใช่เป้าหมาย / สิ่งที่ถือว่าล้มเหลว

**เป้าหมาย**
1. ผู้ส่งเขียนแถว outbox **ใน Transaction เดียวกับข้อมูล** ด้วยการเรียกบรรทัดเดียว
2. Relay ส่งแถวที่ยังไม่ publish เข้า `internpath.events` แบบ at-least-once รักษาลำดับต่อ `aggregate_id`
3. ผู้รับลงทะเบียน handler ต่อ `(producer, eventType)`; lib จัดการ idempotency (`processed_events`), manual ack, retry 3 ครั้ง (5 วินาที / 30 วินาที / 2 นาที) แล้วเข้า DLQ
4. สลับ RabbitMQ ในเครื่องกับ CloudAMQP ได้ด้วยการเปลี่ยน `RABBITMQ_URL` เท่านั้น
5. ทุก Service ใช้ได้โดยไม่ต้องรู้เรื่อง RabbitMQ topology

**ไม่ใช่เป้าหมาย (รอบนี้)**
- ชนิดข้อมูล Payload ของ E01-E18 (เจ้าของแต่ละ Service เพิ่มใน `libs/contracts` ตามสูตรใน developer-guide §6.3)
- เทียบ `entity_version` (เป็นกติกาของ handler แต่ละตัว; lib อาจมี helper เล็กๆ ถ้าสะดวก แต่ไม่บังคับ)
- แจ้งเตือน Admin เมื่อเข้า DLQ ผ่าน Notification (ทำเป็น hook `onDeadLetter` + log ระดับ `error` ก่อน)
- MinIO/Storage, Gateway, Service Token, Scheduler

**สิ่งที่ถือว่าล้มเหลวแม้โค้ดจะรัน**
- lib กลาง import Prisma หรือผูกกับ schema ของ Service ใดโดยตรง
- Service ส่ง RabbitMQ ตรงๆ โดยไม่ผ่าน outbox
- Event หายหรือประมวลผลซ้ำสองครั้งโดยไม่มีการกันซ้ำเมื่อ broker/DB ล่มกลางทาง

## 3. ข้อจำกัด

- Prisma client เป็นของแต่ละ Service (generate แยก) จึงใส่ใน `libs/common` ไม่ได้
- `libs/common` มี `amqplib` และ `pg` เป็น dependency อยู่แล้ว ใช้สองตัวนี้ ไม่เพิ่มของใหม่ถ้าไม่จำเป็น
- ชื่อ exchange/routing key/envelope อยู่ใน `libs/contracts` แล้ว ต้องใช้ของเดิม ไม่ประกาศซ้ำ
- CloudAMQP แผนฟรีจำกัดจำนวน queue → ใช้ retry queue **ร่วมต่อ Service** (3 คิวต่อ Service)
- ห้าม Log เนื้อหา Event ที่มีข้อมูลอ่อนไหว (เช่น `ReviewSubmitted`, event-contract §1)

## 4. ทางเลือกที่พิจารณา (Approaches)

| # | แนวทาง | ข้อดี | ข้อเสีย |
| :-: | :--- | :--- | :--- |
| **1** | **Relay ใช้ `pg` อ่าน/mark ตาราง outbox; Service เขียน outbox และ `processed_events` ผ่าน Prisma `tx` ของตัวเอง โดย lib รับ `tx` ผ่าน interface เชิงโครงสร้าง (เลือก)** | lib ไม่รู้จัก Prisma; Service คุม Transaction เอง; ตรงกับสถาปัตยกรรมที่วางไว้ | ต้องส่งฟังก์ชันเปิด Transaction เข้ามาตอนตั้งค่า |
| 2 | lib กำหนด adapter interface ให้ Service เขียนเชื่อม Prisma เอง | ยืดหยุ่นสุด | ทุก Service ต้องเขียนโค้ดเชื่อมซ้ำ เสี่ยงทำไม่เหมือนกัน |
| 3 | ใช้ `pg` ทั้งหมดแทน Prisma สำหรับ outbox/processed_events | Transaction ตรงไปตรงมา | ขัดกับสถาปัตยกรรม (Prisma เป็นเจ้าของตาราง) และ Service ต้องถือสองการเชื่อมต่อใน Transaction เดียวไม่ได้ |

**ผู้ตัดสินใจเลือกข้อ 1** (2026-11-13) เพราะคง Prisma เป็นเจ้าของ schema และให้ Transaction เดียวกับข้อมูลโดยไม่ต้องมี adapter ต่อ Service

## 5. การออกแบบ (ส่วนที่ตกลงแล้ว)

### 5.1 ฝั่งผู้ส่ง
```ts
// ภายใน Prisma $transaction ของ Service
await outbox.add(tx, {
  type: 'JobSubmitted', version: 1,
  aggregateId: job.id, correlationId, payload,
});
```
- `tx` ถูกกำหนดเป็น interface เชิงโครงสร้างที่ต้องการแค่ `tx.outboxEvent.create({ data })` ซึ่ง Prisma tx client เข้ากันได้โดยไม่ต้อง import Prisma
- `event_id` = `outbox_events.id` (สร้าง UUID v4 ในฝั่ง lib); คอลัมน์ตาม [data-schema.md](../../data-schema.md) §2.2 (`id`, `type`, `version`, `aggregate_id`, `payload`, `correlation_id`, `created_at`, `published_at`, `attempts`)

### 5.2 Relay
- ทำงานเป็น background loop ใน Service ที่ publish; ต่อ Postgres ด้วย `pg` ผ่าน `<PREFIX>_DIRECT_URL`
- วนอ่านแถว `published_at IS NULL` เรียงตาม `created_at` (จำกัดจำนวนต่อรอบ), publish แบบ confirm แล้ว mark `published_at`
- **มี relay ทำงานได้ครั้งละหนึ่งตัวต่อฐานข้อมูล** (ใช้ Postgres advisory lock) เพื่อรักษาลำดับต่อ `aggregate_id`
- ถ้า publish ล้มเหลว: เพิ่ม `attempts`, หยุดรอบนั้น (ไม่ข้ามแถวไปส่งแถวหลัง), พักแล้วลองใหม่
- ความถี่: ทุก 2 วินาทีเมื่อมีงาน, พักนานขึ้นเมื่อไม่มีงาน (ค่าตาม architecture §7)
- สร้าง Envelope จากแถว: `occurred_at` = `created_at`, `producer` = ชื่อ Service ที่ตั้งค่า; message ตาม event-contract §2 (`content_type: application/json`, `delivery_mode: 2`, `message_id = event_id`, header `x-correlation-id`)

### 5.3 ฝั่งผู้รับ
```ts
consumer.on({ producer: 'job', type: 'JobSubmitted' }, async (envelope, tx) => { ... });
```
- Service ส่งฟังก์ชัน `runInTransaction(fn)` (ห่อ Prisma `$transaction`) ตอนตั้งค่า
- ต่อ 1 message: เปิด Transaction → `processed_events` insert แบบ skip duplicate (ไม่ได้แถวใหม่ = ซ้ำ → ข้ามและ ack) → เรียก handler ด้วย `tx` เดียวกัน → commit → **ack หลัง commit**
- handler ล้มเหลว = rollback ทั้งก้อน (รวมตัวกันซ้ำ) จึงลองใหม่ได้ถูกต้อง
- Consumer **ต้องไม่ล้มเมื่อเจอฟิลด์ที่ไม่รู้จัก** (event-contract §3.5); `version` ที่ไม่รู้จักถือเป็นข้อผิดพลาดไม่ลองใหม่ → DLQ

### 5.4 Topology และ Retry/DLQ
- Exchange `internpath.events` (topic, durable) และ `internpath.dlx`; ใช้ค่าคงที่และ `routingKey()` จาก `libs/contracts`
- Queue ต่อ Consumer ชื่อ `<consumer>.<EventType>` ผูกกับ `<producer>.<EventType>`; DLQ ชื่อ `<consumer>.<EventType>.dlq`
- Retry: **3 คิวร่วมต่อ Service** (หน่วง 5 วินาที / 30 วินาที / 2 นาที ตั้ง TTL ที่ตัวคิว ไม่ใช่ต่อ message เพื่อไม่ให้คิวติดหัวแถว); เก็บจำนวนครั้งใน header `x-retry-count`; ครบ 3 ครั้งแล้วล้มอีก → DLQ
- ข้อผิดพลาดที่ลองใหม่ไม่มีประโยชน์ (envelope เสีย, version ไม่รู้จัก) → DLQ ทันที
- DLQ: เรียก `onDeadLetter` + log ระดับ `error` (ไม่ log payload)

### 5.5 การตั้งค่าและการใช้งาน
- ค่าที่อ่าน: `RABBITMQ_URL` เท่านั้นสำหรับ broker (รองรับ `amqp://` และ `amqps://`)
- ชื่อ Service และ DB URL ส่งตอนตั้งค่า module (ไม่ hardcode ใน lib)
- Export ผ่าน `libs/common/src/index.ts`; มี Nest module ให้ Service import และปิด connection อย่างถูกต้องตอน shutdown
- เปิดสถานะ connection ให้ `/ready` ใช้ตรวจ Broker

### 5.6 การทดสอบ
- **Unit test** (Mocha + Chai + Sinon, mock `amqplib`/`pg`): การสร้าง envelope, ลำดับ/การหยุดของ relay เมื่อ publish ล้ม, การกันซ้ำ, นับ retry และเข้า DLQ, ack หลัง commit
- **Integration test หนึ่งชุด** กับ RabbitMQ และ Postgres จริงใน Docker (`pnpm infra:up`) ครอบคลุม: ส่งผ่าน outbox → ถึง consumer, ส่งซ้ำไม่ประมวลผลสองครั้ง, handler ล้ม → retry ตามหน่วง → DLQ ตารางทดสอบสร้างเอง ไม่พึ่ง Prisma; **ข้ามอัตโนมัติ** ถ้าต่อ broker/DB ไม่ได้
- CI ปัจจุบันรันเฉพาะ unit test (ไม่บังคับมี Docker)

## 6. เอกสารและไฟล์ที่ต้องอัปเดตใน PR เดียวกัน

1. `developer-guide.md` §7: ติ๊ก "Outbox relay และ Consumer"; §6.3 ข้อ 3-4: เปลี่ยนเป็นวิธีเรียก helper จริง
2. `architecture.md` §3: `libs/common` จาก "Outbox publisher" เป็น Outbox relay + Consumer + Retry/DLQ
3. `event-contract.md` §3.3: ปรับถ้ากลไก retry ที่ทำจริงต่างจากที่เขียน (ดู §7)
4. **เสนอเพิ่ม (ลบทิ้งได้ถ้าไม่เห็นด้วย):** `docker-compose.yml` ให้ Postgres/RabbitMQ/MinIO bind `127.0.0.1` และเพิ่ม `restart: unless-stopped` (งานค้างใน developer-guide §7 ที่อยู่ในไฟล์เดียวกับที่ใช้ทดสอบ)

## 7. ปล่อยให้ผู้ลงมือตัดสิน

- **กลไกคืน message จาก retry queue ไปยังคิวต้นทาง** ภายใต้เพดานคิวของ CloudAMQP: TTL + DLX ต้องตรวจเรื่อง routing key ที่ติดไปกับ message ที่ถูก dead-letter ให้ชัดเจนแล้วยืนยันกับ RabbitMQ จริงด้วย integration test ถ้าต่างจาก event-contract §3.3 ให้แก้เอกสาร ไม่ใช่ฝืนโค้ด
- ขนาด batch, ช่วงพักของ relay, prefetch ของ consumer, โครงโฟลเดอร์ภายใน `outbox/` และ `messaging/`
- ชื่อ method/class ที่แน่นอน ตราบที่ผู้ใช้เรียกได้ตามรูปแบบใน §5.1 และ §5.3

## 8. ข้อสมมติที่ผู้เขียนตัดสินเอง (ตรวจได้)

- เลือกให้ relay ทำงานหนึ่งตัวต่อฐานข้อมูลด้วย advisory lock (ง่ายกว่าและรักษาลำดับ; เพียงพอกับขนาดโครงงาน)
- DLQ แจ้ง Admin ผ่าน log + hook ก่อน ยังไม่ผูก Notification (Service นั้นยังไม่มี)
- integration test ใช้ตารางที่สร้างเองในฐาน `internpath` ของ Docker ไม่ใช่ฐานของ Service
