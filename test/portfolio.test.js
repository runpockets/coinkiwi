import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createStore } from "../lib/store.js";
import {
  DEFAULT_PORTFOLIO_SORT,
  filterPortfolioRows,
  getPortfolioPnlMeta,
  normalizePortfolioSort,
  sortPortfolioRows,
  summarizePortfolioRows,
  togglePortfolioSort,
} from "../public/portfolio.js";

const FIXTURE_ROWS = [
  {
    coin: { code: "ETH", name: "Ethereum", rank: 2, rate: 2500, changes: { h24: 4.2 } },
    qty: 4,
    value: 10_000,
    cost: 8_000,
    pnl: 2_000,
    pnlPct: 25,
  },
  {
    coin: { code: "SOL", name: "Solana", rank: 5, rate: 150, changes: { h24: 11.5 } },
    qty: 20,
    value: 3_000,
    cost: 1_500,
    pnl: 1_500,
    pnlPct: 100,
  },
  {
    coin: { code: "BTC", name: "Bitcoin", rank: 1, rate: 60_000, changes: { h24: -1.2 } },
    qty: 0.5,
    value: 30_000,
    cost: 35_000,
    pnl: -5_000,
    pnlPct: -14.2857,
  },
  {
    coin: { code: "ADA", name: "Cardano", rank: 9, rate: 0.5, changes: { h24: -6.4 } },
    qty: 1_000,
    value: 500,
    cost: null,
    pnl: null,
    pnlPct: null,
  },
  {
    coin: { code: "DOGE", name: "Dogecoin", rank: 8, rate: 0.12, changes: { h24: 18.0 } },
    qty: 0,
    value: 0,
    cost: null,
    pnl: null,
    pnlPct: null,
  },
  {
    coin: { code: "XRP", name: "XRP", rank: 4, rate: 0.62, changes: { h24: null } },
    qty: 0,
    value: 0,
    cost: null,
    pnl: null,
    pnlPct: null,
  },
];

const codes = (rows) => rows.map((r) => r.coin.code);

test("sortPortfolioRows sorts by value desc and asc while keeping watch-only rows at the bottom", () => {
  assert.deepEqual(codes(sortPortfolioRows(FIXTURE_ROWS, "value", "desc")), [
    "BTC",
    "ETH",
    "SOL",
    "ADA",
    "XRP",
    "DOGE",
  ]);

  // Ascending shows smallest actual holding first; watch-only coins remain last ordered by rank
  assert.deepEqual(codes(sortPortfolioRows(FIXTURE_ROWS, "value", "asc")), [
    "ADA",
    "SOL",
    "ETH",
    "BTC",
    "XRP",
    "DOGE",
  ]);
});

test("sortPortfolioRows sorts by P&L ($) and P&L (%) independently with missing cost basis last", () => {
  // By dollar P&L: ETH (+$2k), SOL (+$1.5k), BTC (-$5k), then no-cost-basis rows by value/rank
  assert.deepEqual(codes(sortPortfolioRows(FIXTURE_ROWS, "pnl", "desc")), [
    "ETH",
    "SOL",
    "BTC",
    "ADA",
    "XRP",
    "DOGE",
  ]);
  assert.deepEqual(codes(sortPortfolioRows(FIXTURE_ROWS, "pnl", "asc")), [
    "BTC",
    "SOL",
    "ETH",
    "ADA",
    "XRP",
    "DOGE",
  ]);

  // By percentage P&L: SOL (+100%), ETH (+25%), BTC (-14.3%), then missing P&L rows
  assert.deepEqual(codes(sortPortfolioRows(FIXTURE_ROWS, "pnlPct", "desc")), [
    "SOL",
    "ETH",
    "BTC",
    "ADA",
    "XRP",
    "DOGE",
  ]);
  assert.deepEqual(codes(sortPortfolioRows(FIXTURE_ROWS, "pnlPct", "asc")), [
    "BTC",
    "ETH",
    "SOL",
    "ADA",
    "XRP",
    "DOGE",
  ]);
});

