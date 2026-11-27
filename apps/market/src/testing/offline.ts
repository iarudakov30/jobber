// Jest `setupFiles`: runs before every test file. Nx loads `apps/market/.env` into each task's
// environment, `MARKET_LIVE_PRICES=on` included, so without this a suite that builds the app from
// its env would connect to the real exchanges. No test may: those that need live prices pass
// `LIVE_PRICES_OPTIONS` themselves, pointed at the fake exchanges (testing/fake-exchanges.ts).
for (const name of [
  'MARKET_LIVE_PRICES',
  'MARKET_PRICE_PROVIDERS',
  'COINBASE_WS_URL',
  'COINBASE_REST_URL',
  'BINANCE_WS_URL',
  'BINANCE_REST_URL',
]) {
  delete process.env[name];
}
