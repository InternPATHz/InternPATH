import { expect } from 'chai';
import { DEFAULT_RULES } from '../../src/screening/defaults';
import { evaluateJob } from '../../src/screening/evaluate';
import type { EvaluationInput, JobContent, Rules } from '../../src/screening/types';

const LONG = 'พัฒนาเว็บแอปพลิเคชันร่วมกับทีมวิศวกรอาวุโสและเรียนรู้กระบวนการทำงานจริงของบริษัท '.repeat(2);

function baseContent(over: Partial<JobContent> = {}): JobContent {
  return {
    job_title: 'นักศึกษาฝึกงานด้านพัฒนาซอฟต์แวร์',
    description: LONG,
    responsibilities: 'เขียนโค้ดและทดสอบ',
    qualifications: 'กำลังศึกษาด้านคอมพิวเตอร์',
    allowance_text: 'เบี้ยเลี้ยงรายเดือน',
    location: 'กรุงเทพฯ',
    ...over,
  };
}

function input(over: Partial<EvaluationInput> = {}, content: Partial<JobContent> = {}): EvaluationInput {
  return {
    content: baseContent(content),
    hours_per_week: 35,
    allowance: { type: 'AMOUNT', amount_thb: 5000 },
    company_flag_under_review: false,
    ...over,
  };
}

function withRule(code: string, patch: { weight?: number; enabled?: boolean }): Rules {
  return {
    ...DEFAULT_RULES,
    riskRules: DEFAULT_RULES.riskRules.map((r) => (r.code === code ? { ...r, ...patch } : r)),
  };
}

const evaluate = (i: EvaluationInput, rules: Rules = DEFAULT_RULES) => evaluateJob(i, rules);

