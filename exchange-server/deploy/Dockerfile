FROM node:24-bookworm-slim AS build
ENV API_INTERNAL_URL=http://api:3001 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY exchange-server/package.json exchange-server/package-lock.json ./exchange-server/
COPY exchange-server/apps/api/package.json ./exchange-server/apps/api/
COPY exchange-server/apps/web/package.json ./exchange-server/apps/web/
COPY exchange-server/packages/protocol/package.json ./exchange-server/packages/protocol/
RUN cd exchange-server && npm ci
COPY src ./src
COPY preview-src ./preview-src
COPY tsconfig.base.json ./tsconfig.base.json
COPY media ./media
COPY chrome-extension/sidepanel.css ./chrome-extension/sidepanel.css
COPY exchange-server ./exchange-server
RUN cd exchange-server && npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app/exchange-server
COPY --from=build --chown=node:node /app/exchange-server/node_modules ./node_modules
COPY --from=build --chown=node:node /app/exchange-server/package.json ./package.json
COPY --from=build --chown=node:node /app/exchange-server/packages/protocol ./packages/protocol
COPY --from=build --chown=node:node /app/exchange-server/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /app/exchange-server/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=node:node /app/exchange-server/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/exchange-server/apps/api/scripts ./apps/api/scripts
COPY --from=build --chown=node:node /app/exchange-server/apps/api/drizzle ./apps/api/drizzle
COPY --from=build --chown=node:node /app/exchange-server/apps/web/package.json ./apps/web/package.json
COPY --from=build --chown=node:node /app/exchange-server/apps/web/node_modules ./apps/web/node_modules
COPY --from=build --chown=node:node /app/exchange-server/apps/web/next.config.ts ./apps/web/next.config.ts
COPY --from=build --chown=node:node /app/exchange-server/apps/web/.next ./apps/web/.next
COPY --from=build --chown=node:node /app/exchange-server/apps/web/public ./apps/web/public
USER node

FROM runtime AS api
WORKDIR /app/exchange-server/apps/api
CMD ["node", "dist/main.js"]

FROM runtime AS web
WORKDIR /app/exchange-server/apps/web
CMD ["node", "../../node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
