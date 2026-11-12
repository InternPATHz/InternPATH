import type { Config } from 'tailwindcss';

// Design Token จาก README หัวข้อ 8 (Light Theme) — แก้สีทั้งเว็บที่นี่ที่เดียว
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: { DEFAULT: '#FFFFFF', muted: '#F8FAFC' },
        border: '#E2E8F0',
        ink: { DEFAULT: '#0F172A', soft: '#475569' },
        primary: { DEFAULT: '#2563EB', hover: '#1D4ED8', soft: '#EFF6FF' },
        accent: { DEFAULT: '#7C3AED', soft: '#F5F3FF' }, // Featured / Urgent / Fast-Track เท่านั้น
        success: { DEFAULT: '#10B981', text: '#065F46', soft: '#ECFDF5' },
        warning: { DEFAULT: '#F59E0B', text: '#92400E', soft: '#FFFBEB' },
        danger: { DEFAULT: '#EF4444', text: '#991B1B', soft: '#FEF2F2' },
        neutral: { DEFAULT: '#64748B' },
      },
      fontFamily: {
        sans: ['var(--font-noto-sans-thai)', 'system-ui', 'sans-serif'],
      },
      lineHeight: { thai: '1.6' }, // ภาษาไทยห้ามบีบระยะบรรทัด
    },
  },
  plugins: [],
};

export default config;
