import { useEffect, useRef } from "react";
import { CandlestickSeries, ColorType, HistogramSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import type { Candle } from "../candles";

export type { Candle };

// Both trading surfaces share this renderer on purpose, so candle colour,
// grid contrast and crosshair styling cannot drift apart between them.
const UP = "#19e79a";
const DOWN = "#ff5b70";
const UP_FILL = "rgba(25,231,154,.34)";
const DOWN_FILL = "rgba(255,91,112,.34)";

// History: this was candlesticks, became a smooth area chart on 2026-09-12,
// and is candlesticks again now. Worth recording why the first switch
// happened and why coming back is not just undoing it.
//
// The area chart was a response to a real problem — a 1m candle grid on a
// market that trades a few times an hour came out as a handful of bars
// separated by holes, which reads as broken data. But the holes were a bug
// in how candles were built, not something inherent to candles: empty
// buckets were dropped from the series entirely, and each bucket opened at
// its own first trade instead of the previous close, so even adjacent
// candles gapped. buildCandles fills both of those now, and a continuous
// candle series stays readable on a sparse market while still showing the
// open/high/low/close an area chart throws away.
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
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#68778c",
        fontFamily: "\"JetBrains Mono\",ui-monospace,monospace",
        fontSize: 10,
        attributionLogo: false,
      },
      // Horizontal lines only. A full grid competes with the candles for
      // attention at this candle width; price levels are what a trader
      // actually reads off the background.
      grid: { vertLines: { visible: false }, horzLines: { color: "rgba(112,132,157,.07)" } },
      rightPriceScale: { borderColor: "rgba(112,132,157,.13)", entireTextOnly: true },
      timeScale: { borderColor: "rgba(112,132,157,.13)", timeVisible: true, secondsVisible: false, rightOffset: 4, barSpacing: 9, minBarSpacing: 1 },
      crosshair: {
        vertLine: { color: "rgba(25,231,154,.4)", width: 1, style: 3, labelBackgroundColor: "#0d3527" },
        horzLine: { color: "rgba(25,231,154,.4)", width: 1, style: 3, labelBackgroundColor: "#0d3527" },
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
      autoSize: true,
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP_FILL,
      downColor: DOWN_FILL,
      // Borders carry the colour and the fills stay translucent, so a dense
      // run of candles reads as structure rather than as a solid block.
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: "rgba(25,231,154,.72)",
      wickDownColor: "rgba(255,91,112,.72)",
      priceFormat: { type: "custom", formatter: priceLabel, minMove: 1e-12 },
    });
    // Volume sits in its own scale pinned to the bottom fifth, so it reads
    // as a band under the price rather than as bars climbing through it.
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume", color: UP_FILL, base: 0 });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    series.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0.24 } });
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
    seriesRef.current.setData(candles.map((candle) => ({
      time: asTime(candle.time),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    })));
    volumeRef.current.setData(candles.map((candle) => ({
      time: asTime(candle.time),
      value: candle.volume,
      // Colour by the candle's own direction rather than against the
      // previous close: a doji in a quiet bucket has zero volume and no
      // direction, and colouring it red because the last real trade was
      // down put phantom red bars across otherwise empty stretches.
      color: candle.close >= candle.open ? "rgba(25,231,154,.3)" : "rgba(255,91,112,.3)",
    })));
    if (!hasFitRef.current && candles.length) {
      // Bar width is computed rather than fitted or fixed, because both
      // extremes look broken. fitContent() stretches whatever candles exist
      // across the whole panel, so a market with five buckets drew five
      // candles a couple of hundred pixels wide. A hard barSpacing does the
      // opposite: forty candles at nine pixels leave most of the panel empty
      // with everything crammed against the right edge.
      //
      // Fill the width when there is room, clamped to a range where a candle
      // still looks like a candle.
      const width = containerRef.current?.clientWidth ?? 0;
      const spacing = width > 0 ? Math.min(16, Math.max(4, Math.floor(width / (candles.length + 6)))) : 9;
      chartRef.current?.timeScale().applyOptions({ barSpacing: spacing });
      chartRef.current?.timeScale().scrollToRealTime();
      hasFitRef.current = true;
    }
  }, [candles]);

  return <div ref={containerRef} className="terminal-chart-canvas" />;
}
