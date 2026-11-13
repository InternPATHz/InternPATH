// ปิด Log ระหว่างรันเทสต์ (ต้องตั้งก่อน import AppModule)
process.env.LOG_LEVEL = 'silent';
// เทสต์พื้นฐาน/CI ไม่มี DB และ RabbitMQ — AppModule จึงไม่โหลด VerificationModule (ดู src/app.module.ts)
process.env.DISABLE_INFRA = 'true';
