import type { Config } from 'tailwindcss';

/**
 * Design Token ทั้งเว็บ — อิง DESIGN-apple.md แล้วปรับให้เหมาะกับแพลตฟอร์มฝึกงาน (แก้สีทั้งเว็บที่นี่ที่เดียว)
 * - สีโต้ตอบมีสีเดียว: Action Blue (#0066cc) ใช้กับลิงก์ ปุ่มหลัก และวงโฟกัส
 * - พื้นผิว: ขาว / Parchment (#f5f5f7) / Tile เข้ม (#272729) — เปลี่ยนสีพื้นแทนการใช้เงาหรือกรอบหนา
 * - สีสถานะ (ผ่าน/รอ/ไม่ผ่าน) ยังจำเป็นต่อระบบ จึงใช้ชุดสีระบบของ Apple (เขียว/ส้ม/แดง) และม่วงสำหรับ Featured เท่านั้น
 * - มุมโค้ง: lg = 11px (ช่องกรอก/ปุ่มขนาดเล็ก), xl/2xl = 18px (การ์ด), ปุ่มหลักเป็นแคปซูล (rounded-full)
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: { DEFAULT: '#FFFFFF', muted: '#F5F5F7', pearl: '#FAFAFC' },
        tile: { DEFAULT: '#272729', 2: '#2A2A2C', 3: '#252527' },
        border: '#E0E0E0',
        ink: { DEFAULT: '#1D1D1F', soft: '#6E6E73', muted: '#86868B' },
        primary: { DEFAULT: '#0066CC', hover: '#0071E3', soft: '#EAF3FD', 'on-dark': '#2997FF' },
        accent: { DEFAULT: '#AF52DE', text: '#8944AB', soft: '#F6EDFB' }, // Featured / Fast-Track เท่านั้น
        success: { DEFAULT: '#34C759', text: '#1F7A35', soft: '#E9F8EE' },
        warning: { DEFAULT: '#FF9F0A', text: '#9A5200', soft: '#FFF4E3' },
        danger: { DEFAULT: '#FF3B30', text: '#C4001A', soft: '#FFEEED' },
        info: { DEFAULT: '#0066CC', text: '#0058B0', soft: '#EAF3FD' },
        neutral: { DEFAULT: '#86868B' },
      },
      fontFamily: {
        // ตัวอักษรละตินใช้ SF Pro บนอุปกรณ์ Apple, ภาษาไทยและอุปกรณ์อื่นใช้ Noto Sans Thai
        sans: ['-apple-system', 'BlinkMacSystemFont', 'var(--font-noto-sans-thai)', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        lg: '11px',
        xl: '18px',
        '2xl': '18px',
      },
      letterSpacing: {
        display: '-0.015em', // หัวข้อแบบ "Apple tight" — ใช้กับหัวข้อขนาดใหญ่เท่านั้น
      },
      lineHeight: { thai: '1.6' }, // ภาษาไทยห้ามบีบระยะบรรทัด
    },
  },
  plugins: [],
};

export default config;
