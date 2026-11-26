import {
  CandlestickSeries,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  createChart,
} from 'lightweight-charts';
import { useEffect, useRef } from 'react';

import { type Bar, applyTick } from './bars';

/**
 * 1-minute candles with lightweight-charts: `bars` from the `candles` query, then each live
 * `tick` updates the last bar (or starts the next minute's).
 */
export function PriceChart({
  bars,
  tick,
}: {
  bars: Bar[];
  tick?: { price: string; at: number };
}) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const last = useRef<Bar | undefined>(undefined);

  useEffect(() => {
    if (!container.current) {
      return;
    }
    const created = createChart(container.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'white' },
        textColor: '#475569',
      },
      grid: {
        vertLines: { color: '#f1f5f9' },
        horzLines: { color: '#f1f5f9' },
      },
      timeScale: { timeVisible: true, secondsVisible: false },
    });
    series.current = created.addSeries(CandlestickSeries, {
      upColor: '#059669',
      downColor: '#dc2626',
      borderVisible: false,
      wickUpColor: '#059669',
      wickDownColor: '#dc2626',
    });
    chart.current = created;
    return () => {
      created.remove();
      chart.current = null;
      series.current = null;
    };
  }, []);

  useEffect(() => {
    series.current?.setData(
      bars.map((b) => ({ ...b, time: b.time as UTCTimestamp })),
    );
    last.current = bars.at(-1);
    chart.current?.timeScale().scrollToRealTime();
  }, [bars]);

  useEffect(() => {
    if (!tick) {
      return;
    }
    const bar = applyTick(last.current, tick);
    if (bar) {
      series.current?.update({ ...bar, time: bar.time as UTCTimestamp });
      last.current = bar;
    }
  }, [tick]);

  return (
    <div
      ref={container}
      className="h-80 w-full"
      data-testid="price-chart"
      aria-label="Price chart"
    />
  );
}
