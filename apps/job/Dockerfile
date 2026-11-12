# build จากราก repo:  docker build -f apps/job/Dockerfile .
FROM node:20-alpine AS build
RUN npm install -g pnpm@9.15.0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY libs ./libs
COPY apps/job ./apps/job
RUN pnpm install --frozen-lockfile --filter @internpath/job... --ignore-scripts
RUN pnpm --filter @internpath/job exec prisma generate
RUN pnpm --filter @internpath/job... build

FROM node:20-alpine
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/apps/job
EXPOSE 3002
USER node
CMD ["node", "dist/main.js"]
