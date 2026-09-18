// node --test scripts/stock-price-signer.nodetest.mjs (node:test, not vitest)
import { test } from "node:test";
import assert from "node:assert/strict";
process.env.STOCK_FEED_ADDRESS ||= "0x0000000000000000000000000000000000000001";
const { aggregate, newYorkToEpoch, usMarketOpen } = await import("./stock-price-signer.mjs");

test("median of agreeing sources, conf floor", () => {
  const r = aggregate([100, 100.1, undefined]);
  assert.equal(r.sources, 2);
  assert.ok(Math.abs(r.price - 100.05) < 1e-9);
  assert.ok(Math.abs(r.conf - 0.050025) < 1e-9); // 5 bps of 100.05 beats half the 0.1 range
  assert.ok(Math.abs(aggregate([100, 100, 100]).conf - 0.05) < 1e-9); // 5 bps floor
});
test("refuses one source or disagreement", () => {
  assert.equal(aggregate([100, undefined, NaN]), null);
  assert.equal(aggregate([100, 101]), null); // 1% apart
  assert.equal(aggregate([100, 100.2, 130]), null); // outlier poisons the tick
});
test("New York timestamps across DST", () => {
  assert.equal(new Date(newYorkToEpoch("Sep 18, 2026 10:13 AM")).toISOString(), "2026-09-18T14:13:00.000Z");
  assert.equal(new Date(newYorkToEpoch("Dec 15, 2026 10:13 AM")).toISOString(), "2026-12-15T15:13:00.000Z");
});
test("session hours", () => {
  assert.equal(usMarketOpen(new Date("2026-09-18T13:30:00Z")), true);
  assert.equal(usMarketOpen(new Date("2026-09-18T20:00:00Z")), false);
});
