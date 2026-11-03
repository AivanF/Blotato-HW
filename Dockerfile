FROM node:24-alpine
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile --prod

ENV NODE_ENV=production
# Node runs the TypeScript directly, so there's no build step.
CMD ["node", "--disable-warning=ExperimentalWarning", "apps/server/src/main.ts"]
