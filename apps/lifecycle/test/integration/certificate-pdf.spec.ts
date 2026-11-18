import { existsSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import { expect } from 'chai';
import { chromium } from 'playwright';
import { PlaywrightCertificatePdfRenderer } from '../../src/modules/certificates/certificate-pdf.renderer';

/**
 * สร้าง PDF จริงด้วย Chromium ของ Playwright (README §8 — ฟอนต์ไทยต้องฝังในไฟล์)
 * - ต้องติดตั้ง Chromium ก่อน: `pnpm --filter @internpath/lifecycle exec playwright install chromium`
 * - CI ยังไม่ติดตั้ง Chromium ⇒ ไม่ลงทะเบียนชุดนี้ (ไม่ใช่ pending — job `service-integration` ใช้ `--forbid-pending`)
 *   ตั้ง `RUN_PDF_TESTS=true` เพื่อบังคับรัน (ไม่มี Chromium ⇒ ล้ม ไม่ข้ามเงียบ)
 */
const forced = process.env.RUN_PDF_TESTS === 'true';
const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

if (forced || hasChromium) describe(
  'Lifecycle 1.7 — PDF ใบรับรองด้วย Chromium จริง',
  function (this: Mocha.Suite) {
    this.timeout(120_000);
    const renderer = new PlaywrightCertificatePdfRenderer(new ConfigService({ WEB_BASE_URL: 'https://internpath.test' }));

    after(() => renderer.onModuleDestroy());

    // ชื่อที่มีสระบน + วรรณยุกต์ซ้อน (ปิ่น, น้ำ, ฤทธิ์, ศักดิ์) ตาม README §8
    const input = {
      certificateCode: 'IP-2026-ABCD2345',
      holderName: 'ปิ่นมณี น้ำใส ฤทธิ์ศักดิ์',
      companyName: 'บริษัท ทดสอบ จำกัด',
      jobTitle: 'Backend Developer Intern',
      periodStart: new Date('2026-06-01T00:00:00Z'),
      periodEnd: new Date('2026-08-31T00:00:00Z'),
      actualDays: 91,
      issuedAt: new Date('2026-11-18T03:00:00Z'),
    };

    it('ได้ไฟล์ PDF หน้าเดียว และฝังเฉพาะฟอนต์ Sarabun (ไม่ตกไปใช้ฟอนต์ของเครื่อง)', async () => {
      const pdf = await renderer.render(input);
      const text = pdf.toString('latin1');
      expect(text.startsWith('%PDF-')).to.equal(true);
      expect(text.match(/\/Type\s*\/Page\b/g)).to.have.length(1);

      const fonts = [...new Set(text.match(/\/BaseFont\s*\/[^\s/<>[\]]+/g) ?? [])];
      expect(fonts.length).to.be.greaterThan(0);
      for (const font of fonts) expect(font, font).to.match(/\+Sarabun-(Regular|Bold)$/);
      // ฝังไฟล์ฟอนต์จริง (subset) ไม่ใช่แค่อ้างชื่อ
      expect((text.match(/\/FontFile\d?/g) ?? []).length).to.equal(fonts.length);
    });

    it('สร้างซ้ำได้ (ใช้ Browser เดิม) และเนื้อหาต่างกันตามรหัส', async () => {
      const [a, b] = await Promise.all([
        renderer.render(input),
        renderer.render({ ...input, certificateCode: 'IP-2026-ZZZZ9999' }),
      ]);
      expect(a.equals(b)).to.equal(false);
    });
  },
);
