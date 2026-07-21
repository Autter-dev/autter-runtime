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
USER node
EXPOSE 4318
CMD ["node", "packages/otlp-ingester/dist/index.js"]
