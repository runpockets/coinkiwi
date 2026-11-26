import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPocket } from "../server.js";

const VALID_KEY = "lcw_test_secret_key_987654";

async function makeDataDir(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "pockets-coinkiwi-"));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }));
  return dataDir;
}

async function startMockLcw(t) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const apiKey = req.headers["x-api-key"];
    calls.push({ method: req.method, url: req.url, apiKey, body });

    res.setHeader("content-type", "application/json");
    if (apiKey !== VALID_KEY) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { status: 401, description: "Invalid API key" } }));
      return;
    }

    if (req.url === "/credits") {
      res.end(JSON.stringify({ dailyCreditsRemaining: 9850, dailyCreditsLimit: 10000 }));
      return;
    }

    if (req.url === "/overview") {
      res.end(
        JSON.stringify({
          cap: 2_250_000_000_000,
          volume: 92_400_000_000,
          liquidity: 11_200_000_000,
          btcDominance: 0.558,
        }),
      );
      return;
    }

    if (req.url === "/overview/history") {
      const now = Date.now();
      res.end(
        JSON.stringify([
          { date: now - 86_400_000, cap: 2_200_000_000_000, volume: 88_000_000_000 },
          { date: now - 43_200_000, cap: 2_230_000_000_000, volume: 90_000_000_000 },
          { date: now, cap: 2_250_000_000_000, volume: 92_400_000_000 },
        ]),
      );
      return;
    }

    if (req.url === "/coins/list") {
      res.end(
        JSON.stringify([
          {
            code: "BTC",
            name: "Bitcoin",
            rank: 1,
            rate: 64250.5,
            volume: 35_000_000_000,
            cap: 1_260_000_000_000,
            liquidity: 1_500_000_000,
            circulatingSupply: 19_800_000,
            totalSupply: 19_800_000,
            maxSupply: 21_000_000,
            allTimeHighUSD: 126080,
            categories: ["layer1", "smart_contract_platforms"],
            delta: { hour: 1.005, day: 1.042, week: 0.965, month: 1.12, quarter: 1.2, year: 1.5 },
            links: { website: "https://bitcoin.org" },
          },
          {
            code: "ETH",
            name: "Ethereum",
            rank: 2,
            rate: 2450.25,
            volume: 14_000_000_000,
            cap: 294_000_000_000,
            liquidity: 900_000_000,
            circulatingSupply: 120_000_000,
            totalSupply: 120_000_000,
            maxSupply: null,
            allTimeHighUSD: 4878,
            categories: ["layer1", "defi"],
            delta: { hour: 0.998, day: 1.065, week: 1.03, month: 1.08, quarter: 1.1, year: 1.2 },
            links: { website: "https://ethereum.org" },
          },
        ]),
      );
      return;
    }

    if (req.url === "/exchanges/list") {
      res.end(
        JSON.stringify([
          {
            code: "binance",
            name: "Binance",
            centralized: true,
            usCompliant: false,
            markets: 1800,
            volume: 18_000_000_000,
            bidTotal: 140_000_000,
            askTotal: 135_000_000,
            visitors: 1_900_000,
            links: { website: "https://binance.com" },
          },
          {
            code: "coinbase",
            name: "Coinbase",
            centralized: true,
            usCompliant: true,
            markets: 420,
            volume: 3_500_000_000,
            bidTotal: 75_000_000,
            askTotal: 70_000_000,
            visitors: 1_400_000,
            links: { website: "https://coinbase.com" },
          },
        ]),
      );
      return;
    }

    if (req.url === "/coins/single") {
      res.end(
        JSON.stringify({
          code: body.code || "BTC",
          name: body.code === "ETH" ? "Ethereum" : "Bitcoin",
          rank: body.code === "ETH" ? 2 : 1,
          rate: body.code === "ETH" ? 2450.25 : 64250.5,
          volume: 35_000_000_000,
          cap: 1_260_000_000_000,
          liquidity: 1_500_000_000,
          circulatingSupply: 19_800_000,
          totalSupply: 19_800_000,
          maxSupply: 21_000_000,
          allTimeHighUSD: 126080,
          exchanges: 185,
          markets: 1420,
          pairs: 412,
          contracts:
            body.code === "ETH"
              ? { ETH: "0x1234567890abcdef1234567890abcdef12345678" }
              : { BTC: "" },
          categories: ["layer1"],
          delta: { hour: 1.005, day: 1.042, week: 0.965, month: 1.12, quarter: 1.2, year: 1.5 },
          links: { website: "https://bitcoin.org" },
        }),
      );
      return;
    }

    if (req.url === "/coins/single/history") {
      const now = Date.now();
      res.end(
        JSON.stringify({
          history: [
            { date: now - 86_400_000, rate: 61800, volume: 31_000_000_000, cap: 1_210_000_000_000 },
            { date: now - 43_200_000, rate: 63100, volume: 33_000_000_000, cap: 1_235_000_000_000 },
            { date: now, rate: 64250.5, volume: 35_000_000_000, cap: 1_260_000_000_000 },
          ],
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: { description: "Not found" } }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeIdleConnections();
      }),
  );
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    calls,
  };
}

