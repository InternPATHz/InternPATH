import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { Ban, FileText, ShieldCheck, Trash2 } from 'lucide-react';
import { PrivacyContents } from './privacy-contents';

export const metadata: Metadata = { title: 'นโยบายความเป็นส่วนตัว' };

/**
 * นโยบายความเป็นส่วนตัวของ InternPath — เนื้อหาอ้างอิงกติกาใน README §5.9–§5.11 (เก็บไฟล์, Audit, PDPA และการลบบัญชี)
 * ข้อ 9 ใช้ช่องทางในระบบ (หน้าบัญชี / อาจารย์ที่ปรึกษา / ผู้ดูแลแพลตฟอร์มของสถาบัน) ไม่มีอีเมลกลาง — PM ตัดสิน 2026-11-24
 */
const VERSION = '1.0';
const UPDATED = '24 พฤศจิกายน 2569';

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="scroll-mt-24 text-2xl font-semibold sm:text-[28px]">{title}</h2>
      <div className="mt-4 space-y-3 text-[17px] leading-[1.75] text-ink">{children}</div>
    </section>
  );
}

function List({ items }: { items: ReactNode[] }) {
  return <ul className="list-disc space-y-1.5 pl-5">{items.map((item, index) => <li key={index}>{item}</li>)}</ul>;
}

const summaries = [
  {
    icon: FileText,
    title: 'เรซูเม่ไปถึงบริษัทเมื่อคุณยินยอม',
    text: 'คุณต้องให้ความยินยอมก่อนที่เรซูเม่ของคุณจะถูกส่งให้บริษัทแต่ละแห่ง',
  },
  {
    icon: ShieldCheck,
    title: 'บริษัทมองไม่เห็นรายงานปัญหา',
    text: 'รายงานปัญหาระหว่างฝึกงานเห็นได้โดยคุณเอง อาจารย์ที่ปรึกษา และผู้ดูแลระบบ',
  },
  {
    icon: Ban,
    title: 'เราไม่ขายข้อมูลของคุณ',
    text: 'ปัจจุบันเราไม่ใช้คุกกี้หรือเครื่องมือติดตามเพื่อการโฆษณาหรือการวิเคราะห์พฤติกรรม',
  },
  {
    icon: Trash2,
    title: 'ขอลบบัญชีได้',
    text: 'เมื่อคุณขอลบบัญชี ทุกบริการของระบบจะลบหรือทำให้ข้อมูลของคุณไม่ระบุตัวตน',
    link: { href: '#retention', label: 'อ่านข้อ 6' },
  },
];

