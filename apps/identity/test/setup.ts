// ปิด Log ระหว่างรันเทสต์ (ต้องตั้งก่อน import AppModule)
process.env.LOG_LEVEL = 'silent';
// เทสต์พื้นฐาน/CI ไม่มี Postgres และ RabbitMQ
process.env.DISABLE_INFRA = 'true';