async function startMockGateway(t) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        data: [{ value: "27", value_classification: "Fear", timestamp: "1730000000" }],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeIdleConnections();
      }),
  );
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
  };
}

async function startPocket(t, opts = {}) {
  const pocket = createPocket({
    host: "127.0.0.1",
    port: 0,
    env: {},
    ...opts,
  });
  await pocket.listen();
  t.after(() => pocket.close());
  return {
    pocket,
    base: `http://127.0.0.1:${pocket.address().port}`,
  };
}

test("GET /health returns 200 JSON and serves SPA + static assets", async (t) => {
  const dataDir = await makeDataDir(t);
  const { base } = await startPocket(t, { dataDir });

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.match(health.headers.get("content-type"), /application\/json/);
  assert.deepEqual(await health.json(), { status: "ok" });

  for (const path of ["/", "/exchanges", "/coins/BTC", "/portfolio", "/categories"]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200, `expected 200 for ${path}`);
    assert.match(res.headers.get("content-type"), /text\/html/);
    if (path === "/") {
      const html = await res.text();
      assert.match(html, /id="sample-watermark-overlay"/);
      assert.match(html, /SAMPLE DATA\. ADD API KEY/);
    }
  }

  const css = await fetch(`${base}/styles.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /text\/css/);

  const js = await fetch(`${base}/app.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type"), /text\/javascript/);

  const filtersJs = await fetch(`${base}/filters.js`);
  assert.equal(filtersJs.status, 200);
  assert.match(filtersJs.headers.get("content-type"), /text\/javascript/);

  const portfolioJs = await fetch(`${base}/portfolio.js`);
  assert.equal(portfolioJs.status, 200);
  assert.match(portfolioJs.headers.get("content-type"), /text\/javascript/);

  const ico = await fetch(`${base}/favicon.ico`);
  assert.equal(ico.status, 200);
  assert.match(ico.headers.get("content-type"), /image\/x-icon/);
  assert.ok((await ico.arrayBuffer()).byteLength > 100);

  for (const iconPath of ["/favicon-32x32.png", "/favicon-64x64.png", "/apple-touch-icon.png"]) {
    const iconRes = await fetch(`${base}${iconPath}`);
    assert.equal(iconRes.status, 200, `expected 200 for ${iconPath}`);
    assert.match(iconRes.headers.get("content-type"), /image\/png/);
    assert.ok((await iconRes.arrayBuffer()).byteLength > 100);
  }
});

test("unconfigured instance serves labeled sample data", async (t) => {
  const dataDir = await makeDataDir(t);
  const { base } = await startPocket(t, { dataDir });

  const statusRes = await fetch(`${base}/api/status`);
  assert.equal(statusRes.status, 200);
  const status = await statusRes.json();
  assert.equal(status.configured, false);
  assert.equal(status.dataMode, "sample");

  const marketsRes = await fetch(`${base}/api/markets?currency=USD`);
  assert.equal(marketsRes.status, 200);
  const markets = await marketsRes.json();
  assert.equal(markets.meta.isSample, true);
  assert.ok(markets.coins.length >= 20);
  assert.equal(markets.coins[0].code, "BTC");
  assert.ok(Array.isArray(markets.hotCategories));
  assert.equal(markets.hotCategories.length, 3);
  assert.equal(markets.hotCategories.includes("Stablecoins"), false);
  assert.ok(Array.isArray(markets.hotCategoryDetails));
  assert.equal(markets.hotCategoryDetails.length, 3);
  assert.deepEqual(
    markets.hotCategoryDetails.map((d) => d.name),
    markets.hotCategories,
  );
  assert.ok(markets.hotCategoryDetails.every((d) => typeof d.reason === "string" && d.reason.length > 20));
  assert.ok(markets.hotCategoryDetails.every((d) => typeof d.signal === "string" && d.score > 0));
  assert.ok(markets.trending.every((c) => c.change24h > 0));
  assert.ok(markets.gainers.every((c) => c.change24h > 0));
  assert.ok(markets.gainers[0].change24h >= markets.gainers[1].change24h);
});

