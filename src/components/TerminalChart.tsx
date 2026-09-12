import { useEffect, useRef } from "react";
import { AreaSeries, ColorType, HistogramSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

// Keep every trading surface on the same terminal palette. The coin route and
// the standalone terminal intentionally share this renderer so line color,
// grid contrast, and crosshair labels cannot drift apart again.
const UP = "#26d98a";
const DOWN = "#ff4f6a";

// Switched from candlesticks to a smooth filled area/line 2026-09-12 (user
// request: "chart buy dan sell harus bener-bener mulus" — really smooth).
// Two real problems candlesticks had, not just an aesthetic preference:
// most Arcodian coins trade a handful of times a day, so a 1m/5m candle
// grid was mostly empty wicks with huge gaps — looked broken, not "sparse
// but legitimate" the way a continuous line reads with the exact same
// underlying data. A smooth area also matches what traders coming from
// Pons/pump.fun-style launchpads already expect from a bonding-curve chart.
// Still real, still onchain — this draws the same close-price series a
// candle chart would, just without inventing OHLC structure sparse trade
// data doesn't actually support.
export function TerminalChart({ candles, priceLabel, onHover }: { candles: Candle[]; priceLabel: (value: number) => string; onHover: (candle: Candle | null) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
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
    // lineWidth 3 + curved corners (lightweight-charts' Area series draws a
    // straight-segment polyline, not a spline — the "smoothness" comes from
    // point density plus a soft gradient fill, same trick the Market card
    // sparklines already use) reads as fluid at any zoom level instead of
    // the jagged, thin line a lineWidth:1 chart gets at wide time ranges.
    const series = chart.addSeries(AreaSeries, {
      lineColor: UP, topColor: "rgba(38,217,138,.32)", bottomColor: "rgba(38,217,138,.02)",
      lineWidth: 3, priceFormat: { type: "custom", formatter: priceLabel, minMove: 1e-12 },
      crosshairMarkerRadius: 5, crosshairMarkerBorderColor: "#05070a", crosshairMarkerBorderWidth: 2,
    });
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume", color: "rgba(38,217,138,.28)" });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    series.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.22 } });
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
    seriesRef.current.setData(candles.map((candle) => ({ time: asTime(candle.time), value: candle.close })));
    // Trend color: green if this window's price is net up since its first
    // point, red if net down — an area chart has one continuous fill, not
    // per-bar coloring, so this is the equivalent signal a candle chart's
    // green/red bars gave, just computed over the visible range instead of
    // bar-by-bar (matches how the Market card sparklines already color).
    const first = candles[0]?.close;
    const last = candles.at(-1)?.close;
    const up = first == null || last == null || last >= first;
    const accent = up ? UP : DOWN;
    seriesRef.current.applyOptions({
      lineColor: accent,
      topColor: up ? "rgba(38,217,138,.32)" : "rgba(255,79,106,.28)",
      bottomColor: up ? "rgba(38,217,138,.02)" : "rgba(255,79,106,.02)",
    });
    volumeRef.current.setData(candles.map((candle, index) => {
      const previousClose = index > 0 ? candles[index - 1].close : candle.open;
      return { time: asTime(candle.time), value: candle.volume, color: candle.close >= previousClose ? "rgba(38,217,138,.32)" : "rgba(255,79,106,.32)" };
    }));
    if (!hasFitRef.current && candles.length) {
      chartRef.current?.timeScale().fitContent();
      hasFitRef.current = true;
    }
  }, [candles]);

  return <div ref={containerRef} className="terminal-chart-canvas" />;
}
