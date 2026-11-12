# build จากราก repo:  docker build -f apps/identity/Dockerfile .
FROM node:20-alpine AS build
RUN npm install -g pnpm@9.15.0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY libs ./libs
COPY apps/identity ./apps/identity
RUN pnpm install --frozen-lockfile --filter @internpath/identity... --ignore-scripts
RUN pnpm --filter @internpath/identity exec prisma generate
RUN pnpm --filter @internpath/identity... build

FROM node:20-alpine
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/apps/identity
EXPOSE 3001
USER node
CMD ["node", "dist/main.js"]
