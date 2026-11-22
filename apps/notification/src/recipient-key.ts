import { createHash } from 'node:crypto';

export const recipientKey = (userId: string) =>
  createHash('sha256').update(userId.toLowerCase()).digest('hex');
