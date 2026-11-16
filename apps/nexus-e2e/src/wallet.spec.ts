import { Browser, Page, expect, test } from '@playwright/test';

import { E2eUser, e2eUsers } from './users';

// Spec acceptance test 9, against the real auth and wallet: log in, see the seeded balance, send
// $5 to a second user, check both balances after a refresh, and make sure a double click on Send
// creates one transfer. The tests share one sender and run in order.
test.describe.configure({ mode: 'serial' });

const { sender, recipient } = e2eUsers();

async function signIn(page: Page, user: E2eUser) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/wallet$/);
}

/** A separate browser context: its own cookies, so its own session. */
async function signedInPage(browser: Browser, user: E2eUser) {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, user);
  return page;
}

const balance = (page: Page) =>
  page.getByTestId('balance-USD').locator('dd').first();
const history = (page: Page) => page.getByRole('list', { name: 'History' });

async function send(page: Page, toEmail: string, amount: string) {
  await page.getByRole('link', { name: 'Send', exact: true }).click();
  await page.getByLabel("Recipient's email").fill(toEmail);
  await page.getByLabel('Amount (USD)').fill(amount);
}

test('a signed-in user sees the seeded balance', async ({ browser }) => {
  const page = await signedInPage(browser, sender);

  await expect(balance(page)).toHaveText('$100.00');
  await expect(history(page).getByText('+$100.00')).toBeVisible();
});

test('sending $5 shows on both wallets after a refresh', async ({
  browser,
}) => {
  const page = await signedInPage(browser, sender);

  await send(page, recipient.email, '5');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('status')).toHaveText(
    `Sent $5.00 to ${recipient.email}.`,
  );

  await page.goto('/wallet');
  await page.reload();
  await expect(balance(page)).toHaveText('$95.00');
  await expect(history(page).getByText('-$5.00')).toHaveCount(1);

  const other = await signedInPage(browser, recipient);
  await expect(balance(other)).toHaveText('$5.00');
  await expect(history(other).getByText('+$5.00')).toHaveCount(1);
});

test('double-clicking Send creates one transfer', async ({ browser }) => {
  const page = await signedInPage(browser, sender);

  await send(page, recipient.email, '1');
  await page.getByRole('button', { name: 'Send' }).dblclick();
  await expect(page.getByRole('status')).toHaveText(
    `Sent $1.00 to ${recipient.email}.`,
  );

  await page.goto('/wallet');
  await page.reload();
  await expect(balance(page)).toHaveText('$94.00');
  await expect(history(page).getByText('-$1.00')).toHaveCount(1);

  const other = await signedInPage(browser, recipient);
  await expect(balance(other)).toHaveText('$6.00');
});

test('a refused transfer explains why and moves nothing', async ({
  browser,
}) => {
  const page = await signedInPage(browser, sender);

  await send(page, recipient.email, '1000');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(
    page.getByText('Not enough money in your wallet.'),
  ).toBeVisible();

  await page.getByRole('link', { name: 'Wallet', exact: true }).click();
  await expect(balance(page)).toHaveText('$94.00');
});

test('signed-out visitors are sent to the login page', async ({ page }) => {
  await page.goto('/send');

  await expect(page).toHaveURL(/\/login\?returnUrl=/);
});
