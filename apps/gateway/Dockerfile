# build จากราก repo:  docker build -f apps/gateway/Dockerfile .
FROM node:20-alpine AS build
RUN npm install -g pnpm@9.15.0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY libs ./libs
COPY apps/gateway ./apps/gateway
RUN pnpm install --frozen-lockfile --filter @internpath/gateway... --ignore-scripts
RUN pnpm --filter @internpath/gateway... build

FROM node:20-alpine
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/apps/gateway
EXPOSE 3000
USER node
CMD ["node", "dist/main.js"]
