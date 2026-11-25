-- The fake market's coins (phase 4), 8 decimal places each. Must match ASSETS in @jobber/money.
-- Accounts reference assets(code), so a coin account can exist only once its asset row does.
INSERT INTO assets (code, scale) VALUES
  ('NXC', 8),
  ('BLIP', 8),
  ('ORB', 8),
  ('WISP', 8)
ON CONFLICT (code) DO NOTHING;
