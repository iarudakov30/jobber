import { Browser, Page, expect, test } from '@playwright/test';

import { killGateway, startGateway } from './gateway';
import { credit } from './global-setup';
import { E2eUser, e2eUsers } from './users';

// Phase 4 against the real auth, wallet, market and realtime gateway: trades whose results
// arrive on the user feed (no reload anywhere), and acceptance test 10, a gateway that dies
// under an open tab. The tests share one trader, who starts with $100.00, and run in order.
test.describe.configure({ mode: 'serial' });

const { trader, ownsGateway } = e2eUsers();

async function signedInPage(browser: Browser, user: E2eUser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/wallet$/);
  return page;
}

const connection = (page: Page) => page.getByTestId('connection-status');
const usd = (page: Page) => page.getByTestId('trade-balance-USD').locator('dd');
const nxc = (page: Page) => page.getByTestId('trade-balance-NXC').locator('dd');
const orderForm = (page: Page) => page.getByRole('form', { name: 'Order' });

/** Dollars in a "$1,234.56" text (the first amount in it). */
function dollars(text: string | null): number {
  const match = /\$([\d,]+\.\d{2})/.exec(text ?? '');
  if (!match) {
    throw new Error(`no amount in ${text}`);
  }
  return Number(match[1].replace(/,/g, ''));
}

async function openTrade(browser: Browser): Promise<Page> {
  const page = await signedInPage(browser, trader);
  await page.goto('/trade/NXC');
  await expect(connection(page)).toHaveAttribute('data-status', 'open');
  await expect(page.getByTestId('live-price')).toHaveText(/\$\d/);
  return page;
}

test('a market buy: the quote, the fill and the new balances arrive live', async ({
  browser,
}) => {
  const page = await openTrade(browser);
  await expect(usd(page)).toHaveText('$100.00');

  await orderForm(page).getByLabel('Quantity (NXC)').fill('0.1');
  await orderForm(page).getByRole('button', { name: 'Get quote' }).click();
  await expect(page.getByTestId('quote-countdown')).toHaveText(
    /Quote valid for \d+ s/,
  );
  await orderForm(page).getByRole('button', { name: 'Buy NXC' }).click();

  const done = orderForm(page).getByRole('status');
  await expect(done).toHaveText(/^Bought 0\.1 NXC for \$\d+\.\d{2}\.$/);
  const paid = dollars(await done.textContent());
  // From the user feed, without a reload: the fill's toast and both balances.
  await expect(page.getByTestId('toast')).toContainText(
    `Bought 0.1 NXC for $${paid.toFixed(2)}`,
  );
  await expect(usd(page)).toHaveText(`$${(100 - paid).toFixed(2)}`);
  await expect(nxc(page)).toHaveText('0.1 NXC');
  await expect(
    page.getByRole('list', { name: 'Recent orders' }).getByTestId('order'),
  ).toContainText(['Filled']);
});

test('a limit order holds its USD until it is cancelled', async ({
  browser,
}) => {
  const page = await openTrade(browser);
  const before = dollars(await usd(page).textContent());

  await orderForm(page).getByRole('radio', { name: 'Limit' }).click();
  await orderForm(page).getByLabel('Quantity (NXC)').fill('1');
  await orderForm(page).getByLabel('Limit price (USD per coin)').fill('1');
  await orderForm(page)
    .getByRole('button', { name: 'Place limit buy' })
    .click();

  await expect(orderForm(page).getByRole('status')).toHaveText(
    'Limit order placed: buy 1 NXC at $1.00.',
  );
  // $1.00 plus the 0.5% fee, rounded up: $1.01 held.
  await expect(usd(page)).toHaveText(
    `$${(before - 1.01).toFixed(2)} + $1.01 held`,
  );
  const open = page.getByRole('list', { name: 'Open orders' });
  await expect(open.getByTestId('order')).toHaveCount(1);

  await open.getByRole('button', { name: 'Cancel' }).click();

  await expect(page.getByText('No open orders.')).toBeVisible();
  await expect(usd(page)).toHaveText(`$${before.toFixed(2)}`);
});

test('a limit order the price crosses is filled by the market on its own', async ({
  browser,
}) => {
  const page = await openTrade(browser);
  const price = dollars(await page.getByTestId('live-price').textContent());

  await orderForm(page).getByRole('radio', { name: 'Limit' }).click();
  await orderForm(page).getByLabel('Quantity (NXC)').fill('0.01');
  // Far above the price: the next tick crosses it, and it fills at its limit.
  await orderForm(page)
    .getByLabel('Limit price (USD per coin)')
    .fill((price * 2).toFixed(2));
  await orderForm(page)
    .getByRole('button', { name: 'Place limit buy' })
    .click();

  await expect(page.getByTestId('toast').last()).toContainText(
    'Bought 0.01 NXC',
    { timeout: 10_000 },
  );
  await expect(nxc(page)).toHaveText('0.11 NXC');
  await expect(page.getByText('No open orders.')).toBeVisible();
});

test('the portfolio values the coins at live prices', async ({ browser }) => {
  const page = await signedInPage(browser, trader);
  await page.getByRole('link', { name: 'Portfolio', exact: true }).click();

  const row = page.getByTestId('position-NXC');
  await expect(row).toContainText('0.11 NXC');
  await expect(row.getByTestId('value')).toHaveText(/^\$\d+\.\d{2}$/);
  await expect(row.getByTestId('pl')).toHaveText(/^[+-]\$\d+\.\d{2}$/);
});

test('acceptance test 10: when its gateway dies, the tab reconnects, resubscribes and refetches', async ({
  browser,
}) => {
  test.skip(
    !ownsGateway,
    'A realtime gateway was already running on 3007; this test only kills one it started.',
  );
  const page = await openTrade(browser);
  const before = dollars(await usd(page).textContent());

  const killedAt = Date.now();
  killGateway();
  await expect(connection(page)).not.toHaveAttribute('data-status', 'open');

  // A change the tab can't hear about: nobody is there to forward it.
  await credit(trader.id, '500', `e2e-while-down:${trader.id}:${killedAt}`);
  await new Promise((r) => setTimeout(r, 2_000));
  await expect(usd(page)).toHaveText(`$${before.toFixed(2)}`);

  await startGateway();

  // Back within 30 s of the gateway dying...
  await expect(connection(page)).toHaveAttribute('data-status', 'open', {
    timeout: Math.max(1, 30_000 - (Date.now() - killedAt)),
  });
  // ...with the balance refetched (the missed credit shows, no reload)...
  await expect(usd(page)).toHaveText(`$${(before + 5).toFixed(2)}`);
  // ...and the price subscription restored: the live price moves again.
  const price = await page.getByTestId('live-price').textContent();
  await expect(page.getByTestId('live-price')).not.toHaveText(price ?? '', {
    timeout: 15_000,
  });
});
