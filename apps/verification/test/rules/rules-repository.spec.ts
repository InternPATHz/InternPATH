import { expect } from 'chai';
import { DEFAULT_RULES } from '../../src/screening/defaults';
import { RulesRepository } from '../../src/rules/rules.repository';
import type { Rules } from '../../src/screening/types';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';

const sorted = (r: Rules): Rules => ({
  blacklist: [...r.blacklist].sort((a, b) => a.term.localeCompare(b.term)),
  negationCues: [...r.negationCues].sort(),
  riskRules: [...r.riskRules].sort((a, b) => a.code.localeCompare(b.code)),
});

describe('RulesRepository (Postgres จริง)', function () {
  this.timeout(60000);
  let db: TestDatabase;
  let repo: RulesRepository;

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    repo = new RulesRepository();
  });
  after(async () => {
    await db?.drop();
  });

  it('ค่าที่ seed ไว้ใน migration เท่ากับ DEFAULT_RULES', async () => {
    const loaded = await repo.load(db.prisma);
    expect(sorted(loaded)).to.deep.equal(sorted(DEFAULT_RULES));
  });

  it('แถวที่ enabled=false ไม่ถูกโหลด (คำ, cue, กฎ)', async () => {
    await db.prisma.blacklistTerm.update({ where: { term: 'ลงทุน' }, data: { enabled: false } });
    await db.prisma.negationCue.update({ where: { cue: 'no' }, data: { enabled: false } });
    await db.prisma.riskRule.update({ where: { code: 'CONTACT_IN_TEXT' }, data: { enabled: false } });
    const loaded = await repo.load(db.prisma);
    expect(loaded.blacklist.map((t) => t.term)).to.not.include('ลงทุน');
    expect(loaded.blacklist).to.have.length(22);
    expect(loaded.negationCues).to.not.include('no');
    expect(loaded.riskRules.map((r) => r.code)).to.not.include('CONTACT_IN_TEXT');
  });

  it('โหลดภายใน Transaction (tx) ได้เช่นเดียวกัน', async () => {
    const loaded = await db.prisma.$transaction((tx) => repo.load(tx));
    expect(loaded.blacklist).to.have.length(22);
  });
});
