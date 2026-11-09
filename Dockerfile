# Zostavenie: klienta hry (build/client/) a moduly pre /debug (build/shared/, build/debug-compat/) zbalí esbuild (#122, #136) – potrebuje dev závislosti.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY scripts/build.mjs ./scripts/
COPY src ./src
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY --from=build /app/build ./build
COPY public ./public
COPY debug ./debug
RUN mkdir -p data && chown node:node data
USER node
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1
CMD ["node", "src/server/server.ts"]