test("Live Coin Watch API key validates, persists across restarts, never leaks, and loads live data", async (t) => {
  const dataDir = await makeDataDir(t);
  const mockLcw = await startMockLcw(t);
  const mockFng = await startMockGateway(t);

  const first = await startPocket(t, {
    dataDir,
    lcwBaseUrl: mockLcw.baseUrl,
    fngUrl: `${mockFng.baseUrl}/fng`,
    cgPlatformsUrl: `${mockLcw.baseUrl}/cg-platforms`,
  });

  // Invalid key is rejected with 401
  const badRes = await fetch(`${first.base}/api/settings/api-key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "wrong_key" }),
  });
  assert.equal(badRes.status, 401);

  // Valid key succeeds and returns masked status without exposing raw key
  const okRes = await fetch(`${first.base}/api/settings/api-key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey: VALID_KEY }),
  });
  assert.equal(okRes.status, 200);
  const okText = await okRes.text();
  assert.equal(okText.includes(VALID_KEY), false, "raw API key must never appear in response");
  const okStatus = JSON.parse(okText);
  assert.equal(okStatus.configured, true);
  assert.equal(okStatus.source, "saved");
  assert.equal(okStatus.keyHint, "••••7654");
  assert.equal(okStatus.dailyCreditsRemaining, 9850);

  // Verify secrets.json exists with restricted permissions
  const secretStat = await stat(join(dataDir, "secrets.json"));
  assert.equal(secretStat.mode & 0o777, 0o600);

  // Markets endpoint pulls normalized Live Coin Watch data
  const marketsRes = await fetch(`${first.base}/api/markets?currency=USD`);
  assert.equal(marketsRes.status, 200);
  const markets = await marketsRes.json();
  assert.equal(markets.meta.isSample, false);
  assert.equal(markets.coins[0].code, "BTC");
  assert.equal(markets.coins[0].rate, 64250.5);
  assert.equal(markets.coins[0].changes.h24, 4.2); // (1.042 - 1) * 100
  assert.equal(markets.coins[0].changes.d7, -3.5); // (0.965 - 1) * 100

  // Overview endpoint computes BTC & ETH dominance + real exact coin & exchange counts
  const ovRes = await fetch(`${first.base}/api/overview?currency=USD`);
  const ov = await ovRes.json();
  assert.equal(ov.meta.isSample, false);
  assert.equal(ov.overview.coins, 2); // exact count (no "+" when LCW list ended)
  assert.equal(ov.overview.exchanges, 2); // real count from /exchanges/list
  assert.equal(ov.overview.btcDominance, 55.8);
  assert.ok(ov.overview.ethDominance > 10);
  assert.equal(ov.fearAndGreed.value, 27);

  // Exchanges endpoint returns normalized Live Coin Watch exchanges
  const exRes = await fetch(`${first.base}/api/exchanges?currency=USD`);
  assert.equal(exRes.status, 200);
  const exData = await exRes.json();
  assert.equal(exData.meta.isSample, false);
  assert.equal(exData.exchanges.length, 2);
  assert.equal(exData.exchanges[0].name, "Binance");
  assert.equal(exData.exchanges[0].depth, 275_000_000);

  // Coin detail includes exchanges, markets, and pairs counts + sparklines
  const detailRes = await fetch(`${first.base}/api/coins/BTC?currency=USD`);
  const detail = await detailRes.json();
  assert.equal(detail.coin.code, "BTC");
  assert.equal(detail.coin.low24h, 61800);
  assert.equal(detail.coin.high24h, 64250.5);
  assert.equal(detail.coin.exchangesCount, 185);
  assert.equal(detail.coin.marketsCount, 1420);
  assert.equal(detail.coin.pairsCount, 412);
  assert.equal(detail.coin.chains[0].name, "Bitcoin");

  const ethDetail = await (await fetch(`${first.base}/api/coins/ETH?currency=USD`)).json();
  assert.equal(ethDetail.coin.contracts.length, 1);
  assert.equal(ethDetail.coin.contracts[0].chain, "Ethereum");
  assert.match(ethDetail.coin.contracts[0].explorerUrl, /^https:\/\/etherscan\.io\/token\/0x1234/);

  const sparkRes = await fetch(`${first.base}/api/sparklines?codes=BTC&currency=USD`);
  const spark = await sparkRes.json();
  assert.equal(spark.isSample, false);
  assert.deepEqual(spark.sparklines.BTC.points, [61800, 63100, 64250.5]);

  await first.pocket.close();

  // Restart against the same DATA_DIR: saved API key must survive
  const second = await startPocket(t, {
    dataDir,
    lcwBaseUrl: mockLcw.baseUrl,
    fngUrl: `${mockFng.baseUrl}/fng`,
  });
  const afterRestart = await (await fetch(`${second.base}/api/status`)).json();
  assert.equal(afterRestart.configured, true);
  assert.equal(afterRestart.source, "saved");
  assert.equal(afterRestart.keyHint, "••••7654");
});

