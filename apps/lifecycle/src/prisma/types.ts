import type { Prisma } from '../../generated/client';

/** Transaction client ของ Prisma — ใช้ร่วมกับ OutboxTx/ProcessedEventsTx ของ libs/common */
export type Tx = Prisma.TransactionClient;
