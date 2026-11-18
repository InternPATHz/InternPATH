import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Browser } from 'playwright';
import * as QRCode from 'qrcode';
import { renderCertificateHtml, type CertificateTemplateInput } from './certificate-template';

export type CertificatePdfInput = Omit<CertificateTemplateInput, 'verifyUrl' | 'qrDataUrl'>;

/**
 * ตัวสร้าง PDF ของใบรับรอง — เป็น abstract class เพื่อใช้เป็น DI token (เทสต์ส่วนใหญ่แทนด้วยตัวปลอม
 * เพราะ CI ยังไม่มี Chromium; เทสต์ PDF จริงอยู่ใน `test/integration/certificate-pdf.spec.ts`)
 */
export abstract class CertificatePdfRenderer {
  abstract render(input: CertificatePdfInput): Promise<Buffer>;
}

/**
 * URL หน้าตรวจสอบสาธารณะที่อยู่ใน QR — เว็บส่งออกเป็น static (ไม่มีเส้นทาง `[code]`)
 * จึงใช้ query `?code=` (PM ยืนยันแล้ว — api-contract §7.5 "กติกาใบรับรอง")
 */
export function certificateVerifyUrl(webBaseUrl: string, certificateCode: string): string {
  const base = webBaseUrl.replace(/\/+$/, '');
  return `${base}/public/certificates?code=${encodeURIComponent(certificateCode)}`;
}

/**
 * HTML → PDF ด้วย Chromium (Playwright) — เปิดเบราว์เซอร์ครั้งเดียวแล้วใช้ซ้ำ (เปิดใหม่เมื่อหลุด)
 * หน้าเพจปิด JavaScript และบล็อกทุก request ออกเครือข่าย (ทุกอย่างอยู่ใน HTML แล้ว)
 */
@Injectable()
export class PlaywrightCertificatePdfRenderer extends CertificatePdfRenderer implements OnModuleDestroy {
  private readonly logger = new Logger(PlaywrightCertificatePdfRenderer.name);
  private browser?: Promise<Browser>;

  constructor(private readonly config: ConfigService) {
    super();
  }

  async render(input: CertificatePdfInput): Promise<Buffer> {
    const verifyUrl = certificateVerifyUrl(
      this.config.get<string>('WEB_BASE_URL', 'http://localhost:3100'),
      input.certificateCode,
    );
    const qrDataUrl = await QRCode.toDataURL(verifyUrl, { errorCorrectionLevel: 'M', margin: 1, width: 320 });
    const html = renderCertificateHtml({ ...input, verifyUrl, qrDataUrl });

    const browser = await this.getBrowser();
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      await context.route('**/*', (route) =>
        route.request().url().startsWith('data:') ? route.continue() : route.abort(),
      );
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      // รอฟอนต์ data URI ถอดรหัสเสร็จ (สคริปต์ของ Playwright รันได้แม้ปิด JavaScript ของหน้า)
      await page.evaluate('document.fonts.ready.then(() => true)').catch(() => undefined);
      const pdf = await page.pdf({ format: 'A4', landscape: true, printBackground: true, preferCSSPageSize: true });
      return Buffer.from(pdf);
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  async onModuleDestroy(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    if (browser) await (await browser.catch(() => undefined))?.close().catch(() => undefined);
  }

  private getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = import('playwright')
        .then(({ chromium }) => chromium.launch({ headless: true }))
        .then((browser) => {
          browser.on('disconnected', () => {
            this.browser = undefined;
          });
          return browser;
        })
        .catch((error: unknown) => {
          this.browser = undefined;
          this.logger.error('เปิด Chromium สำหรับสร้าง PDF ใบรับรองไม่สำเร็จ');
          throw error;
        });
    }
    return this.browser;
  }
}