test("POCKETS_HTTPS_GATEWAY proxies GET Fear & Greed via /fetch and enables preview sample mode", async (t) => {
  const dataDir = await makeDataDir(t);
  const gateway = await startMockGateway(t);

  const { base } = await startPocket(t, {
    dataDir,
    env: {
      POCKETS_HTTPS_GATEWAY: gateway.baseUrl,
      LIVECOINWATCH_API_KEY: VALID_KEY,
    },
  });

  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.previewGatewayMode, true);
  assert.equal(status.source, "env");
  assert.equal(status.dataMode, "preview_sample");

  const ov = await (await fetch(`${base}/api/overview?currency=USD`)).json();
  assert.equal(ov.meta.isSample, true);
  assert.equal(ov.meta.previewGatewayMode, true);
  assert.equal(ov.fearAndGreed.value, 27);
  assert.equal(gateway.requests.length, 1);
  assert.equal(gateway.requests[0].method, "GET");
  assert.match(gateway.requests[0].url, /^\/fetch\?url=https%3A%2F%2Fapi\.alternative\.me/);
});

test("portfolio watchlist, holdings, and preferences persist across restarts", async (t) => {
  const dataDir = await makeDataDir(t);

  const first = await startPocket(t, { dataDir });

  // Toggle BTC & SOL into watchlist
  await fetch(`${first.base}/api/portfolio/toggle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "BTC" }),
  });
  await fetch(`${first.base}/api/portfolio/holding`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "ETH", quantity: 2.5, avgCost: 1500 }),
  });
  await fetch(`${first.base}/api/preferences`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      currency: "NZD",
      theme: "dark",
      showHighlights: false,
      portfolioSortKey: "pnl",
      portfolioSortDir: "asc",
    }),
  });

  await first.pocket.close();

  const second = await startPocket(t, { dataDir });
  const portfolio = await (await fetch(`${second.base}/api/portfolio`)).json();
  assert.deepEqual(portfolio.watchlist, ["BTC", "ETH"]);
  assert.equal(portfolio.holdings.ETH.quantity, 2.5);
  assert.equal(portfolio.holdings.ETH.avgCost, 1500);

  const prefs = await (await fetch(`${second.base}/api/preferences`)).json();
  assert.equal(prefs.currency, "NZD");
  assert.equal(prefs.theme, "dark");
  assert.equal(prefs.showHighlights, false);
  assert.equal(prefs.portfolioSortKey, "pnl");
  assert.equal(prefs.portfolioSortDir, "asc");

  const rawPortfolio = JSON.parse(await readFile(join(dataDir, "portfolio.json"), "utf8"));
  assert.deepEqual(rawPortfolio.watchlist, ["BTC", "ETH"]);
});

test("markets paginates up to 1,000 coins across 10 Live Coin Watch pages", async (t) => {
  const dataDir = await makeDataDir(t);
  const offsetsSeen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    res.setHeader("content-type", "application/json");
    if (req.url === "/coins/list") {
      const offset = Number(body.offset) || 0;
      const limit = Number(body.limit) || 100;
      offsetsSeen.push(offset);
      const rows = Array.from({ length: limit }, (_, idx) => {
        const rank = offset + idx + 1;
        return {
          code: `C${rank}`,
          name: `Coin ${rank}`,
          rank,
          rate: Math.max(0.01, 1000 / rank),
          volume: 1_000_000,
          cap: 10_000_000_000 / rank,
          delta: { hour: 1.0, day: 1.02, week: 1.05 },
          categories: rank % 5 === 0 ? ["meme"] : ["layer1"],
        };
      });
      res.end(JSON.stringify(rows));
      return;
    }
    res.end(JSON.stringify({}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeIdleConnections();
      }),
  );

  const { base } = await startPocket(t, {
    dataDir,
    env: { LIVECOINWATCH_API_KEY: VALID_KEY },
    lcwBaseUrl: `http://127.0.0.1:${server.address().port}`,
    cgPlatformsUrl: `http://127.0.0.1:${server.address().port}/cg-platforms`,
  });

  const res = await fetch(`${base}/api/markets?currency=USD`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.meta.isSample, false);
  assert.equal(data.coins.length, 1000);
  assert.equal(data.coins[0].code, "C1");
  assert.equal(data.coins[999].code, "C1000");
  assert.equal(offsetsSeen.length, 10);

  // Adjusting coinLimit to 300 persists and limits subsequent fetches to 3 pages
  const prefRes = await fetch(`${base}/api/preferences`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      coinLimit: 300,
      refreshIntervalSec: 300,
      autoRefresh: true,
      dailyCreditLimit: 50_000,
    }),
  });
  assert.equal(prefRes.status, 200);
  const updatedPrefs = await prefRes.json();
  assert.equal(updatedPrefs.coinLimit, 300);
  assert.equal(updatedPrefs.refreshIntervalSec, 300);
  assert.equal(updatedPrefs.autoRefresh, true);

  offsetsSeen.length = 0;
  const smallData = await (await fetch(`${base}/api/markets?currency=USD`)).json();
  assert.equal(smallData.coins.length, 300);
  assert.equal(offsetsSeen.length, 3);

  const statusAfter = await (await fetch(`${base}/api/status`)).json();
  assert.equal(statusAfter.quota.coinLimit, 300);
  assert.equal(statusAfter.quota.creditsPerRefresh, 4);
  assert.equal(statusAfter.quota.requestsToday, 13);
  assert.ok(statusAfter.quota.refreshesRemainingToday > 10_000);

  // Custom non-preset coinLimit (e.g. 1250) paginates 13 pages and slices to exact count
  const customPref = await (
    await fetch(`${base}/api/preferences`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ coinLimit: 1250 }),
    })
  ).json();
  assert.equal(customPref.coinLimit, 1250);

  offsetsSeen.length = 0;
  const customData = await (await fetch(`${base}/api/markets?currency=USD`)).json();
  assert.equal(customData.coins.length, 1250);
  assert.equal(offsetsSeen.length, 13);
  const customStatus = await (await fetch(`${base}/api/status`)).json();
  assert.equal(customStatus.quota.creditsPerRefresh, 14);
});

