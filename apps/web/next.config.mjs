/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // ส่งออกเป็นไฟล์ static (`NEXT_OUTPUT=export next build` → โฟลเดอร์ out/) สำหรับ Front บน Cloudflare ตอนสาธิต (README หัวข้อ Deploy)
  // ไม่ตั้งตัวแปร = build แบบเดิม (Dockerfile ใช้ `next start`)
  ...(process.env.NEXT_OUTPUT === 'export' ? { output: 'export', trailingSlash: true } : {}),
  async rewrites() {
    if (process.env.NODE_ENV !== 'development') return [];
    const gateway = (process.env.GATEWAY_URL || 'http://localhost:3000').replace(/\/$/, '');
    return [{ source: '/api/:path*', destination: `${gateway}/api/:path*` }];
  },
};

export default nextConfig;
