import { randomUUID } from 'node:crypto';
import { expect } from 'chai';
import { DirectoryCompanyIdsService, DIRECTORY_COMPANY_IDS_PAGE_SIZE } from '../../src/modules/internal-jobs/directory-company-ids.service';
import { PrismaService } from '../../src/prisma/prisma.service';

describe('Directory company IDs paging', () => {
  it('uses the last returned company as cursor when another page exists', async () => {
    const rows = Array.from({ length: DIRECTORY_COMPANY_IDS_PAGE_SIZE + 1 }, () => ({ company_id: randomUUID() }));
    const db = { $queryRaw: async () => rows } as unknown as PrismaService;
    const result = await new DirectoryCompanyIdsService(db).list('TECH_IT');
    expect(result.company_ids).to.have.length(DIRECTORY_COMPANY_IDS_PAGE_SIZE);
    expect(result.next_cursor).to.equal(rows[DIRECTORY_COMPANY_IDS_PAGE_SIZE - 1].company_id);
    expect(result.company_ids).not.to.include(rows[DIRECTORY_COMPANY_IDS_PAGE_SIZE].company_id);
  });
});
