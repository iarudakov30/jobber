# Builder Stage
FROM node:20-slim AS builder

WORKDIR /workspace

RUN apt-get update && apt-get install -y openssl

# Copy necessary files for building the app
COPY package*.json ./
COPY nx.json ./
COPY tsconfig*.json ./
COPY jest.config.ts ./
COPY jest.preset.js ./
#COPY .eslintrc.json ./
COPY webpack.*.config.js ./

COPY apps/executor ./apps/executor
COPY libs/grpc ./libs/grpc
COPY libs/money ./libs/money
COPY libs/nestjs ./libs/nestjs
COPY libs/pulsar ./libs/pulsar
COPY libs/rabbitmq ./libs/rabbitmq
COPY libs/tracing ./libs/tracing

# Install dependencies
RUN npm install

RUN apt-get update && apt-get install -y protobuf-compiler

RUN npx nx build executor

# Runner Stage
FROM node:20-slim AS runner

RUN apt-get update && apt-get install -y openssl

WORKDIR /app

COPY --from=builder /workspace/package.json ./
COPY --from=builder /workspace/apps/executor/package.json ./apps/executor/package.json
COPY --from=builder /workspace/libs/tracing/package.json ./libs/tracing/package.json
COPY --from=builder /workspace/libs/grpc/package.json ./libs/grpc/package.json
COPY --from=builder /workspace/libs/pulsar/package.json ./libs/pulsar/package.json
COPY --from=builder /workspace/libs/money/package.json ./libs/money/package.json
COPY --from=builder /workspace/libs/rabbitmq/package.json ./libs/rabbitmq/package.json
COPY --from=builder /workspace/package-lock.json ./

ENV NODE_ENV=production

RUN npm ci

# Copy build output
COPY --from=builder /workspace/dist ./dist

# Copy entrypoint script
COPY apps/executor/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

ENTRYPOINT ["/app/docker-entrypoint.sh"]
