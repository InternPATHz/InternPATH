import type { Prisma } from '../../generated/client';

/** Job transaction client, compatible with the shared OutboxTx and ProcessedEventsTx. */
export type Tx = Prisma.TransactionClient;
