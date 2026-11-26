import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyCoinFilters,
  countActivePanelFilters,
  createDefaultFilterState,
  getActiveFilterChips,
  getAvailableCategories,
  getAvailableChains,
  getCoinMcapFdvRatio,
  parseCompactNumber,
} from "../public/filters.js";
import { getSampleCoins } from "../lib/sample-data.js";

const FIXTURE_COINS = [
  {
    code: "BTC",
    name: "Bitcoin",
    cap: 1_200_000_000_000,
    fdv: 1_260_000_000_000,
    volume: 35_000_000_000,
    liquidity: 1_800_000_000,
    changes: { h1: 0.4, h24: 2.5, d7: 12.0, d30: 18.0, d90: 40.0, y1: 80.0 },
    categories: ["Layer 1"],
    chains: [{ code: "BTC", name: "Bitcoin" }],
  },
  {
    code: "SOL",
    name: "Solana",
    cap: 45_000_000_000,
    fdv: 50_000_000_000,
    volume: 2_500_000_000,
    liquidity: 410_000_000,
    changes: { h1: 1.5, h24: 24.5, d7: 55.0, d30: -12.0, d90: 30.0, y1: 120.0 },
    categories: ["Layer 1", "DeFi"],
    chains: [{ code: "SOL", name: "Solana" }],
  },
  {
    code: "MID",
    name: "MidCap Token",
    cap: 350_000_000,
    fdv: 700_000_000,
    volume: 25_000_000,
    liquidity: 650_000,
    changes: { h1: -2.0, h24: -14.2, d7: -25.0, d30: -52.0, d90: -10.0, y1: 5.0 },
    categories: ["DeFi"],
    chains: [
      { code: "ETH", name: "Ethereum" },
      { code: "ARB", name: "Arbitrum" },
    ],
  },
  {
    code: "SML",
    name: "SmallCap Coin",
    cap: 45_000_000,
    fdv: 180_000_000,
    volume: 1_500_000,
    liquidity: 120_000,
    changes: { h1: 0.2, h24: 62.0, d7: -5.0, d30: 15.0, d90: 0.0, y1: -30.0 },
    categories: ["AI"],
    chains: [{ code: "BASE", name: "Base" }],
  },
  {
    code: "MCR",
    name: "MicroCap Gem",
    cap: 4_200_000,
    fdv: 4_200_000,
    volume: 220_000,
    liquidity: 65_000,
    changes: { h1: -0.5, h24: -55.0, d7: -60.0, d30: 8.0, d90: 12.0, y1: -15.0 },
    categories: ["Meme"],
    chains: [{ code: "SOL", name: "Solana" }],
  },
  {
    code: "ZERO",
    name: "Unverified Cap",
    cap: 0,
    fdv: 12_000_000,
    volume: 40_000,
    liquidity: 10_000,
    changes: { h1: null, h24: 0.0, d7: null, d30: null, d90: null, y1: null },
    categories: ["Meme"],
    chains: [{ code: "ETH", name: "Ethereum" }],
  },
];

test("parseCompactNumber parses plain numbers, currency symbols, commas, negatives, and K/M/B/T suffixes", () => {
  assert.equal(parseCompactNumber(""), null);
  assert.equal(parseCompactNumber("   "), null);
  assert.equal(parseCompactNumber("abc"), null);
  assert.equal(parseCompactNumber("100"), 100);
  assert.equal(parseCompactNumber("$1,250.50"), 1250.5);
  assert.equal(parseCompactNumber("50K"), 50_000);
  assert.equal(parseCompactNumber("$100m"), 100_000_000);
  assert.equal(parseCompactNumber("1.5B"), 1_500_000_000);
  assert.equal(parseCompactNumber("2T"), 2_000_000_000_000);
  assert.equal(parseCompactNumber("-25%"), -25);
  assert.equal(parseCompactNumber("0.75"), 0.75);
});

test("Market Cap presets partition Large, Mid, Small, Micro, and Custom accurately", () => {
  const byMcap = (mcapPreset, extra = {}) =>
    applyCoinFilters(FIXTURE_COINS, { ...createDefaultFilterState(), mcapPreset, ...extra }).map(
      (c) => c.code,
    );

  assert.deepEqual(byMcap("large"), ["BTC", "SOL"]);
  assert.deepEqual(byMcap("mid"), ["MID"]);
  assert.deepEqual(byMcap("small"), ["SML"]);
  // Unverified 0-cap coins should NOT show up under Micro (<$10M)
  assert.deepEqual(byMcap("micro"), ["MCR"]);
  assert.deepEqual(byMcap("custom", { mcapMin: "10M", mcapMax: "500M" }), ["MID", "SML"]);
  // Empty custom inputs keep all coins visible until a bound is typed
  assert.equal(byMcap("custom").length, FIXTURE_COINS.length);
});