test("enriches LCW tokens with multi-chain contracts from 24h CoinGecko directory in 1 GET call", async (t) => {
  const dataDir = await makeDataDir(t);
  let cgCalls = 0;

  const lcwServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    res.setHeader("content-type", "application/json");
    if (req.url === "/coins/single") {
      // Realistic LCW response: NO contracts or platforms field
      res.end(
        JSON.stringify({
          code: body.code,
          name: body.code === "USDC" ? "USDC" : "Chainlink",
          rank: body.code === "USDC" ? 5 : 12,
          rate: body.code === "USDC" ? 0.9999 : 14.5,
          volume: 5_000_000_000,
          cap: 60_000_000_000,
          exchanges: 120,
          markets: 850,
          pairs: 300,
          categories: ["stablecoins"],
          delta: { hour: 1.0, day: 1.0, week: 1.0 },
          links: { website: "https://circle.com/usdc" },
        }),
      );
      return;
    }
    if (req.url === "/coins/single/history") {
      res.end(JSON.stringify({ history: [] }));
      return;
    }
    res.end(JSON.stringify([]));
  });
  await new Promise((resolve) => lcwServer.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        lcwServer.close(resolve);
        lcwServer.closeAllConnections();
      }),
  );

  const cgServer = createServer((req, res) => {
    cgCalls += 1;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify([
        {
          id: "usd-coin",
          symbol: "usdc",
          name: "USDC",
          platforms: {
            ethereum: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            solana: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            base: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
            "polygon-pos": "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
          },
        },
        {
          id: "chainlink",
          symbol: "link",
          name: "Chainlink",
          platforms: {
            ethereum: "0x514910771af9ca656af840dff83e8264ecf986ca",
          },
        },
      ]),
    );
  });
  await new Promise((resolve) => cgServer.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        cgServer.close(resolve);
        cgServer.closeIdleConnections();
      }),
  );

  const { base } = await startPocket(t, {
    dataDir,
    env: { LIVECOINWATCH_API_KEY: VALID_KEY },
    lcwBaseUrl: `http://127.0.0.1:${lcwServer.address().port}`,
    cgPlatformsUrl: `http://127.0.0.1:${cgServer.address().port}/coins/list?include_platform=true`,
  });

  const usdc = await (await fetch(`${base}/api/coins/USDC?currency=USD&metaOnly=1`)).json();
  assert.equal(usdc.coin.contracts.length, 4);
  assert.equal(usdc.coin.contracts[0].chain, "Ethereum");
  assert.match(usdc.coin.contracts[0].explorerUrl, /^https:\/\/etherscan\.io\/token\/0xa0b8/);
  assert.ok(usdc.coin.contracts.some((c) => c.chain === "Solana"));
  assert.ok(usdc.coin.contracts.some((c) => c.chain === "Base"));
  assert.ok(usdc.coin.contracts.some((c) => c.chain === "Polygon"));

  // Second coin reuses the same cached directory with 0 extra CoinGecko requests
  const link = await (await fetch(`${base}/api/coins/LINK?currency=USD&metaOnly=1`)).json();
  assert.equal(link.coin.contracts.length, 1);
  assert.equal(link.coin.contracts[0].chain, "Ethereum");
  assert.equal(cgCalls, 1);
});

