# build จากราก repo:  docker build -f apps/lifecycle/Dockerfile .
FROM node:20-alpine AS build
RUN npm install -g pnpm@9.15.0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY libs ./libs
COPY apps/lifecycle ./apps/lifecycle
RUN pnpm install --frozen-lockfile --filter @internpath/lifecycle... --ignore-scripts
RUN pnpm --filter @internpath/lifecycle exec prisma generate
RUN pnpm --filter @internpath/lifecycle... build

FROM node:20-alpine
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/apps/lifecycle
EXPOSE 3004
USER node
CMD ["node", "dist/main.js"]
