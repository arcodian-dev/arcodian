import { useEffect, useRef } from "react";
import { CandlestickSeries, ColorType, HistogramSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

// Keep every trading surface on the same terminal palette. The coin route and
// the standalone terminal intentionally share this renderer so candle colors,
// grid contrast, and crosshair labels cannot drift apart again.
const UP = "#26d98a";
const DOWN = "#ff4f6a";

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
  // Only auto-fit the very first time this coin gets data. Every later poll
  // (candles arrive every few seconds while a market is live) used to call
  // fitContent() again too, snapping any zoom/pan the trader had just done
  // straight back out — made the chart look "stuck" and unzoomable even
  // though scroll/pinch zoom itself worked fine.
  const hasFitRef = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = createChart(container, {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#8b97a8", fontFamily: "\"JetBrains Mono\",ui-monospace,monospace", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: "#121926" }, horzLines: { color: "#121926" } },
      rightPriceScale: { borderColor: "#161d29" },
      timeScale: { borderColor: "#161d29", timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: "rgba(38,217,138,.55)", labelBackgroundColor: "#153a2b" }, horzLine: { color: "rgba(38,217,138,.55)", labelBackgroundColor: "#153a2b" } },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
      autoSize: true,
    });
    const series = chart.addSeries(CandlestickSeries, { upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN, priceFormat: { type: "custom", formatter: priceLabel, minMove: 1e-12 } });
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume", color: "rgba(38,217,138,.35)" });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    series.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.22 } });
    chartRef.current = chart;
    seriesRef.current = series;
    volumeRef.current = volume;
    hasFitRef.current = false;
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
    volumeRef.current.setData(candles.map((candle) => ({ time: asTime(candle.time), value: candle.volume, color: candle.close >= candle.open ? "rgba(38,217,138,.35)" : "rgba(255,79,106,.35)" })));
    if (!hasFitRef.current && candles.length) {
      chartRef.current?.timeScale().fitContent();
      hasFitRef.current = true;
    }
  }, [candles]);

  return <div ref={containerRef} className="terminal-chart-canvas" />;
}
