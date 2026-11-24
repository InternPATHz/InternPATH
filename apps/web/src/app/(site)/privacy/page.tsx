import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';

export const metadata: Metadata = { title: 'นโยบายความเป็นส่วนตัว' };

/**
 * นโยบายความเป็นส่วนตัวของ InternPath — เนื้อหาอ้างอิงกติกาใน README §5.9–§5.11 (เก็บไฟล์, Audit, PDPA และการลบบัญชี)
 * ข้อ 9 ใช้ช่องทางในระบบ (หน้าบัญชี / อาจารย์ที่ปรึกษา / ผู้ดูแลแพลตฟอร์มของสถาบัน) ไม่มีอีเมลกลาง — PM ตัดสิน 2026-11-24
 */
const VERSION = '1.0';
const UPDATED = '24 พฤศจิกายน 2569';

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-8">
      <h2 id={id} className="scroll-mt-24 text-xl font-semibold">{title}</h2>
      <div className="mt-2 space-y-3 text-[17px] leading-[1.75] text-ink">{children}</div>
    </section>
  );
}

function List({ items }: { items: ReactNode[] }) {
  return <ul className="list-disc space-y-1.5 pl-5">{items.map((item, index) => <li key={index}>{item}</li>)}</ul>;
}

export default function PrivacyPage() {
  return (
    <main>
      <header className="mx-auto max-w-3xl px-4 py-12 text-center sm:px-6 sm:py-16">
        <p className="text-sm font-semibold text-ink-soft">นโยบายความเป็นส่วนตัว</p>
        <h1 className="mt-3 text-4xl font-semibold sm:text-5xl">ข้อมูลของคุณใช้เพื่อการฝึกงานเท่านั้น</h1>
        <p className="mt-2 text-sm text-ink-soft">ฉบับที่ {VERSION} · ปรับปรุงล่าสุด {UPDATED}</p>
        <p className="mt-4 text-sm leading-thai text-ink-soft">
          InternPath เป็นแพลตฟอร์มตัวกลางเชื่อมนักศึกษา อาจารย์ที่ปรึกษา และบริษัทสำหรับการฝึกงาน นโยบายนี้อธิบายว่าเราเก็บข้อมูลอะไร ใช้อย่างไร ใครมองเห็นได้
          และคุณมีสิทธิ์อะไรบ้าง ตามพระราชบัญญัติคุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562 (PDPA)
        </p>

      </header>
      <section className="bg-tile px-4 py-10 text-white sm:px-6">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-2xl font-semibold">สรุปสั้น ๆ</h2>
          <ul className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {['ส่งเรซูเม่เมื่อคุณยินยอม', 'บริษัทมองไม่เห็นรายงานปัญหา', 'เราไม่ขายข้อมูลของคุณ', 'ขอลบบัญชีได้'].map((label) => (
              <li key={label} className="rounded-xl bg-white/5 p-4 font-medium">{label}</li>
            ))}
          </ul>
        </div>
      </section>
      <div className="mx-auto grid max-w-5xl gap-6 px-4 pb-12 sm:px-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <nav aria-label="สารบัญ" className="mt-6 min-w-0 self-start rounded-xl bg-surface-muted p-4 text-sm lg:sticky lg:top-20">
          <ol className="flex gap-3 overflow-x-auto pb-1 lg:grid lg:gap-2">
            {[
              ['collect', '1. ข้อมูลที่เราเก็บ'], ['purpose', '2. วัตถุประสงค์การใช้'], ['visible', '3. ใครมองเห็นข้อมูลของคุณ'],
              ['security', '4. การรักษาความปลอดภัย'], ['browser', '5. ข้อมูลที่เก็บในเบราว์เซอร์'], ['retention', '6. การเก็บรักษาและการลบบัญชี'],
              ['rights', '7. สิทธิ์ของคุณ'], ['changes', '8. การแก้ไขนโยบาย'], ['contact', '9. ติดต่อเรา'],
            ].map(([id, label]) => <li key={id} className="shrink-0 lg:shrink"><a href={`#${id}`} className="text-primary hover:underline">{label}</a></li>)}
          </ol>
        </nav>

        <article className="min-w-0">
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
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="bg-surface-muted"><tr><th scope="col" className="p-3">ข้อมูล</th><th scope="col" className="p-3">ผู้ที่มองเห็น</th></tr></thead>
                <tbody>
                  {[
                    ['เรซูเม่และโปรไฟล์', 'เจ้าของ HR ของบริษัทที่ได้รับใบสมัครหลังให้ความยินยอม และอาจารย์ที่ปรึกษาที่ผูกแล้ว ผู้ดูแลระบบเห็นเฉพาะกรณีที่ถูกยกระดับ'],
                    ['ผลประเมินการฝึกงาน', 'เจ้าของ HR ของบริษัทเจ้าของ และอาจารย์ที่ปรึกษา ผู้ดูแลระบบเห็นเฉพาะกรณีที่ถูกยกระดับ'],
                    ['รายงานปัญหาระหว่างฝึกงาน', 'เจ้าของ อาจารย์ที่ปรึกษา และผู้ดูแลระบบ'],
                    ['รีวิวบริษัท', 'สาธารณะ ผู้เขียนเลือกแสดงเฉพาะสาขาและชั้นปีได้'],
                    ['ใบรับรองการฝึกงาน', 'เจ้าของเห็นไฟล์ หน้าตรวจสอบสาธารณะแสดงข้อมูลที่จำกัด'],
                  ].map(([label, audience]) => (
                    <tr key={label} className="border-t border-border"><th scope="row" className="p-3 align-top font-medium">{label}</th><td className="p-3">{audience}</td></tr>
                  ))}
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
              'ข้อจำกัดที่ทราบ: ระบบยังไม่มีการสแกนไวรัสไฟล์ที่อัปโหลดในเฟสปัจจุบัน',
            ]} />
          </Section>

          <Section id="browser" title="5. ข้อมูลที่เก็บในเบราว์เซอร์">
            <p>
              เว็บเก็บโทเคนต่ออายุไว้ในพื้นที่จัดเก็บของเบราว์เซอร์ (localStorage) เพื่อให้คุณยังเข้าสู่ระบบอยู่เมื่อเปิดหน้าใหม่ และลบออกเมื่อคุณออกจากระบบ
              ปัจจุบันเราไม่ใช้คุกกี้หรือเครื่องมือติดตามเพื่อการโฆษณาหรือการวิเคราะห์พฤติกรรม
            </p>
          </Section>

          <Section id="retention" title="6. การเก็บรักษาและการลบบัญชี">
            <p>เราเก็บข้อมูลของคุณตราบเท่าที่บัญชียังใช้งานอยู่ เมื่อคุณขอลบบัญชี ทุกบริการของระบบจะลบหรือทำให้ข้อมูลของคุณไม่ระบุตัวตน รวมถึงไฟล์ในพื้นที่จัดเก็บ</p>
            <p><strong className="text-ink">สิ่งที่เก็บไว้แต่ไม่ระบุตัวตน</strong> เพื่อความถูกต้องของระบบ:</p>
            <List items={[
              'ใบรับรองการฝึกงาน (ชื่อบนหน้าตรวจสอบแสดงเป็น "ผู้ใช้ที่ลบบัญชีแล้ว")',
              'รีวิวที่เผยแพร่แล้ว',
              'ประวัติการเปลี่ยนสถานะและบันทึกการกระทำของผู้ดูแลระบบ (แทนรหัสผู้ใช้ด้วยรหัสนิรนาม)',
            ]} />
            <p><strong className="text-ink">ข้อจำกัดของการลบ:</strong></p>
            <List items={[
              'ลบไม่ได้ขณะมีใบสมัครที่ยังดำเนินอยู่ (รออาจารย์ตอบ อนุมัติแล้ว กำลังฝึก รอประเมิน หรือมีการโต้แย้งผลที่ยังไม่จบ) ต้องถอนหรือยุติก่อน',
              'เจ้าของบริษัท (Owner) ต้องโอนสิทธิ์ให้สมาชิกคนอื่นก่อนลบบัญชี',
            ]} />
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

          <p className="mt-10 text-sm"><Link href="/" className="text-primary hover:underline">← กลับหน้าแรก</Link></p>
        </article>
      </div>
    </main>
  );
}
