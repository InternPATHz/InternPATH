import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect } from 'chai';
import { DirectoryJobClient } from '../../src/modules/directory/directory-job.client';
import { DirectoryQueryDto } from '../../src/modules/directory/directory.dto';
import { DirectoryService } from '../../src/modules/directory/directory.service';
import { PrismaService } from '../../src/prisma/prisma.service';

describe('Directory category filtering', () => {
  it('intersects category companies with requested ids before counting and paging', async () => {
    const matching = randomUUID();
    const other = randomUUID();
    const excluded = randomUUID();
    const whereClauses: unknown[] = [];
    const company = {
      id: matching, name: 'Matched', logoKey: null, universityPartner: true, ratingStats: null,
    };
    const db = {
      company: {
        count: ({ where }: { where: unknown }) => { whereClauses.push(where); return Promise.resolve(1); },
        findMany: ({ where }: { where: unknown }) => { whereClauses.push(where); return Promise.resolve([company]); },
      },
      $transaction: (queries: Promise<unknown>[]) => Promise.all(queries),
    } as unknown as PrismaService;
    const jobs = { companyIds: async () => new Set([matching, excluded]) } as unknown as DirectoryJobClient;
    const service = new DirectoryService(db, new ConfigService({}), jobs);
    const query = Object.assign(new DirectoryQueryDto(), {
      category: 'TECH_IT' as const, ids: `${matching},${other}`, partner: true, page: 1, page_size: 20,
    });
    const result = await service.list(query);
    expect(result.meta.total).to.equal(1);
    expect(result.data.map((item) => item.id)).to.deep.equal([matching]);
    expect(whereClauses).to.deep.equal([
      { status: 'VERIFIED', id: { in: [matching] }, universityPartner: true },
      { status: 'VERIFIED', id: { in: [matching] }, universityPartner: true },
    ]);
  });

  it('returns an empty page without querying Identity when Job has no matching companies', async () => {
    const db = { company: { count: () => { throw new Error('unexpected query'); } } } as unknown as PrismaService;
    const jobs = { companyIds: async () => new Set<string>() } as unknown as DirectoryJobClient;
    const service = new DirectoryService(db, new ConfigService({}), jobs);
    const result = await service.list(Object.assign(new DirectoryQueryDto(), { category: 'TECH_IT' as const }));
    expect(result).to.deep.equal({ data: [], meta: { page: 1, page_size: 20, total: 0 } });
  });
});
