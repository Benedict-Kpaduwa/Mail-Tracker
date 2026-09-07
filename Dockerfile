# Build the server + dashboard, then run with a slim runtime image.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build:server && npm run build:dashboard

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# better-sqlite3 ships a prebuilt binary for this base image via npm ci above.
VOLUME ["/app/data"]
ENV DB_PATH=/app/data/mailtrack.db
EXPOSE 8787
CMD ["node", "dist/server/index.js"]
