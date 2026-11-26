CREATE TABLE "candles" (
	"coin" text NOT NULL,
	"interval" text NOT NULL,
	"start" timestamp with time zone NOT NULL,
	"open" bigint NOT NULL,
	"high" bigint NOT NULL,
	"low" bigint NOT NULL,
	"close" bigint NOT NULL,
	CONSTRAINT "candles_coin_interval_start_pk" PRIMARY KEY("coin","interval","start"),
	CONSTRAINT "candles_interval_valid" CHECK ("candles"."interval" IN ('1m')),
	CONSTRAINT "candles_prices_valid" CHECK ("candles"."low" > 0 AND "candles"."low" <= LEAST("candles"."open", "candles"."close") AND "candles"."high" >= GREATEST("candles"."open", "candles"."close"))
);
