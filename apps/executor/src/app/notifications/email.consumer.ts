import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientGrpc } from '@nestjs/microservices';
import type { Transporter } from 'nodemailer';
import { firstValueFrom } from 'rxjs';
import {
  AUTH_SERVICE_NAME,
  AuthServiceClient,
  GrpcStatus,
  Packages,
} from '@jobber/grpc';
import { validateMessage } from '@jobber/pulsar';
import {
  EMAIL_QUEUE,
  EMAIL_TOPUP,
  NonRetryableError,
  RabbitConnection,
  RabbitConsumer,
  RabbitMessageMeta,
  TopUpEmailMessage,
} from '@jobber/rabbitmq';
import { SENT_EMAILS, SentEmails } from './sent-emails';
import { topUpEmail } from './templates';

export const MAILER = 'MAILER';

/**
 * Sends the emails queued on `notifications.email`. A failure (mail server down, auth
 * unreachable) is retried after 5 s, 30 s and 5 min, and after the 5th attempt the message waits
 * in `notifications.email.dlq` for `nx run rabbitmq:replay`. Bad data and unknown users go to
 * the DLQ at once.
 */
@Injectable()
export class EmailConsumer
  extends RabbitConsumer<unknown>
  implements OnModuleInit
{
  private auth: AuthServiceClient;
  private readonly from: string;

  constructor(
    connection: RabbitConnection,
    @Inject(Packages.AUTH) private readonly authClient: ClientGrpc,
    @Inject(MAILER) private readonly mailer: Transporter,
    @Inject(SENT_EMAILS) private readonly sent: SentEmails,
    configService: ConfigService,
  ) {
    super(connection, EMAIL_QUEUE);
    this.from = configService.get(
      'EMAIL_FROM',
      'NexusPay <no-reply@nexuspay.test>',
    );
  }

  override onModuleInit(): void {
    this.auth =
      this.authClient.getService<AuthServiceClient>(AUTH_SERVICE_NAME);
    super.onModuleInit();
  }

  protected async onMessage(
    data: unknown,
    meta: RabbitMessageMeta,
  ): Promise<void> {
    if (meta.routingKey !== EMAIL_TOPUP) {
      throw new NonRetryableError(`No email template for ${meta.routingKey}`);
    }
    if (!meta.messageId) {
      // Without an id a redelivery can't be recognised; every publisher here sets one.
      throw new NonRetryableError('An email message needs a messageId');
    }
    const message = await validateMessage(TopUpEmailMessage, data);

    if (await this.sent.has(meta.messageId)) {
      this.logger.log(`Email for ${meta.messageId} was already sent`);
      return;
    }
    const to = await this.emailOf(message.userId);
    const email = topUpEmail(message);
    await this.mailer.sendMail({
      from: this.from,
      to,
      subject: email.subject,
      text: email.text,
      html: email.html,
      headers: { 'X-NexusPay-Message-Id': meta.messageId },
    });
    await this.sent.remember(meta.messageId);
    this.logger.log(
      `Sent ${meta.routingKey} for payment ${message.paymentId} (attempt ${meta.attempt})`,
    );
  }

  private async emailOf(userId: number): Promise<string> {
    try {
      return (await firstValueFrom(this.auth.getUser({ id: userId }))).email;
    } catch (error) {
      if ((error as { code?: number }).code === GrpcStatus.NOT_FOUND) {
        throw new NonRetryableError(`No user ${userId}`);
      }
      throw error;
    }
  }
}