test("24h Volume, Liquidity, FDV, and Market Cap / FDV presets filter accurately", () => {
  const filterCodes = (patch) =>
    applyCoinFilters(FIXTURE_COINS, { ...createDefaultFilterState(), ...patch }).map((c) => c.code);

  assert.deepEqual(filterCodes({ volPreset: "10m" }), ["BTC", "SOL", "MID"]);
  assert.deepEqual(filterCodes({ volPreset: "100m" }), ["BTC", "SOL"]);
  assert.deepEqual(filterCodes({ volPreset: "custom", volMin: "1M", volMax: "30M" }), ["MID", "SML"]);

  assert.deepEqual(filterCodes({ liqPreset: "50k" }), ["BTC", "SOL", "MID", "SML", "MCR"]);
  assert.deepEqual(filterCodes({ liqPreset: "500k" }), ["BTC", "SOL", "MID"]);
  assert.deepEqual(filterCodes({ liqPreset: "1m" }), ["BTC", "SOL"]);

  assert.deepEqual(filterCodes({ fdvPreset: "100m" }), ["BTC", "SOL", "MID", "SML"]);
  assert.deepEqual(filterCodes({ fdvPreset: "1b" }), ["BTC", "SOL"]);

  assert.equal(Number(getCoinMcapFdvRatio(FIXTURE_COINS[2]).toFixed(2)), 0.5);
  assert.equal(getCoinMcapFdvRatio(FIXTURE_COINS[5]), null);
  assert.deepEqual(filterCodes({ ratioPreset: "0.75" }), ["BTC", "SOL", "MCR"]);
  assert.deepEqual(filterCodes({ ratioPreset: "1.0" }), ["MCR"]);
  assert.deepEqual(filterCodes({ ratioPreset: "custom", ratioMin: "0.2", ratioMax: "0.6" }), [
    "MID",
    "SML",
  ]);
});

test("Price Changes filter works across all timeframes (1h, 24h, 7d, 30d, 90d, 1y) and custom negative ranges", () => {
  const filterCodes = (patch) =>
    applyCoinFilters(FIXTURE_COINS, { ...createDefaultFilterState(), ...patch }).map((c) => c.code);

  assert.deepEqual(filterCodes({ changeTimeframe: "h24", changePreset: "gt0" }), ["BTC", "SOL", "SML"]);
  assert.deepEqual(filterCodes({ changeTimeframe: "h24", changePreset: "gt20" }), ["SOL", "SML"]);
  assert.deepEqual(filterCodes({ changeTimeframe: "h24", changePreset: "gt50" }), ["SML"]);
  assert.deepEqual(filterCodes({ changeTimeframe: "h24", changePreset: "lt-10" }), ["MID", "MCR"]);
  assert.deepEqual(filterCodes({ changeTimeframe: "h24", changePreset: "lt-50" }), ["MCR"]);
  assert.deepEqual(filterCodes({ changeTimeframe: "d7", changePreset: "gt10" }), ["BTC", "SOL"]);
  assert.deepEqual(filterCodes({ changeTimeframe: "d30", changePreset: "lt-50" }), ["MID"]);
  assert.deepEqual(filterCodes({ changeTimeframe: "y1", changePreset: "gt50" }), ["BTC", "SOL"]);
  assert.deepEqual(
    filterCodes({ changeTimeframe: "h24", changePreset: "custom", changeMin: "-20", changeMax: "5" }),
    ["BTC", "MID", "ZERO"],
  );
});

test("Chain, Category, Watchlist, and Search Query combine cleanly and produce accurate active chips", () => {
  const f = {
    ...createDefaultFilterState(),
    chain: "Solana",
    volPreset: "1m",
    changeTimeframe: "d7",
    changePreset: "gt50",
  };
  const filtered = applyCoinFilters(FIXTURE_COINS, f, { activeCategory: "DeFi" });
  assert.deepEqual(
    filtered.map((c) => c.code),
    ["SOL"],
  );

  const chips = getActiveFilterChips(f, { activeCategory: "DeFi" });
  assert.equal(chips.length, 4);
  assert.deepEqual(
    chips.map((c) => c.key),
    ["chain", "category", "vol", "change"],
  );
  assert.equal(countActivePanelFilters(f), 3);

  const sampleCoins = getSampleCoins();
  assert.equal(
    sampleCoins.every((c) => Array.isArray(c.chains) && c.chains.length > 0),
    true,
    "all sample coins should have at least one chain for the Chains dropdown",
  );
  const chains = getAvailableChains(sampleCoins);
  assert.ok(chains.length >= 10);
  assert.equal(chains[0].name, "Ethereum");

  const cats = getAvailableCategories(sampleCoins, ["Layer 1", "DeFi", "Stablecoins"]);
  assert.equal(cats[0].name, "Layer 1");
  assert.ok(cats[0].count > 0);
});