test("sortPortfolioRows sorts by holdings quantity, price, 24h change, coin name, and rank", () => {
  assert.deepEqual(codes(sortPortfolioRows(FIXTURE_ROWS, "holdings", "desc")), [
    "ADA",
    "SOL",
    "ETH",
    "BTC",
    "XRP",
    "DOGE",
  ]);

  assert.deepEqual(codes(sortPortfolioRows(FIXTURE_ROWS, "price", "desc")), [
    "BTC",
    "ETH",
    "SOL",
    "XRP",
    "ADA",
    "DOGE",
  ]);

  // Missing 24h change (XRP) stays at bottom even when ascending
  assert.deepEqual(codes(sortPortfolioRows(FIXTURE_ROWS, "h24", "desc")), [
    "DOGE",
    "SOL",
    "ETH",
    "BTC",
    "ADA",
    "XRP",
  ]);
  assert.deepEqual(codes(sortPortfolioRows(FIXTURE_ROWS, "h24", "asc")), [
    "ADA",
    "BTC",
    "ETH",
    "SOL",
    "DOGE",
    "XRP",
  ]);

  assert.deepEqual(codes(sortPortfolioRows(FIXTURE_ROWS, "coin", "asc")), [
    "BTC",
    "ADA",
    "DOGE",
    "ETH",
    "SOL",
    "XRP",
  ]);
  assert.deepEqual(codes(sortPortfolioRows(FIXTURE_ROWS, "coin", "desc")), [
    "XRP",
    "SOL",
    "ETH",
    "DOGE",
    "ADA",
    "BTC",
  ]);

  assert.deepEqual(codes(sortPortfolioRows(FIXTURE_ROWS, "rank", "asc")), [
    "BTC",
    "ETH",
    "XRP",
    "SOL",
    "DOGE",
    "ADA",
  ]);
});

test("togglePortfolioSort and normalizePortfolioSort handle defaults and P&L column toggling", () => {
  assert.deepEqual(normalizePortfolioSort("invalid", "sideways"), DEFAULT_PORTFOLIO_SORT);
  assert.deepEqual(normalizePortfolioSort("coin", null), { key: "coin", dir: "asc" });

  // Clicking active column flips direction
  assert.deepEqual(togglePortfolioSort("value", "desc", "value"), { key: "value", dir: "asc" });
  // Clicking new text column defaults to asc; numeric defaults to desc
  assert.deepEqual(togglePortfolioSort("value", "desc", "coin"), { key: "coin", dir: "asc" });
  assert.deepEqual(togglePortfolioSort("coin", "asc", "h24"), { key: "h24", dir: "desc" });
  // Clicking P&L header when sorted by pnlPct flips pnlPct direction rather than resetting to pnl
  assert.deepEqual(togglePortfolioSort("pnlPct", "desc", "pnl"), { key: "pnlPct", dir: "asc" });
});

test("filterPortfolioRows separates all, holdings, and watchlist-only rows", () => {
  assert.equal(filterPortfolioRows(FIXTURE_ROWS, "all").length, 6);
  assert.deepEqual(codes(filterPortfolioRows(FIXTURE_ROWS, "holdings")), [
    "ETH",
    "SOL",
    "BTC",
    "ADA",
  ]);
  assert.deepEqual(codes(filterPortfolioRows(FIXTURE_ROWS, "watchlist")), ["DOGE", "XRP"]);
});

test("createStore persists valid portfolioSortKey and portfolioSortDir preferences", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "coinkiwi-port-sort-"));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }));

  const store = createStore(dataDir);
  const initial = await store.getPreferences();
  assert.equal(initial.portfolioSortKey, "value");
  assert.equal(initial.portfolioSortDir, "desc");

  const updated = await store.updatePreferences({
    portfolioSortKey: "pnlPct",
    portfolioSortDir: "asc",
  });
  assert.equal(updated.portfolioSortKey, "pnlPct");
  assert.equal(updated.portfolioSortDir, "asc");

  // Invalid values are ignored
  const afterInvalid = await store.updatePreferences({
    portfolioSortKey: "bogus",
    portfolioSortDir: "sideways",
  });
  assert.equal(afterInvalid.portfolioSortKey, "pnlPct");
  assert.equal(afterInvalid.portfolioSortDir, "asc");

  // Re-reading from disk preserves the saved preference
  const reloaded = await createStore(dataDir).getPreferences();
  assert.equal(reloaded.portfolioSortKey, "pnlPct");
  assert.equal(reloaded.portfolioSortDir, "asc");
});

test("sortPortfolioRows keeps unpriced holdings after priced ones in both directions", () => {
  const rows = [
    {
      coin: { code: "STETH", name: "STETH", rank: null, rate: null, changes: {} },
      qty: 5,
      value: null,
      cost: 10_000,
      pnl: null,
      pnlPct: null,
    },
    ...FIXTURE_ROWS.slice(0, 2),
  ];

  assert.deepEqual(codes(sortPortfolioRows(rows, "value", "desc")), ["ETH", "SOL", "STETH"]);
  assert.deepEqual(codes(sortPortfolioRows(rows, "value", "asc")), ["SOL", "ETH", "STETH"]);
  assert.deepEqual(codes(sortPortfolioRows(rows, "price", "desc")), ["ETH", "SOL", "STETH"]);
  assert.deepEqual(codes(sortPortfolioRows(rows, "price", "asc")), ["SOL", "ETH", "STETH"]);
  assert.deepEqual(codes(sortPortfolioRows(rows, "pnl", "asc")), ["SOL", "ETH", "STETH"]);
});