describe('evaluateJob', () => {
  it('ประกาศปกติ → score 0, LOW, APPROVE', () => {
    const e = evaluate(input());
    expect(e).to.include({ risk_score: 0, risk_level: 'LOW', decision: 'APPROVE', negated_only: false });
    expect(e.matched_keywords).to.deep.equal([]);
  });

  it('คำ HARD ใน job_title ที่ไม่ปฏิเสธ → HIGH + AUTO_REJECT ไม่ว่าคะแนนเท่าไร', () => {
    const e = evaluate(input({}, { job_title: 'ฝึกงาน ค่ามัดจำ 500' }));
    expect(e).to.include({ risk_level: 'HIGH', decision: 'AUTO_REJECT' });
    expect(e.risk_score).to.be.at.least(70);
    expect(e.reasons.map((r) => r.code)).to.include('BLACKLIST_HARD');
    expect(e.reasons.find((r) => r.code === 'BLACKLIST_HARD')!.matched_text).to.equal('ค่ามัดจำ');
  });

  it('คำ HARD ใน description ที่ไม่ปฏิเสธ → AUTO_REJECT', () => {
    const e = evaluate(input({}, { description: LONG + ' ต้องจ่ายค่าสมัคร' }));
    expect(e).to.include({ risk_level: 'HIGH', decision: 'AUTO_REJECT' });
  });

  it('README: "ไม่มีค่ามัดจำ" ใน description → MEDIUM, PENDING_REVIEW, negated_only', () => {
    const e = evaluate(input({}, { description: LONG + ' ไม่มีค่ามัดจำ' }));
    expect(e).to.include({ risk_level: 'MEDIUM', decision: 'PENDING_REVIEW', negated_only: true });
    expect(e.reasons.map((r) => r.code)).to.include('BLACKLIST_NEGATED');
    expect(e.matched_keywords[0].negated).to.equal(true);
  });

  it('README: "ไม่มีค่ามัดจำ แต่ต้องโอนเงินก่อน" → AUTO_REJECT', () => {
    const e = evaluate(input({}, { description: LONG + ' ไม่มีค่ามัดจำ แต่ต้องโอนเงินก่อน' }));
    expect(e).to.include({ risk_level: 'HIGH', decision: 'AUTO_REJECT', negated_only: false });
  });

  it('คำ HARD ในฟิลด์อื่น (responsibilities) → +40 ไม่ใช่ AUTO_REJECT ทันที ผล MEDIUM', () => {
    const e = evaluate(input({}, { responsibilities: 'เก็บค่าสมัครจากผู้เข้าร่วม' }));
    expect(e).to.include({ risk_score: 40, risk_level: 'MEDIUM', decision: 'PENDING_REVIEW' });
    expect(e.reasons.map((r) => r.code)).to.include('HARD_TERM_OTHER_FIELD');
  });

  it('คำ HARD ในฟิลด์อื่นหลายคำ/หลายฟิลด์ นับ +40 ครั้งเดียว', () => {
    const e = evaluate(input({}, { responsibilities: 'เก็บค่าสมัคร', qualifications: 'ต้องมีค่ามัดจำ' }));
    expect(e.risk_score).to.equal(40);
  });

  it('ขอบคะแนน 19/20/69/70 และตัดที่ 100', () => {
    const noAllowance = (w: number) => evaluate(input({ allowance: { type: 'NONE' } }), withRule('NO_ALLOWANCE', { weight: w }));
    expect(noAllowance(19)).to.include({ risk_score: 19, risk_level: 'LOW', decision: 'APPROVE' });
    expect(noAllowance(20)).to.include({ risk_score: 20, risk_level: 'MEDIUM', decision: 'PENDING_REVIEW' });
    expect(noAllowance(69)).to.include({ risk_score: 69, risk_level: 'MEDIUM', decision: 'PENDING_REVIEW' });
    expect(noAllowance(70)).to.include({ risk_score: 70, risk_level: 'HIGH', decision: 'AUTO_REJECT' });
    expect(noAllowance(150).risk_score).to.equal(100);
  });

  it('ตัวอย่างใน spec: เบอร์โทรใน description = 45 MEDIUM; เบอร์โทร + เบี้ยเลี้ยง 40,000 = 75 HIGH', () => {
    const phone = { description: LONG + ' โทร 081-234-5678' };
    const a = evaluate(input({}, phone));
    expect(a).to.include({ risk_score: 45, risk_level: 'MEDIUM', decision: 'PENDING_REVIEW' });
    expect(a.reasons.find((r) => r.code === 'CONTACT_IN_TEXT')).to.not.equal(undefined);
    const b = evaluate(input({ allowance: { type: 'AMOUNT', amount_thb: 40000 } }, phone));
    expect(b).to.include({ risk_score: 75, risk_level: 'HIGH', decision: 'AUTO_REJECT' });
  });

  it('ช่องทางติดต่อในฟิลด์ contact_notes ก็นับ (ครั้งเดียว)', () => {
    const e = evaluate(input({}, { contact_notes: 'line id: abc123 หรืออีเมล hr@example.co.th' }));
    expect(e.risk_score).to.equal(45);
  });

  it('ธง UNDER_REVIEW: LOW → PENDING_REVIEW (reasons มี COMPANY_UNDER_REVIEW); HIGH ยัง AUTO_REJECT', () => {
    const low = evaluate(input({ company_flag_under_review: true }));
    expect(low).to.include({ risk_level: 'LOW', decision: 'PENDING_REVIEW' });
    expect(low.reasons.map((r) => r.code)).to.include('COMPANY_UNDER_REVIEW');
    const high = evaluate(input({ company_flag_under_review: true }, { job_title: 'รับสมัคร mlm' }));
    expect(high).to.include({ risk_level: 'HIGH', decision: 'AUTO_REJECT' });
  });

  it('ALLOWANCE_HIGH (> 30000): 30000 ไม่นับ, 30001 นับ +30', () => {
    expect(evaluate(input({ allowance: { type: 'AMOUNT', amount_thb: 30000 } })).risk_score).to.equal(0);
    expect(evaluate(input({ allowance: { type: 'AMOUNT', amount_thb: 30001 } })).risk_score).to.equal(30);
  });

  it('HOURS_EXCESSIVE: 49 → +25, 45 → +10, 40 → 0', () => {
    expect(evaluate(input({ hours_per_week: 49 })).risk_score).to.equal(25);
    expect(evaluate(input({ hours_per_week: 45 })).risk_score).to.equal(10);
    expect(evaluate(input({ hours_per_week: 40 })).risk_score).to.equal(0);
  });

  it('DESCRIPTION_TOO_SHORT (< 100): 99 → +15, 100 → 0', () => {
    expect(evaluate(input({}, { description: 'ก'.repeat(99) })).risk_score).to.equal(15);
    expect(evaluate(input({}, { description: 'ก'.repeat(100) })).risk_score).to.equal(0);
  });

  it('NO_ALLOWANCE: +5', () => {
    expect(evaluate(input({ allowance: { type: 'NONE' } })).risk_score).to.equal(5);
  });

  it('SOFT_TERMS: ทั้ง 6 คำรวมถูกตัดที่ +30; คำเดียวกันซ้ำนับครั้งเดียว; คำที่ปฏิเสธไม่นับ', () => {
    const all = 'ด่วน รีบสมัคร ที่นั่งจำกัด รับทันที รายได้ดี รายได้ไม่จำกัด';
    expect(evaluate(input({}, { description: LONG + all })).risk_score).to.equal(30);
    expect(evaluate(input({}, { description: LONG + ' ด่วน ด่วน ด่วน' })).risk_score).to.equal(10);
    expect(evaluate(input({}, { description: LONG + ' ไม่รับสมัครด่วน' })).risk_score).to.equal(0);
  });

  it('กฎที่ enabled=false ไม่นับ', () => {
    const e = evaluate(input({ allowance: { type: 'NONE' } }), withRule('NO_ALLOWANCE', { enabled: false }));
    expect(e.risk_score).to.equal(0);
  });

  it('content ที่คืนผ่าน normalizeText แล้ว และ start/end ใช้ตัดข้อความใน content[field] ได้ตรง (มีอักขระความกว้างศูนย์คั่น)', () => {
    const e = evaluate(input({}, { description: LONG + ' ต้องจ่าย ค่า​มัดจำ' }));
    expect(e.content.description).to.not.include('​');
    expect(e.decision).to.equal('AUTO_REJECT');
    const k = e.matched_keywords.find((m) => m.term === 'ค่ามัดจำ')!;
    expect(e.content[k.field as keyof JobContent]!.slice(k.start, k.end)).to.equal('ค่ามัดจำ');
  });

  it('ตัวพิมพ์ต่างกัน: "MLM" ในชื่อตำแหน่ง → AUTO_REJECT', () => {
    expect(evaluate(input({}, { job_title: 'Intern MLM team' })).decision).to.equal('AUTO_REJECT');
  });

  it('ข้อความ 200,000 ตัวอักษรทุกฟิลด์ จบภายใน 1 วินาที', () => {
    const big = 'ก'.repeat(200_000);
    const t0 = Date.now();
    evaluate(
      input(
        {},
        {
          job_title: big,
          description: big,
          responsibilities: big,
          qualifications: big,
          allowance_text: big,
          location: big,
          contact_notes: big,
        },
      ),
    );
    expect(Date.now() - t0).to.be.lessThan(1000);
  });

  it('reasons ต่อคำ ไม่ใช่ต่อครั้งที่ปรากฏ: "ค่ามัดจำ" สามครั้ง → BLACKLIST_HARD หนึ่งรายการ (ผลรีวิว #4)', () => {
    const e = evaluate(input({}, { description: LONG + ' ค่ามัดจำ ค่ามัดจำ ค่ามัดจำ' }));
    expect(e.reasons.filter((r) => r.code === 'BLACKLIST_HARD')).to.have.length(1);
  });

  it('ข้อความ 200,000 ตัวอักษรที่ซ้ำคำต้องห้าม: reasons/matched_keywords มีขนาดจำกัด และไม่ล้มด้วย RangeError (คำ 1 ตัวอักษรที่ Admin เพิ่ม)', () => {
    const rules: Rules = { ...DEFAULT_RULES, blacklist: [...DEFAULT_RULES.blacklist, { term: 'ก', severity: 'SOFT', weight: 1 }] };
    for (const text of ['mlm'.repeat(66_000), 'ก'.repeat(200_000), 'ไม่มีmlm '.repeat(25_000)]) {
      const e = evaluate(input({}, { description: text }), rules);
      expect(e.reasons.length, 'reasons').to.be.lessThan(50);
      expect(e.matched_keywords.length, 'matched_keywords').to.be.at.most(1000);
      expect(JSON.stringify(e.reasons).length).to.be.lessThan(20_000);
    }
  });

  it('DEFAULT_RULES: 17 HARD, 6 SOFT, 8 cues, 8 กฎ รวม NEGATION_WINDOW=12', () => {
    expect(DEFAULT_RULES.blacklist.filter((t) => t.severity === 'HARD')).to.have.length(17);
    expect(DEFAULT_RULES.blacklist.filter((t) => t.severity === 'SOFT')).to.have.length(6);
    expect(DEFAULT_RULES.negationCues).to.have.length(8);
    expect(DEFAULT_RULES.riskRules).to.have.length(8);
    expect(DEFAULT_RULES.riskRules.find((r) => r.code === 'NEGATION_WINDOW')!.params.max_gap).to.equal(12);
  });

  it('คำ HARD ตั้งต้นทุกคำทำให้ title ถูก AUTO_REJECT และ SOFT ทุกคำมี weight', () => {
    for (const t of DEFAULT_RULES.blacklist) {
      if (t.severity === 'HARD') {
        expect(evaluate(input({}, { job_title: `งาน ${t.term}` })).decision, t.term).to.equal('AUTO_REJECT');
      } else {
        expect(t.weight, t.term).to.be.a('number');
      }
    }
  });

  it('ผลบวกลวงของค่าตั้งต้น: ข้อความงานปกติด้านวิศวกรรม/การตลาดไม่ติดคำต้องห้าม', () => {
    const e = evaluate(
      input(
        {},
        {
          description: LONG + ' ทำงานกับเครือข่ายองค์กร พัฒนา API ออกแบบฐานข้อมูล วิเคราะห์ข้อมูลการตลาดออนไลน์ และ network security',
          responsibilities: 'ดูแลระบบเครือข่าย เขียนเอกสารทดสอบ',
        },
      ),
    );
    expect(e).to.include({ decision: 'APPROVE', risk_score: 0 });
  });
});
