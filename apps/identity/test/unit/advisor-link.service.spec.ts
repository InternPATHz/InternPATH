import { randomUUID } from 'node:crypto';
import { AppException, OutboxWriter } from '@internpath/common';
import { expect } from 'chai';
import { Prisma } from '../../generated/client';
import { AdvisorLinkService } from '../../src/modules/advisor-links/advisor-link.service';
import { AuthMailer } from '../../src/modules/auth/auth.mailer';
import { AuthService } from '../../src/modules/auth/auth.service';
import { PrismaService } from '../../src/prisma/prisma.service';

const advisorId = randomUUID();
const universityId = randomUUID();
const body = { email: 'new@test.ac.th', full_name: 'นักศึกษา', student_code: ' s6610010 ', major: 'CS', year_level: 4 };

/** Transaction ล้มด้วย P2034 (คำขอพร้อมกัน) แล้วดูว่ากิ่ง catch หารหัสซ้ำอย่างไร */
function serviceAfterSerializationFailure(codeTaken: boolean) {
  const lookups: unknown[] = [];
  const db = {
    user: {
      findUnique: async ({ where }: { where: { id?: string; email?: string } }) => (where.id === advisorId
        ? { id: advisorId, role: 'ADVISOR', status: 'ACTIVE', emailVerifiedAt: new Date(), universityId }
        : null),
    },
    university: { findUniqueOrThrow: async () => ({ id: universityId, emailDomain: 'test.ac.th' }) },
    studentProfileIdentity: {
      findFirst: async (args: unknown) => { lookups.push(args); return codeTaken ? { userId: randomUUID() } : null; },
    },
    $transaction: async () => {
      throw new Prisma.PrismaClientKnownRequestError('could not serialize access', { code: 'P2034', clientVersion: 'test' });
    },
  } as unknown as PrismaService;
  const service = new AdvisorLinkService(db, {} as OutboxWriter, {} as AuthService, {} as AuthMailer);
  return { service, lookups };
}

describe('AdvisorLinkService.createStudent serialization failure (P2034)', () => {
  it('looks up a duplicate code by the profile university_id and answers STUDENT_CODE_ALREADY_USED', async () => {
    const { service, lookups } = serviceAfterSerializationFailure(true);
    const error = await service.createStudent(advisorId, body, randomUUID()).then(() => null, (e: unknown) => e);
    expect(error).to.be.instanceOf(AppException).and.include({ code: 'STATE_CONFLICT' });
    expect((error as AppException).getStatus()).to.equal(409);
    expect((error as AppException).details).to.deep.equal([{ field: 'student_code', issue: 'STUDENT_CODE_ALREADY_USED' }]);
    // ตรงกับ unique (university_id, student_code) ของโปรไฟล์ — ไม่ใช่ users.university_id
    expect(lookups).to.deep.equal([{
      where: { studentCode: 'S6610010', universityId, user: { status: { not: 'DELETED' } } }, select: { userId: true },
    }]);
  });

  it('answers a generic retry 409 when neither the email nor the code is taken', async () => {
    const { service } = serviceAfterSerializationFailure(false);
    const error = await service.createStudent(advisorId, body, randomUUID()).then(() => null, (e: unknown) => e);
    expect(error).to.be.instanceOf(AppException).and.include({ code: 'STATE_CONFLICT' });
    expect((error as AppException).getStatus()).to.equal(409);
    expect((error as AppException).details ?? []).to.deep.equal([]);
  });
});
