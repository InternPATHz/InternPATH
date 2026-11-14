import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Global, INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AppException, OutboxWriter } from '@internpath/common';
import { expect } from 'chai';
import { Client } from 'pg';
import { AccountDeletionModule } from '../../src/modules/account-deletion/account-deletion.module';
import { AccountDeletionService, DELETION_ELIGIBILITY, DeletionEligibility } from '../../src/modules/account-deletion/account-deletion.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';

const APP_ROOT = path.resolve(__dirname, '../..');
const ROOT_ENV = path.resolve(APP_ROOT, '../../.env');
function adminUrl(): string | undefined {
  if (process.env.IDENTITY_IT_ADMIN_URL) return process.env.IDENTITY_IT_ADMIN_URL;
  if (!existsSync(ROOT_ENV)) return undefined;
  const line = readFileSync(ROOT_ENV, 'utf8').split(/\r?\n/).find((value) => value.startsWith('IDENTITY_DIRECT_URL='));
  if (!line) return undefined;
  const url = new URL(line.slice('IDENTITY_DIRECT_URL='.length).replace(/^"|"$/g, ''));
  url.pathname = '/postgres';
  return url.toString();
}

@Global()
@Module({ providers: [OutboxWriter], exports: [OutboxWriter] })
class StubMessagingModule {}

