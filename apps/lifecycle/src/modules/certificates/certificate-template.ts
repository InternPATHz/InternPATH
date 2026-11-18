import { readFileSync } from 'node:fs';

/**
 * หน้า HTML ของ E-Certificate (README §5.4, §8) — แปลงเป็น PDF ด้วย Chromium ของ Playwright
 * ฝังฟอนต์ Sarabun (OFL-1.1 จาก `@fontsource/sarabun`) เป็น data URI ในหน้า ⇒ Chromium ฝังฟอนต์ใน PDF เอง
 * ไม่พึ่งฟอนต์ของเครื่อง/คอนเทนเนอร์ (alpine ไม่มีฟอนต์ไทย) และไม่โหลดอะไรจากเครือข่าย
 * การวางสระบน/วรรณยุกต์ซ้อนทำโดย HarfBuzz ของ Chromium จากตาราง GPOS ของฟอนต์ — จึงสร้างจาก HTML ไม่วาดเองลง PDF
 */

export interface CertificateTemplateInput {
  certificateCode: string;
  holderName: string;
  companyName: string;
  jobTitle: string;
  periodStart: Date;
  periodEnd: Date;
  actualDays: number;
  issuedAt: Date;
  /** URL หน้าตรวจสอบสาธารณะ (อยู่ใน QR และพิมพ์ใต้ QR) */
  verifyUrl: string;
  /** QR เป็น data URI (`image/png`) — สร้างจาก `verifyUrl` */
  qrDataUrl: string;
}

/** ชุดย่อยของฟอนต์ที่ต้องใช้: ไทย + ละติน (ชื่อบริษัท/ตำแหน่งภาษาอังกฤษ, ตัวเลข, URL) ทั้งตัวปกติและตัวหนา */
const FONT_FACES: ReadonlyArray<{ subset: 'thai' | 'latin'; weight: 400 | 700; unicodeRange: string }> = [
  { subset: 'thai', weight: 400, unicodeRange: 'U+02D7,U+0303,U+0331,U+0E01-0E5B,U+200C-200D,U+25CC' },
  { subset: 'thai', weight: 700, unicodeRange: 'U+02D7,U+0303,U+0331,U+0E01-0E5B,U+200C-200D,U+25CC' },
  {
    subset: 'latin',
    weight: 400,
    unicodeRange:
      'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  },
  {
    subset: 'latin',
    weight: 700,
    unicodeRange:
      'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  },
];

let fontCss: string | undefined;

/** อ่านไฟล์ฟอนต์ครั้งเดียวต่อ process (รวม ~45 KB) */
export function embeddedFontCss(): string {
  if (fontCss) return fontCss;
  fontCss = FONT_FACES.map(({ subset, weight, unicodeRange }) => {
    const file = require.resolve(`@fontsource/sarabun/files/sarabun-${subset}-${weight}-normal.woff2`);
    const data = readFileSync(file).toString('base64');
    return `@font-face{font-family:'Sarabun';font-style:normal;font-weight:${weight};font-display:block;` +
      `src:url(data:font/woff2;base64,${data}) format('woff2');unicode-range:${unicodeRange};}`;
  }).join('\n');
  return fontCss;
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** ชื่อ/บริษัท/ตำแหน่งมาจากผู้ใช้ ⇒ escape ทุกค่าก่อนใส่ใน HTML (กัน HTML/script injection ตอน render) */
export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);

/** วันที่แบบไทย พ.ศ. เช่น `1 พฤศจิกายน 2569` — คอลัมน์ `@db.Date` เป็นเที่ยงคืน UTC จึงจัดรูปแบบด้วย UTC */
export function formatThaiDate(value: Date, timeZone = 'UTC'): string {
  return new Intl.DateTimeFormat('th-TH-u-ca-buddhist', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone,
  }).format(value);
}

export function renderCertificateHtml(input: CertificateTemplateInput): string {
  const e = escapeHtml;
  const period = `${formatThaiDate(input.periodStart)} ถึง ${formatThaiDate(input.periodEnd)}`;
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<title>E-Certificate ${e(input.certificateCode)}</title>
<style>
${embeddedFontCss()}
@page { size: A4 landscape; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: 'Sarabun'; color: #1f2937; background: #ffffff; }
.page { width: 297mm; height: 210mm; padding: 14mm; }
.frame { height: 100%; border: 2.5mm solid #1e3a5f; padding: 12mm 16mm; position: relative; }
.brand { font-size: 13pt; font-weight: 700; letter-spacing: 0.08em; color: #1e3a5f; }
h1 { margin: 6mm 0 2mm; font-size: 30pt; font-weight: 700; color: #1e3a5f; }
.subtitle { font-size: 14pt; color: #4b5563; margin: 0 0 8mm; }
.label { font-size: 13pt; color: #4b5563; margin: 0; }
.holder { font-size: 28pt; font-weight: 700; margin: 2mm 0 6mm; line-height: 1.5; }
.detail { font-size: 15pt; margin: 1.5mm 0; line-height: 1.6; }
.detail strong { font-weight: 700; }
.footer { position: absolute; left: 16mm; right: 16mm; bottom: 10mm; display: flex; justify-content: space-between; align-items: flex-end; }
.meta { font-size: 11pt; color: #4b5563; line-height: 1.6; }
.qr { text-align: center; font-size: 9pt; color: #4b5563; }
.qr img { width: 32mm; height: 32mm; display: block; margin: 0 auto 1mm; }
.url { word-break: break-all; max-width: 70mm; }
</style>
</head>
<body>
<div class="page"><div class="frame">
  <div class="brand">INTERNPATH</div>
  <h1>หนังสือรับรองการฝึกงาน</h1>
  <p class="subtitle">Internship Certificate</p>
  <p class="label">ขอรับรองว่า</p>
  <p class="holder">${e(input.holderName)}</p>
  <p class="detail">ได้ฝึกงานในตำแหน่ง <strong>${e(input.jobTitle)}</strong></p>
  <p class="detail">ณ <strong>${e(input.companyName)}</strong></p>
  <p class="detail">ระหว่างวันที่ ${e(period)} (รวม ${input.actualDays} วัน)</p>
  <div class="footer">
    <div class="meta">
      Certificate ID: <strong>${e(input.certificateCode)}</strong><br>
      ออกเมื่อ ${e(formatThaiDate(input.issuedAt, 'Asia/Bangkok'))}<br>
      ตรวจสอบความถูกต้องได้ที่หน้าตรวจสอบใบรับรองของ InternPath
    </div>
    <div class="qr">
      <img src="${e(input.qrDataUrl)}" alt="QR">
      <div class="url">${e(input.verifyUrl)}</div>
    </div>
  </div>
</div></div>
</body>
</html>`;
}
