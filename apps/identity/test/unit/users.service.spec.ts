import { randomUUID } from 'node:crypto';
import { expect } from 'chai';
import { UsersService } from '../../src/modules/users/users.service';
import { PrismaService } from '../../src/prisma/prisma.service';

function hrUser(memberRole: 'OWNER' | 'MEMBER', categories: string[]) {
  const companyId = randomUUID();
  return {
    id: randomUUID(), email: 'hr@company.test', fullName: 'HR', phone: null, role: 'COMPANY_HR', status: 'ACTIVE',
    emailVerifiedAt: new Date(), createdAt: new Date(), universityId: null, studentProfile: null, advisorProfile: null,
    companyMember: { companyId, memberRole, categories, company: { id: companyId, name: 'Company', status: 'VERIFIED' } },
  };
}

function serviceFor(user: unknown): UsersService {
  const db = { user: { findUnique: async () => user } } as unknown as PrismaService;
  return new UsersService(db);
}

describe('GET /users/me company categories', () => {
  it('returns the categories the Owner assigned to a Member (job form lists only these)', async () => {
    const me = await serviceFor(hrUser('MEMBER', ['TECH_IT', 'CORPORATE_SERVICES'])).me(randomUUID());
    expect(me.company?.member_role).to.equal('MEMBER');
    expect(me.company?.categories).to.deep.equal(['TECH_IT', 'CORPORATE_SERVICES']);
  });

  it('omits categories for the Owner (Owner covers every category)', async () => {
    const me = await serviceFor(hrUser('OWNER', [])).me(randomUUID());
    expect(me.company?.member_role).to.equal('OWNER');
    expect(me.company).to.not.have.property('categories');
  });
});
