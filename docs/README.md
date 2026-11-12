# 📚 เอกสารเทคนิค (Technical Docs)

[README หลัก](../README.md) เก็บ **กฎธุรกิจ** ของระบบ ส่วนโฟลเดอร์นี้เก็บรายละเอียดเชิงเทคนิค

| เอกสาร | เนื้อหา |
| :--- | :--- |
| [getting-started.md](getting-started.md) | ติดตั้งเครื่องมือ, ตั้งค่า `.env`, รันโปรเจกต์, คำสั่งที่ใช้บ่อย |
| [developer-guide.md](developer-guide.md) | คู่มือสำหรับคนที่จะเขียนโค้ดต่อ: โครงของ Service, กฎที่ห้ามฝ่าฝืน, สูตรเพิ่ม Endpoint/ตาราง/Event, สิ่งที่ยังไม่มี |
| [architecture.md](architecture.md) | ภาพรวมระบบ, Service และเจ้าของ, Monorepo, การสื่อสาร Sync/Async, Security, Background Jobs, Environment, Open Decisions |
| [api-contract.md](api-contract.md) | REST Endpoint ทั้งหมด, สิทธิ์ตาม Role, รูปแบบ Error, Internal API |
| [event-contract.md](event-contract.md) | Event ทั้งหมด, Envelope, Payload, RabbitMQ Routing, Retry/DLQ, Idempotency |
| [data-schema.md](data-schema.md) | ตาราง/ฟิลด์ของแต่ละ Service, Enum สถานะ และ State Machine (ใบสมัคร, ประกาศงาน ฯลฯ) |
| [diagram.md](diagram.md) | Diagram ประกอบ (Mermaid): Use Case, Sequence, Class, ER — สร้างจาก api/event/data-schema ถ้าขัดกันให้ยึดเอกสารต้นทาง |

**ถ้าเพิ่ง clone มา** ให้เริ่มที่ [getting-started.md](getting-started.md) แล้วต่อด้วย [developer-guide.md](developer-guide.md)