test("GET /api/fx caches live exchange rates and converts currencies from USD cache with 0 extra market calls", async (t) => {
  const dataDir = await makeDataDir(t);
  let coinsListCalls = 0;
  let singleCalls = 0;
  const mockFx = { USD: 1, NZD: 1.75, EUR: 0.9, GBP: 0.8, AUD: 1.5 };

  const lcwServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    res.setHeader("content-type", "application/json");
    if (req.url === "/coins/list") {
      coinsListCalls += 1;
      res.end(
        JSON.stringify([
          {
            code: "BTC",
            name: "Bitcoin",
            rank: 1,
            rate: 100_000,
            volume: 20_000_000_000,
            cap: 2_000_000_000_000,
            delta: { hour: 1.0, day: 1.02, week: 1.05 },
          },
        ]),
      );
      return;
    }
    if (req.url === "/coins/single") {
      singleCalls += 1;
      const mult = mockFx[body.currency] || 1;
      res.end(JSON.stringify({ code: "BTC", rate: 100_000 * mult }));
      return;
    }
    if (req.url === "/cg") {
      res.end("[]");
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { description: "Not found" } }));
  });
  await new Promise((resolve) => lcwServer.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        lcwServer.close(resolve);
        lcwServer.closeAllConnections();
      }),
  );

  const lcwBase = `http://127.0.0.1:${lcwServer.address().port}`;
  const { base } = await startPocket(t, {
    dataDir,
    env: { LIVECOINWATCH_API_KEY: VALID_KEY },
    lcwBaseUrl: lcwBase,
    cgPlatformsUrl: `${lcwBase}/cg`,
  });

  // Prime USD markets cache (1 call)
  const usdMarkets = await (await fetch(`${base}/api/markets?currency=USD`)).json();
  assert.equal(usdMarkets.coins[0].rate, 100_000);
  assert.equal(coinsListCalls, 1);

  // Fetch /api/fx: computes exact live FX ratios from BTC across 4 fiats (reuses cached BTC USD)
  const fx1 = await (await fetch(`${base}/api/fx`)).json();
  assert.equal(fx1.base, "USD");
  assert.equal(fx1.isSample, false);
  assert.equal(fx1.rates.NZD, 1.75);
  assert.equal(fx1.rates.EUR, 0.9);
  assert.equal(fx1.rates.GBP, 0.8);
  assert.equal(fx1.rates.AUD, 1.5);
  assert.equal(fx1.rates.BTC, 1 / 100_000);
  assert.equal(singleCalls, 4);

  // Second /api/fx hits 6h cache with 0 extra LCW calls
  const fx2 = await (await fetch(`${base}/api/fx`)).json();
  assert.equal(fx2.rates.NZD, 1.75);
  assert.equal(singleCalls, 4);

  // Requesting NZD markets converts directly from the USD cache with 0 extra /coins/list calls
  const nzdMarkets = await (await fetch(`${base}/api/markets?currency=NZD`)).json();
  assert.equal(nzdMarkets.currency, "NZD");
  assert.equal(nzdMarkets.coins[0].rate, 175_000);
  assert.deepEqual(nzdMarkets.hotCategories, usdMarkets.hotCategories);
  assert.equal(coinsListCalls, 1);
  assert.equal(singleCalls, 4);
});

