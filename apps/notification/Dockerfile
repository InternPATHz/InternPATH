# build จากราก repo:  docker build -f apps/notification/Dockerfile .
FROM node:20-alpine AS build
RUN npm install -g pnpm@9.15.0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY libs ./libs
COPY apps/notification ./apps/notification
RUN pnpm install --frozen-lockfile --filter @internpath/notification... --ignore-scripts
RUN pnpm --filter @internpath/notification exec prisma generate
RUN pnpm --filter @internpath/notification... build

FROM node:20-alpine
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/apps/notification
EXPOSE 3005
USER node
CMD ["node", "dist/main.js"]
