/** Tile เข้ม (DESIGN-apple: product-tile-dark) อธิบายป้ายความน่าเชื่อถือ */
export function TrustNotice() {
  return (
    <aside aria-labelledby="trust-title" className="bg-tile px-4 py-16 text-center text-white sm:py-20">
      <h2 id="trust-title" className="text-3xl font-semibold sm:text-[40px] sm:leading-[1.1]">เข้าใจป้ายความน่าเชื่อถือ</h2>
      <p className="mx-auto mt-4 max-w-2xl text-lg text-white/75">
        Verified by Platform และ University Partner คือบริษัทที่แพลตฟอร์มตรวจสอบแล้ว
        ส่วน Featured เป็นบริการดันประกาศขึ้นแสดงก่อน ไม่ได้หมายความว่าน่าเชื่อถือกว่า
        อ่านรายละเอียดและรีวิวก่อนสมัครทุกครั้ง
      </p>
    </aside>
  );
}
