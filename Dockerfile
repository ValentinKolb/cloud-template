# Production image for the template app. 3 stages, oven/bun:1-alpine.
#
#   docker build -t my-app .

FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

FROM deps AS build
ENV NODE_ENV=production \
    APP_ID=expeditions \
    APP_DIR=.
COPY tsconfig.json ./
COPY src src
RUN bun run node_modules/@valentinkolb/cloud/scripts/build.ts

FROM oven/bun:1-alpine AS runtime
WORKDIR /app
COPY --from=build /app/dist ./
EXPOSE 3000
CMD ["bun", "server.js"]
