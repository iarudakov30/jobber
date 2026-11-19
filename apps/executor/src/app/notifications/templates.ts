import { AssetCode, formatAmount, fromWire } from '@jobber/money';
import { TopUpEmailMessage } from '@jobber/rabbitmq';

export interface Email {
  subject: string;
  text: string;
  html: string;
}

/** "Your top-up of $50.00 is in your wallet". */
export function topUpEmail(message: TopUpEmailMessage): Email {
  const amount = formatAmount(
    fromWire(message.amount),
    message.currency as AssetCode,
  );
  return {
    subject: `Your top-up of ${amount} is in your NexusPay wallet`,
    text:
      `We received your payment of ${amount}. It is now available in your NexusPay wallet.\n\n` +
      `Payment reference: ${message.paymentId}\n`,
    html:
      `<p>We received your payment of <strong>${amount}</strong>. ` +
      `It is now available in your NexusPay wallet.</p>` +
      `<p style="color:#666">Payment reference: ${message.paymentId}</p>`,
  };
}
