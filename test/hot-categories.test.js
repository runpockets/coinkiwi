import assert from "node:assert/strict";
import { test } from "node:test";
import { computeHotCategories } from "../lib/market-service.js";
import { getSampleCoins } from "../lib/sample-data.js";

function makeCoin({
  code,
  name = code,
  categories = ["Layer 1"],
  rate = 10,
  cap = 1_000_000_000,
  volume = 100_000_000,
  h1 = 0.2,
  h24 = 2,
  d7 = 4,
} = {}) {
  return {
    code,
    name,
    categories,
    rate,
    cap,
    volume,
    changes: { h1, h24, d7 },
  };
}

function buildRealisticMarket(extraCoins = []) {
  const coins = [];
  // 25 Layer 1 coins (solid baseline)
  for (let i = 0; i < 25; i += 1) {
    coins.push(
      makeCoin({
        code: `L1_${i}`,
        categories: ["Layer 1"],
        cap: (25 - i) * 4_000_000_000,
        volume: (25 - i) * 200_000_000,
        h24: 1.5,
        d7: 1.0,
      }),
    );
  }
  // 20 DeFi coins (steady positive)
  for (let i = 0; i < 20; i += 1) {
    coins.push(
      makeCoin({
        code: `DEFI_${i}`,
        categories: ["DeFi"],
        cap: (20 - i) * 600_000_000,
        volume: (20 - i) * 45_000_000,
        h24: 4.5,
        d7: 8.0,
      }),
    );
  }
  // 20 AI coins (strong multi-day rally)
  for (let i = 0; i < 20; i += 1) {
    coins.push(
      makeCoin({
        code: `AI_${i}`,
        categories: ["AI"],
        cap: (20 - i) * 500_000_000,
        volume: (20 - i) * 55_000_000,
        h24: 8.5,
        d7: 16.0,
      }),
    );
  }
  // 20 Layer 2 coins (solid positive)
  for (let i = 0; i < 20; i += 1) {
    coins.push(
      makeCoin({
        code: `L2_${i}`,
        categories: ["Layer 2"],
        cap: (20 - i) * 400_000_000,
        volume: (20 - i) * 35_000_000,
        h24: 5.5,
        d7: 10.0,
      }),
    );
  }
  // 20 Gaming coins (mildly negative)
  for (let i = 0; i < 20; i += 1) {
    coins.push(
      makeCoin({
        code: `GAME_${i}`,
        categories: ["Gaming"],
        cap: (20 - i) * 250_000_000,
        volume: (20 - i) * 15_000_000,
        h24: -1.5,
        d7: -3.0,
      }),
    );
  }
  // Stablecoins + Wrapped tokens (must be excluded)
  for (let i = 0; i < 10; i += 1) {
    coins.push(
      makeCoin({
        code: `USD_${i}`,
        categories: ["Stablecoins", "Fiat Backed"],
        rate: 1,
        cap: 10_000_000_000,
        volume: 5_000_000_000,
        h24: 0.01,
        d7: 0.02,
      }),
    );
    coins.push(
      makeCoin({
        code: `WBTC_${i}`,
        categories: ["Wrapped Tokens"],
        cap: 2_000_000_000,
        volume: 500_000_000,
        h24: 18,
        d7: 35,
      }),
    );
  }
  return [...coins, ...extraCoins];
}

test("rejects tiny micro-cap categories even with extreme single-coin pumps", () => {
  const microPumpers = [
    makeCoin({
      code: "TINY1",
      categories: ["Micro Niche"],
      cap: 4_000_000,
      volume: 3_000_000,
      h24: 145,
      d7: 190,
    }),
    makeCoin({
      code: "TINY2",
      categories: ["Micro Niche"],
      cap: 2_000_000,
      volume: 1_500_000,
      h24: 80,
      d7: 120,
    }),
    makeCoin({
      code: "TINY3",
      categories: ["Micro Niche"],
      cap: 1_000_000,
      volume: 800_000,
      h24: 60,
      d7: 95,
    }),
  ];
  const coins = buildRealisticMarket(microPumpers);
  const res = computeHotCategories(coins);

  assert.equal(res.hotCategories.length, 3);
  assert.equal(res.hotCategories.includes("Micro Niche"), false);
  assert.equal(res.hotCategories.includes("Stablecoins"), false);
  assert.equal(res.hotCategories.includes("Fiat Backed"), false);
  assert.equal(res.hotCategories.includes("Wrapped Tokens"), false);
  assert.deepEqual(res.hotCategories, ["AI", "Layer 2", "DeFi"]);
});

