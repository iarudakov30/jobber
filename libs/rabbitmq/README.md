# rabbitmq

RabbitMQ for NestJS apps: one self-healing connection (`RabbitConnection`), a confirm-channel
publisher (`RabbitPublisher`), and `RabbitConsumer<T>` with explicit retry queues
(`<queue>.retry.<n>`), a dead-letter queue (`<queue>.dlq`) and delay buckets that keep the routing
key. The topology is declared from `RabbitModule.forRoot({ url, topology })` on every connect.

Move dead-lettered messages back: `npx nx run rabbitmq:replay --queue=<name>`.

Run `nx test rabbitmq` to execute the tests (Docker required: Testcontainers).