test("summarizePortfolioRows excludes uncosted holdings from profit and flags partial coverage", () => {
  // Reported regression: $100 holding at $100 cost (break-even) + $100 holding with no cost
  const rows = [
    {
      coin: { code: "BTC", name: "Bitcoin", rate: 100, changes: { h24: 2 } },
      qty: 1,
      value: 100,
      cost: 100,
      hasPrice: true,
    },
    {
      coin: { code: "ETH", name: "Ethereum", rate: 100, changes: { h24: -2 } },
      qty: 1,
      value: 100,
      cost: null,
      hasPrice: true,
    },
  ];

  const summary = summarizePortfolioRows(rows);
  assert.equal(summary.totalValue, 200);
  assert.equal(summary.costBasisValue, 100);
  assert.equal(summary.totalCost, 100);
  assert.equal(summary.hasCostBasis, true);
  assert.equal(summary.totalPnl, 0);
  assert.equal(summary.totalPnlPct, 0);
  assert.equal(summary.dayPct, 0);
  assert.equal(summary.holdingsCount, 2);
  assert.equal(summary.costBasisCount, 1);
  assert.equal(summary.missingCostBasisCount, 1);
  assert.equal(summary.excludedFromPnlCount, 1);
  assert.equal(summary.isPartialPnl, true);

  assert.deepEqual(getPortfolioPnlMeta(summary), {
    label: "Profit / Loss (Partial)",
    subtext: "Based on 1 of 2 holdings with cost basis",
  });
});

test("summarizePortfolioRows computes partial profit on mixed fixture rows without inflating P&L", () => {
  // FIXTURE_ROWS has 3 holdings with cost basis (ETH +2k, SOL +1.5k, BTC -5k => -1.5k on 44.5k cost),
  // 1 holding without cost basis (ADA worth $500), and 2 watch-only coins (DOGE, XRP).
  const summary = summarizePortfolioRows(FIXTURE_ROWS);
  assert.equal(summary.totalValue, 43_500);
  assert.equal(summary.costBasisValue, 43_000);
  assert.equal(summary.totalCost, 44_500);
  assert.equal(summary.totalPnl, -1_500);
  assert.ok(Math.abs(summary.totalPnlPct - (-1_500 / 44_500) * 100) < 1e-9);
  assert.equal(summary.holdingsCount, 4);
  assert.equal(summary.watchlistOnlyCount, 2);
  assert.equal(summary.costBasisCount, 3);
  assert.equal(summary.missingCostBasisCount, 1);
  assert.equal(summary.isPartialPnl, true);

  assert.deepEqual(getPortfolioPnlMeta(summary), {
    label: "Profit / Loss (Partial)",
    subtext: "Based on 3 of 4 holdings with cost basis",
  });
});

test("summarizePortfolioRows marks full P&L when every holding has price and cost basis (ignoring watch-only)", () => {
  const rows = [
    {
      coin: { code: "ETH", name: "Ethereum", rate: 150, changes: { h24: 10 } },
      qty: 1,
      value: 150,
      cost: 100,
      hasPrice: true,
    },
    {
      coin: { code: "BTC", name: "Bitcoin", rate: 80, changes: { h24: -5 } },
      qty: 1,
      value: 80,
      cost: 100,
      hasPrice: true,
    },
    {
      coin: { code: "DOGE", name: "Dogecoin", rate: 0.2, changes: { h24: 50 } },
      qty: 0,
      value: 0,
      cost: null,
      hasPrice: true,
    },
  ];

  const summary = summarizePortfolioRows(rows);
  assert.equal(summary.totalValue, 230);
  assert.equal(summary.costBasisValue, 230);
  assert.equal(summary.totalCost, 200);
  assert.equal(summary.totalPnl, 30);
  assert.equal(summary.totalPnlPct, 15);
  assert.equal(summary.holdingsCount, 2);
  assert.equal(summary.watchlistOnlyCount, 1);
  assert.equal(summary.costBasisCount, 2);
  assert.equal(summary.isPartialPnl, false);

  assert.deepEqual(getPortfolioPnlMeta(summary), {
    label: "Total Profit / Loss",
    subtext: null,
  });
});

