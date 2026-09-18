import { useEffect, useRef } from "react";
import { CandlestickSeries, ColorType, HistogramSeries, LineStyle, createChart, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import type { Candle, ChartRange } from "../stocks";

const UP = "#8FC79A";
const DOWN = "#E0766A";

/** Seconds to add to a UTC timestamp to show New York wall-clock time. The
 * chart library labels axes in UTC, and US stocks are read in exchange time. */
function newYorkOffset(at: number): number {
  const date = new Date(at * 1000);
  const ny = new Date(date.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const utc = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
  return Math.round((ny.getTime() - utc.getTime()) / 1000);
}

/** Candles plus volume for one stock and range. `live` (the latest signed or
 * displayed price) moves the last intraday candle between candle refreshes. */
export function StockChart({ candles, range, live }: { candles: Candle[]; range: ChartRange; live: number | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const lineRef = useRef<IPriceLine | null>(null);
  const lastRef = useRef<{ time: UTCTimestamp; open: number; high: number; low: number; close: number } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = createChart(container, {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#8F8468", fontFamily: "\"Space Mono\",ui-monospace,monospace", fontSize: 10, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: "rgba(237,230,214,.05)" } },
      rightPriceScale: { borderColor: "rgba(237,230,214,.10)", scaleMargins: { top: 0.08, bottom: 0.22 } },
      timeScale: { borderColor: "rgba(237,230,214,.10)", rightOffset: 3, minBarSpacing: 0.5 },
      crosshair: {
        vertLine: { color: "rgba(143,199,154,.45)", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#24382a" },
        horzLine: { color: "rgba(143,199,154,.45)", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#24382a" },
      },
      autoSize: true,
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "rgba(143,199,154,.35)", downColor: "rgba(224,118,106,.35)", borderUpColor: UP, borderDownColor: DOWN,
      wickUpColor: "rgba(143,199,154,.8)", wickDownColor: "rgba(224,118,106,.8)", lastValueVisible: false, priceLineVisible: false,
    });
    const volume = chart.addSeries(HistogramSeries, { priceScaleId: "volume", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chartRef.current = chart; seriesRef.current = series; volumeRef.current = volume;
    return () => { chart.remove(); chartRef.current = null; seriesRef.current = null; volumeRef.current = null; lineRef.current = null; };
  }, []);

  useEffect(() => {
    const chart = chartRef.current, series = seriesRef.current, volume = volumeRef.current;
    if (!chart || !series || !volume) return;
    const intraday = range === "1D" || range === "5D";
    chart.applyOptions({ timeScale: { timeVisible: intraday, secondsVisible: false } });
    const offset = candles.length ? newYorkOffset(candles[candles.length - 1].time) : 0;
    const bars = candles.map((c) => ({ time: (c.time + offset) as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close }));
    series.setData(bars);
    volume.setData(candles.map((c, i) => ({ time: bars[i].time, value: c.volume, color: c.close >= c.open ? "rgba(143,199,154,.22)" : "rgba(224,118,106,.22)" })));
    lastRef.current = bars.length ? { ...bars[bars.length - 1] } : null;
    chart.timeScale().fitContent();
  }, [candles, range]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series || live === null || !Number.isFinite(live)) return;
    if (!lineRef.current) lineRef.current = series.createPriceLine({ price: live, color: UP, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: "" });
    else lineRef.current.applyOptions({ price: live });
    const last = lastRef.current;
    if (last && (range === "1D" || range === "5D")) {
      const next = { ...last, close: live, high: Math.max(last.high, live), low: Math.min(last.low, live) };
      lastRef.current = next;
      series.update(next);
    }
  }, [live, range]);

  return <div className="stocks-chart" ref={containerRef} />;
}