export default function PrivacyPage() {
  return (
    <main>
      <header className="mx-auto max-w-3xl px-4 py-12 text-center sm:px-6 sm:py-16">
        <p className="text-sm font-semibold text-ink-soft">นโยบายความเป็นส่วนตัว</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-display sm:text-5xl">
          ข้อมูลของคุณ<br />ใช้เพื่อการฝึกงานเท่านั้น
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-base leading-thai text-ink-soft">
          InternPath เป็นแพลตฟอร์มตัวกลางเชื่อมนักศึกษา อาจารย์ที่ปรึกษา และบริษัทสำหรับการฝึกงาน นโยบายนี้อธิบายว่าเราเก็บข้อมูลอะไร ใช้อย่างไร ใครมองเห็นได้
          และคุณมีสิทธิ์อะไรบ้าง ตามพระราชบัญญัติคุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562 (PDPA)
        </p>
        <p className="mt-5 text-sm text-ink-soft">ฉบับที่ {VERSION} · ปรับปรุงล่าสุด {UPDATED}</p>
      </header>

      <section aria-labelledby="privacy-summary" className="bg-tile px-4 py-12 text-white sm:px-6 sm:py-16">
        <div className="mx-auto max-w-[1100px]">
          <h2 id="privacy-summary" className="text-center text-2xl font-semibold sm:text-4xl">สรุปสั้น ๆ</h2>
          <ul className="mt-8 grid gap-4 min-[561px]:grid-cols-2 min-[1069px]:grid-cols-4">
            {summaries.map(({ icon: Icon, title, text, link }) => (
              <li key={title} className="rounded-xl bg-tile-2 p-5 sm:p-6">
                <Icon aria-hidden="true" className="h-8 w-8" strokeWidth={1.4} />
                <h3 className="mt-4 text-lg font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-thai text-white/80">{text}</p>
                {link && <a href={link.href} className="mt-2 inline-block text-sm text-primary-on-dark hover:underline">{link.label}</a>}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <div className="mx-auto grid max-w-[1100px] grid-cols-1 items-start gap-8 px-4 py-10 sm:px-6 sm:py-16 min-[834px]:grid-cols-[15rem_minmax(0,1fr)] min-[834px]:gap-12">
        <PrivacyContents />
        <article className="min-w-0 max-w-[680px] space-y-12">
          <Section id="collect" title="1. ข้อมูลที่เราเก็บ">
            <List items={[
              <><strong className="text-ink">ข้อมูลบัญชี:</strong> อีเมล ชื่อ-นามสกุล เบอร์โทร (ถ้ามี) และรหัสผ่าน (เก็บเป็นค่าแฮช ไม่เก็บรหัสผ่านจริง)</>,
              <><strong className="text-ink">นักศึกษา:</strong> รหัสนักศึกษา สาขา ชั้นปี สถาบัน เรซูเม่และโปรไฟล์ ใบสมัครและสถานะ ผลประเมินการฝึกงาน รีวิวบริษัท และรายงานปัญหาระหว่างฝึกงาน</>,
              <><strong className="text-ink">อาจารย์ที่ปรึกษา:</strong> ภาควิชา และการผูกกับนักศึกษา</>,
              <><strong className="text-ink">บริษัทและ HR:</strong> ชื่อและเลขทะเบียนนิติบุคคล เว็บไซต์ เบอร์โทรบริษัท เอกสารยืนยันบริษัท และประกาศงาน</>,
              <><strong className="text-ink">บันทึกการทำงานของระบบ:</strong> ประวัติการเปลี่ยนสถานะ (ใบสมัคร ประกาศ บัญชี ใบรับรอง) และบันทึกการกระทำของผู้ดูแลระบบ ซึ่งไม่มีเนื้อหาข้อความส่วนตัวของคุณ</>,
            ]} />
          </Section>

          <Section id="purpose" title="2. วัตถุประสงค์การใช้">
            <List items={[
              'สร้างและยืนยันตัวตนของบัญชี และรักษาความปลอดภัยของการเข้าสู่ระบบ',
              'จับคู่นักศึกษากับประกาศงาน และดำเนินกระบวนการสมัคร อนุมัติโดยอาจารย์ที่ปรึกษา การฝึกงาน การประเมินผล และการออกใบรับรอง',
              'ตรวจสอบความน่าเชื่อถือของบริษัทและประกาศงาน เพื่อป้องกันการหลอกลวงนักศึกษา',
              'แจ้งเตือนสถานะที่เกี่ยวข้องกับคุณทางในระบบและอีเมล',
              'แสดงรีวิวบริษัทเพื่อช่วยให้นักศึกษาตัดสินใจ',
            ]} />
          </Section>

          <Section id="visible" title="3. ใครมองเห็นข้อมูลของคุณ">
            <div role="region" aria-label="ตารางผู้ที่มองเห็นข้อมูล" tabIndex={0}
              className="overflow-x-auto rounded-xl border border-border focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
              <table className="w-full min-w-[26rem] border-collapse text-left text-sm">
                <thead className="bg-surface-muted">
                  <tr><th scope="col" className="px-4 py-3">ข้อมูล</th><th scope="col" className="px-4 py-3">ผู้ที่มองเห็น</th></tr>
                </thead>
                <tbody>
                  <tr className="border-t border-border">
                    <th scope="row" className="w-2/5 px-4 py-3 align-top font-semibold">เรซูเม่และโปรไฟล์:</th>
                    <td className="px-4 py-3">คุณเอง HR ของบริษัทที่คุณส่งใบสมัครไป (หลังจากคุณให้ความยินยอม) และอาจารย์ที่ปรึกษาที่ผูกแล้ว ผู้ดูแลระบบดูได้เฉพาะกรณีที่ถูกยกระดับ</td>
                  </tr>
                  <tr className="border-t border-border">
                    <th scope="row" className="w-2/5 px-4 py-3 align-top font-semibold">ผลประเมินการฝึกงาน:</th>
                    <td className="px-4 py-3">คุณเอง HR ของบริษัทเจ้าของ และอาจารย์ที่ปรึกษา (ผู้ดูแลระบบดูได้เฉพาะกรณีที่ถูกยกระดับ)</td>
                  </tr>
                  <tr className="border-t border-border">
                    <th scope="row" className="w-2/5 px-4 py-3 align-top font-semibold">รายงานปัญหาระหว่างฝึกงาน:</th>
                    <td className="px-4 py-3">คุณเอง อาจารย์ที่ปรึกษา และผู้ดูแลระบบ — <strong className="text-ink">บริษัทมองไม่เห็น</strong></td>
                  </tr>
                  <tr className="border-t border-border">
                    <th scope="row" className="w-2/5 px-4 py-3 align-top font-semibold">รีวิวบริษัท:</th>
                    <td className="px-4 py-3">สาธารณะ โดยคุณเลือกแสดงแบบไม่ระบุชื่อได้ (แสดงเฉพาะสาขาและชั้นปี)</td>
                  </tr>
                  <tr className="border-t border-border">
                    <th scope="row" className="w-2/5 px-4 py-3 align-top font-semibold">ใบรับรองการฝึกงาน (E-Certificate):</th>
                    <td className="px-4 py-3">ไฟล์เห็นได้เฉพาะเจ้าของ ส่วนหน้าตรวจสอบสาธารณะแสดงข้อมูลที่จำกัด</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>คุณต้องให้ความยินยอมก่อนที่เรซูเม่ของคุณจะถูกส่งให้บริษัทแต่ละแห่ง เราไม่ขายข้อมูลส่วนบุคคลของคุณ</p>
          </Section>

          <Section id="security" title="4. การรักษาความปลอดภัย">
            <List items={[
              'รหัสผ่านเก็บเป็นค่าแฮช (Argon2id) การเข้าสู่ระบบใช้โทเคนอายุสั้นและโทเคนต่ออายุที่เปลี่ยนใหม่ทุกครั้งที่ใช้',
              'เรซูเม่ เอกสารยืนยันบริษัท และไฟล์ใบรับรองเก็บในพื้นที่ส่วนตัว เปิดดูผ่านลิงก์ชั่วคราวอายุประมาณ 10 นาทีที่ออกให้หลังตรวจสิทธิ์แล้วเท่านั้น',
              'ทุกบริการของระบบตรวจสิทธิ์การเข้าถึงข้อมูลของตนเองเสมอ ไม่พึ่งการตรวจที่ด่านหน้าเพียงอย่างเดียว',
            ]} />
            <p className="rounded-xl bg-surface-muted p-4 text-base">
              <strong>ข้อจำกัดที่ทราบ:</strong> ระบบยังไม่มีการสแกนไวรัสไฟล์ที่อัปโหลดในเฟสปัจจุบัน
            </p>
          </Section>

          <Section id="browser" title="5. ข้อมูลที่เก็บในเบราว์เซอร์">
            <p>
              เว็บเก็บโทเคนต่ออายุไว้ในพื้นที่จัดเก็บของเบราว์เซอร์แยกตามแท็บ (sessionStorage) เพื่อให้คุณยังเข้าสู่ระบบอยู่เมื่อโหลดหน้าใหม่ในแท็บเดิม
              และลบออกเมื่อคุณออกจากระบบหรือปิดแท็บนั้น การเปิดแท็บใหม่จึงต้องเข้าสู่ระบบอีกครั้ง
              ปัจจุบันเราไม่ใช้คุกกี้หรือเครื่องมือติดตามเพื่อการโฆษณาหรือการวิเคราะห์พฤติกรรม
            </p>
          </Section>

          <Section id="retention" title="6. การเก็บรักษาและการลบบัญชี">
            <p>เราเก็บข้อมูลของคุณตราบเท่าที่บัญชียังใช้งานอยู่ เมื่อคุณขอลบบัญชี ทุกบริการของระบบจะลบหรือทำให้ข้อมูลของคุณไม่ระบุตัวตน รวมถึงไฟล์ในพื้นที่จัดเก็บ</p>
            <div className="grid grid-cols-1 gap-3 min-[641px]:grid-cols-2">
              <div className="min-w-0 space-y-2 rounded-xl border border-border p-4 text-sm">
                <h3 className="font-semibold">สิ่งที่เก็บไว้แต่ไม่ระบุตัวตน เพื่อความถูกต้องของระบบ:</h3>
                <List items={[
                  'ใบรับรองการฝึกงาน (ชื่อบนหน้าตรวจสอบแสดงเป็น "ผู้ใช้ที่ลบบัญชีแล้ว")',
                  'รีวิวที่เผยแพร่แล้ว',
                  'ประวัติการเปลี่ยนสถานะและบันทึกการกระทำของผู้ดูแลระบบ (แทนรหัสผู้ใช้ด้วยรหัสนิรนาม)',
                ]} />
              </div>
              <div className="min-w-0 space-y-2 rounded-xl border border-border p-4 text-sm">
                <h3 className="font-semibold">ข้อจำกัดของการลบ:</h3>
                <List items={[
                  'ลบไม่ได้ขณะมีใบสมัครที่ยังดำเนินอยู่ (รออาจารย์ตอบ อนุมัติแล้ว กำลังฝึก รอประเมิน หรือมีการโต้แย้งผลที่ยังไม่จบ) ต้องถอนหรือยุติก่อน',
                  'เจ้าของบริษัท (Owner) ต้องโอนสิทธิ์ให้สมาชิกคนอื่นก่อนลบบัญชี',
                ]} />
              </div>
            </div>
            <p>
              ขอลบบัญชีได้เองที่ <Link href="/account/delete" className="font-medium text-primary hover:underline">บัญชีของฉัน › ลบบัญชี</Link> (ต้องเข้าสู่ระบบ) หรือติดต่อตามช่องทางในข้อ 9
            </p>
          </Section>

          <Section id="rights" title="7. สิทธิ์ของคุณ">
            <List items={[
              'ขอเข้าถึงและขอสำเนาข้อมูลส่วนบุคคลของคุณ',
              'ขอแก้ไขข้อมูลที่ไม่ถูกต้องหรือไม่ครบถ้วน',
              'ขอลบหรือทำให้ข้อมูลไม่ระบุตัวตน (ภายใต้ข้อจำกัดในข้อ 6)',
              'ถอนความยินยอมที่เคยให้ไว้ โดยไม่กระทบการประมวลผลที่ทำไปแล้วก่อนถอน',
              'ร้องเรียนต่อหน่วยงานที่มีอำนาจตาม PDPA หากเห็นว่าการประมวลผลไม่ถูกต้อง',
            ]} />
          </Section>

          <Section id="changes" title="8. การแก้ไขนโยบาย">
            <p>เมื่อมีการเปลี่ยนแปลงสำคัญ เราจะปรับวันที่ด้านบนของหน้านี้ และแจ้งให้ทราบผ่านระบบก่อนมีผลบังคับใช้ เมื่อการเปลี่ยนแปลงนั้นกระทบสิทธิ์ของคุณ</p>
          </Section>

          <Section id="contact" title="9. ติดต่อเรา">
            <p>หากต้องการใช้สิทธิ์ตามข้อ 7 หรือมีคำถามเกี่ยวกับนโยบายนี้ ใช้ช่องทางต่อไปนี้:</p>
            <List items={[
              <>ดูและแก้ไขข้อมูลของคุณได้เองที่หน้า <Link href="/account" className="font-medium text-primary hover:underline">บัญชีของฉัน</Link> และหน้าโปรไฟล์ตามบทบาทของคุณ</>,
              <>ขอลบบัญชีได้เองที่ <Link href="/account/delete" className="font-medium text-primary hover:underline">บัญชีของฉัน › ลบบัญชี</Link></>,
              'นักศึกษา: แจ้งอาจารย์ที่ปรึกษาที่ผูกกับบัญชีของคุณ เพื่อส่งเรื่องต่อถึงผู้ดูแลแพลตฟอร์ม',
              'อาจารย์และบริษัท: ติดต่อผู้ดูแลแพลตฟอร์ม InternPath ของสถาบัน',
            ]} />
          </Section>

          <p className="text-sm"><Link href="/" className="text-primary hover:underline">← กลับหน้าแรก</Link></p>
        </article>
      </div>
    </main>
  );
}
