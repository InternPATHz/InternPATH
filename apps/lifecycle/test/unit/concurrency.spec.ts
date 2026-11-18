import { expect } from 'chai';
import { mapWithConcurrency } from '../../src/common/async/concurrency';

describe('mapWithConcurrency', () => {
  it('คงลำดับผลลัพธ์ตาม input แม้แต่ละงานเสร็จไม่พร้อมกัน', async () => {
    const out = await mapWithConcurrency([30, 5, 20, 1], 2, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    expect(out).to.deep.equal(['0:30', '1:5', '2:20', '3:1']);
  });

  it('ทำพร้อมกันไม่เกิน limit', async () => {
    let running = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 25 }, (_, i) => i), 4, async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 2));
      running--;
    });
    expect(peak).to.equal(4);
  });

  it('รายการว่าง ⇒ [] และ limit ไม่ถูกต้อง ⇒ RangeError', async () => {
    expect(await mapWithConcurrency([], 3, async () => 1)).to.deep.equal([]);
    let error: unknown;
    try {
      await mapWithConcurrency([1], 0, async () => 1);
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(RangeError);
  });

  it('fn throw ⇒ reject ทั้งชุด', async () => {
    let error: unknown;
    try {
      await mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      });
    } catch (e) {
      error = e;
    }
    expect((error as Error).message).to.equal('boom');
  });
});