describe('Identity account deletion (Postgres)', function () {
  this.timeout(90_000);
  let admin: Client;
  let dbName: string;
  let app: INestApplication;
  let db: PrismaService;
  let service: AccountDeletionService;
  let allowApplications = true;
  const eligibility: DeletionEligibility = {
    async assertNoActiveApplications() {
      if (!allowApplications) throw new AppException('DELETION_BLOCKED', 'Active application', 422);
    },
  };

  before(async function () {
    const base = adminUrl();
    if (!base) this.skip();
    admin = new Client({ connectionString: base, connectionTimeoutMillis: 2000 });
    try { await admin.connect(); await admin.query('SELECT 1'); }
    catch { await admin.end().catch(() => undefined); this.skip(); }
    dbName = `id_del_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(base);
    url.pathname = `/${dbName}`;
    const testUrl = url.toString();
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: APP_ROOT, env: { ...process.env, IDENTITY_DATABASE_URL: testUrl, IDENTITY_DIRECT_URL: testUrl }, stdio: 'pipe',
    });
    process.env.IDENTITY_DATABASE_URL = testUrl;
    process.env.IDENTITY_DIRECT_URL = testUrl;
    const moduleRef = await Test.createTestingModule({ imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), PrismaModule, StubMessagingModule, AccountDeletionModule,
    ] }).overrideProvider(DELETION_ELIGIBILITY).useValue(eligibility).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    db = app.get(PrismaService);
    service = app.get(AccountDeletionService);
  });

  after(async () => {
    await app?.close();
    if (dbName && admin) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end().catch(() => undefined);
    delete process.env.IDENTITY_DATABASE_URL;
    delete process.env.IDENTITY_DIRECT_URL;
  });

  it('anonymizes a student, revokes tokens, and emits E15/E16 once', async () => {
    const email = 'student@example.test';
    const user = await db.user.create({ data: { email, passwordHash: 'old-hash', fullName: 'Student Name',
      phone: '0800000000', role: 'STUDENT', status: 'ACTIVE', emailVerifiedAt: new Date(),
      studentProfile: { create: { studentCode: 'S-01', major: 'CS', yearLevel: 3 } },
      consents: { create: { type: 'PRIVACY_POLICY', policyVersion: 'v1' } },
      refreshTokens: { create: { tokenHash: 'refresh-01', familyId: randomUUID(), expiresAt: new Date(Date.now() + 60_000) } },
      emailTokens: { create: { purpose: 'RESET_PASSWORD', tokenHash: 'email-01', expiresAt: new Date(Date.now() + 60_000) } },
    } });
    await db.statusHistory.create({ data: { entity: 'USER', entityId: user.id, toStatus: 'ACTIVE',
      actorId: user.id, actorRole: 'STUDENT', correlationId: randomUUID() } });
    await db.adminAuditLog.create({ data: { adminId: user.id, action: 'TEST', targetType: 'USER',
      targetId: user.id, correlationId: randomUUID() } });
    const requestId = await service.request(user.id);
    expect(await service.request(user.id)).to.equal(requestId);
    const requestedAt = (await db.deletionRequest.findUniqueOrThrow({ where: { id: requestId } })).requestedAt.toISOString();
    await service.complete(requestId);
    await service.complete(requestId);

    const deleted = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(deleted.status).to.equal('DELETED');
    expect(deleted.email).to.not.equal(email);
    expect(deleted.fullName).to.equal('ผู้ใช้ที่ลบบัญชีแล้ว');
    expect(deleted.phone).to.equal(null);
    expect(deleted.passwordHash).to.not.equal('old-hash');
    expect(await db.studentProfileIdentity.count({ where: { userId: user.id } })).to.equal(0);
    expect(await db.consent.count({ where: { userId: user.id } })).to.equal(0);
    expect(await db.refreshToken.count({ where: { userId: user.id } })).to.equal(0);
    expect(await db.emailToken.count({ where: { userId: user.id } })).to.equal(0);
    expect(await db.tokenDenylist.count({ where: { userId: user.id } })).to.equal(1);
    const event = await db.outboxEvent.findFirstOrThrow({ where: { type: 'UserDeletionRequested', aggregateId: user.id } });
    const payload = event.payload as { requested_at: string; anonymous_actor_id: string; mode: string };
    expect(payload.requested_at).to.equal(requestedAt);
    expect(payload.mode).to.equal('DELETE_AND_ANONYMIZE');
    expect((await db.statusHistory.findMany({ where: { entityId: user.id } })).map((row) => row.actorId))
      .to.deep.equal([payload.anonymous_actor_id, payload.anonymous_actor_id]);
    expect((await db.adminAuditLog.findFirstOrThrow({ where: { targetId: user.id } })).adminId)
      .to.equal(payload.anonymous_actor_id);
    expect(await db.outboxEvent.count({ where: { aggregateId: user.id, type: 'UserDeletionRequested' } })).to.equal(1);
    expect(await db.outboxEvent.count({ where: { aggregateId: user.id, type: 'UserSuspended' } })).to.equal(1);
    expect((await db.deletionRequest.findUniqueOrThrow({ where: { id: requestId } })).status).to.equal('COMPLETED');
  });

  it('blocks active applications without changing the account', async () => {
    const user = await db.user.create({ data: { email: 'blocked@example.test', passwordHash: 'hash',
      fullName: 'Blocked', role: 'STUDENT', status: 'ACTIVE' } });
    const requestId = await service.request(user.id);
    allowApplications = false;
    try { await service.complete(requestId); expect.fail('Expected DELETION_BLOCKED'); }
    catch (error) { expect(error).to.be.instanceOf(AppException); expect((error as AppException).code).to.equal('DELETION_BLOCKED'); }
    finally { allowApplications = true; }
    expect((await db.deletionRequest.findUniqueOrThrow({ where: { id: requestId } })).status).to.equal('BLOCKED');
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).email).to.equal('blocked@example.test');
    expect(await db.outboxEvent.count({ where: { aggregateId: user.id } })).to.equal(0);
  });

  it('requires HR Owner transfer before requesting deletion', async () => {
    const company = await db.company.create({ data: { name: 'Owner Co', registrationNo: 'REG-DEL', emailDomain: 'owner.test' } });
    const owner = await db.user.create({ data: { email: 'owner@owner.test', passwordHash: 'hash',
      fullName: 'Owner', role: 'COMPANY_HR', status: 'ACTIVE',
      companyMember: { create: { companyId: company.id, memberRole: 'OWNER' } } } });
    try { await service.request(owner.id); expect.fail('Expected DELETION_BLOCKED'); }
    catch (error) { expect(error).to.be.instanceOf(AppException); expect((error as AppException).code).to.equal('DELETION_BLOCKED'); }
    expect(await db.deletionRequest.count({ where: { userId: owner.id } })).to.equal(0);
  });

  it('unlinks students when an advisor is deleted', async () => {
    const advisor = await db.user.create({ data: { email: 'advisor@uni.test', passwordHash: 'hash',
      fullName: 'Advisor', role: 'ADVISOR', status: 'ACTIVE',
      advisorProfile: { create: { department: 'CS' } } } });
    const student = await db.user.create({ data: { email: 'linked@uni.test', passwordHash: 'hash',
      fullName: 'Linked', role: 'STUDENT', status: 'ACTIVE',
      studentProfile: { create: { studentCode: 'S-02', major: 'CS', yearLevel: 3,
        advisorId: advisor.id, advisorLinkStatus: 'LINKED' } } } });
    await service.complete(await service.request(advisor.id));
    const link = await db.studentProfileIdentity.findUniqueOrThrow({ where: { userId: student.id } });
    expect(link.advisorId).to.equal(null);
    expect(link.advisorLinkStatus).to.equal('NONE');
    const event = await db.outboxEvent.findFirstOrThrow({ where: { type: 'AdvisorLinkChanged', aggregateId: student.id } });
    expect(event.payload).to.include({ old_advisor_id: advisor.id, link_status: 'UNLINKED' });
    expect((await db.user.findUniqueOrThrow({ where: { id: student.id } })).version).to.equal(2);
    expect(await db.advisorProfile.count({ where: { userId: advisor.id } })).to.equal(0);
  });

  it('removes an HR member and pseudonymizes invitation history', async () => {
    const company = await db.company.create({ data: { name: 'Member Co', registrationNo: 'REG-MEMBER-DEL',
      emailDomain: 'member.test' } });
    const member = await db.user.create({ data: { email: 'member@member.test', passwordHash: 'hash',
      fullName: 'Member', role: 'COMPANY_HR', status: 'ACTIVE',
      companyMember: { create: { companyId: company.id, memberRole: 'MEMBER' } } } });
    await db.companyInvitation.create({ data: { companyId: company.id, email: member.email,
      tokenHash: 'invite-member', invitedBy: member.id, expiresAt: new Date(Date.now() + 60_000),
      acceptedAt: new Date() } });
    await service.complete(await service.request(member.id));
    expect(await db.companyMember.count({ where: { userId: member.id } })).to.equal(0);
    const invitation = await db.companyInvitation.findFirstOrThrow({ where: { tokenHash: 'invite-member' } });
    expect(invitation.email).to.not.equal(member.email);
    expect(invitation.invitedBy).to.not.equal(member.id);
    const event = await db.outboxEvent.findFirstOrThrow({ where: { type: 'UserDeletionRequested', aggregateId: member.id } });
    expect(event.payload).to.include({ company_id: company.id, role: 'COMPANY_HR' });
  });
});