test("GET /api/bootstrap serves fresh and stale volume cache with zero upstream calls", async (t) => {
  const dataDir = await makeDataDir(t);
  const mockLcw = await startMockLcw(t);
  const mockFng = await startMockGateway(t);

  const first = await startPocket(t, {
    dataDir,
    env: { LIVECOINWATCH_API_KEY: VALID_KEY },
    lcwBaseUrl: mockLcw.baseUrl,
    fngUrl: `${mockFng.baseUrl}/fng`,
    cgPlatformsUrl: `${mockLcw.baseUrl}/cg-platforms`,
  });

  // Prime the volume cache (as if Browser 1 already visited the site).
  await fetch(`${first.base}/api/markets?currency=USD`);
  await fetch(`${first.base}/api/overview?currency=USD`);
  await fetch(`${first.base}/api/exchanges?currency=USD`);
  await fetch(`${first.base}/api/coins/BTC?currency=USD`);
  await fetch(`${first.base}/api/fx`);

  const callsBeforeFreshBootstrap = mockLcw.calls.length;
  const fngBeforeFreshBootstrap = mockFng.requests.length;

  // Browser 2 opens while cache is fresh: /api/bootstrap makes 0 upstream calls
  // and signals no refresh needed for markets/overview/exchanges/fx.
  const freshRes = await fetch(`${first.base}/api/bootstrap?include=exchanges&coin=BTC`);
  assert.equal(freshRes.status, 200);
  const freshBoot = await freshRes.json();
  assert.equal(mockLcw.calls.length, callsBeforeFreshBootstrap);
  assert.equal(mockFng.requests.length, fngBeforeFreshBootstrap);
  assert.equal(freshBoot.markets.coins[0].code, "BTC");
  assert.equal(freshBoot.markets.coins[0].rate, 64250.5);
  assert.equal(freshBoot.overview.overview.btcDominance, 55.8);
  assert.equal(freshBoot.overview.fearAndGreed.value, 27);
  assert.equal(freshBoot.exchanges.exchanges[0].name, "Binance");
  assert.equal(freshBoot.detail.coin.code, "BTC");
  assert.equal(freshBoot.detail.history24h.length, 3);
  assert.equal(freshBoot.needsRefresh.markets, false);
  assert.equal(freshBoot.needsRefresh.overview, false);
  assert.equal(freshBoot.needsRefresh.exchanges, false);
  assert.equal(freshBoot.needsRefresh.fx, false);

  await first.pocket.close();

  // Age the cached files on disk past TTL (e.g. 20 minutes ago) to simulate opening
  // a new browser later (and even after a container restart with the same volume).
  const twentyMinAgo = Date.now() - 20 * 60_000;
  for (const name of ["markets_USD_1000.json", "overview_USD.json", "exchanges_USD.json"]) {
    const file = join(dataDir, "cache", name);
    const parsed = JSON.parse(await readFile(file, "utf8"));
    parsed.fetchedAt = twentyMinAgo;
    await writeFile(file, JSON.stringify(parsed), "utf8");
  }

  const second = await startPocket(t, {
    dataDir,
    env: { LIVECOINWATCH_API_KEY: VALID_KEY },
    lcwBaseUrl: mockLcw.baseUrl,
    fngUrl: `${mockFng.baseUrl}/fng`,
    cgPlatformsUrl: `${mockLcw.baseUrl}/cg-platforms`,
  });

  const callsBeforeStaleBootstrap = mockLcw.calls.length;
  const fngBeforeStaleBootstrap = mockFng.requests.length;

  // Browser 2 opens against expired disk cache: /api/bootstrap STILL returns cached
  // volume data immediately with 0 upstream calls, while marking needsRefresh=true.
  const staleRes = await fetch(`${second.base}/api/bootstrap?include=exchanges&coin=BTC`);
  assert.equal(staleRes.status, 200);
  const staleBoot = await staleRes.json();
  assert.equal(mockLcw.calls.length, callsBeforeStaleBootstrap);
  assert.equal(mockFng.requests.length, fngBeforeStaleBootstrap);
  assert.equal(staleBoot.markets.coins[0].code, "BTC");
  assert.equal(staleBoot.markets.meta.isStale, false);
  assert.equal(staleBoot.markets.meta.fetchedAt, twentyMinAgo);
  assert.equal(staleBoot.overview.overview.btcDominance, 55.8);
  assert.equal(staleBoot.exchanges.exchanges[0].name, "Binance");
  assert.equal(staleBoot.detail.coin.code, "BTC");
  assert.equal(staleBoot.needsRefresh.markets, true);
  assert.equal(staleBoot.needsRefresh.overview, true);
  assert.equal(staleBoot.needsRefresh.exchanges, true);
  assert.equal(staleBoot.needsRefresh.status, true);
});

test("GET /api/bootstrap on unconfigured instance returns sample data without blocking", async (t) => {
  const dataDir = await makeDataDir(t);
  const { base } = await startPocket(t, { dataDir });

  const res = await fetch(`${base}/api/bootstrap`);
  assert.equal(res.status, 200);
  const boot = await res.json();
  assert.equal(boot.status.configured, false);
  assert.equal(boot.markets.meta.isSample, true);
  assert.ok(boot.markets.coins.length >= 20);
  assert.equal(boot.overview.meta.isSample, true);
  assert.equal(boot.needsRefresh.markets, false);
  assert.equal(boot.needsRefresh.fx, false);
  assert.equal(boot.needsRefresh.status, false);
});

