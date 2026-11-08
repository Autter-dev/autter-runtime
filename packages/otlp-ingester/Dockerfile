FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/otlp-ingester/package.json packages/otlp-ingester/
RUN npm install --workspace @autter/otlp-ingester
COPY packages/otlp-ingester packages/otlp-ingester
RUN npm run build -w @autter/otlp-ingester

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/otlp-ingester/package.json packages/otlp-ingester/
RUN npm install --workspace @autter/otlp-ingester --omit=dev && npm cache clean --force
COPY --from=build /app/packages/otlp-ingester/dist packages/otlp-ingester/dist
# Sink outbox: undelivered webhook batches, re-sent after a restart. Owned by
# the runtime user so a named volume mounted here is writable. Unused unless
# AUTTER_SINK_URL is set; SINK_OUTBOX_DIR=off keeps the queue in memory.
RUN mkdir -p /var/lib/autter/sink-outbox && chown node:node /var/lib/autter/sink-outbox
ENV SINK_OUTBOX_DIR=/var/lib/autter/sink-outbox
USER node
EXPOSE 4318
CMD ["node", "packages/otlp-ingester/dist/index.js"]
