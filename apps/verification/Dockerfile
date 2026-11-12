# build จากราก repo:  docker build -f apps/verification/Dockerfile .
FROM node:20-alpine AS build
RUN npm install -g pnpm@9.15.0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY libs ./libs
COPY apps/verification ./apps/verification
RUN pnpm install --frozen-lockfile --filter @internpath/verification... --ignore-scripts
RUN pnpm --filter @internpath/verification exec prisma generate
RUN pnpm --filter @internpath/verification... build

FROM node:20-alpine
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/apps/verification
EXPOSE 3003
USER node
CMD ["node", "dist/main.js"]
