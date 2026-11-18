import { expect } from 'chai';
import { CERTIFICATE_CODE_PATTERN, generateCertificateCode, isCertificateCode } from '../../src/modules/certificates/certificate-code';
import { certificateVerifyUrl } from '../../src/modules/certificates/certificate-pdf.renderer';
import {
  checkCertificateIssuable,
  effectiveMinActualDays,
} from '../../src/modules/certificates/certificate-rules';
import {
  embeddedFontCss,
  escapeHtml,
  formatThaiDate,
  renderCertificateHtml,
} from '../../src/modules/certificates/certificate-template';
import { PublicCertificateRateLimitGuard } from '../../src/modules/certificates/public-rate-limit.guard';
import type { LifecycleConfigService } from '../../src/config/lifecycle-config.service';

const d = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

describe('Lifecycle 1.7 — ใบรับรอง (Unit)', () => {
  describe('certificate_code', () => {
    it('รูปแบบ IP-<ปี>-<8 ตัว Crockford Base32> และสุ่มไม่ซ้ำ', () => {
      const codes = new Set(Array.from({ length: 2000 }, () => generateCertificateCode(new Date('2026-11-18T03:00:00Z'))));
      expect(codes.size).to.equal(2000);
      for (const code of codes) {
        expect(code).to.match(CERTIFICATE_CODE_PATTERN);
        expect(code.startsWith('IP-2026-')).to.equal(true);
        expect(code.slice('IP-2026-'.length)).not.to.match(/[ILOU]/);
      }
    });

    it('ปีตามเวลากรุงเทพ — 31 ธ.ค. 18:00 UTC คือ 1 ม.ค. ของปีถัดไปที่ไทย', () => {
      expect(generateCertificateCode(new Date('2026-12-31T16:59:59Z')).startsWith('IP-2026-')).to.equal(true);
      expect(generateCertificateCode(new Date('2026-12-31T17:00:00Z')).startsWith('IP-2027-')).to.equal(true);
    });

    it('isCertificateCode ปฏิเสธรูปแบบผิด (ตัวเล็ก, I/L/O/U, ยาวไม่ตรง, injection)', () => {
      expect(isCertificateCode('IP-2026-ABCD2345')).to.equal(true);
      for (const bad of ['ip-2026-ABCD2345', 'IP-2026-ABCD234', 'IP-2026-ABCD23456', 'IP-2026-ABCDI345', 'IP-26-ABCD2345',
        "IP-2026-ABCD2345' OR 1=1", '', 'IP-2026-ABCD2345/verify-hash']) {
        expect(isCertificateCode(bad), bad).to.equal(false);
      }
    });
  });

  describe('เงื่อนไขออกใบรับรอง (UAT-08 ข้อ 3, UAT-09)', () => {
    const app = (status: string, start: string | null, end: string | null) =>
      ({ status, actualStartDate: start ? d(start) : null, actualEndDate: end ? d(end) : null }) as never;

    it('EVALUATED_PASS ฝึกจริง 30 วันพอดี ⇒ ผ่าน (คืนจำนวนวัน)', () => {
      expect(checkCertificateIssuable(app('EVALUATED_PASS', '2026-06-01', '2026-07-01'), 'PASS', 30)).to.deep.equal({ days: 30 });
    });

    it('ฝึกจริง 29 วัน / ไม่มีวันสิ้นสุดจริง ⇒ 422 CERT_MIN_ACTUAL_DAYS', () => {
      for (const subject of [app('EVALUATED_PASS', '2026-06-01', '2026-06-30'), app('EVALUATED_PASS', '2026-06-01', null)]) {
        const result = checkCertificateIssuable(subject, 'PASS', 30);
        expect('error' in result && result.error.code).to.equal('CERT_MIN_ACTUAL_DAYS');
        expect('error' in result && result.error.getStatus()).to.equal(422);
      }
    });

    it('COMPLETED ที่บริษัทประเมิน PASS ⇒ ผ่าน; COMPLETED ที่ประเมิน FAIL ⇒ 409', () => {
      expect(checkCertificateIssuable(app('COMPLETED', '2026-06-01', '2026-08-01'), 'PASS', 30)).to.have.property('days', 61);
      const fail = checkCertificateIssuable(app('COMPLETED', '2026-06-01', '2026-08-01'), 'FAIL', 30);
      expect('error' in fail && fail.error.getStatus()).to.equal(409);
    });

    it('สถานะอื่น (EVALUATED_FAIL, TERMINATED, IN_PROGRESS, NO_EVALUATION) ⇒ 409 NOT_EVALUATED_PASS', () => {
      for (const status of ['EVALUATED_FAIL', 'TERMINATED', 'IN_PROGRESS', 'NO_EVALUATION', 'FAIL_DISPUTED']) {
        const result = checkCertificateIssuable(app(status, '2026-06-01', '2026-08-01'), 'PASS', 30);
        expect('error' in result && result.error.details?.[0]?.issue, status).to.equal('NOT_EVALUATED_PASS');
      }
    });

    it('ขั้นต่ำจาก config ต่ำกว่า CHECK ของ DB (30) ไม่ได้ แต่สูงกว่าได้', () => {
      expect(effectiveMinActualDays(10)).to.equal(30);
      expect(effectiveMinActualDays(45)).to.equal(45);
    });
  });

  describe('หน้า HTML ของใบรับรอง', () => {
    const base = {
      certificateCode: 'IP-2026-ABCD2345',
      holderName: 'ปิ่นมณี น้ำใส',
      companyName: 'บริษัท ทดสอบ จำกัด',
      jobTitle: 'Backend Intern',
      periodStart: d('2026-06-01'),
      periodEnd: d('2026-08-31'),
      actualDays: 91,
      issuedAt: new Date('2026-11-18T03:00:00Z'),
      verifyUrl: 'https://internpath.test/public/certificates?code=IP-2026-ABCD2345',
      qrDataUrl: 'data:image/png;base64,AAAA',
    };

    it('escape ค่าจากผู้ใช้ทุกตัว (กัน HTML/script injection ตอน render)', () => {
      const html = renderCertificateHtml({
        ...base,
        holderName: '<script>alert(1)</script>',
        companyName: 'A & "B"',
        jobTitle: "<img src=x onerror='x'>",
      });
      expect(html).not.to.include('<script>alert');
      expect(html).not.to.include('<img src=x');
      expect(html).to.include('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).to.include('A &amp; &quot;B&quot;');
      expect(escapeHtml(`<>&"'`)).to.equal('&lt;&gt;&amp;&quot;&#39;');
    });

    it('ฝังฟอนต์ Sarabun ไทย+ละติน ตัวปกติ/ตัวหนา เป็น data URI (ไม่โหลดจากเครือข่าย)', () => {
      const css = embeddedFontCss();
      expect(css.match(/@font-face/g)).to.have.length(4);
      expect(css.match(/src:url\(data:font\/woff2;base64,/g)).to.have.length(4);
      expect(css).to.include('U+0E01-0E5B');
      const html = renderCertificateHtml(base);
      expect(html).not.to.match(/(?:src|href)=["']https?:/);
      expect(html).to.include("font-family: 'Sarabun'");
    });

    it('วันที่เป็นภาษาไทย พ.ศ. และมีรหัส/URL ตรวจสอบบนใบ', () => {
      expect(formatThaiDate(d('2026-06-01'))).to.equal('1 มิถุนายน 2569');
      const html = renderCertificateHtml(base);
      expect(html).to.include('1 มิถุนายน 2569 ถึง 31 สิงหาคม 2569');
      expect(html).to.include('IP-2026-ABCD2345');
      expect(html).to.include('https://internpath.test/public/certificates?code=IP-2026-ABCD2345');
    });

    it('URL ใน QR ใช้ query ?code= (เว็บเป็น static export) และตัด / ท้าย WEB_BASE_URL', () => {
      expect(certificateVerifyUrl('http://localhost:3100/', 'IP-2026-ABCD2345')).to.equal(
        'http://localhost:3100/public/certificates?code=IP-2026-ABCD2345',
      );
    });
  });

  describe('Rate limit ที่ Service ของหน้าสาธารณะ', () => {
    const guard = () => new PublicCertificateRateLimitGuard({} as LifecycleConfigService);

    it('ครั้งที่ max+1 ในหน้าต่างเดียวกัน ⇒ ต้องรอ (วินาที > 0); IP อื่นไม่กระทบ; ครบนาทีแล้วเริ่มใหม่', () => {
      const g = guard();
      const t0 = 1_000_000;
      for (let i = 0; i < 3; i += 1) expect(g.hit('10.0.0.1', 3, t0 + i)).to.equal(0);
      expect(g.hit('10.0.0.1', 3, t0 + 10)).to.equal(60);
      expect(g.hit('10.0.0.2', 3, t0 + 10)).to.equal(0);
      expect(g.hit('10.0.0.1', 3, t0 + 60_000)).to.equal(0);
    });
  });
});