test("GET /api/quotes resolves off-list portfolio coins via /coins/map + /coins/single fallback and hydrates /api/bootstrap", async (t) => {
  const dataDir = await makeDataDir(t);
  const calls = [];
  const customLcw = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    calls.push({ url: req.url, body });
    res.setHeader("content-type", "application/json");

    if (req.url === "/coins/list") {
      // Only BTC is in the ranked markets list; STETH and RETH are off-list.
      res.end(
        JSON.stringify([
          {
            code: "BTC",
            name: "Bitcoin",
            rank: 1,
            rate: 64000,
            volume: 30_000_000_000,
            cap: 1_250_000_000_000,
            delta: { hour: 1.0, day: 1.02, week: 1.05 },
          },
        ]),
      );
      return;
    }

    if (req.url === "/coins/map") {
      // Return RETH from /coins/map, intentionally omitting STETH to exercise /coins/single fallback.
      const out = [];
      if (Array.isArray(body.codes) && body.codes.includes("RETH")) {
        out.push({
          code: "RETH",
          name: "Rocket Pool ETH",
          rank: 1205,
          rate: 2780.5,
          volume: 12_000_000,
          cap: 1_100_000_000,
          delta: { hour: 1.001, day: 1.031, week: 1.04 },
        });
      }
      res.end(JSON.stringify(out));
      return;
    }

    if (req.url === "/coins/single") {
      if (body.code === "STETH") {
        res.end(
          JSON.stringify({
            code: "STETH",
            name: "Lido Staked Ether",
            rate: 2448.75,
            volume: 85_000_000,
            cap: 24_000_000_000,
            delta: { hour: 1.002, day: 1.048, week: 1.02 },
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { description: "Not found" } }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: { description: "Not found" } }));
  });
  await new Promise((resolve) => customLcw.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        customLcw.close(resolve);
        customLcw.closeIdleConnections();
      }),
  );

  const lcwBaseUrl = `http://127.0.0.1:${customLcw.address().port}`;
  const { base } = await startPocket(t, {
    dataDir,
    env: { LIVECOINWATCH_API_KEY: VALID_KEY },
    lcwBaseUrl,
    cgPlatformsUrl: `${lcwBaseUrl}/cg-platforms`,
  });

  // Track BTC (in markets) plus off-list STETH and RETH in portfolio.
  await fetch(`${base}/api/portfolio/holding`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "STETH", quantity: 2.5, avgCost: 2100 }),
  });
  await fetch(`${base}/api/portfolio/toggle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "RETH" }),
  });

  // Load markets first (contains only BTC).
  const marketsRes = await fetch(`${base}/api/markets?currency=USD`);
  assert.equal(marketsRes.status, 200);
  const markets = await marketsRes.json();
  assert.equal(markets.coins.length, 1);
  assert.equal(markets.coins[0].code, "BTC");

  // Before quotes are cached, /api/bootstrap flags needsRefresh.portfolioCoins = true.
  const bootBefore = await (await fetch(`${base}/api/bootstrap`)).json();
  assert.equal(bootBefore.needsRefresh.portfolioCoins, true);

  // Fetch quotes for BTC (served from markets cache), RETH (via /coins/map), STETH (via /coins/single fallback).
  const quotesRes = await fetch(`${base}/api/quotes?codes=BTC,RETH,STETH&currency=USD`);
  assert.equal(quotesRes.status, 200);
  const quotes = await quotesRes.json();
  assert.equal(quotes.coins.BTC.rate, 64000);
  assert.equal(quotes.coins.RETH.rate, 2780.5);
  assert.equal(quotes.coins.RETH.name, "Rocket Pool ETH");
  assert.equal(quotes.coins.STETH.rate, 2448.75);
  assert.equal(quotes.coins.STETH.name, "Lido Staked Ether");
  assert.equal(quotes.coins.STETH.rank, null);

  // /coins/map should only have requested off-list codes (not BTC).
  const mapCalls = calls.filter((c) => c.url === "/coins/map");
  assert.equal(mapCalls.length, 1);
  assert.deepEqual(mapCalls[0].body.codes.slice().sort(), ["RETH", "STETH"]);
  const singleCalls = calls.filter((c) => c.url === "/coins/single");
  assert.equal(singleCalls.length, 1);
  assert.equal(singleCalls[0].body.code, "STETH");

  // Second /api/quotes call and /api/bootstrap both serve from cache with 0 extra upstream calls.
  const callsBeforeCached = calls.length;
  const cachedQuotes = await (
    await fetch(`${base}/api/quotes?codes=BTC,RETH,STETH&currency=USD`)
  ).json();
  assert.equal(cachedQuotes.coins.STETH.rate, 2448.75);
  assert.equal(calls.length, callsBeforeCached);

  const bootAfter = await (await fetch(`${base}/api/bootstrap`)).json();
  assert.equal(calls.length, callsBeforeCached);
  assert.equal(bootAfter.needsRefresh.portfolioCoins, false);
  assert.equal(bootAfter.extraCoins.STETH.rate, 2448.75);
  assert.equal(bootAfter.extraCoins.RETH.rate, 2780.5);
  assert.equal(bootAfter.extraCoins.BTC, undefined);
});
