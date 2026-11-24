FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /app
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY next.config.ts postcss.config.mjs tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:22-alpine
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/.npmrc ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
