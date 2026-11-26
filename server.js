// CoinKiwi: dependency-free Node HTTP server for self-hosted crypto tracking
// and powered by the Live Coin Watch API with DATA_DIR persistence.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { LcwApiError } from "./lib/lcw-client.js";
import { createMarketService } from "./lib/market-service.js";
import { createStore } from "./lib/store.js";

const ROOT_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(ROOT_DIR, "public");
const MAX_BODY_BYTES = 32 * 1024;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const THEME_CHROME_COLORS = {
  light: { surface: "#ffffff", bg: "#ffffff" },
  dark: { surface: "#111827", bg: "#0b1120" },
};

async function getThemeChrome(store) {
  try {
    const prefs = await store.getPreferences();
    const theme = prefs?.theme === "dark" ? "dark" : "light";
    return { theme, ...THEME_CHROME_COLORS[theme] };
  } catch {
    return { theme: "light", ...THEME_CHROME_COLORS.light };
  }
}

async function serveSpaHtml(res, store) {
  const fullPath = resolve(PUBLIC_DIR, "index.html");
  let html = await readFile(fullPath, "utf8");
  const chrome = await getThemeChrome(store);
  if (chrome.theme === "dark") {
    html = html
      .replace('<html lang="en" data-theme="light">', '<html lang="en" data-theme="dark">')
      .replace(
        '<meta name="theme-color" id="theme-color-meta" content="#ffffff" />',
        `<meta name="theme-color" id="theme-color-meta" content="${chrome.surface}" />`,
      );
  }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  });
  res.end(html);
}

