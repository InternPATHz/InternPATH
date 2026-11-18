import { randomUUID } from 'node:crypto';
import { expect } from 'chai';
import type { IdentityInternalClient } from '../../src/internal/identity-client.service';
import { STUDENT_NAMES_BATCH_MAX, StudentNamesService } from '../../src/internal/student-names.service';
import { FakeIdentity } from '../support/profile-resume-fakes';

describe('StudentNamesService (Unit)', () => {
  const build = () => {
    const identity = new FakeIdentity();
    return { identity, service: new StudentNamesService(identity as unknown as IdentityInternalClient) };
  };

  it('ตัด id ซ้ำ แบ่งเรียกครั้งละไม่เกิน 100 และคืนชื่อว่างให้ id ที่ Identity ไม่รู้จัก', async () => {
    const { identity, service } = build();
    const ids = Array.from({ length: STUDENT_NAMES_BATCH_MAX + 5 }, () => randomUUID());
    ids.forEach((id, i) => identity.setStudent(id, { full_name: `นักศึกษา ${i}` }));
    const unknown = randomUUID();

    const names = await service.names([...ids, ids[0], unknown]);
    expect(identity.nameCalls.map((c) => c.length)).to.deep.equal([STUDENT_NAMES_BATCH_MAX, 6]);
    expect(names.size).to.equal(ids.length + 1);
    expect(names.get(ids[0])).to.equal('นักศึกษา 0');
    expect(names.get(ids[STUDENT_NAMES_BATCH_MAX + 4])).to.equal(`นักศึกษา ${STUDENT_NAMES_BATCH_MAX + 4}`);
    expect(names.get(unknown)).to.equal('');
  });

  it('Identity ล่ม ⇒ ไม่ throw คืนชื่อว่างทุกคน • ไม่มี id ⇒ ไม่เรียก Identity', async () => {
    const { identity, service } = build();
    const id = randomUUID();
    identity.setStudent(id);
    identity.unavailable = true;
    expect(await service.name(id)).to.equal('');

    identity.unavailable = false;
    expect((await service.names([])).size).to.equal(0);
    expect(identity.nameCalls).to.have.length(0);
  });
});