test("rejects high-volume panic selloffs and single-coin outlier sectors", () => {
  const extra = [];
  // Panic selloff sector: huge volume/turnover, sharply negative 24h & 7d
  for (let i = 0; i < 10; i += 1) {
    extra.push(
      makeCoin({
        code: `CRASH_${i}`,
        categories: ["Panic Sector"],
        cap: 800_000_000,
        volume: 600_000_000, // 75% turnover from panic selling
        h24: -12,
        d7: -22,
      }),
    );
  }
  // Single-coin outlier sector: 1 coin pumps +75%, 9 others are red
  extra.push(
    makeCoin({
      code: "OUTLIER_0",
      categories: ["One Coin Wonder"],
      cap: 2_000_000_000,
      volume: 400_000_000,
      h24: 75,
      d7: 110,
    }),
  );
  for (let i = 1; i < 10; i += 1) {
    extra.push(
      makeCoin({
        code: `OUTLIER_${i}`,
        categories: ["One Coin Wonder"],
        cap: 150_000_000,
        volume: 15_000_000,
        h24: -3.5,
        d7: -6.0,
      }),
    );
  }

  const coins = buildRealisticMarket(extra);
  const res = computeHotCategories(coins);

  assert.equal(res.hotCategories.includes("Panic Sector"), false);
  assert.equal(res.hotCategories.includes("One Coin Wonder"), false);
  assert.deepEqual(res.hotCategories, ["AI", "Layer 2", "DeFi"]);
});

test("hysteresis and EMA smoothing prevent flip-flopping on minor refresh noise", () => {
  const t0 = 1_750_000_000_000;
  // Build market where DeFi (#3) and Layer 1 (#4) are close, with DeFi slightly ahead
  const baseCoins = buildRealisticMarket();
  const initial = computeHotCategories(baseCoins, { now: t0 });
  assert.deepEqual(initial.hotCategories, ["AI", "Layer 2", "DeFi"]);

  // 3 minutes later: Layer 1 ticks slightly above DeFi on raw snapshot (+0.5% bump)
  const tickedCoins = baseCoins.map((c) => {
    if (c.categories.includes("Layer 1")) {
      return { ...c, changes: { ...c.changes, h24: 5.2, d7: 8.6 } };
    }
    if (c.categories.includes("DeFi")) {
      return { ...c, changes: { ...c.changes, h24: 4.1, d7: 7.4 } };
    }
    return c;
  });

  const threeMinLater = computeHotCategories(tickedCoins, {
    prevState: initial.nextState,
    now: t0 + 3 * 60_000,
  });
  // Incumbent DeFi stays hot instead of churning on a 3-minute tick
  assert.equal(
    threeMinLater.hotCategories.includes("DeFi"),
    true,
    "healthy incumbent should not be displaced by minor 3-minute noise",
  );

  // 90 minutes later (past dwell window) with a decisive sustained breakout by Gaming
  let state = threeMinLater.nextState;
  const breakoutCoins = baseCoins.map((c) => {
    if (c.categories.includes("Gaming")) {
      return {
        ...c,
        volume: c.volume * 3,
        changes: { h1: 2.5, h24: 18, d7: 34 },
      };
    }
    if (c.categories.includes("DeFi")) {
      return { ...c, changes: { h1: -0.5, h24: -1.2, d7: -1.5 } };
    }
    return c;
  });

  for (let step = 1; step <= 4; step += 1) {
    const next = computeHotCategories(breakoutCoins, {
      prevState: state,
      now: t0 + (30 * step) * 60_000,
    });
    state = next.nextState;
    if (step === 4) {
      assert.equal(
        next.hotCategories.includes("Gaming"),
        true,
        "decisive sustained breakout should promote challenger after dwell/smoothing",
      );
    }
  }
});

test("produces substantial reasoning metadata and leaders on built-in sample dataset", () => {
  const sampleCoins = getSampleCoins("USD");
  const res = computeHotCategories(sampleCoins);

  assert.equal(res.hotCategories.length, 3);
  assert.equal(res.hotCategoryDetails.length, 3);
  assert.equal(res.hotCategories.includes("Stablecoins"), false);

  for (let i = 0; i < res.hotCategoryDetails.length; i += 1) {
    const detail = res.hotCategoryDetails[i];
    assert.equal(detail.name, res.hotCategories[i]);
    assert.ok(detail.score >= 0 && detail.score <= 100);
    assert.ok(typeof detail.signal === "string" && detail.signal.length > 3);
    assert.ok(typeof detail.reason === "string" && detail.reason.length > 20);
    assert.ok(typeof detail.metrics.capWeighted24h === "number");
    assert.ok(typeof detail.metrics.capWeighted7d === "number");
    assert.ok(typeof detail.metrics.alpha7d === "number");
    assert.ok(detail.metrics.totalVolume > 0);
    assert.ok(Array.isArray(detail.leaders) && detail.leaders.length > 0);
  }
});
