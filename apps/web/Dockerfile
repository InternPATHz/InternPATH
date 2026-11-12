# build จากราก repo:  docker build -f apps/web/Dockerfile .
FROM node:20-alpine AS build
RUN npm install -g pnpm@9.15.0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY libs/contracts ./libs/contracts
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile --filter @internpath/web... --ignore-scripts
RUN pnpm --filter @internpath/contracts build && pnpm --filter @internpath/web build

FROM node:20-alpine
RUN npm install -g pnpm@9.15.0
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/apps/web
EXPOSE 3100
USER node
CMD ["pnpm", "start"]
