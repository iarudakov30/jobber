-- The real coins (phase 4.5): real prices, paper trading, 8 decimal places each like the fake
-- market's coins. Must match ASSETS in @jobber/money (a test compares them).
INSERT INTO assets (code, scale) VALUES
  ('BTC', 8),
  ('ETH', 8),
  ('HYPE', 8),
  ('ZEC', 8)
ON CONFLICT (code) DO NOTHING;
