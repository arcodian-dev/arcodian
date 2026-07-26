import { useEffect, useRef } from "react";
import { CandlestickSeries, ColorType, HistogramSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

const UP = "#22C55E";
const DOWN = "#F0475A";

/// TradingView's own open-source charting engine (lightweight-charts), not the
/// TradingView widget — the widget only plots symbols TradingView itself
/// indexes, which can't show a bonding-curve or freshly graduated pair. This
/// renders our own indexed trade data through the same rendering engine and
/// interaction model (crosshair, wheel-zoom, drag-pan) traders already expect.
export function TerminalChart({ candles, priceLabel, onHover }: { candles: Candle[]; priceLabel: (value: number) => string; onHover: (candle: Candle | null) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const candlesRef = useRef<Candle[]>(candles);
  candlesRef.current = candles;
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = createChart(container, {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#93A6C4", fontFamily: "\"Spline Sans Mono\",\"JetBrains Mono\",monospace", fontSize: 11 },
      grid: { vertLines: { color: "rgba(233,239,250,.06)" }, horzLines: { color: "rgba(233,239,250,.06)" } },
      rightPriceScale: { borderColor: "rgba(233,239,250,.14)" },
      timeScale: { borderColor: "rgba(233,239,250,.14)", timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: "#5AD6F7", labelBackgroundColor: "#0A1428" }, horzLine: { color: "#5AD6F7", labelBackgroundColor: "#0A1428" } },
      autoSize: true,
    });
    const series = chart.addSeries(CandlestickSeries, { upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN, priceFormat: { type: "custom", formatter: priceLabel, minMove: 1e-12 } });
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume", color: "rgba(147,166,196,.35)" });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    series.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.22 } });
    chartRef.current = chart;
    seriesRef.current = series;
    volumeRef.current = volume;
    const handleCrosshair = (param: { time?: unknown }) => {
      const time = param.time as number | undefined;
      onHoverRef.current(time ? candlesRef.current.find((candle) => candle.time === time) || null : null);
    };
    chart.subscribeCrosshairMove(handleCrosshair);
    return () => { chart.unsubscribeCrosshairMove(handleCrosshair); chart.remove(); chartRef.current = null; seriesRef.current = null; volumeRef.current = null; };
    // priceLabel is stable per-render currency choice, not worth tearing the chart down for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!seriesRef.current || !volumeRef.current) return;
    const asTime = (seconds: number) => seconds as UTCTimestamp;
    seriesRef.current.setData(candles.map((candle) => ({ time: asTime(candle.time), open: candle.open, high: candle.high, low: candle.low, close: candle.close })));
    volumeRef.current.setData(candles.map((candle) => ({ time: asTime(candle.time), value: candle.volume, color: candle.close >= candle.open ? "rgba(34,197,94,.35)" : "rgba(240,71,90,.35)" })));
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  return <div ref={containerRef} className="terminal-chart-canvas" />;
}
