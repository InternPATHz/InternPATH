# build จากราก repo:  docker build -f apps/lifecycle/Dockerfile .
# ใช้ Debian (bookworm) ไม่ใช้ Alpine: Chromium ของ Playwright ที่ออก E-Certificate PDF รองรับเฉพาะ glibc
# build และ runtime ต้องเป็นฐานเดียวกัน เพราะ Prisma engine ถูก generate ตามแพลตฟอร์มของ stage build
FROM node:20-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@9.15.0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY libs ./libs
COPY apps/lifecycle ./apps/lifecycle
RUN pnpm install --frozen-lockfile --filter @internpath/lifecycle... --ignore-scripts
RUN pnpm --filter @internpath/lifecycle exec prisma generate
RUN pnpm --filter @internpath/lifecycle... build

FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=build /repo /repo
WORKDIR /repo/apps/lifecycle
# ติดตั้ง Chromium (รุ่นตรงกับ playwright ใน package.json) พร้อมไลบรารีระบบ แล้วเปิดให้ผู้ใช้ node อ่านได้
# (ฟอนต์ไทยฝังในไฟล์ PDF เอง ไม่พึ่งฟอนต์ของระบบ)
RUN npx playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright \
    && rm -rf /var/lib/apt/lists/*
EXPOSE 3004
USER node
CMD ["node", "dist/main.js"]