test("summarizePortfolioRows returns null profit when no holdings have a cost basis", () => {
  const rows = [
    {
      coin: { code: "BTC", name: "Bitcoin", rate: 100, changes: { h24: 5 } },
      qty: 1,
      value: 100,
      cost: null,
      hasPrice: true,
    },
    {
      coin: { code: "ETH", name: "Ethereum", rate: 200, changes: { h24: 5 } },
      qty: 1,
      value: 200,
      cost: null,
      hasPrice: true,
    },
  ];

  const summary = summarizePortfolioRows(rows);
  assert.equal(summary.totalValue, 300);
  assert.equal(summary.costBasisValue, 0);
  assert.equal(summary.totalCost, 0);
  assert.equal(summary.hasCostBasis, false);
  assert.equal(summary.totalPnl, null);
  assert.equal(summary.totalPnlPct, null);
  assert.equal(summary.holdingsCount, 2);
  assert.equal(summary.costBasisCount, 0);
  assert.equal(summary.missingCostBasisCount, 2);
  assert.equal(summary.isPartialPnl, false);

  assert.deepEqual(getPortfolioPnlMeta(summary), {
    label: "Total Profit / Loss",
    subtext: null,
  });

  const emptySummary = summarizePortfolioRows([]);
  assert.equal(emptySummary.totalValue, 0);
  assert.equal(emptySummary.totalPnl, null);
  assert.equal(emptySummary.totalPnlPct, null);
  assert.equal(emptySummary.isPartialPnl, false);
});

test("summarizePortfolioRows excludes unpriced holdings from profit and handles zero cost basis", () => {
  // Priced holding with cost + unpriced holding with cost
  const unpricedMixed = summarizePortfolioRows([
    {
      coin: { code: "BTC", name: "Bitcoin", rate: 120, changes: { h24: 0 } },
      qty: 1,
      value: 120,
      cost: 100,
      hasPrice: true,
    },
    {
      coin: { code: "STETH", name: "STETH", rate: null, changes: {} },
      qty: 2,
      value: null,
      cost: 500,
      hasPrice: false,
    },
  ]);
  assert.equal(unpricedMixed.totalValue, 120);
  assert.equal(unpricedMixed.costBasisValue, 120);
  assert.equal(unpricedMixed.totalCost, 100);
  assert.equal(unpricedMixed.totalPnl, 20);
  assert.equal(unpricedMixed.totalPnlPct, 20);
  assert.equal(unpricedMixed.isPartialPnl, true);
  assert.deepEqual(getPortfolioPnlMeta(unpricedMixed), {
    label: "Profit / Loss (Partial)",
    subtext: "Based on 1 of 2 priced holdings",
  });

  // Both missing cost basis and missing price
  const bothExcluded = summarizePortfolioRows([
    {
      coin: { code: "BTC", name: "Bitcoin", rate: 120, changes: {} },
      qty: 1,
      value: 120,
      cost: 100,
      hasPrice: true,
    },
    {
      coin: { code: "ETH", name: "Ethereum", rate: 200, changes: {} },
      qty: 1,
      value: 200,
      cost: null,
      hasPrice: true,
    },
    {
      coin: { code: "STETH", name: "STETH", rate: null, changes: {} },
      qty: 2,
      value: null,
      cost: 500,
      hasPrice: false,
    },
  ]);
  assert.equal(bothExcluded.totalPnl, 20);
  assert.equal(bothExcluded.totalPnlPct, 20);
  assert.equal(bothExcluded.isPartialPnl, true);
  assert.deepEqual(getPortfolioPnlMeta(bothExcluded), {
    label: "Profit / Loss (Partial)",
    subtext: "Based on 1 of 3 holdings with price & cost basis",
  });

  // Only unpriced holding with cost basis waits for current prices
  const awaitingPrice = summarizePortfolioRows([
    {
      coin: { code: "STETH", name: "STETH", rate: null, changes: {} },
      qty: 2,
      value: null,
      cost: 500,
      hasPrice: false,
    },
  ]);
  assert.equal(awaitingPrice.hasCostBasis, false);
  assert.equal(awaitingPrice.totalPnl, null);
  assert.equal(awaitingPrice.holdingsWithCostBasisCount, 1);
  assert.deepEqual(getPortfolioPnlMeta(awaitingPrice), {
    label: "Total Profit / Loss",
    subtext: "Waiting for current prices",
  });

  // Recorded $0 cost basis (e.g. airdrop) counts as recorded cost basis with null percentage
  const zeroCost = summarizePortfolioRows([
    {
      coin: { code: "ARB", name: "Arbitrum", rate: 2, changes: {} },
      qty: 50,
      value: 100,
      cost: 0,
      hasPrice: true,
    },
    {
      coin: { code: "ETH", name: "Ethereum", rate: 100, changes: {} },
      qty: 1,
      value: 100,
      cost: null,
      hasPrice: true,
    },
  ]);
  assert.equal(zeroCost.totalValue, 200);
  assert.equal(zeroCost.costBasisValue, 100);
  assert.equal(zeroCost.totalCost, 0);
  assert.equal(zeroCost.totalPnl, 100);
  assert.equal(zeroCost.totalPnlPct, null);
  assert.equal(zeroCost.costBasisCount, 1);
  assert.equal(zeroCost.isPartialPnl, true);
});
