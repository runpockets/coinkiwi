import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createStore } from "../lib/store.js";
import {
  DEFAULT_PORTFOLIO_SORT,
  filterPortfolioRows,
  normalizePortfolioSort,
  sortPortfolioRows,
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
