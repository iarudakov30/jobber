-- Custom SQL migration file, put your code below! --

-- Every transaction's entries must sum to zero per asset. A deferred constraint trigger runs at
-- COMMIT, after all of a transaction's entries are in, so a half-written posting can't commit.
CREATE FUNCTION ledger_check_transaction_balanced() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM entries
    WHERE transaction_id = NEW.transaction_id
    GROUP BY asset
    HAVING sum(amount) <> 0
  ) THEN
    RAISE EXCEPTION 'transaction % is not balanced', NEW.transaction_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'entries_balanced';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER entries_balanced
  AFTER INSERT ON entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_transaction_balanced();
--> statement-breakpoint

-- Entries are append-only: a correction is a new, reversing transaction.
CREATE FUNCTION ledger_reject_entry_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'entries are append-only (% rejected)', TG_OP
    USING ERRCODE = 'restrict_violation';
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER entries_append_only
  BEFORE UPDATE OR DELETE ON entries
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_entry_change();
--> statement-breakpoint
CREATE TRIGGER entries_no_truncate
  BEFORE TRUNCATE ON entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_entry_change();
--> statement-breakpoint

-- USD only in phase 2; the coins arrive with the market in phase 4.
INSERT INTO assets (code, scale) VALUES ('USD', 2) ON CONFLICT (code) DO NOTHING;
