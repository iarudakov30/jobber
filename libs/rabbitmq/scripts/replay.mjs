// Moves the messages waiting in <queue>.dlq back to <queue> as first attempts.
//
//   npx nx run rabbitmq:replay --queue=notifications.email
//
// RABBITMQ_URL defaults to amqp://localhost:5672. Only the messages in the DLQ when the script
// starts are moved, so one that fails again and returns to the DLQ isn't replayed in a loop.
// Each message keeps its messageId and original routing key; the attempt count and dead-letter
// reason are dropped.
import { connect } from 'amqplib';

const queue = argument('queue');
if (!queue) {
  console.error('Usage: replay.mjs --queue=<name>');
  process.exit(1);
}
const url = process.env.RABBITMQ_URL ?? 'amqp://localhost:5672';
const dlq = `${queue}.dlq`;

const model = await connect(url);
try {
  const channel = await model.createConfirmChannel();
  await channel.checkQueue(queue);
  const { messageCount } = await channel.checkQueue(dlq);
  let moved = 0;
  for (let i = 0; i < messageCount; i++) {
    const message = await channel.get(dlq, { noAck: false });
    if (!message) {
      break;
    }
    const headers = Object.fromEntries(
      Object.entries(message.properties.headers ?? {}).filter(
        ([name]) =>
          name !== 'x-attempt' &&
          name !== 'x-dead-letter-reason' &&
          name !== 'x-death' &&
          !name.startsWith('x-first-death-') &&
          !name.startsWith('x-last-death-'),
      ),
    );
    await new Promise((resolve, reject) =>
      channel.sendToQueue(
        queue,
        message.content,
        {
          messageId: message.properties.messageId,
          contentType: message.properties.contentType,
          timestamp: message.properties.timestamp,
          persistent: true,
          headers,
        },
        (err) => (err ? reject(err) : resolve()),
      ),
    );
    // Only after the broker confirmed the copy: a crash in between duplicates, never loses.
    channel.ack(message);
    moved++;
  }
  console.log(`Moved ${moved} message(s) from ${dlq} to ${queue}`);
  await channel.close();
} finally {
  await model.close();
}

function argument(name) {
  const args = process.argv.slice(2);
  for (const [i, arg] of args.entries()) {
    if (arg === `--${name}`) {
      return args[i + 1];
    }
    if (arg.startsWith(`--${name}=`)) {
      return arg.slice(name.length + 3);
    }
  }
  return undefined;
}