async function serveManifest(res, store) {
  const chrome = await getThemeChrome(store);
  const manifest = {
    name: "CoinKiwi",
    short_name: "CoinKiwi",
    description: "Self-hosted cryptocurrency price tracker powered by Live Coin Watch",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: chrome.bg,
    theme_color: chrome.surface,
    icons: [
      {
        src: "/apple-touch-icon.png?v=6",
        sizes: "180x180",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/favicon.svg?v=6",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
  res.writeHead(200, {
    "content-type": "application/manifest+json; charset=utf-8",
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  });
  res.end(`${JSON.stringify(manifest, null, 2)}\n`);
}

function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const err = new Error("Request body too large");
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const err = new Error("Invalid JSON body");
    err.status = 400;
    throw err;
  }
}

async function servePublicFile(res, relativePath) {
  const fullPath = resolve(PUBLIC_DIR, relativePath);
  if (!fullPath.startsWith(`${PUBLIC_DIR}/`) && fullPath !== PUBLIC_DIR) {
    sendText(res, 403, "Forbidden\n");
    return;
  }
  let data;
  try {
    data = await readFile(fullPath);
  } catch (err) {
    if (err.code === "ENOENT") {
      sendText(res, 404, "Not found\n");
      return;
    }
    throw err;
  }
  const mime = MIME_TYPES[extname(fullPath)] || "application/octet-stream";
  res.writeHead(200, {
    "content-type": mime,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  });
  res.end(data);
}

export function createPocket(options = {}) {
  const env = options.env ?? process.env;
  const dataDir = options.dataDir ?? env.DATA_DIR ?? "/data";
  const host = options.host ?? env.HOST ?? "0.0.0.0";
  const port = options.port ?? (Number(env.PORT) || 8080);

  const store = createStore(dataDir);
  const market = createMarketService({
    store,
    env,
    clientOptions: {
      baseUrl: options.lcwBaseUrl,
      fngUrl: options.fngUrl,
      cgPlatformsUrl: options.cgPlatformsUrl,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    },
  });

  const server = createServer(async (req, res) => {
    let url;
    try {
      // Route on req.url against a fixed base so untrusted Host headers cannot
      // affect routing or throw inside this handler.
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      sendText(res, 400, "Bad request\n");
      return;
    }

    const { pathname, searchParams } = url;
    const method = req.method || "GET";

    try {
      // Health check required by Pockets runtime contract.
      if (method === "GET" && pathname === "/health") {
        sendJson(res, 200, { status: "ok" });
        return;
      }

      // ---- API Routes ----
      if (pathname.startsWith("/api/")) {
        if (method === "GET" && pathname === "/api/bootstrap") {
          const includeExchanges = searchParams.get("include") === "exchanges";
          const coinCode = searchParams.get("coin") || null;
          const payload = await market.getBootstrap({ includeExchanges, coinCode });
          sendJson(res, 200, payload);
          return;
        }

        if (method === "GET" && pathname === "/api/status") {
          const refresh = searchParams.get("refresh") === "1";
          const status = await market.getStatus({ refreshCredits: refresh });
          sendJson(res, 200, status);
          return;
        }

        if (method === "POST" && pathname === "/api/settings/api-key") {
          const body = await readJsonBody(req);
          const status = await market.saveApiKey(body?.apiKey);
          sendJson(res, 200, status);
          return;
        }

        if (method === "DELETE" && pathname === "/api/settings/api-key") {
          const status = await market.removeApiKey();
          sendJson(res, 200, status);
          return;
        }

        if (method === "GET" && pathname === "/api/preferences") {
          const prefs = await store.getPreferences();
          sendJson(res, 200, prefs);
          return;
        }

        if (method === "PUT" && pathname === "/api/preferences") {
          const body = await readJsonBody(req);
          const prefs = await store.updatePreferences(body);
          sendJson(res, 200, prefs);
          return;
        }

        if (method === "GET" && pathname === "/api/portfolio") {
          const portfolio = await store.getPortfolio();
          sendJson(res, 200, portfolio);
          return;
        }

        if (method === "POST" && pathname === "/api/portfolio/toggle") {
          const body = await readJsonBody(req);
          const result = await store.toggleWatchlist(body?.code);
          sendJson(res, 200, result);
          return;
        }

        if (method === "PUT" && pathname === "/api/portfolio/holding") {
          const body = await readJsonBody(req);
          const portfolio = await store.setHolding(body?.code, {
            quantity: body?.quantity,
            avgCost: body?.avgCost,
          });
          sendJson(res, 200, portfolio);
          return;
        }

        const holdingDelMatch = pathname.match(/^\/api\/portfolio\/holding\/([^/]+)$/);
        if (method === "DELETE" && holdingDelMatch) {
          const code = decodeURIComponent(holdingDelMatch[1]);
          const portfolio = await store.deleteHolding(code);
          sendJson(res, 200, portfolio);
          return;
        }

        if (method === "GET" && pathname === "/api/fx") {
          const forceRefresh = searchParams.get("refresh") === "1";
          const data = await market.getFxRates({ forceRefresh });
          sendJson(res, 200, data);
          return;
        }

        if (method === "GET" && pathname === "/api/overview") {
          const currency = searchParams.get("currency") || "USD";
          const forceRefresh = searchParams.get("refresh") === "1";
          const data = await market.getOverview({ currency, forceRefresh });
          sendJson(res, 200, data);
          return;
        }

        if (method === "GET" && pathname === "/api/markets") {
          const currency = searchParams.get("currency") || "USD";
          const forceRefresh = searchParams.get("refresh") === "1";
          const data = await market.getMarkets({ currency, forceRefresh });
          sendJson(res, 200, data);
          return;
        }

        if (method === "GET" && pathname === "/api/exchanges") {
          const currency = searchParams.get("currency") || "USD";
          const forceRefresh = searchParams.get("refresh") === "1";
          const data = await market.getExchanges({ currency, forceRefresh });
          sendJson(res, 200, data);
          return;
        }

        if (method === "GET" && pathname === "/api/sparklines") {
          const currency = searchParams.get("currency") || "USD";
          const rawCodes = searchParams.get("codes") || "";
          const codes = rawCodes
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          const data = await market.getSparklines({ codes, currency });
          sendJson(res, 200, data);
          return;
        }

        if (method === "GET" && pathname === "/api/quotes") {
          const currency = searchParams.get("currency") || "USD";
          const forceRefresh = searchParams.get("refresh") === "1";
          const rawCodes = searchParams.get("codes") || "";
          const codes = rawCodes
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          const data = await market.getCoinQuotes({ codes, currency, forceRefresh });
          sendJson(res, 200, data);
          return;
        }

        if (method === "GET" && pathname === "/api/search") {
          const query = searchParams.get("q") || "";
          const currency = searchParams.get("currency") || "USD";
          const data = await market.searchCoins({ query, currency });
          sendJson(res, 200, data);
          return;
        }

        const coinHistMatch = pathname.match(/^\/api\/coins\/([^/]+)\/history$/);
        if (method === "GET" && coinHistMatch) {
          const code = decodeURIComponent(coinHistMatch[1]);
          const currency = searchParams.get("currency") || "USD";
          const range = searchParams.get("range") || "24h";
          const data = await market.getCoinHistory({ code, currency, range });
          sendJson(res, 200, data);
          return;
        }

        const coinDetailMatch = pathname.match(/^\/api\/coins\/([^/]+)$/);
        if (method === "GET" && coinDetailMatch) {
          const code = decodeURIComponent(coinDetailMatch[1]);
          const currency = searchParams.get("currency") || "USD";
          const forceRefresh = searchParams.get("refresh") === "1";
          const metaOnly = searchParams.get("metaOnly") === "1";
          const data = await market.getCoinDetail({ code, currency, forceRefresh, metaOnly });
          sendJson(res, 200, data);
          return;
        }

        sendJson(res, 404, { error: "API route not found" });
        return;
      }

      if (method !== "GET" && method !== "HEAD") {
        sendText(res, 405, "Method not allowed\n");
        return;
      }

      // Static assets from /public
      const staticFiles = new Map([
        ["/styles.css", "styles.css"],
        ["/app.js", "app.js"],
        ["/charts.js", "charts.js"],
        ["/filters.js", "filters.js"],
        ["/portfolio.js", "portfolio.js"],
        ["/favicon.ico", "favicon.ico"],
        ["/favicon.svg", "favicon.svg"],
        ["/favicon-32x32.png", "favicon-32x32.png"],
        ["/favicon-64x64.png", "favicon-64x64.png"],
        ["/apple-touch-icon.png", "apple-touch-icon.png"],
      ]);

      if (pathname === "/manifest.webmanifest") {
        await serveManifest(res, store);
        return;
      }

      if (staticFiles.has(pathname)) {
        await servePublicFile(res, staticFiles.get(pathname));
        return;
      }

      // SPA HTML routes
      if (
        pathname === "/" ||
        pathname === "/exchanges" ||
        pathname === "/portfolio" ||
        pathname === "/categories" ||
        /^\/coins\/[^/]+$/.test(pathname)
      ) {
        await serveSpaHtml(res, store);
        return;
      }

      sendText(res, 404, "Not found\n");
    } catch (err) {
      if (err instanceof LcwApiError) {
        sendJson(res, err.status || 500, { error: err.message, code: err.code });
        return;
      }
      if (err?.status && err.status >= 400 && err.status < 500) {
        sendJson(res, err.status, { error: err.message });
        return;
      }
      // Log message only (never request headers or secrets).
      console.error("coinkiwi: unhandled request error:", err?.message || err);
      sendJson(res, 500, { error: "Internal server error" });
    }
  });

  let closing;

  return {
    dataDir,
    server,
    listen() {
      return new Promise((resolveListen, rejectListen) => {
        const onError = (err) => rejectListen(err);
        server.once("error", onError);
        server.listen(port, host, () => {
          server.removeListener("error", onError);
          resolveListen();
        });
      });
    },
    address() {
      return server.address();
    },
    close() {
      if (!closing) {
        closing = new Promise((resolveClose, rejectClose) => {
          server.close((err) => (err ? rejectClose(err) : resolveClose()));
        });
        server.closeIdleConnections();
      }
      return closing;
    },
  };
}

const isMain = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href,
);

if (isMain) {
  const pocket = createPocket();
  await pocket.listen();
  const addr = pocket.address();
  console.log(
    `coinkiwi listening on http://${addr.address}:${addr.port} ` +
      `(data: ${pocket.dataDir})`,
  );

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`coinkiwi received ${signal}, shutting down`);
    pocket.close().then(
      () => process.exit(0),
      (err) => {
        console.error("coinkiwi: error during shutdown", err?.message || err);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
