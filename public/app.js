// CoinKiwi SPA client: zero-dependency ES module for CoinKiwi's
// homepage, coin detail view, portfolio/watchlist, categories, search, and
// Live Coin Watch API key setup.

import {
  renderDetailChart,
  renderOverviewChart,
  renderSparklineSvg,
} from "./charts.js";
import {
  applyCoinFilters,
  CHANGE_PRESETS,
  CHANGE_TIMEFRAMES,
  countActivePanelFilters,
  createDefaultFilterState,
  FDV_PRESETS,
  getActiveFilterChips,
  getAvailableCategories,
  getAvailableChains,
  getCoinMcapFdvRatio,
  LIQUIDITY_PRESETS,
  MCAP_PRESETS,
  RATIO_PRESETS,
  VOLUME_PRESETS,
} from "./filters.js";
import {
  DEFAULT_PORTFOLIO_SORT,
  filterPortfolioRows,
  getDefaultPortfolioSortDir,
  getPortfolioPnlMeta,
  normalizePortfolioSort,
  PORTFOLIO_SORT_OPTIONS,
  sortPortfolioRows,
  summarizePortfolioRows,
  togglePortfolioSort,
} from "./portfolio.js";

const CURRENCIES = {
  USD: { symbol: "$", code: "USD" },
  NZD: { symbol: "NZ$", code: "NZD" },
  EUR: { symbol: "€", code: "EUR" },
  GBP: { symbol: "£", code: "GBP" },
  AUD: { symbol: "A$", code: "AUD" },
  BTC: { symbol: "₿", code: "BTC" },
};

const state = {
  status: null,
  preferences: {
    currency: "USD",
    theme: "light",
    showHighlights: true,
    perPage: 100,
    coinLimit: 1000,
    refreshIntervalSec: 180,
    autoRefresh: false,
    dailyCreditLimit: 10_000,
    portfolioSortKey: DEFAULT_PORTFOLIO_SORT.key,
    portfolioSortDir: DEFAULT_PORTFOLIO_SORT.dir,
    columns: {
      h1: true,
      h24: true,
      d7: true,
      d30: false,
      volume: true,
      liquidity: false,
      cap: true,
      fdv: false,
      mcapFdv: false,
      sparkline: true,
    },
  },
  portfolio: { watchlist: [], holdings: {} },
  portfolioFilter: "all",
  extraCoins: {},
  overview: null,
  fearAndGreed: null,
  markets: null,
  fxRates: {
    USD: 1,
    NZD: 1.71,
    EUR: 0.92,
    GBP: 0.79,
    AUD: 1.54,
    BTC: 1 / 67000,
  },
  fxRatesLive: false,
  exchanges: {
    data: null,
    fromSnapshot: false,
    filter: "All",
    sortKey: "volume",
    sortDir: "desc",
    query: "",
  },
  activeCategory: "All",
  sortKey: "rank",
  sortDir: "asc",
  page: 1,
  filterOpen: false,
  filter: createDefaultFilterState(),
  // Coin detail view state
  detail: {
    code: null,
    data: null,
    fromSnapshot: false,
    range: "24h",
    metric: "rate",
    tab: "overview",
    historyCache: new Map(),
    loadingHistory: false,
  },
  // Search dropdown state
  searchResults: [],
  searchIndex: -1,
  openPopover: null,
};

let stickyScrollHandler = null;
let autoRefreshTimer = null;
let nextAutoRefreshAt = 0;
let isLoadingData = false;
let prevPrices = new Map();
let priceFlash = new Map();
let sparklineAbortController = null;
let prewarmAbortController = null;
const prefetchedCoins = new Map(); // code -> { cur, ts, promise, data }
const prefetchedHistory = new Map(); // `${code}:${cur}:${range}` -> { ts, promise, history }
const topChartsWarmedAt = new Map(); // cur -> timestamp
const portfolioQuotesInFlight = new Set(); // codes currently being fetched via /api/quotes
const portfolioQuoteAttemptedAt = new Map(); // code -> timestamp
const PORTFOLIO_QUOTE_RETRY_MS = 60_000;

function getTrackedPortfolioCodes() {
  return [
    ...new Set([
      ...(state.portfolio.watchlist || []),
      ...Object.keys(state.portfolio.holdings || {}),
    ]),
  ];
}

function rememberCoin(coin) {
  if (!coin?.code) return;
  const code = coin.code;
  let foundInMarkets = false;
  if (Array.isArray(state.markets?.coins)) {
    const idx = state.markets.coins.findIndex((c) => c.code === code);
    if (idx >= 0) {
      foundInMarkets = true;
      state.markets.coins[idx] = { ...state.markets.coins[idx], ...coin };
    }
  }
  const isTracked =
    state.portfolio.watchlist.includes(code) ||
    Object.prototype.hasOwnProperty.call(state.portfolio.holdings, code);
  if (!foundInMarkets || isTracked) {
    state.extraCoins[code] = { ...(state.extraCoins[code] || {}), ...coin };
  }
}

function findKnownCoin(code, marketByCode = null) {
  const marketCoin = marketByCode
    ? marketByCode.get(code)
    : state.markets?.coins?.find((c) => c.code === code) || null;
  if (marketCoin && Number.isFinite(marketCoin.rate) && marketCoin.rate > 0) {
    return marketCoin;
  }
  const extraCoin = state.extraCoins?.[code] || null;
  if (extraCoin && Number.isFinite(extraCoin.rate) && extraCoin.rate > 0) {
    return extraCoin;
  }
  const prefetched = prefetchedCoins.get(code)?.data?.coin || null;
  if (prefetched && Number.isFinite(prefetched.rate) && prefetched.rate > 0) {
    return prefetched;
  }
  const detailCoin =
    state.detail.code === code ? state.detail.data?.coin || null : null;
  if (detailCoin && Number.isFinite(detailCoin.rate) && detailCoin.rate > 0) {
    return detailCoin;
  }
  return marketCoin || extraCoin || prefetched || detailCoin || null;
}

function ensurePortfolioCoinQuotes({ forceRefresh = false } = {}) {
  const trackedCodes = getTrackedPortfolioCodes();
  if (!trackedCodes.length) return Promise.resolve();

  const marketByCode = new Map(
    (state.markets?.coins || []).map((c) => [c.code, c]),
  );
  const now = Date.now();
  const codesToFetch = trackedCodes.filter((code) => {
    if (portfolioQuotesInFlight.has(code)) return false;
    const marketHit = marketByCode.get(code);
    const hasMarketPrice =
      marketHit && Number.isFinite(marketHit.rate) && marketHit.rate > 0;
    if (forceRefresh) {
      return !hasMarketPrice;
    }
    const known = findKnownCoin(code, marketByCode);
    if (known && Number.isFinite(known.rate) && known.rate > 0) return false;
    const lastAttempt = portfolioQuoteAttemptedAt.get(code) || 0;
    return now - lastAttempt >= PORTFOLIO_QUOTE_RETRY_MS;
  });

  if (!codesToFetch.length) return Promise.resolve();

  for (const code of codesToFetch) {
    portfolioQuotesInFlight.add(code);
    portfolioQuoteAttemptedAt.set(code, now);
  }

  const url = `/api/quotes?codes=${encodeURIComponent(codesToFetch.join(","))}&currency=USD${forceRefresh ? "&refresh=1" : ""}`;
  return apiJson(url)
    .then((res) => {
      const returned = res?.coins && typeof res.coins === "object" ? res.coins : {};
      let updated = false;
      for (const coin of Object.values(returned)) {
        if (coin?.code && Number.isFinite(coin.rate) && coin.rate > 0) {
          rememberCoin(coin);
          updated = true;
        }
      }
      if (updated) saveClientSnapshot();
    })
    .catch(() => {
      // Allow immediate retry on next visit if the network call failed.
      for (const code of codesToFetch) {
        portfolioQuoteAttemptedAt.delete(code);
      }
    })
    .finally(() => {
      for (const code of codesToFetch) {
        portfolioQuotesInFlight.delete(code);
      }
      if (currentRoute().name === "portfolio") {
        renderPortfolioPage({ skipQuoteFetch: true });
      }
    });
}

const SNAPSHOT_KEY = "coinkiwi_snapshot_v2";

function getClientStorage() {
  try {
    if (window.localStorage) return window.localStorage;
  } catch {
    // Fallback below.
  }
  try {
    if (window.sessionStorage) return window.sessionStorage;
  } catch {
    // Storage unavailable.
  }
  return null;
}

function saveClientSnapshot() {
  const storage = getClientStorage();
  if (!storage) return;

  const cleanMeta = (m) =>
    m ? { ...m, isStale: false, warning: null, warningCode: null } : m;

  const trackedSet = new Set(getTrackedPortfolioCodes());
  const compactExtraCoins = {};
  for (const [code, coin] of Object.entries(state.extraCoins || {})) {
    if (trackedSet.has(code) && coin && typeof coin === "object") {
      compactExtraCoins[code] = { ...coin, sparkline: undefined };
    }
  }

  const base = {
    savedAt: Date.now(),
    preferences: state.preferences,
    portfolio: state.portfolio,
    extraCoins: compactExtraCoins,
    status: state.status,
    fxRates: state.fxRates,
    overview: state.overview
      ? { ...state.overview, meta: cleanMeta(state.overview.meta) }
      : null,
    exchanges: state.exchanges.data
      ? {
          ...state.exchanges.data,
          meta: cleanMeta(state.exchanges.data.meta),
          exchanges: Array.isArray(state.exchanges.data.exchanges)
            ? state.exchanges.data.exchanges.slice(0, 150)
            : [],
        }
      : null,
    detail:
      state.detail.code && state.detail.data?.coin
        ? {
            code: state.detail.code,
            currency: "USD",
            coin: state.detail.data.coin,
            history24h: (state.detail.historyCache.get("24h") || []).slice(-120),
          }
        : null,
  };

  // Try saving up to 1,000 coins for instant table/search/categories on reload;
  // gracefully shrink if storage quota is tight.
  const attempts = [
    () => ({
      ...base,
      markets: state.markets
        ? {
            ...state.markets,
            meta: cleanMeta(state.markets.meta),
            coins: (state.markets.coins || []).slice(0, 1000),
          }
        : null,
    }),
    () => ({
      ...base,
      markets: state.markets
        ? {
            ...state.markets,
            meta: cleanMeta(state.markets.meta),
            coins: (state.markets.coins || []).slice(0, 250).map((c) => ({
              ...c,
              sparkline: undefined,
            })),
          }
        : null,
    }),
    () => ({
      ...base,
      exchanges: null,
      markets: state.markets
        ? {
            ...state.markets,
            meta: cleanMeta(state.markets.meta),
            coins: (state.markets.coins || []).slice(0, 100).map((c) => ({
              ...c,
              sparkline: undefined,
            })),
          }
        : null,
    }),
  ];

  for (const build of attempts) {
    try {
      storage.setItem(SNAPSHOT_KEY, JSON.stringify(build()));
      return;
    } catch {
      // Retry with smaller payload.
    }
  }
}

function restoreClientSnapshot() {
  const storage = getClientStorage();
  if (!storage) return false;
  try {
    const raw = storage.getItem(SNAPSHOT_KEY);
    if (!raw) return false;
    const snap = JSON.parse(raw);
    if (!snap || typeof snap !== "object") return false;

    if (snap.preferences && typeof snap.preferences === "object") {
      state.preferences = {
        ...state.preferences,
        ...snap.preferences,
        columns: {
          ...state.preferences.columns,
          ...(snap.preferences.columns || {}),
        },
      };
    }
    if (snap.portfolio && typeof snap.portfolio === "object") {
      state.portfolio = {
        watchlist: Array.isArray(snap.portfolio.watchlist) ? snap.portfolio.watchlist : [],
        holdings:
          snap.portfolio.holdings && typeof snap.portfolio.holdings === "object"
            ? snap.portfolio.holdings
            : {},
      };
    }
    if (snap.extraCoins && typeof snap.extraCoins === "object") {
      state.extraCoins = { ...state.extraCoins, ...snap.extraCoins };
    }
    if (snap.status && typeof snap.status === "object") {
      state.status = snap.status;
    }
    if (snap.fxRates && typeof snap.fxRates === "object") {
      state.fxRates = { ...state.fxRates, ...snap.fxRates, USD: 1 };
    }
    if (snap.overview && typeof snap.overview === "object") {
      state.overview = snap.overview;
      state.fearAndGreed = snap.overview.fearAndGreed || null;
    }
    if (snap.markets && Array.isArray(snap.markets.coins)) {
      state.markets = snap.markets;
      prevPrices = new Map(snap.markets.coins.map((c) => [c.code, c.rate]));
    }
    if (snap.exchanges && Array.isArray(snap.exchanges.exchanges)) {
      state.exchanges.data = snap.exchanges;
      state.exchanges.fromSnapshot = true;
    }

    const route = currentRoute();
    if (route.name === "coin") {
      let restoredCoin = null;
      let restoredHist = [];
      if (snap.detail?.code === route.code && snap.detail?.coin) {
        restoredCoin = snap.detail.coin;
        restoredHist = Array.isArray(snap.detail.history24h) ? snap.detail.history24h : [];
      } else if (state.markets?.coins) {
        restoredCoin = state.markets.coins.find((c) => c.code === route.code) || null;
      }
      if (restoredCoin) {
        const historyCache = new Map();
        if (restoredHist.length) historyCache.set("24h", restoredHist);
        state.detail = {
          code: route.code,
          data: {
            currency: "USD",
            coin: restoredCoin,
            history24h: restoredHist,
          },
          fromSnapshot: true,
          range: "24h",
          metric: "rate",
          tab: "overview",
          historyCache,
          loadingHistory: restoredHist.length === 0,
        };
      }
    }

    return Boolean(state.markets || state.overview || state.exchanges.data || state.detail.data);
  } catch {
    return false;
  }
}

function formatIntervalLabel(sec) {
  const s = Number(sec) || 180;
  if (s < 60) return `${s}s`;
  const mins = Math.round(s / 60);
  return `${mins}m`;
}

function formatCountdown(ms) {
  const secs = Math.max(0, Math.ceil(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ==================== Helpers & Formatters ====================

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function currencyMeta(code = state.preferences.currency) {
  return CURRENCIES[String(code || "USD").toUpperCase()] || CURRENCIES.USD;
}

function getFxRate(currency = state.preferences.currency) {
  const code = String(currency || "USD").toUpperCase();
  if (code === "USD") return 1;
  if (code === "BTC") {
    const btc = state.markets?.coins?.find((c) => c.code === "BTC");
    if (btc?.rate > 0) return 1 / btc.rate;
    return Number(state.fxRates.BTC) > 0 ? Number(state.fxRates.BTC) : 1 / 67000;
  }
  const r = Number(state.fxRates[code]);
  return Number.isFinite(r) && r > 0 ? r : 1;
}

function switchDisplayCurrency(nextCur) {
  if (!nextCur || nextCur === state.preferences.currency) return;
  state.preferences.currency = nextCur;
  renderTopBar();
  renderCurrentRoute();
  saveClientSnapshot();
  // Persist preference in the background — zero market re-fetch or API credits!
  savePreferences({ currency: nextCur });
}

function formatPrice(usdValue, currency = state.preferences.currency) {
  if (typeof usdValue !== "number" || !Number.isFinite(usdValue)) return "—";
  const value = usdValue * getFxRate(currency);
  const { symbol, code } = currencyMeta(currency);
  if (code === "BTC") {
    const abs = Math.abs(value);
    const digits = abs >= 1 ? 4 : abs >= 0.001 ? 6 : 8;
    return `${symbol}${value.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: digits,
    })}`;
  }
  const abs = Math.abs(value);
  let minFrac = 2;
  let maxFrac = 2;
  if (abs === 0) {
    maxFrac = 2;
  } else if (abs < 0.0001) {
    minFrac = 6;
    maxFrac = 8;
  } else if (abs < 0.01) {
    minFrac = 4;
    maxFrac = 6;
  } else if (abs < 2) {
    minFrac = 4;
    maxFrac = 4;
  }
  return `${symbol}${value.toLocaleString(undefined, {
    minimumFractionDigits: minFrac,
    maximumFractionDigits: maxFrac,
  })}`;
}

function formatWholeCurrency(usdValue, currency = state.preferences.currency) {
  if (typeof usdValue !== "number" || !Number.isFinite(usdValue) || usdValue === 0) return "—";
  const value = usdValue * getFxRate(currency);
  const { symbol, code } = currencyMeta(currency);
  if (code === "BTC") {
    return `${symbol}${Math.round(value).toLocaleString()}`;
  }
  return `${symbol}${Math.round(value).toLocaleString()}`;
}

function formatCompactCurrency(usdValue, currency = state.preferences.currency) {
  if (typeof usdValue !== "number" || !Number.isFinite(usdValue)) return "—";
  const value = usdValue * getFxRate(currency);
  const { symbol } = currencyMeta(currency);
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}${symbol}${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}${symbol}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${symbol}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${symbol}${(abs / 1e3).toFixed(2)}K`;
  if (abs >= 1) return `${sign}${symbol}${abs.toFixed(2)}`;
  return `${sign}${symbol}${abs.toPrecision(3)}`;
}

function formatSupply(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "∞";
  if (value >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  return Math.round(value).toLocaleString();
}

function formatDeltaHtml(pct, suffix = "") {
  if (typeof pct !== "number" || !Number.isFinite(pct)) {
    return `<span class="ck-muted">—</span>`;
  }
  const rounded = Math.abs(pct) < 0.05 ? 0 : pct;
  const isUp = rounded >= 0;
  const cls = isUp ? "ck-up" : "ck-down";
  const arrow = isUp ? "▲" : "▼";
  return `<span class="ck-delta ${cls}">${arrow} ${Math.abs(rounded).toFixed(1)}%${suffix ? ` ${esc(suffix)}` : ""}</span>`;
}

function displayCode(code) {
  const s = String(code || "");
  return s.replace(/^_+/, "") || s;
}

function renderAvatar(coin, sizeClass = "") {
  const initials = esc(displayCode(coin.code || "?").slice(0, 3));
  const bg = esc(coin.color || "#4BCC00");
  if (coin.icon) {
    return `<span class="ck-coin-avatar ${sizeClass}" style="background:${bg}">
      <img src="${esc(coin.icon)}" alt="" loading="lazy" onerror="this.remove()" />
    </span>`;
  }
  return `<span class="ck-coin-avatar ${sizeClass}" style="background:${bg}">${initials}</span>`;
}

function timeAgo(ts) {
  if (!ts) return "";
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return `${hrs}h ago`;
}

async function apiJson(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      headers: { "content-type": "application/json", ...(options.headers || {}) },
      ...options,
    });
  } catch (networkErr) {
    const err = new Error(
      state.status?.previewGatewayMode
        ? "Could not reach the Pockets Preview server. Preview may have stopped or restarted — reload the preview, or install via Sync source → Build/Update to use your Live Coin Watch API key."
        : "Could not reach the CoinKiwi server. Check that CoinKiwi is still running and try again.",
    );
    err.cause = networkErr;
    throw err;
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = new Error(body?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = body?.code;
    throw err;
  }
  return body;
}

// ==================== Theme, Chrome & Status ====================

function applyTheme(theme) {
  const dark = theme === "dark";
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  const sun = document.getElementById("theme-icon-sun");
  const moon = document.getElementById("theme-icon-moon");
  if (sun && moon) {
    sun.classList.toggle("ck-hidden", dark);
    moon.classList.toggle("ck-hidden", !dark);
  }
}

let syncGlobalStatsScroll = null;

function renderTopBar() {
  const ov = state.overview?.overview;
  const fng = state.fearAndGreed;
  const cur = state.preferences.currency;

  const elCoins = document.getElementById("stat-coins");
  const elEx = document.getElementById("stat-exchanges");
  const elMcap = document.getElementById("stat-mcap");
  const elMcapDelta = document.getElementById("stat-mcap-delta");
  const elVol = document.getElementById("stat-vol");
  const elDom = document.getElementById("stat-dom");
  const elFng = document.getElementById("stat-fng");

  if (ov) {
    elCoins.textContent =
      typeof ov.coins === "number" ? ov.coins.toLocaleString() : String(ov.coins || "—");
    elEx.textContent =
      typeof ov.exchanges === "number"
        ? ov.exchanges.toLocaleString()
        : String(ov.exchanges || "—");
    elMcap.textContent = formatCompactCurrency(ov.cap, cur);
    elMcapDelta.innerHTML = formatDeltaHtml(ov.capChange24h);
    elVol.textContent = formatCompactCurrency(ov.volume, cur);

    const domParts = [];
    if (typeof ov.btcDominance === "number") domParts.push(`BTC ${ov.btcDominance.toFixed(1)}%`);
    if (typeof ov.ethDominance === "number") domParts.push(`ETH ${ov.ethDominance.toFixed(2)}%`);
    elDom.textContent = domParts.join(" ") || "—";
  }

  if (fng && Number.isFinite(fng.value)) {
    const slug = String(fng.classification || "neutral")
      .toLowerCase()
      .replace(/\s+/g, "-");
    elFng.textContent = `${fng.classification} (${fng.value})`;
    elFng.className = `ck-fng-${slug}`;
  }

  // API status pill (desktop + compact mobile CTA)
  const st = state.status;
  const apiBtn = document.getElementById("btn-api-status");
  const mApiBtn = document.getElementById("btn-mobile-api");
  const dot = document.getElementById("api-status-dot");
  const label = document.getElementById("api-status-label");
  const mDot = document.getElementById("mobile-api-dot");
  const mLabel = document.getElementById("mobile-api-label");
  if (st) {
    dot.className = "ck-status-dot";
    if (mDot) mDot.className = "ck-status-dot";
    const q = st.quota;
    const needsKey = !st.configured;
    if (apiBtn) apiBtn.classList.toggle("is-needs-key", needsKey || Boolean(st.previewGatewayMode));
    if (mApiBtn) mApiBtn.classList.toggle("is-needs-key", needsKey || Boolean(st.previewGatewayMode));
    if (st.previewGatewayMode) {
      label.textContent = st.configured ? "Preview Sample" : "Add API Key";
      if (mLabel) mLabel.textContent = st.configured ? "Sample" : "API Key";
    } else if (st.configured) {
      dot.classList.add("is-live");
      if (mDot) mDot.classList.add("is-live");
      label.textContent =
        typeof q?.refreshesRemainingToday === "number"
          ? `LCW Live · ${q.refreshesRemainingToday.toLocaleString()} refreshes left`
          : "LCW Live";
      if (mLabel) mLabel.textContent = "Live";
    } else {
      label.textContent = "Add API Key";
      if (mLabel) mLabel.textContent = "API Key";
    }
  }

  // Portfolio badge (desktop + mobile bottom tab)
  const badge = document.getElementById("nav-portfolio-count");
  const mBadge = document.getElementById("mobile-portfolio-count");
  const count = state.portfolio.watchlist.length;
  badge.textContent = String(count);
  badge.classList.toggle("ck-hidden", count === 0);
  if (mBadge) {
    mBadge.textContent = count > 99 ? "99+" : String(count);
    mBadge.classList.toggle("ck-hidden", count === 0);
  }

  // Footer updated timestamp
  updateFooterTimestamp();

  renderDataBanner();
  renderSampleWatermark();
  syncGlobalStatsScroll?.();
}

function initGlobalStatsScroller() {
  const wrapEl = document.getElementById("global-stats-wrap");
  const statsEl = document.getElementById("global-stats");
  if (!wrapEl || !statsEl) return;

  const AUTO_SPEED_PX_PER_SEC = 28;
  const INITIAL_PAUSE_MS = 2200;
  const EDGE_PAUSE_MS = 2400;
  const INTERACTION_RESUME_MS = 5000;
  const HOVER_RESUME_MS = 1200;
  const DRAG_THRESHOLD_PX = 4;

  const reducedMotionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  let reducedMotion = Boolean(reducedMotionQuery?.matches);

  let hovered = false;
  let focused = false;
  let dragging = false;
  let touching = false;
  let autoActive = false;
  let suppressClick = false;

  let dir = 1;
  let pos = statsEl.scrollLeft || 0;
  let pauseUntil = performance.now() + INITIAL_PAUSE_MS;
  let rafId = null;
  let resumeTimer = null;
  let lastTs = 0;

  function getMaxScroll() {
    return Math.max(0, statsEl.scrollWidth - statsEl.clientWidth);
  }

  function stopLoop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (resumeTimer !== null) {
      clearTimeout(resumeTimer);
      resumeTimer = null;
    }
    autoActive = false;
    lastTs = 0;
  }

  function pauseAuto(ms) {
    pauseUntil = Math.max(pauseUntil, performance.now() + ms);
    stopLoop();
  }

  function shouldAutoRun() {
    return (
      !reducedMotion &&
      !document.hidden &&
      !hovered &&
      !focused &&
      !dragging &&
      !touching &&
      getMaxScroll() > 2
    );
  }

  function syncFadeClasses(scrollPos, maxScroll) {
    const isOverflowing = maxScroll > 2;
    const canLeft = isOverflowing && scrollPos > 2;
    const canRight = isOverflowing && scrollPos < maxScroll - 2;

    wrapEl.classList.toggle("is-overflowing", isOverflowing);
    wrapEl.classList.toggle("can-scroll-left", canLeft);
    wrapEl.classList.toggle("can-scroll-right", canRight);
  }

  function tick(ts) {
    rafId = null;
    if (!shouldAutoRun()) {
      autoActive = false;
      lastTs = 0;
      return;
    }

    const maxScroll = getMaxScroll();
    if (lastTs === 0) {
      lastTs = ts;
      pos = Math.min(maxScroll, Math.max(0, statsEl.scrollLeft));
    }
    const dt = Math.min(0.05, Math.max(0, (ts - lastTs) / 1000));
    lastTs = ts;

    if (pos >= maxScroll - 0.5 && dir > 0) {
      dir = -1;
      pos = maxScroll;
      statsEl.scrollLeft = maxScroll;
      syncFadeClasses(maxScroll, maxScroll);
      autoActive = false;
      pauseUntil = performance.now() + EDGE_PAUSE_MS;
      scheduleAutoCheck();
      return;
    }
    if (pos <= 0.5 && dir < 0) {
      dir = 1;
      pos = 0;
      statsEl.scrollLeft = 0;
      syncFadeClasses(0, maxScroll);
      autoActive = false;
      pauseUntil = performance.now() + EDGE_PAUSE_MS;
      scheduleAutoCheck();
      return;
    }

    pos = Math.min(maxScroll, Math.max(0, pos + dir * AUTO_SPEED_PX_PER_SEC * dt));
    const rounded = Math.round(pos);
    if (statsEl.scrollLeft !== rounded) {
      statsEl.scrollLeft = rounded;
    }
    syncFadeClasses(pos, maxScroll);

    if (pos >= maxScroll - 0.5 && dir > 0) {
      dir = -1;
      pos = maxScroll;
      autoActive = false;
      pauseUntil = performance.now() + EDGE_PAUSE_MS;
      scheduleAutoCheck();
      return;
    }
    if (pos <= 0.5 && dir < 0) {
      dir = 1;
      pos = 0;
      autoActive = false;
      pauseUntil = performance.now() + EDGE_PAUSE_MS;
      scheduleAutoCheck();
      return;
    }

    rafId = requestAnimationFrame(tick);
  }

  function scheduleAutoCheck() {
    if (!shouldAutoRun()) {
      stopLoop();
      return;
    }
    if (rafId !== null) return;

    if (resumeTimer !== null) {
      clearTimeout(resumeTimer);
      resumeTimer = null;
    }

    const wait = pauseUntil - performance.now();
    if (wait > 16) {
      resumeTimer = setTimeout(() => {
        resumeTimer = null;
        scheduleAutoCheck();
      }, wait);
    } else {
      autoActive = true;
      lastTs = 0;
      rafId = requestAnimationFrame(tick);
    }
  }

  function updateOverflowState() {
    const maxScroll = getMaxScroll();
    const isOverflowing = maxScroll > 2;

    if (!isOverflowing) {
      stopLoop();
      pos = 0;
      dir = 1;
      syncFadeClasses(0, 0);
      return;
    }

    if (!autoActive) {
      pos = Math.min(maxScroll, Math.max(0, statsEl.scrollLeft));
    } else {
      pos = Math.min(maxScroll, Math.max(0, pos));
    }

    syncFadeClasses(autoActive ? pos : statsEl.scrollLeft, maxScroll);
    if (!autoActive) {
      scheduleAutoCheck();
    }
  }

  statsEl.addEventListener(
    "scroll",
    () => {
      const maxScroll = getMaxScroll();
      if (!autoActive) {
        pos = statsEl.scrollLeft;
      }
      syncFadeClasses(statsEl.scrollLeft, maxScroll);
    },
    { passive: true },
  );

  statsEl.addEventListener(
    "wheel",
    (e) => {
      const maxScroll = getMaxScroll();
      if (maxScroll <= 2 || e.ctrlKey) return;

      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        pauseAuto(INTERACTION_RESUME_MS);
        scheduleAutoCheck();
        return;
      }

      let delta = e.deltaY;
      if (e.deltaMode === 1) delta *= 16;
      else if (e.deltaMode === 2) delta *= statsEl.clientWidth;

      const canMoveRight = delta > 0 && statsEl.scrollLeft < maxScroll - 1;
      const canMoveLeft = delta < 0 && statsEl.scrollLeft > 1;
      if (!canMoveRight && !canMoveLeft) return;

      e.preventDefault();
      statsEl.scrollLeft += delta;
      pos = statsEl.scrollLeft;
      dir = delta > 0 ? 1 : -1;
      pauseAuto(INTERACTION_RESUME_MS);
      scheduleAutoCheck();
    },
    { passive: false },
  );

  statsEl.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse" || e.button !== 0 || getMaxScroll() <= 2) return;
    const startX = e.clientX;
    const startScroll = statsEl.scrollLeft;
    let moved = false;

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) >= DRAG_THRESHOLD_PX) {
        moved = true;
        dragging = true;
        wrapEl.classList.add("is-dragging");
        stopLoop();
      }
      if (moved) {
        statsEl.scrollLeft = startScroll - dx;
        pos = statsEl.scrollLeft;
      }
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (moved) {
        dragging = false;
        wrapEl.classList.remove("is-dragging");
        suppressClick = true;
        setTimeout(() => {
          suppressClick = false;
        }, 0);
        pauseAuto(INTERACTION_RESUME_MS);
        scheduleAutoCheck();
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });

  statsEl.addEventListener(
    "click",
    (e) => {
      if (suppressClick) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );

  statsEl.addEventListener("dragstart", (e) => {
    if (getMaxScroll() > 2) e.preventDefault();
  });

  statsEl.addEventListener(
    "touchstart",
    () => {
      touching = true;
      stopLoop();
    },
    { passive: true },
  );

  const onTouchEnd = () => {
    touching = false;
    pauseAuto(INTERACTION_RESUME_MS);
    scheduleAutoCheck();
  };
  statsEl.addEventListener("touchend", onTouchEnd, { passive: true });
  statsEl.addEventListener("touchcancel", onTouchEnd, { passive: true });

  wrapEl.addEventListener("pointerenter", (e) => {
    if (e.pointerType === "touch") return;
    hovered = true;
    stopLoop();
  });

  wrapEl.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "touch") return;
    hovered = false;
    pauseAuto(HOVER_RESUME_MS);
    scheduleAutoCheck();
  });

  wrapEl.addEventListener("focusin", (e) => {
    if (e.target && typeof e.target.matches === "function" && !e.target.matches(":focus-visible")) {
      return;
    }
    focused = true;
    stopLoop();
  });

  wrapEl.addEventListener("focusout", (e) => {
    if (wrapEl.contains(e.relatedTarget)) return;
    focused = false;
    pauseAuto(HOVER_RESUME_MS);
    scheduleAutoCheck();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopLoop();
    } else {
      scheduleAutoCheck();
    }
  });

  const onReducedMotionChange = (e) => {
    reducedMotion = e.matches;
    if (reducedMotion) {
      stopLoop();
    } else {
      scheduleAutoCheck();
    }
  };
  if (reducedMotionQuery?.addEventListener) {
    reducedMotionQuery.addEventListener("change", onReducedMotionChange);
  } else if (reducedMotionQuery?.addListener) {
    reducedMotionQuery.addListener(onReducedMotionChange);
  }

  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(() => updateOverflowState());
    ro.observe(wrapEl);
    ro.observe(statsEl);
  }
  window.addEventListener("resize", updateOverflowState, { passive: true });
  document.fonts?.ready?.then(() => updateOverflowState());

  syncGlobalStatsScroll = updateOverflowState;
  updateOverflowState();
}

function getSampleOverlayState() {
  const st = state.status;
  const meta = state.markets?.meta || state.overview?.meta;
  if (!st && !meta) return { show: false, text: "" };

  const isPreview = Boolean(meta?.previewGatewayMode || st?.previewGatewayMode);
  const isAuthError =
    meta?.warningCode === "INVALID_API_KEY" || meta?.warningCode === "NO_API_KEY";
  const isSample = Boolean(meta?.isSample || (!meta && st && !st.configured));

  if (!isSample) {
    return { show: false, text: "" };
  }

  const text =
    isPreview && st?.configured && !isAuthError
      ? "PREVIEW SAMPLE DATA"
      : "SAMPLE DATA. ADD API KEY";

  return { show: true, text };
}

function renderSampleWatermark() {
  const overlay = document.getElementById("sample-watermark-overlay");
  if (!overlay) return;
  const { show, text } = getSampleOverlayState();

  document.body.classList.toggle("ck-sample-mode", show);
  overlay.classList.toggle("ck-hidden", !show);

  if (show && overlay.dataset.watermarkText !== text) {
    overlay.dataset.watermarkText = text;
    overlay.querySelectorAll(".ck-sample-watermark-text").forEach((node) => {
      node.textContent = text;
    });
  }
}

function updateFooterTimestamp() {
  const footerUpdated = document.getElementById("footer-updated");
  const fetchedAt = state.markets?.meta?.fetchedAt || state.overview?.meta?.fetchedAt;
  if (footerUpdated && fetchedAt) {
    const modeTag = state.markets?.meta?.isSample
      ? "Sample data"
      : state.markets?.meta?.isStale
        ? "Cached (stale)"
        : "Live Coin Watch";
    footerUpdated.textContent = `${modeTag} · Updated ${timeAgo(fetchedAt)}`;
  }
}

function renderDataBanner() {
  const banner = document.getElementById("data-banner");
  const meta = state.markets?.meta || state.overview?.meta;
  const st = state.status;

  if (!meta && !st) {
    banner.classList.add("ck-hidden");
    banner.classList.remove("is-sample");
    return;
  }

  if (meta?.isSample || meta?.isStale) {
    const isPreview = Boolean(meta.previewGatewayMode || st?.previewGatewayMode);
    const isAuthError =
      meta.warningCode === "INVALID_API_KEY" || meta.warningCode === "NO_API_KEY";
    const needsKey = !isPreview && (!st?.configured || isAuthError);
    const isSample = Boolean(meta.isSample);
    let badgeText = meta.isStale ? "STALE CACHE" : "SAMPLE DATA";
    let message = "";
    let ctaMode = "none"; // "key" | "retry" | "none"

    if (isPreview) {
      badgeText = st?.configured ? "PREVIEW SAMPLE" : "SAMPLE DATA";
      message = st?.configured
        ? "Pockets Preview's gateway supports GET/HEAD only; Live Coin Watch POST requests run live once installed (Sync source → Build/Update) or run locally."
        : "Showing sample data — add your free Live Coin Watch API key to load live prices when installed or run locally.";
      ctaMode = "key";
    } else if (!st?.configured) {
      message =
        "Showing sample data (not live prices). Add your free Live Coin Watch API key to load real-time markets and charts.";
      ctaMode = "key";
    } else if (meta.warning) {
      message = `${meta.warning} Showing ${meta.isStale ? "last cached" : "sample"} data.`;
      ctaMode = needsKey ? "key" : "retry";
    } else {
      message = "Showing sample market data.";
      ctaMode = needsKey ? "key" : "retry";
    }

    const ctaLabel =
      ctaMode === "retry"
        ? "Retry Now"
        : isPreview && st?.configured
          ? "How to Enable Live Data"
          : "Add API Key";
    banner.classList.toggle("is-sample", isSample);
    banner.innerHTML = `
      <div class="ck-container ck-banner-inner">
        <div class="ck-banner-text">
          <span class="ck-sample-tag"><span class="ck-sample-tag-dot" aria-hidden="true"></span>${esc(badgeText)}</span>
          <span>${esc(message)}</span>
        </div>
        <div>
          ${
            ctaMode !== "none"
              ? `<button type="button" class="ck-btn-brand-sm" id="banner-action-btn">${ctaLabel}</button>`
              : ""
          }
        </div>
      </div>
    `;
    banner.classList.remove("ck-hidden");
    const cta = document.getElementById("banner-action-btn");
    if (cta) {
      cta.addEventListener("click", () => {
        if (ctaMode === "retry") {
          loadAllData({ forceRefresh: true });
        } else {
          openApiKeyModal("key");
        }
      });
    }
  } else {
    banner.classList.add("ck-hidden");
    banner.classList.remove("is-sample");
    banner.innerHTML = "";
  }
}

function updateActiveNav(routeName) {
  document.querySelectorAll("[data-nav]").forEach((el) => {
    el.classList.toggle("is-active", el.getAttribute("data-nav") === routeName);
  });
}

// ==================== Routing ====================

function currentRoute() {
  const path = window.location.pathname;
  if (path === "/exchanges") return { name: "exchanges" };
  if (path === "/portfolio") return { name: "portfolio" };
  if (path === "/categories") return { name: "categories" };
  const coinMatch = path.match(/^\/coins\/([^/]+)$/);
  if (coinMatch) {
    return { name: "coin", code: decodeURIComponent(coinMatch[1]).toUpperCase() };
  }
  return { name: "markets" };
}

function resetMarketsView() {
  state.activeCategory = "All";
  state.page = 1;
  state.sortKey = "rank";
  state.sortDir = "asc";
  state.filter = createDefaultFilterState();
  state.filterOpen = false;
}

function navigate(path) {
  if (window.location.pathname !== path) {
    window.history.pushState({}, "", path);
  }
  closePopovers();
  closeMobileSheets();
  renderCurrentRoute();
  window.scrollTo({ top: 0, behavior: "instant" });
}

function teardownStickyBar() {
  const bar = document.getElementById("sticky-coin-bar");
  if (bar) {
    bar.classList.add("ck-hidden");
    bar.innerHTML = "";
  }
  if (stickyScrollHandler) {
    window.removeEventListener("scroll", stickyScrollHandler);
    stickyScrollHandler = null;
  }
}

async function renderCurrentRoute() {
  teardownStickyBar();
  const route = currentRoute();
  updateActiveNav(route.name);

  if (route.name === "coin") {
    await renderCoinDetailPage(route.code);
  } else if (route.name === "exchanges") {
    await renderExchangesPage();
  } else if (route.name === "portfolio") {
    renderPortfolioPage();
  } else if (route.name === "categories") {
    renderCategoriesPage();
  } else {
    renderMarketsPage();
  }
}

// ==================== Homepage (Markets) ====================

function buildPageButtons(current, total) {
  const pages = new Set([1, total, current, current - 1, current + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  let html = "";
  let prev = 0;
  for (const p of sorted) {
    if (prev && p - prev > 1) {
      html += `<span class="ck-muted" style="padding:0 4px">…</span>`;
    }
    html += `<button type="button" class="ck-page-btn ${p === current ? "is-active" : ""}" data-goto-page="${p}">${p}</button>`;
    prev = p;
  }
  return html;
}

function getFilteredSortedCoins() {
  const all = state.markets?.coins || [];
  const list = applyCoinFilters(all, state.filter, {
    activeCategory: state.activeCategory,
    watchlist: state.portfolio.watchlist,
  });

  const key = state.sortKey;
  const dir = state.sortDir === "asc" ? 1 : -1;
  const getVal = (coin) => {
    switch (key) {
      case "price":
        return coin.rate ?? -Infinity;
      case "h1":
        return coin.changes.h1 ?? -Infinity;
      case "h24":
        return coin.changes.h24 ?? -Infinity;
      case "d7":
        return coin.changes.d7 ?? -Infinity;
      case "d30":
        return coin.changes.d30 ?? -Infinity;
      case "volume":
        return coin.volume ?? -Infinity;
      case "liquidity":
        return coin.liquidity ?? -Infinity;
      case "cap":
        return coin.cap ?? -Infinity;
      case "fdv":
        return coin.fdv ?? -Infinity;
      case "mcapFdv": {
        const ratio = getCoinMcapFdvRatio(coin);
        return ratio ?? -Infinity;
      }
      case "rank":
      default:
        return coin.rank ?? 999999;
    }
  };

  return [...list].sort((a, b) => (getVal(a) - getVal(b)) * dir);
}

function clearFilterKey(key) {
  switch (key) {
    case "chain":
      state.filter.chain = "All";
      break;
    case "category":
      state.activeCategory = "All";
      break;
    case "query":
      state.filter.query = "";
      break;
    case "mcap":
      state.filter.mcapPreset = "all";
      state.filter.mcapMin = "";
      state.filter.mcapMax = "";
      break;
    case "vol":
      state.filter.volPreset = "all";
      state.filter.volMin = "";
      state.filter.volMax = "";
      break;
    case "change":
      state.filter.changePreset = "all";
      state.filter.changeMin = "";
      state.filter.changeMax = "";
      break;
    case "liq":
      state.filter.liqPreset = "all";
      state.filter.liqMin = "";
      state.filter.liqMax = "";
      break;
    case "fdv":
      state.filter.fdvPreset = "all";
      state.filter.fdvMin = "";
      state.filter.fdvMax = "";
      break;
    case "ratio":
      state.filter.ratioPreset = "all";
      state.filter.ratioMin = "";
      state.filter.ratioMax = "";
      break;
    default:
      break;
  }
}

function resetAllFilters({ includeCategory = true } = {}) {
  state.filter = createDefaultFilterState();
  if (includeCategory) {
    state.activeCategory = "All";
  }
  state.page = 1;
}

const FILTER_ROW_CONFIGS = [
  {
    key: "mcap",
    title: "Market Cap",
    presets: MCAP_PRESETS,
    presetField: "mcapPreset",
    minField: "mcapMin",
    maxField: "mcapMax",
    unitPrefix: "$",
    unitSuffix: "",
    minPlaceholder: "Min (e.g. 10M)",
    maxPlaceholder: "Max (e.g. 1B)",
    hint: "Supports K, M, B, T (USD)",
  },
  {
    key: "vol",
    title: "24h Volume",
    presets: VOLUME_PRESETS,
    presetField: "volPreset",
    minField: "volMin",
    maxField: "volMax",
    unitPrefix: "$",
    unitSuffix: "",
    minPlaceholder: "Min (e.g. 500K)",
    maxPlaceholder: "Max (e.g. 50M)",
    hint: "Supports K, M, B, T (USD)",
  },
  {
    key: "change",
    title: "Price Changes",
    presets: CHANGE_PRESETS,
    presetField: "changePreset",
    minField: "changeMin",
    maxField: "changeMax",
    unitPrefix: "",
    unitSuffix: "%",
    minPlaceholder: "Min % (e.g. -20)",
    maxPlaceholder: "Max % (e.g. 50)",
    hint: "Negative values allowed",
    hasTimeframes: true,
  },
  {
    key: "liq",
    title: "Liquidity",
    presets: LIQUIDITY_PRESETS,
    presetField: "liqPreset",
    minField: "liqMin",
    maxField: "liqMax",
    unitPrefix: "$",
    unitSuffix: "",
    minPlaceholder: "Min (e.g. 100K)",
    maxPlaceholder: "Max (e.g. 10M)",
    hint: "±2% orderbook depth (USD)",
  },
  {
    key: "fdv",
    title: "Fully Diluted Valuation",
    presets: FDV_PRESETS,
    presetField: "fdvPreset",
    minField: "fdvMin",
    maxField: "fdvMax",
    unitPrefix: "$",
    unitSuffix: "",
    minPlaceholder: "Min (e.g. 50M)",
    maxPlaceholder: "Max (e.g. 5B)",
    hint: "Supports K, M, B, T (USD)",
  },
  {
    key: "ratio",
    title: "Market Cap / FDV",
    presets: RATIO_PRESETS,
    presetField: "ratioPreset",
    minField: "ratioMin",
    maxField: "ratioMax",
    unitPrefix: "",
    unitSuffix: "",
    minPlaceholder: "Min (e.g. 0.25)",
    maxPlaceholder: "Max (e.g. 1.0)",
    hint: "Ratio from 0.0 to 1.0",
  },
];

function renderFilterPanelHtml(markets, filteredCount, totalCount) {
  if (!state.filterOpen) return "";

  const coins = markets?.coins || [];
  const chains = getAvailableChains(coins);
  const categories = getAvailableCategories(coins, markets?.categories || []);
  const selectedCat =
    state.activeCategory !== "All" && state.activeCategory !== "Watchlist"
      ? state.activeCategory
      : "All";
  const f = state.filter;
  const activeChips = getActiveFilterChips(f, { activeCategory: state.activeCategory });
  const hasAny = activeChips.length > 0;
  const cur = state.preferences.currency;

  return `
    <section id="filter-panel" class="ck-filter-panel" aria-label="Advanced cryptocurrency filters">
      <div class="ck-flt-top-grid">
        <div class="ck-flt-control">
          <label for="flt-chain" class="ck-flt-label">Chains</label>
          <div class="ck-flt-select-wrap">
            <select id="flt-chain" class="ck-flt-select" aria-label="Filter by blockchain">
              <option value="All" ${f.chain === "All" ? "selected" : ""}>All Chains</option>
              ${chains
                .map(
                  (ch) =>
                    `<option value="${esc(ch.name)}" ${f.chain === ch.name ? "selected" : ""}>${esc(ch.name)} (${ch.count})</option>`,
                )
                .join("")}
            </select>
            <svg class="ck-flt-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m4 6 4 4 4-4" />
            </svg>
          </div>
        </div>

        <div class="ck-flt-control">
          <label for="flt-category" class="ck-flt-label">Categories</label>
          <div class="ck-flt-select-wrap">
            <select id="flt-category" class="ck-flt-select" aria-label="Filter by category">
              <option value="All" ${selectedCat === "All" ? "selected" : ""}>All Categories</option>
              ${categories
                .map(
                  (cat) =>
                    `<option value="${esc(cat.name)}" ${selectedCat === cat.name ? "selected" : ""}>${esc(cat.name)} (${cat.count})</option>`,
                )
                .join("")}
            </select>
            <svg class="ck-flt-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m4 6 4 4 4-4" />
            </svg>
          </div>
        </div>

        <div class="ck-flt-control">
          <label for="flt-query" class="ck-flt-label">Search Coin</label>
          <div class="ck-flt-search-wrap">
            <svg class="ck-flt-search-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <circle cx="9" cy="9" r="5.5" />
              <path d="m13.2 13.2 3.3 3.3" stroke-linecap="round" />
            </svg>
            <input
              type="text"
              id="flt-query"
              class="ck-flt-search-input"
              placeholder="All Coins (name or ticker)"
              value="${esc(f.query)}"
              autocomplete="off"
              aria-label="Filter by coin name or ticker"
            />
            <button
              type="button"
              id="flt-query-clear"
              class="ck-flt-clear-input ${f.query ? "" : "ck-hidden"}"
              aria-label="Clear search"
              title="Clear"
            >✕</button>
          </div>
        </div>
      </div>

      <div class="ck-flt-rows">
        ${FILTER_ROW_CONFIGS.map((row) => {
          const activePreset = f[row.presetField] || "all";
          const isCustom = activePreset === "custom";
          return `
            <div class="ck-flt-row" data-flt-row="${row.key}">
              <div class="ck-flt-row-head">
                <span class="ck-flt-label">${esc(row.title)}</span>
                ${
                  row.hasTimeframes
                    ? `
                  <div class="ck-flt-tf-group" role="group" aria-label="Price change timeframe">
                    ${CHANGE_TIMEFRAMES.map(
                      (tf) =>
                        `<button type="button" class="ck-flt-pill is-tf ${f.changeTimeframe === tf.id ? "is-active" : ""}" data-flt-tf="${tf.id}" aria-pressed="${f.changeTimeframe === tf.id}">${esc(tf.label)}</button>`,
                    ).join("")}
                  </div>
                `
                    : ""
                }
              </div>
              <div class="ck-flt-pills" role="group" aria-label="${esc(row.title)} presets">
                ${row.presets
                  .map(
                    (p) =>
                      `<button type="button" class="ck-flt-pill ${activePreset === p.id ? "is-active" : ""}" data-flt-group="${row.key}" data-flt-preset="${esc(p.id)}" aria-pressed="${activePreset === p.id}">${esc(p.label)}</button>`,
                  )
                  .join("")}
              </div>
              ${
                isCustom
                  ? `
                <div class="ck-flt-custom-row">
                  <div class="ck-flt-custom-field">
                    ${row.unitPrefix ? `<span class="ck-flt-unit is-prefix">${esc(row.unitPrefix)}</span>` : ""}
                    <input
                      type="text"
                      inputmode="decimal"
                      class="ck-flt-custom-input ${row.unitPrefix ? "has-prefix" : ""} ${row.unitSuffix ? "has-suffix" : ""}"
                      data-flt-custom="${row.key}:min"
                      placeholder="${esc(row.minPlaceholder)}"
                      value="${esc(f[row.minField])}"
                      aria-label="${esc(row.title)} minimum"
                    />
                    ${row.unitSuffix ? `<span class="ck-flt-unit is-suffix">${esc(row.unitSuffix)}</span>` : ""}
                  </div>
                  <span class="ck-flt-custom-sep">to</span>
                  <div class="ck-flt-custom-field">
                    ${row.unitPrefix ? `<span class="ck-flt-unit is-prefix">${esc(row.unitPrefix)}</span>` : ""}
                    <input
                      type="text"
                      inputmode="decimal"
                      class="ck-flt-custom-input ${row.unitPrefix ? "has-prefix" : ""} ${row.unitSuffix ? "has-suffix" : ""}"
                      data-flt-custom="${row.key}:max"
                      placeholder="${esc(row.maxPlaceholder)}"
                      value="${esc(f[row.maxField])}"
                      aria-label="${esc(row.title)} maximum"
                    />
                    ${row.unitSuffix ? `<span class="ck-flt-unit is-suffix">${esc(row.unitSuffix)}</span>` : ""}
                  </div>
                  <span class="ck-flt-custom-hint">${esc(row.hint)}</span>
                </div>
              `
                  : ""
              }
            </div>
          `;
        }).join("")}
      </div>

      <div class="ck-flt-footer">
        <div class="ck-flt-footer-meta">
          <span id="flt-match-count" class="ck-flt-match-count">Showing <strong>${filteredCount.toLocaleString()}</strong> of ${totalCount.toLocaleString()} coins</span>
          ${cur !== "USD" ? `<span class="ck-flt-usd-note">Dollar thresholds evaluated in USD</span>` : ""}
        </div>
        <div class="ck-flt-footer-actions">
          <button type="button" id="flt-reset-all" class="ck-btn ck-flt-action-btn" ${hasAny ? "" : "disabled"}>Reset Filters</button>
          <button type="button" id="flt-done" class="ck-btn ck-btn-primary ck-flt-action-btn">Done</button>
        </div>
      </div>
    </section>
  `;
}

function renderActiveFilterChipsHtml() {
  const chips = getActiveFilterChips(state.filter, { activeCategory: state.activeCategory });
  if (!chips.length) return "";
  return `
    <div class="ck-active-filters" aria-label="Active filters">
      <span class="ck-active-filters-label">Active:</span>
      ${chips
        .map(
          (ch) => `
        <span class="ck-active-chip">
          <span class="ck-active-chip-k">${esc(ch.label)}:</span>
          <strong class="ck-active-chip-v">${esc(ch.value)}</strong>
          <button type="button" class="ck-active-chip-x" data-clear-filter="${esc(ch.key)}" aria-label="Remove ${esc(ch.label)} filter" title="Remove">×</button>
        </span>
      `,
        )
        .join("")}
      <button type="button" id="btn-clear-all-chips" class="ck-link-btn ck-active-clear-all">Clear all</button>
    </div>
  `;
}

function renderMarketsResultsHtml(filtered) {
  const cur = state.preferences.currency;
  const perPage = state.preferences.perPage || 100;
  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  if (state.page > totalPages) state.page = totalPages;
  const startIdx = (state.page - 1) * perPage;
  const pageCoins = filtered.slice(startIdx, startIdx + perPage);
  const watchSet = new Set(state.portfolio.watchlist);
  const cols = state.preferences.columns;

  const sortArrow = (k) => {
    if (state.sortKey !== k) return "";
    return `<span class="ck-sort-arrow">${state.sortDir === "asc" ? "▲" : "▼"}</span>`;
  };

  if (pageCoins.length === 0) {
    return {
      pageCoins,
      totalPages,
      html: `<div class="ck-empty">
        <p><strong>No coins match your current filter.</strong></p>
        <p>${state.activeCategory === "Watchlist" ? "Click the ☆ star next to any coin to add it to your watchlist." : "Try adjusting or clearing your filter controls."}</p>
        <button type="button" class="ck-btn" id="btn-reset-empty">Reset filters</button>
      </div>`,
    };
  }

  const html = `
    <div class="ck-table-wrap">
      <table class="ck-table">
        <thead>
          <tr>
            <th class="ck-col-star is-left" aria-label="Watchlist"></th>
            <th class="ck-col-rank is-left is-sortable" data-sort="rank">${sortArrow("rank")}#</th>
            <th class="ck-col-coin is-left">Coin</th>
            <th class="is-sortable" data-sort="price">${sortArrow("price")}Price</th>
            ${cols.h1 ? `<th class="is-sortable" data-sort="h1">${sortArrow("h1")}1h</th>` : ""}
            ${cols.h24 ? `<th class="is-sortable" data-sort="h24">${sortArrow("h24")}24h</th>` : ""}
            ${cols.d7 ? `<th class="is-sortable" data-sort="d7">${sortArrow("d7")}7d</th>` : ""}
            ${cols.d30 ? `<th class="is-sortable" data-sort="d30">${sortArrow("d30")}30d</th>` : ""}
            ${cols.volume ? `<th class="is-sortable" data-sort="volume">${sortArrow("volume")}24h Volume</th>` : ""}
            ${cols.liquidity ? `<th class="is-sortable" data-sort="liquidity">${sortArrow("liquidity")}Liquidity</th>` : ""}
            ${cols.cap ? `<th class="is-sortable" data-sort="cap">${sortArrow("cap")}Market Cap</th>` : ""}
            ${cols.fdv ? `<th class="is-sortable" data-sort="fdv">${sortArrow("fdv")}FDV</th>` : ""}
            ${cols.mcapFdv ? `<th class="is-sortable" data-sort="mcapFdv">${sortArrow("mcapFdv")}MCap / FDV</th>` : ""}
            ${cols.sparkline ? `<th>Last 7 Days</th>` : ""}
          </tr>
        </thead>
        <tbody>
          ${pageCoins
            .map((coin) => {
              const starred = watchSet.has(coin.code);
              const sparkUp = (coin.changes.d7 ?? coin.changes.h24 ?? 0) >= 0;
              const ratio = cols.mcapFdv ? getCoinMcapFdvRatio(coin) : null;
              return `
                <tr data-coin-row="${esc(coin.code)}">
                  <td class="ck-col-star is-left">
                    <button
                      type="button"
                      class="ck-star-btn ${starred ? "is-starred" : ""}"
                      data-star="${esc(coin.code)}"
                      aria-label="${starred ? "Remove from portfolio" : "Add to portfolio"}"
                      title="${starred ? "Remove from portfolio" : "Add to portfolio"}"
                    >${starred ? "★" : "☆"}</button>
                  </td>
                  <td class="ck-col-rank is-left">${coin.rank}</td>
                  <td class="ck-col-coin is-left">
                    <a href="/coins/${encodeURIComponent(coin.code)}" class="ck-coin-cell" data-link>
                      ${renderAvatar(coin)}
                      <span class="ck-coin-meta">
                        <span class="ck-coin-name">${esc(coin.name)}</span>
                        <span class="ck-coin-code">${esc(displayCode(coin.code))}</span>
                      </span>
                    </a>
                  </td>
                  <td class="ck-price-cell ${priceFlash.get(coin.code) === "up" ? "ck-flash-up" : priceFlash.get(coin.code) === "down" ? "ck-flash-down" : ""}">${esc(formatPrice(coin.rate, cur))}</td>
                  ${cols.h1 ? `<td>${formatDeltaHtml(coin.changes.h1)}</td>` : ""}
                  ${cols.h24 ? `<td>${formatDeltaHtml(coin.changes.h24)}</td>` : ""}
                  ${cols.d7 ? `<td>${formatDeltaHtml(coin.changes.d7)}</td>` : ""}
                  ${cols.d30 ? `<td>${formatDeltaHtml(coin.changes.d30)}</td>` : ""}
                  ${cols.volume ? `<td>${esc(formatWholeCurrency(coin.volume, cur))}</td>` : ""}
                  ${cols.liquidity ? `<td>${coin.liquidity > 0 ? esc(formatCompactCurrency(coin.liquidity, cur)) : `<span class="ck-muted">—</span>`}</td>` : ""}
                  ${
                    cols.cap
                      ? `<td>${
                          coin.cap > 0
                            ? esc(formatWholeCurrency(coin.cap, cur))
                            : coin.fdv > 0
                              ? `<span class="ck-muted" title="Circulating market cap unverified · FDV: ${esc(formatWholeCurrency(coin.fdv, cur))}">—</span>`
                              : `<span class="ck-muted" title="Circulating market cap unavailable">—</span>`
                        }</td>`
                      : ""
                  }
                  ${cols.fdv ? `<td>${coin.fdv > 0 ? esc(formatWholeCurrency(coin.fdv, cur)) : `<span class="ck-muted">—</span>`}</td>` : ""}
                  ${cols.mcapFdv ? `<td>${ratio !== null ? esc(Math.min(ratio, 99.99).toFixed(2)) : `<span class="ck-muted">—</span>`}</td>` : ""}
                  ${
                    cols.sparkline
                      ? `<td data-spark-cell="${esc(coin.code)}">${renderSparklineSvg(estimateSparklinePoints(coin), sparkUp)}</td>`
                      : ""
                  }
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    </div>

    <div class="ck-pagination">
      <span>Showing ${startIdx + 1} to ${Math.min(filtered.length, startIdx + pageCoins.length)} of ${filtered.length} coins</span>
      <div class="ck-page-controls">
        <label class="ck-muted" style="margin-right:8px">
          Rows
          <select id="select-per-page" class="ck-page-btn" style="margin-left:4px">
            ${[25, 50, 100]
              .map((n) => `<option value="${n}" ${n === perPage ? "selected" : ""}>${n}</option>`)
              .join("")}
          </select>
        </label>
        <button type="button" class="ck-page-btn" id="page-prev" ${state.page <= 1 ? "disabled" : ""}>‹</button>
        ${buildPageButtons(state.page, totalPages)}
        <button type="button" class="ck-page-btn" id="page-next" ${state.page >= totalPages ? "disabled" : ""}>›</button>
      </div>
    </div>
  `;

  return { pageCoins, totalPages, html };
}

function bindMarketsResultsEvents(container, totalPages) {
  if (!container) return;

  container.querySelectorAll("[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.getAttribute("data-sort");
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.sortKey = key;
        state.sortDir = key === "rank" ? "asc" : "desc";
      }
      refreshMarketsResultsInPlace();
    });
  });

  container.querySelectorAll("[data-star]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const code = btn.getAttribute("data-star");
      await toggleWatchlist(code);
    });
  });

  container.querySelector("#btn-reset-empty")?.addEventListener("click", () => {
    resetAllFilters({ includeCategory: true });
    renderMarketsPage();
  });

  const perPageSel = container.querySelector("#select-per-page");
  if (perPageSel) {
    perPageSel.addEventListener("change", async () => {
      const next = Number(perPageSel.value);
      state.preferences.perPage = next;
      state.page = 1;
      refreshMarketsResultsInPlace();
      await savePreferences({ perPage: next });
    });
  }

  container.querySelector("#page-prev")?.addEventListener("click", () => {
    if (state.page > 1) {
      state.page -= 1;
      refreshMarketsResultsInPlace();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });

  container.querySelector("#page-next")?.addEventListener("click", () => {
    if (state.page < totalPages) {
      state.page += 1;
      refreshMarketsResultsInPlace();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });

  container.querySelectorAll("[data-goto-page]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = Number(btn.getAttribute("data-goto-page"));
      if (target >= 1 && target <= totalPages && target !== state.page) {
        state.page = target;
        refreshMarketsResultsInPlace();
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    });
  });
}

function bindActiveFilterChips(host) {
  if (!host) return;
  host.querySelectorAll("[data-clear-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.getAttribute("data-clear-filter");
      clearFilterKey(key);
      state.page = 1;
      renderMarketsPage();
    });
  });
  host.querySelector("#btn-clear-all-chips")?.addEventListener("click", () => {
    resetAllFilters({ includeCategory: true });
    renderMarketsPage();
  });
}

function updateFilterButtonUi() {
  const btn = document.getElementById("btn-filter");
  if (!btn) return;
  const activeCount = countActivePanelFilters(state.filter);
  btn.classList.toggle("is-active", state.filterOpen || activeCount > 0);
  btn.setAttribute("aria-expanded", String(state.filterOpen));
  const badge = document.getElementById("filter-count-badge");
  if (badge) {
    badge.textContent = String(activeCount);
    badge.classList.toggle("ck-hidden", activeCount === 0);
  }
}

function refreshMarketsResultsInPlace() {
  const markets = state.markets;
  if (!markets) return;
  const totalCount = (markets.coins || []).length;
  const filtered = getFilteredSortedCoins();
  const resultsHost = document.getElementById("markets-results-host");
  if (resultsHost) {
    const { pageCoins, totalPages, html } = renderMarketsResultsHtml(filtered);
    resultsHost.innerHTML = html;
    bindMarketsResultsEvents(resultsHost, totalPages);
    if (!markets.meta?.isSample && state.preferences.columns.sparkline) {
      hydrateLiveSparklines(pageCoins);
    }
  }

  const chipsHost = document.getElementById("active-filters-host");
  if (chipsHost) {
    chipsHost.innerHTML = renderActiveFilterChipsHtml();
    bindActiveFilterChips(chipsHost);
  }

  const matchEl = document.getElementById("flt-match-count");
  if (matchEl) {
    matchEl.innerHTML = `Showing <strong>${filtered.length.toLocaleString()}</strong> of ${totalCount.toLocaleString()} coins`;
  }

  const resetBtn = document.getElementById("flt-reset-all");
  if (resetBtn) {
    const hasAny =
      getActiveFilterChips(state.filter, { activeCategory: state.activeCategory }).length > 0;
    resetBtn.disabled = !hasAny;
  }

  updateFilterButtonUi();
}

function rerenderFilterPanelInPlace({ focusSelector = null } = {}) {
  const host = document.getElementById("filter-panel-host");
  if (!host || !state.markets) return;
  const totalCount = (state.markets.coins || []).length;
  const filtered = getFilteredSortedCoins();
  host.innerHTML = renderFilterPanelHtml(state.markets, filtered.length, totalCount);
  bindFilterPanelEvents(host);
  if (focusSelector) {
    const el = host.querySelector(focusSelector);
    if (el) el.focus();
  }
}

function bindFilterPanelEvents(host) {
  if (!host) return;

  host.querySelector("#flt-chain")?.addEventListener("change", (e) => {
    state.filter.chain = e.target.value || "All";
    state.page = 1;
    refreshMarketsResultsInPlace();
  });

  host.querySelector("#flt-category")?.addEventListener("change", (e) => {
    state.activeCategory = e.target.value || "All";
    state.page = 1;
    renderMarketsPage();
  });

  const queryInput = host.querySelector("#flt-query");
  const queryClear = host.querySelector("#flt-query-clear");
  if (queryInput) {
    queryInput.addEventListener("input", (e) => {
      state.filter.query = e.target.value;
      state.page = 1;
      if (queryClear) queryClear.classList.toggle("ck-hidden", !state.filter.query);
      refreshMarketsResultsInPlace();
    });
  }
  if (queryClear) {
    queryClear.addEventListener("click", () => {
      state.filter.query = "";
      state.page = 1;
      if (queryInput) {
        queryInput.value = "";
        queryInput.focus();
      }
      queryClear.classList.add("ck-hidden");
      refreshMarketsResultsInPlace();
    });
  }

  host.querySelectorAll("[data-flt-tf]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.filter.changeTimeframe = btn.getAttribute("data-flt-tf");
      state.page = 1;
      rerenderFilterPanelInPlace();
      refreshMarketsResultsInPlace();
    });
  });

  host.querySelectorAll("[data-flt-group]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const groupKey = btn.getAttribute("data-flt-group");
      const presetId = btn.getAttribute("data-flt-preset");
      const cfg = FILTER_ROW_CONFIGS.find((r) => r.key === groupKey);
      if (!cfg) return;
      state.filter[cfg.presetField] = presetId;
      if (presetId !== "custom") {
        state.filter[cfg.minField] = "";
        state.filter[cfg.maxField] = "";
      }
      state.page = 1;
      rerenderFilterPanelInPlace({
        focusSelector: presetId === "custom" ? `[data-flt-custom="${groupKey}:min"]` : null,
      });
      refreshMarketsResultsInPlace();
    });
  });

  host.querySelectorAll("[data-flt-custom]").forEach((inp) => {
    inp.addEventListener("input", (e) => {
      const [groupKey, bound] = inp.getAttribute("data-flt-custom").split(":");
      const cfg = FILTER_ROW_CONFIGS.find((r) => r.key === groupKey);
      if (!cfg) return;
      const field = bound === "max" ? cfg.maxField : cfg.minField;
      state.filter[field] = e.target.value;
      state.page = 1;
      refreshMarketsResultsInPlace();
    });
  });

  host.querySelector("#flt-reset-all")?.addEventListener("click", () => {
    resetAllFilters({ includeCategory: true });
    renderMarketsPage();
  });

  host.querySelector("#flt-done")?.addEventListener("click", () => {
    state.filterOpen = false;
    rerenderFilterPanelInPlace();
    updateFilterButtonUi();
  });
}

function estimateSparklinePoints(coin) {
  if (Array.isArray(coin.sparkline) && coin.sparkline.length >= 2) {
    return coin.sparkline;
  }
  const end = Number(coin.rate) || 1;
  const d7 = Number.isFinite(coin.changes?.d7)
    ? coin.changes.d7
    : Number.isFinite(coin.changes?.h24)
      ? coin.changes.h24
      : 0;
  const start = end / (1 + d7 / 100 || 1);
  let seed = 0;
  const code = String(coin.code || "X");
  for (let i = 0; i < code.length; i += 1) {
    seed = (seed * 31 + code.charCodeAt(i)) >>> 0;
  }
  const pts = [];
  const count = 16;
  const amp = Math.min(0.06, Math.max(0.008, Math.abs(d7) / 250 + 0.01));
  for (let i = 0; i < count; i += 1) {
    const t = i / (count - 1);
    const wave =
      i === 0 || i === count - 1
        ? 0
        : Math.sin((seed % 17) + t * Math.PI * 3.2) * amp +
          Math.cos((seed % 11) + t * Math.PI * 6.1) * (amp * 0.45);
    pts.push((start + (end - start) * t) * (1 + wave));
  }
  return pts;
}

function renderMarketsPage({ skipBackgroundFetch = false } = {}) {
  const main = document.getElementById("main-content");
  const cur = state.preferences.currency;
  const ov = state.overview?.overview;
  const markets = state.markets;

  if (!markets) {
    main.innerHTML = `<div class="ck-card" style="padding:36px">
      <div class="ck-skeleton-line" style="width:280px;height:26px;margin-bottom:14px"></div>
      <div class="ck-skeleton-line" style="width:100%;height:14px;margin-bottom:24px"></div>
      <div class="ck-skeleton-line" style="width:100%;height:320px"></div>
    </div>`;
    return;
  }

  const showHighlights = state.preferences.showHighlights;
  const trending = markets.trending || [];
  const gainers = markets.gainers || [];
  const hotCategories = Array.isArray(markets.hotCategories) ? markets.hotCategories : [];
  const hotCategoryDetails = Array.isArray(markets.hotCategoryDetails)
    ? markets.hotCategoryDetails
    : [];
  const hotDetailMap = new Map(hotCategoryDetails.map((d) => [d.name, d]));
  const hotSet = new Set(hotCategories);
  const activeHotDetail = hotDetailMap.get(state.activeCategory) || null;

  // Build category bar: All, Watchlist, Categories link,
  // 3 dynamic 🔥 hot categories, plus top remaining sectors by market cap.
  const otherCats = (markets.categories || [])
    .filter((cat) => !hotSet.has(cat))
    .slice(0, 4);
  const dynamicCats = [...hotCategories, ...otherCats];
  if (
    state.activeCategory !== "All" &&
    state.activeCategory !== "Watchlist" &&
    !dynamicCats.includes(state.activeCategory)
  ) {
    dynamicCats.push(state.activeCategory);
  }
  const tabList = ["All", "Watchlist", ...dynamicCats];

  const filtered = getFilteredSortedCoins();
  const totalCount = (markets.coins || []).length;
  const cols = state.preferences.columns;
  const activePanelFilterCount = countActivePanelFilters(state.filter);
  const { pageCoins, totalPages, html: resultsHtml } = renderMarketsResultsHtml(filtered);

  const capText = ov ? formatCompactCurrency(ov.cap, cur) : "—";
  const capDelta = ov ? formatDeltaHtml(ov.capChange24h) : "";

  main.innerHTML = `
    <section class="ck-page-header">
      <div>
        <h1 class="ck-h1">Cryptocurrency Prices by Market Cap</h1>
        <p class="ck-subtitle">
          The global cryptocurrency market cap today is <strong>${esc(capText)}</strong>, a ${capDelta} change in the last 24 hours.
        </p>
      </div>
      <label class="ck-highlights-toggle">
        <span>Highlights</span>
        <button
          type="button"
          id="toggle-highlights"
          class="ck-switch ${showHighlights ? "is-on" : ""}"
          role="switch"
          aria-checked="${showHighlights}"
          aria-label="Toggle Highlights cards"
        >
          <span class="ck-switch-thumb">${showHighlights ? "✓" : ""}</span>
        </button>
      </label>
    </section>

    ${
      showHighlights
        ? `
      <section class="ck-highlights-grid" aria-label="Market highlights">
        <div class="ck-card">
          <div class="ck-kpi-pair">
            <div>
              <div class="ck-kpi-row">
                <span class="ck-kpi-val">${esc(ov ? formatCompactCurrency(ov.cap, cur) : "—")}</span>
                ${ov ? formatDeltaHtml(ov.capChange24h) : ""}
              </div>
              <div class="ck-kpi-label">Market Cap</div>
            </div>
            <div>
              <div class="ck-kpi-row">
                <span class="ck-kpi-val">${esc(ov ? formatCompactCurrency(ov.volume, cur) : "—")}</span>
                ${ov && typeof ov.volumeChange24h === "number" ? formatDeltaHtml(ov.volumeChange24h) : ""}
              </div>
              <div class="ck-kpi-label">24h Trading Volume</div>
            </div>
          </div>
          <div id="overview-chart-mount" class="ck-overview-chart"></div>
        </div>

        <div class="ck-card">
          <div class="ck-card-head">
            <h2 class="ck-card-title">🔥 Trending</h2>
            <span class="ck-card-link">24h Activity</span>
          </div>
          <div class="ck-mini-list">
            ${trending
              .map(
                (c) => `
              <a href="/coins/${encodeURIComponent(c.code)}" class="ck-mini-row" data-link>
                <span class="ck-mini-left">
                  ${renderAvatar(c)}
                  <span class="ck-mini-name">${esc(c.name)}</span>
                </span>
                <span class="ck-mini-right">
                  <span>${esc(formatPrice(c.rate, cur))}</span>
                  ${formatDeltaHtml(c.change24h)}
                </span>
              </a>
            `,
              )
              .join("")}
          </div>
        </div>

        <div class="ck-card">
          <div class="ck-card-head">
            <h2 class="ck-card-title">🚀 Top Gainers</h2>
            <span class="ck-card-link">24h Change</span>
          </div>
          <div class="ck-mini-list">
            ${gainers
              .map(
                (c) => `
              <a href="/coins/${encodeURIComponent(c.code)}" class="ck-mini-row" data-link>
                <span class="ck-mini-left">
                  ${renderAvatar(c)}
                  <span class="ck-mini-name">${esc(c.name)}</span>
                </span>
                <span class="ck-mini-right">
                  <span>${esc(formatPrice(c.rate, cur))}</span>
                  ${formatDeltaHtml(c.change24h)}
                </span>
              </a>
            `,
              )
              .join("")}
          </div>
        </div>
      </section>
    `
        : ""
    }

    <section class="ck-filter-bar">
      <div class="ck-tabs-scroll" role="tablist" aria-label="Coin categories">
        ${tabList
          .map((tab) => {
            const active = state.activeCategory === tab;
            const hotDetail = hotDetailMap.get(tab);
            const icon =
              tab === "All"
                ? `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.2"/><rect x="9" y="1.5" width="5.5" height="5.5" rx="1.2"/><rect x="1.5" y="9" width="5.5" height="5.5" rx="1.2"/><rect x="9" y="9" width="5.5" height="5.5" rx="1.2"/></svg>`
                : tab === "Watchlist"
                  ? `<span class="ck-star-gold">★</span>`
                  : hotSet.has(tab)
                    ? `<span>🔥</span>`
                    : "";
            const titleAttr = hotDetail
              ? ` title="${esc(`${hotDetail.name} — ${hotDetail.signal} (${hotDetail.score}/100): ${hotDetail.reason}`)}"`
              : "";
            const pillHtml = `<button type="button" class="ck-tab-pill ${active ? "is-active" : ""}" data-cat="${esc(tab)}" role="tab" aria-selected="${active}"${titleAttr}>${icon}<span>${esc(tab)}</span></button>`;
            if (tab === "Watchlist") {
              return `${pillHtml}<a href="/categories" class="ck-tab-pill" data-link><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="4.5" cy="11.5" r="2.5"/><rect x="9" y="9" width="5" height="5" rx="1"/><path d="M8 2 11 7H5L8 2Z"/></svg><span>Categories</span></a>`;
            }
            return pillHtml;
          })
          .join("")}
      </div>

      <div class="ck-filter-actions">
        <div class="ck-popover-anchor">
          <button type="button" id="btn-customize" class="ck-toolbar-btn">
            <span>✦</span><span>Customize</span>
          </button>
          <div id="customize-popover" class="ck-popover ck-hidden" role="dialog" aria-label="Customize columns"></div>
        </div>
        <button
          type="button"
          id="btn-filter"
          class="ck-toolbar-btn ck-filter-toggle-btn ${state.filterOpen || activePanelFilterCount > 0 ? "is-active" : ""}"
          aria-expanded="${state.filterOpen}"
          aria-controls="filter-panel"
        >
          <svg class="ck-flt-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M2 3.5h12l-4.5 5.2v3.6l-3 1.4V8.7L2 3.5Z" />
          </svg>
          <span>Filter</span>
          <span id="filter-count-badge" class="ck-flt-btn-badge ${activePanelFilterCount > 0 ? "" : "ck-hidden"}">${activePanelFilterCount}</span>
          <svg class="ck-flt-btn-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m4 6 4 4 4-4" />
          </svg>
        </button>
      </div>
    </section>

    <div id="filter-panel-host">${renderFilterPanelHtml(markets, filtered.length, totalCount)}</div>
    <div id="active-filters-host">${renderActiveFilterChipsHtml()}</div>

    ${
      activeHotDetail
        ? `
      <section class="ck-hot-banner" aria-label="Hot category reasoning">
        <div class="ck-hot-banner-head">
          <div class="ck-hot-banner-title">
            <span>🔥</span>
            <strong>${esc(activeHotDetail.name)}</strong>
            <span class="ck-hot-signal-pill">${esc(activeHotDetail.signal || "Hot sector")}</span>
          </div>
          <span class="ck-hot-score-pill" title="Weighted across 7d & 24h momentum, market outperformance, breadth, and liquidity">Conviction ${esc(activeHotDetail.score)}/100</span>
        </div>
        <p class="ck-hot-reason">${esc(activeHotDetail.reason)}</p>
        <div class="ck-hot-metrics">
          <div class="ck-hot-metric">
            <span class="ck-hot-metric-label">7d Cap-Wt</span>
            ${formatDeltaHtml(activeHotDetail.metrics?.capWeighted7d)}
          </div>
          <div class="ck-hot-metric">
            <span class="ck-hot-metric-label">24h Cap-Wt</span>
            ${formatDeltaHtml(activeHotDetail.metrics?.capWeighted24h)}
          </div>
          <div class="ck-hot-metric">
            <span class="ck-hot-metric-label">vs Market (7d)</span>
            ${formatDeltaHtml(activeHotDetail.metrics?.alpha7d)}
          </div>
          <div class="ck-hot-metric">
            <span class="ck-hot-metric-label">Breadth</span>
            <strong>${esc(activeHotDetail.metrics?.advancing24h ?? 0)}/${esc(activeHotDetail.metrics?.activeCoins ?? 0)} up</strong>
          </div>
          <div class="ck-hot-metric">
            <span class="ck-hot-metric-label">24h Volume</span>
            <strong>${esc(formatCompactCurrency(activeHotDetail.metrics?.totalVolume || 0, cur))}</strong>
          </div>
          ${
            activeHotDetail.leaders?.length
              ? `
            <div class="ck-hot-leaders">
              <span class="ck-hot-metric-label">Drivers</span>
              ${activeHotDetail.leaders
                .map(
                  (ldr) => `
                <a href="/coins/${encodeURIComponent(ldr.code)}" class="ck-hot-leader-chip" data-link>
                  <span>${esc(displayCode(ldr.code))}</span>
                  ${formatDeltaHtml(ldr.change24h)}
                </a>
              `,
                )
                .join("")}
            </div>
          `
              : ""
          }
        </div>
      </section>
    `
        : ""
    }

    <div id="markets-results-host">${resultsHtml}</div>
  `;

  // Render overview highlight chart
  if (showHighlights && ov?.history) {
    const mount = document.getElementById("overview-chart-mount");
    if (mount) {
      renderOverviewChart(mount, ov.history, {
        formatCompact: (v) => formatCompactCurrency(v, cur),
        isUp: (ov.capChange24h ?? 0) >= 0,
      });
    }
  }

  // Bind homepage events
  const hlBtn = document.getElementById("toggle-highlights");
  if (hlBtn) {
    hlBtn.addEventListener("click", async () => {
      const nextVal = !state.preferences.showHighlights;
      state.preferences.showHighlights = nextVal;
      renderMarketsPage();
      await savePreferences({ showHighlights: nextVal });
    });
  }

  main.querySelectorAll("[data-cat]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeCategory = btn.getAttribute("data-cat");
      state.page = 1;
      renderMarketsPage();
    });
  });

  const btnCustomize = document.getElementById("btn-customize");
  if (btnCustomize) {
    btnCustomize.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleCustomizePopover();
    });
  }

  const btnFilter = document.getElementById("btn-filter");
  if (btnFilter) {
    btnFilter.addEventListener("click", () => {
      closePopovers();
      state.filterOpen = !state.filterOpen;
      rerenderFilterPanelInPlace();
      updateFilterButtonUi();
    });
  }

  bindFilterPanelEvents(document.getElementById("filter-panel-host"));
  bindActiveFilterChips(document.getElementById("active-filters-host"));
  bindMarketsResultsEvents(document.getElementById("markets-results-host"), totalPages);

  // Lazily hydrate real 7d sparklines and pre-warm top-10 24h charts when LCW is live
  if (!skipBackgroundFetch && !markets.meta?.isSample) {
    if (cols.sparkline) {
      hydrateLiveSparklines(pageCoins);
    }
    prewarmTopCoinCharts(markets.coins || []);
  }
}

async function hydrateLiveSparklines(pageCoins) {
  const estimated = pageCoins.filter((c) => c.sparklineEstimated).slice(0, 12);
  if (!estimated.length) return;
  if (sparklineAbortController) sparklineAbortController.abort();
  sparklineAbortController = new AbortController();
  const { signal } = sparklineAbortController;
  const codes = estimated.map((c) => c.code);
  try {
    const res = await apiJson(
      `/api/sparklines?codes=${encodeURIComponent(codes.join(","))}&currency=USD`,
      { signal },
    );
    const map = res?.sparklines || {};
    for (const [code, entry] of Object.entries(map)) {
      if (!entry?.points?.length) continue;
      const coin = state.markets?.coins?.find((c) => c.code === code);
      if (coin) {
        coin.sparkline = entry.points;
        coin.sparklineEstimated = false;
      }
      const cell = document.querySelector(`[data-spark-cell="${CSS.escape(code)}"]`);
      if (cell) {
        const isUp = entry.points[entry.points.length - 1] >= entry.points[0];
        cell.innerHTML = renderSparklineSvg(entry.points, isUp);
      }
    }
  } catch {
    // Keep estimated curves cleanly on failure or abort.
  }
}

function prefetchCoinHistory(code, range = "24h", { signal, forceRefresh = false } = {}) {
  const cleanCode = String(code || "").toUpperCase();
  if (!cleanCode) return null;
  const key = `${cleanCode}:USD:${range}`;
  const existing = !forceRefresh ? prefetchedHistory.get(key) : null;
  if (existing && Date.now() - existing.ts < 5 * 60_000) {
    return existing;
  }

  const entry = { ts: Date.now(), promise: null, history: null };
  entry.promise = apiJson(
    `/api/coins/${encodeURIComponent(cleanCode)}/history?currency=USD&range=${encodeURIComponent(range)}${forceRefresh ? "&refresh=1" : ""}`,
    signal ? { signal } : {},
  )
    .then((res) => {
      const hist = Array.isArray(res?.history) ? res.history : [];
      entry.history = hist;
      return hist;
    })
    .catch(() => {
      // Remove failed/aborted entry so a real click can retry cleanly.
      if (prefetchedHistory.get(key) === entry) {
        prefetchedHistory.delete(key);
      }
      return null;
    });
  prefetchedHistory.set(key, entry);
  return entry;
}

function prewarmTopCoinCharts(coins) {
  if (!Array.isArray(coins) || !coins.length) return;
  if (document.visibilityState !== "visible") return;
  const lastWarmed = topChartsWarmedAt.get("USD") || 0;
  if (Date.now() - lastWarmed < 5 * 60_000) return;

  const top10 = coins.slice(0, 10).map((c) => c.code);
  topChartsWarmedAt.set("USD", Date.now());

  if (prewarmAbortController) prewarmAbortController.abort();
  const controller = new AbortController();
  prewarmAbortController = controller;

  setTimeout(async () => {
    if (controller.signal.aborted || document.visibilityState !== "visible") return;
    if (currentRoute().name !== "markets") return;
    let idx = 0;
    const workers = Array.from({ length: 2 }, async () => {
      while (idx < top10.length && !controller.signal.aborted) {
        const code = top10[idx++];
        if (document.visibilityState !== "visible") break;
        const entry = prefetchCoinHistory(code, "24h", { signal: controller.signal });
        if (entry?.promise) await entry.promise;
      }
    });
    await Promise.all(workers);
  }, 1200);
}

function prefetchCoinMeta(code) {
  const cleanCode = String(code || "").toUpperCase();
  if (!cleanCode || state.status?.previewGatewayMode) return;
  const existing = prefetchedCoins.get(cleanCode);
  if (existing && Date.now() - existing.ts < 120_000) return;

  // Skip if market row already has full contract/exchange metadata.
  const marketRow = state.markets?.coins?.find((c) => c.code === cleanCode);
  if (
    marketRow &&
    marketRow.exchangesCount &&
    marketRow.marketsCount &&
    (marketRow.contracts?.length > 0 || marketRow.chains?.length > 0)
  ) {
    return;
  }

  const entry = { cur: "USD", ts: Date.now(), promise: null, data: null };
  entry.promise = apiJson(
    `/api/coins/${encodeURIComponent(cleanCode)}?currency=USD&metaOnly=1`,
  )
    .then((data) => {
      entry.data = data;
      // Merge enriched metadata straight into in-memory markets/extra cache for instant clicks.
      if (data?.coin) {
        rememberCoin(data.coin);
      }
      return data;
    })
    .catch(() => null);
  prefetchedCoins.set(cleanCode, entry);
}

// ==================== Coin Detail Page ====================

async function renderCoinDetailPage(code, { forceRefresh = false } = {}) {
  // Cancel background homepage sparklines & top-10 prewarm so the clicked coin gets full priority.
  if (sparklineAbortController) {
    sparklineAbortController.abort();
    sparklineAbortController = null;
  }
  if (prewarmAbortController) {
    prewarmAbortController.abort();
    prewarmAbortController = null;
  }

  const main = document.getElementById("main-content");

  if (
    forceRefresh ||
    state.detail.fromSnapshot ||
    state.detail.code !== code ||
    !state.detail.data
  ) {
    const isSameCoin = state.detail.code === code && Boolean(state.detail.data);
    state.detail.fromSnapshot = false;
    const prefetched = prefetchedCoins.get(code);
    const histKey = `${code}:USD:24h`;
    const prefetchedHist = !forceRefresh ? prefetchedHistory.get(histKey) : null;
    const readyHist =
      prefetchedHist &&
      Date.now() - prefetchedHist.ts < 5 * 60_000 &&
      Array.isArray(prefetchedHist.history)
        ? prefetchedHist.history
        : null;

    const marketCoin = !isSameCoin ? findKnownCoin(code) : null;
    let initialCoin = prefetched?.data?.coin || marketCoin;
    if (initialCoin && readyHist?.length) {
      const rates = readyHist.map((h) => h.rate);
      initialCoin = {
        ...initialCoin,
        low24h: Math.min(...rates, initialCoin.rate),
        high24h: Math.max(...rates, initialCoin.rate),
      };
    }

    if (!isSameCoin) {
      const historyCache = new Map();
      if (readyHist) historyCache.set("24h", readyHist);
      state.detail = {
        code,
        data: initialCoin
          ? { currency: "USD", coin: initialCoin, history24h: readyHist || [] }
          : null,
        fromSnapshot: false,
        range: "24h",
        metric: "rate",
        tab: "overview",
        historyCache,
        loadingHistory: !readyHist,
      };

      if (initialCoin) {
        // Instant 0ms paint (including full 24h chart if already pre-warmed or prefetched!).
        paintCoinDetail();
      } else {
        main.innerHTML = `<div class="ck-card" style="padding:36px">
          <div class="ck-skeleton-line" style="width:200px;height:22px;margin-bottom:16px"></div>
          <div class="ck-skeleton-line" style="width:100%;height:360px"></div>
        </div>`;
      }
    }

    // Decouple fast metadata (/api/coins/:code?metaOnly=1) from 24h chart history
    // so Contract, Chains, Exchanges, and Markets show immediately without waiting for chart points.
    const metaPromise =
      !forceRefresh && prefetched?.promise
        ? prefetched.promise
        : apiJson(
            `/api/coins/${encodeURIComponent(code)}?currency=USD&metaOnly=1${forceRefresh ? "&refresh=1" : ""}`,
          );

    const historyPromise = readyHist
      ? Promise.resolve(readyHist)
      : !forceRefresh && prefetchedHist?.promise
        ? prefetchedHist.promise
        : (prefetchCoinHistory(code, "24h", { forceRefresh })?.promise || Promise.resolve([]));

    metaPromise
      .then((metaData) => {
        if (!metaData?.coin || currentRoute().code !== code) return;
        const prevHist = state.detail.historyCache.get("24h") || [];
        const rates = prevHist.map((h) => h.rate);
        const mergedCoin = {
          ...metaData.coin,
          ...(rates.length
            ? {
                low24h: Math.min(...rates, metaData.coin.rate),
                high24h: Math.max(...rates, metaData.coin.rate),
              }
            : {}),
        };
        state.detail.data = {
          ...metaData,
          coin: mergedCoin,
          history24h: prevHist,
        };
        // Cache enriched coin back onto state.markets / state.extraCoins so repeat visits & portfolio are instant.
        rememberCoin(metaData.coin);
        saveClientSnapshot();
        paintCoinDetail();
      })
      .catch((err) => {
        if (currentRoute().code !== code) return;
        if (!state.detail.data) {
          main.innerHTML = `
            <div class="ck-breadcrumb"><a href="/" data-link>Cryptocurrencies</a><span>›</span><span>${esc(code)}</span></div>
            <div class="ck-empty">
              <p><strong>Could not load ${esc(code)}</strong></p>
              <p>${esc(err.message)}</p>
              <a href="/" class="ck-btn" data-link>Back to Cryptocurrencies</a>
            </div>
          `;
        }
      });

    if (!readyHist) {
      const histArr = await historyPromise;
      if (currentRoute().code !== code) return;
      const history24h = Array.isArray(histArr) ? histArr : [];
      state.detail.loadingHistory = false;
      state.detail.historyCache.set("24h", history24h);
      if (state.detail.data?.coin) {
        const rates = history24h.map((h) => h.rate);
        if (rates.length) {
          state.detail.data.coin = {
            ...state.detail.data.coin,
            low24h: Math.min(...rates, state.detail.data.coin.rate),
            high24h: Math.max(...rates, state.detail.data.coin.rate),
          };
        }
        state.detail.data.history24h = history24h;
        saveClientSnapshot();
        paintCoinDetail();
      }
    }
    return;
  }

  paintCoinDetail();
}

function shortenAddress(addr) {
  const s = String(addr || "").trim();
  if (s.length <= 14) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function renderContractRow(contracts) {
  if (!Array.isArray(contracts) || contracts.length === 0) return "";
  const primary = contracts[0];
  const rest = contracts.slice(1);
  const pill = (c) => `
    <span class="ck-info-pill" style="padding:3px 8px;gap:6px">
      <span class="ck-muted" style="font-size:11px">${esc(c.chain)}</span>
      ${
        c.explorerUrl
          ? `<a href="${esc(c.explorerUrl)}" target="_blank" rel="noopener noreferrer" class="ck-num" title="${esc(c.address)}" style="font-weight:700">${esc(shortenAddress(c.address))} ↗</a>`
          : `<span class="ck-num" title="${esc(c.address)}" style="font-weight:700">${esc(shortenAddress(c.address))}</span>`
      }
      <button type="button" class="ck-link-btn" data-copy-addr="${esc(c.address)}" title="Copy contract address" style="color:var(--ck-text-muted);font-size:12px">⧉</button>
    </span>
  `;

  return `
    <div class="ck-info-row">
      <span class="ck-stat-row-label">Contract</span>
      <div class="ck-info-pills">
        ${pill(primary)}
        ${
          rest.length
            ? `<button type="button" class="ck-info-pill" id="btn-toggle-contracts">+${rest.length} more ▾</button>
               <div id="extra-contracts" class="ck-info-pills ck-hidden" style="width:100%;margin-top:4px">
                 ${rest.map(pill).join("")}
               </div>`
            : ""
        }
      </div>
    </div>
  `;
}

function renderChainsRow(chains) {
  if (!Array.isArray(chains) || chains.length === 0) return "";
  return `
    <div class="ck-info-row">
      <span class="ck-stat-row-label">Chains</span>
      <div class="ck-info-pills">
        ${chains
          .map((ch) =>
            ch.explorerUrl
              ? `<a href="${esc(ch.explorerUrl)}" target="_blank" rel="noopener noreferrer" class="ck-info-pill">${esc(ch.name)} ↗</a>`
              : `<span class="ck-info-pill">${esc(ch.name)}</span>`,
          )
          .join("")}
      </div>
    </div>
  `;
}

function paintCoinDetail() {
  const main = document.getElementById("main-content");
  const data = state.detail.data;
  if (!data?.coin) return;

  const coin = data.coin;
  const cur = state.preferences.currency;
  const starred = state.portfolio.watchlist.includes(coin.code);
  const holding = state.portfolio.holdings[coin.code];

  const low24 = coin.low24h ?? coin.rate;
  const high24 = coin.high24h ?? coin.rate;
  const rangePct =
    high24 > low24
      ? Math.max(4, Math.min(100, ((coin.rate - low24) / (high24 - low24)) * 100))
      : 50;

  const athDiff =
    coin.allTimeHigh && coin.rate > 0
      ? ((coin.rate - coin.allTimeHigh) / coin.allTimeHigh) * 100
      : null;

  const linkLabels = {
    website: "Website",
    whitepaper: "Whitepaper",
    twitter: "Twitter",
    reddit: "Reddit",
    discord: "Discord",
    telegram: "Telegram",
    github: "GitHub",
    medium: "Medium",
  };
  const linkEntries = Object.entries(coin.links || {});

  const history = state.detail.historyCache.get(state.detail.range) || [];

  main.innerHTML = `
    <nav class="ck-breadcrumb" aria-label="Breadcrumb">
      <a href="/" data-link>Cryptocurrencies</a>
      <span>›</span>
      <span>${esc(coin.name)} Price</span>
    </nav>

    <div class="ck-detail-grid">
      <!-- Coin Hero Block (top of left sidebar on desktop; top of page above chart on mobile) -->
      <section class="ck-detail-hero-block">
        <div class="ck-detail-title-row">
          ${renderAvatar(coin, "is-lg")}
          <h1 class="ck-detail-name">${esc(coin.name)}</h1>
          <span class="ck-detail-sub">${esc(displayCode(coin.code))} Price</span>
          ${coin.rank ? `<span class="ck-rank-pill">#${coin.rank}</span>` : ""}
        </div>

        <div class="ck-hero-price-row">
          <span class="ck-hero-price">${esc(formatPrice(coin.rate, cur))}</span>
          <span class="ck-hero-delta">${formatDeltaHtml(coin.changes.h24, "(24h)")}</span>
        </div>

        <div class="ck-range-block">
          <div class="ck-range-track">
            <div class="ck-range-fill" style="width:${rangePct.toFixed(1)}%"></div>
          </div>
          <div class="ck-range-labels">
            <span>${esc(formatPrice(low24, cur))}</span>
            <span class="ck-muted">24h Range</span>
            <span>${esc(formatPrice(high24, cur))}</span>
          </div>
        </div>

        <div class="ck-portfolio-cta-row">
          <button
            type="button"
            id="detail-star-btn"
            class="ck-btn-bevel ${starred ? "is-starred" : ""}"
          >
            <span>${starred ? "★" : "☆"}</span>
            <span>${starred ? "In Portfolio" : "Add to Portfolio"}</span>
          </button>
          <button
            type="button"
            id="detail-holding-btn"
            class="ck-btn-bevel"
            style="flex:0 0 auto;padding:0 12px"
            title="Track local holdings"
          >${holding ? `${holding.quantity} ${esc(coin.code)}` : "+ Holding"}</button>
        </div>
      </section>

      <!-- Coin Stats, Converter & Info Block (below hero in left sidebar on desktop; below chart on mobile) -->
      <aside class="ck-detail-meta-block">
        <div class="ck-detail-stats-sec">
          <div class="ck-stat-list">
            <div class="ck-stat-row">
              <span class="ck-stat-row-label">Market Cap</span>
              <span class="ck-stat-row-val">${coin.cap > 0 ? esc(formatCompactCurrency(coin.cap, cur)) : "—"}</span>
            </div>
            <div class="ck-stat-row">
              <span class="ck-stat-row-label">Fully Diluted Valuation</span>
              <span class="ck-stat-row-val">${coin.fdv > 0 ? esc(formatCompactCurrency(coin.fdv, cur)) : "—"}</span>
            </div>
            <div class="ck-stat-row">
              <span class="ck-stat-row-label">24 Hour Trading Vol</span>
              <span class="ck-stat-row-val">${esc(formatCompactCurrency(coin.volume, cur))}</span>
            </div>
            ${
              coin.liquidity
                ? `<div class="ck-stat-row">
                    <span class="ck-stat-row-label">Orderbook Liquidity (±2%)</span>
                    <span class="ck-stat-row-val">${esc(formatCompactCurrency(coin.liquidity, cur))}</span>
                  </div>`
                : ""
            }
            <div class="ck-stat-row">
              <span class="ck-stat-row-label">Circulating Supply</span>
              <span class="ck-stat-row-val">${esc(formatSupply(coin.circulatingSupply))}</span>
            </div>
            <div class="ck-stat-row">
              <span class="ck-stat-row-label">Total Supply</span>
              <span class="ck-stat-row-val">${esc(formatSupply(coin.totalSupply))}</span>
            </div>
            <div class="ck-stat-row">
              <span class="ck-stat-row-label">Max Supply</span>
              <span class="ck-stat-row-val">${esc(formatSupply(coin.maxSupply))}</span>
            </div>
            ${
              coin.exchangesCount
                ? `<div class="ck-stat-row">
                    <span class="ck-stat-row-label">Listed Exchanges</span>
                    <span class="ck-stat-row-val"><a href="/exchanges" data-link style="color:var(--ck-up)">${coin.exchangesCount.toLocaleString()}</a></span>
                  </div>`
                : ""
            }
            ${
              coin.marketsCount
                ? `<div class="ck-stat-row">
                    <span class="ck-stat-row-label">Active Markets</span>
                    <span class="ck-stat-row-val">${coin.marketsCount.toLocaleString()}</span>
                  </div>`
                : ""
            }
            ${
              coin.pairsCount
                ? `<div class="ck-stat-row">
                    <span class="ck-stat-row-label">Trading Pairs</span>
                    <span class="ck-stat-row-val">${coin.pairsCount.toLocaleString()}</span>
                  </div>`
                : ""
            }
          </div>
        </div>

        <div class="ck-detail-converter-sec">
          <h2 class="ck-section-label">${esc(displayCode(coin.code))} Converter</h2>
          <div class="ck-converter-box">
            <div class="ck-converter-row">
              <input
                type="number"
                id="conv-coin"
                class="ck-converter-input"
                value="1"
                step="any"
                aria-label="${esc(displayCode(coin.code))} amount"
              />
              <span class="ck-converter-unit">${esc(displayCode(coin.code))}</span>
            </div>
            <div class="ck-converter-row">
              <input
                type="number"
                id="conv-fiat"
                class="ck-converter-input"
                value="${Number(((coin.rate || 0) * getFxRate(cur)).toFixed((coin.rate || 0) * getFxRate(cur) >= 1 ? 2 : 6))}"
                step="any"
                aria-label="${esc(cur)} amount"
              />
              <span class="ck-converter-unit">${esc(cur)}</span>
            </div>
          </div>
        </div>

        <div class="ck-detail-info-sec">
          <h2 class="ck-section-label">Info</h2>
          <div>
            ${renderContractRow(coin.contracts)}
            ${renderChainsRow(coin.chains)}
            ${
              linkEntries.length
                ? `<div class="ck-info-row">
                    <span class="ck-stat-row-label">Links</span>
                    <div class="ck-info-pills">
                      ${linkEntries
                        .map(
                          ([k, url]) =>
                            `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" class="ck-info-pill">${esc(linkLabels[k] || k)} ↗</a>`,
                        )
                        .join("")}
                    </div>
                  </div>`
                : ""
            }
            <div class="ck-info-row">
              <span class="ck-stat-row-label">API Code</span>
              <div class="ck-info-pills">
                <button type="button" class="ck-info-pill" id="btn-copy-code">${esc(coin.code)} ⧉</button>
              </div>
            </div>
            ${
              coin.categories?.length
                ? `<div class="ck-info-row">
                    <span class="ck-stat-row-label">Categories</span>
                    <div class="ck-info-pills">
                      ${coin.categories
                        .map(
                          (cat) =>
                            `<button type="button" class="ck-info-pill" data-jump-cat="${esc(cat)}">${esc(cat)}</button>`,
                        )
                        .join("")}
                    </div>
                  </div>`
                : ""
            }
          </div>
        </div>

        <div class="ck-detail-hist-sec">
          <h2 class="ck-section-label">${esc(displayCode(coin.code))} Historical Price</h2>
          <div class="ck-stat-list">
            <div class="ck-stat-row">
              <span class="ck-stat-row-label">24h Range</span>
              <span class="ck-stat-row-val">${esc(formatPrice(low24, cur))} – ${esc(formatPrice(high24, cur))}</span>
            </div>
            ${
              coin.allTimeHigh
                ? `<div class="ck-stat-row">
                    <span class="ck-stat-row-label">All-Time High</span>
                    <span class="ck-stat-row-val">
                      ${esc(formatPrice(coin.allTimeHigh, cur))}
                      ${athDiff !== null ? formatDeltaHtml(athDiff) : ""}
                    </span>
                  </div>`
                : ""
            }
          </div>
        </div>
      </aside>

      <!-- Right Chart & Tabs Column -->
      <section class="ck-detail-main">
        <div class="ck-underline-tabs" role="tablist">
          ${[
            ["overview", "Overview"],
            ["markets", "Markets"],
            ["historical", "Historical Data"],
            ["about", "About"],
          ]
            .map(
              ([id, label]) =>
                `<button type="button" class="ck-underline-tab ${state.detail.tab === id ? "is-active" : ""}" data-detail-tab="${id}">${label}</button>`,
            )
            .join("")}
        </div>

        ${
          state.detail.tab === "overview"
            ? `
          <div class="ck-chart-toolbar">
            <div class="ck-segmented" role="group" aria-label="Chart metric">
              <button type="button" class="ck-seg-btn ${state.detail.metric === "rate" ? "is-active" : ""}" data-metric="rate">Price</button>
              <button type="button" class="ck-seg-btn ${state.detail.metric === "cap" ? "is-active" : ""}" data-metric="cap">Market Cap</button>
            </div>
            <div class="ck-segmented" role="group" aria-label="Timeframe">
              ${[
                ["24h", "24H"],
                ["7d", "7D"],
                ["1m", "1M"],
                ["3m", "3M"],
                ["1y", "1Y"],
                ["max", "Max"],
              ]
                .map(
                  ([r, label]) =>
                    `<button type="button" class="ck-seg-btn ${state.detail.range === r ? "is-active" : ""}" data-range="${r}">${label}</button>`,
                )
                .join("")}
            </div>
          </div>

          <div id="detail-chart-mount" class="ck-detail-chart-wrap">
            ${
              state.detail.loadingHistory
                ? `<div class="ck-chart-loading" role="status" aria-live="polite"><span class="ck-spinner" aria-hidden="true"></span><span>Loading chart…</span></div>`
                : ""
            }
          </div>

          <table class="ck-perf-table" aria-label="Price performance">
            <thead>
              <tr>
                <th>1h</th>
                <th>24h</th>
                <th>7d</th>
                <th>30d</th>
                <th>90d</th>
                <th>1y</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>${formatDeltaHtml(coin.changes.h1)}</td>
                <td>${formatDeltaHtml(coin.changes.h24)}</td>
                <td>${formatDeltaHtml(coin.changes.d7)}</td>
                <td>${formatDeltaHtml(coin.changes.d30)}</td>
                <td>${formatDeltaHtml(coin.changes.d90)}</td>
                <td>${formatDeltaHtml(coin.changes.y1)}</td>
              </tr>
            </tbody>
          </table>

          <div class="ck-about-card">
            <h3>About ${esc(coin.name)} (${esc(coin.code)})</h3>
            <p style="margin:0">${esc(coin.about)}</p>
          </div>
        `
            : state.detail.tab === "markets"
              ? renderCoinMarketsTab(coin, cur)
              : state.detail.tab === "historical"
                ? renderHistoricalTab(history, cur)
                : `
          <div class="ck-about-card">
            <h3>About ${esc(coin.name)} (${esc(coin.code)})</h3>
            <p>${esc(coin.about)}</p>
            <p class="ck-muted" style="margin-bottom:0">Market prices, volumes, supply figures, and historical time series are sourced from Live Coin Watch.</p>
          </div>
        `
        }
      </section>
    </div>
  `;

  // Render interactive chart if on overview tab
  if (state.detail.tab === "overview" && !state.detail.loadingHistory) {
    const mount = document.getElementById("detail-chart-mount");
    if (mount) {
      renderDetailChart(mount, history, {
        metric: state.detail.metric,
        range: state.detail.range,
        formatAxis: (v) =>
          state.detail.metric === "cap"
            ? formatCompactCurrency(v, cur)
            : v * getFxRate(cur) >= 1000
              ? formatCompactCurrency(v, cur)
              : formatPrice(v, cur),
        formatTooltipValue: (v) =>
          state.detail.metric === "cap"
            ? formatWholeCurrency(v, cur)
            : formatPrice(v, cur),
        formatCompact: (v) => formatCompactCurrency(v, cur),
      });
    }
  }

  // Bind sticky coin scroll header
  const stickyBar = document.getElementById("sticky-coin-bar");
  stickyBar.innerHTML = `
    <div class="ck-container ck-sticky-coin-inner">
      <div style="display:flex;align-items:center;gap:10px">
        ${renderAvatar(coin)}
        <strong>${esc(displayCode(coin.code))}</strong>
        <strong class="ck-num">${esc(formatPrice(coin.rate, cur))}</strong>
        ${formatDeltaHtml(coin.changes.h24, "(24h)")}
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <button type="button" class="ck-btn" id="sticky-star-btn" style="height:32px;padding:0 12px;font-size:12.5px">
          ${starred ? "★ Saved" : "☆ Add"}
        </button>
      </div>
    </div>
  `;
  const stickyStarBtn = document.getElementById("sticky-star-btn");
  if (stickyStarBtn) {
    stickyStarBtn.addEventListener("click", () => toggleWatchlist(coin.code));
  }

  if (stickyScrollHandler) window.removeEventListener("scroll", stickyScrollHandler);
  stickyScrollHandler = () => {
    stickyBar.classList.toggle("ck-hidden", window.scrollY < 260);
  };
  window.addEventListener("scroll", stickyScrollHandler, { passive: true });

  // Bind coin detail interactions
  document.getElementById("detail-star-btn")?.addEventListener("click", () => {
    toggleWatchlist(coin.code);
  });

  document.getElementById("detail-holding-btn")?.addEventListener("click", () => {
    openHoldingModal(coin);
  });

  document.getElementById("btn-copy-code")?.addEventListener("click", async (e) => {
    try {
      await navigator.clipboard.writeText(coin.code);
      e.currentTarget.textContent = `${coin.code} ✓`;
      setTimeout(() => {
        if (e.currentTarget) e.currentTarget.textContent = `${coin.code} ⧉`;
      }, 1500);
    } catch {
      // Ignore clipboard permission errors.
    }
  });

  main.querySelectorAll("[data-copy-addr]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const addr = btn.getAttribute("data-copy-addr");
      try {
        await navigator.clipboard.writeText(addr);
        btn.textContent = "✓";
        setTimeout(() => {
          btn.textContent = "⧉";
        }, 1500);
      } catch {
        // Ignore clipboard errors.
      }
      e.stopPropagation();
    });
  });

  document.getElementById("btn-toggle-contracts")?.addEventListener("click", (e) => {
    const extra = document.getElementById("extra-contracts");
    if (!extra) return;
    const opening = extra.classList.contains("ck-hidden");
    extra.classList.toggle("ck-hidden", !opening);
    const count = (coin.contracts?.length || 1) - 1;
    e.currentTarget.textContent = opening ? "Hide ▴" : `+${count} more ▾`;
  });

  main.querySelectorAll("[data-jump-cat]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeCategory = btn.getAttribute("data-jump-cat");
      navigate("/");
    });
  });

  // Live bidirectional converter (converts USD base rate using active display currency FX)
  const convCoin = document.getElementById("conv-coin");
  const convFiat = document.getElementById("conv-fiat");
  const displayRate = (coin.rate || 0) * getFxRate(cur);
  if (convCoin && convFiat && displayRate > 0) {
    convCoin.addEventListener("input", () => {
      const n = Number(convCoin.value);
      convFiat.value = Number.isFinite(n)
        ? Number((n * displayRate).toFixed(displayRate >= 1 ? 2 : 6))
        : "";
    });
    convFiat.addEventListener("input", () => {
      const n = Number(convFiat.value);
      convCoin.value = Number.isFinite(n)
        ? Number((n / displayRate).toFixed(6))
        : "";
    });
  }

  // Underline tabs
  main.querySelectorAll("[data-detail-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.detail.tab = btn.getAttribute("data-detail-tab");
      paintCoinDetail();
    });
  });

  // Chart metric toggle
  main.querySelectorAll("[data-metric]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.detail.metric = btn.getAttribute("data-metric");
      paintCoinDetail();
    });
  });

  // Chart timeframe toggle
  main.querySelectorAll("[data-range]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const nextRange = btn.getAttribute("data-range");
      if (state.detail.range === nextRange) return;
      state.detail.range = nextRange;
      if (!state.detail.historyCache.has(nextRange)) {
        state.detail.loadingHistory = true;
        paintCoinDetail();
        try {
          const res = await apiJson(
            `/api/coins/${encodeURIComponent(coin.code)}/history?currency=USD&range=${encodeURIComponent(nextRange)}`,
          );
          state.detail.historyCache.set(nextRange, res.history || []);
        } catch {
          state.detail.historyCache.set(nextRange, []);
        } finally {
          state.detail.loadingHistory = false;
        }
      }
      paintCoinDetail();
    });
  });
}

function renderCoinMarketsTab(coin, cur) {
  return `
    <div class="ck-summary-grid" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:16px">
      <div class="ck-card">
        <div class="ck-kpi-label">24h Trading Volume</div>
        <div class="ck-kpi-val" style="margin-top:4px">${esc(formatCompactCurrency(coin.volume, cur))}</div>
      </div>
      <div class="ck-card">
        <div class="ck-kpi-label">Orderbook Liquidity (±2%)</div>
        <div class="ck-kpi-val" style="margin-top:4px">${coin.liquidity ? esc(formatCompactCurrency(coin.liquidity, cur)) : "—"}</div>
      </div>
      <div class="ck-card">
        <div class="ck-kpi-label">Listed Venues</div>
        <div class="ck-kpi-val" style="margin-top:4px">
          ${coin.exchangesCount ? `${coin.exchangesCount.toLocaleString()} exchanges` : "—"}
        </div>
        <div class="ck-muted" style="font-size:12px;margin-top:2px">
          ${coin.marketsCount ? `${coin.marketsCount.toLocaleString()} markets` : ""}${coin.marketsCount && coin.pairsCount ? " · " : ""}${coin.pairsCount ? `${coin.pairsCount.toLocaleString()} pairs` : ""}
        </div>
      </div>
    </div>

    <div class="ck-about-card">
      <h3>${esc(coin.name)} (${esc(coin.code)}) Markets</h3>
      <p style="margin:0 0 12px">
        Live Coin Watch's public API provides aggregate market counts (<strong>${coin.exchangesCount ? coin.exchangesCount.toLocaleString() : "—"}</strong> exchanges, <strong>${coin.marketsCount ? coin.marketsCount.toLocaleString() : "—"}</strong> active markets, <strong>${coin.pairsCount ? coin.pairsCount.toLocaleString() : "—"}</strong> pairs) and combined volume/liquidity, rather than individual per-exchange trading pair orderbooks (e.g. <code>Binance ${esc(coin.code)}/USDT</code>).
      </p>
      <a href="/exchanges" class="ck-btn" style="display:inline-flex;align-items:center" data-link>Browse All Exchanges →</a>
    </div>
  `;
}

function renderHistoricalTab(history, cur) {
  if (!history.length) {
    return `<div class="ck-empty">No historical points loaded for this timeframe.</div>`;
  }
  const rows = [...history].reverse().slice(0, 30);
  return `
    <div class="ck-table-wrap">
      <table class="ck-table">
        <thead>
          <tr>
            <th class="is-left">Timestamp</th>
            <th>Price</th>
            <th>24h Volume</th>
            <th>Market Cap</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (p) => `
            <tr>
              <td class="is-left">${esc(new Date(p.date).toLocaleString())}</td>
              <td class="ck-price-cell">${esc(formatPrice(p.rate, cur))}</td>
              <td>${esc(formatWholeCurrency(p.volume, cur))}</td>
              <td>${esc(formatWholeCurrency(p.cap, cur))}</td>
            </tr>
          `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

// ==================== Exchanges Page ====================

async function renderExchangesPage({ forceRefresh = false } = {}) {
  const main = document.getElementById("main-content");

  if (
    forceRefresh ||
    state.exchanges.fromSnapshot ||
    !state.exchanges.data
  ) {
    const hadData = Boolean(state.exchanges.data?.exchanges?.length);
    state.exchanges.fromSnapshot = false;
    if (hadData) {
      // Keep existing exchanges table on screen while fresh data fetches.
      paintExchangesPage();
    } else {
      main.innerHTML = `<div class="ck-card" style="padding:36px">
        <div class="ck-skeleton-line" style="width:280px;height:24px;margin-bottom:16px"></div>
        <div class="ck-skeleton-line" style="width:100%;height:340px"></div>
      </div>`;
    }
    try {
      state.exchanges.data = await apiJson(
        `/api/exchanges?currency=USD${forceRefresh ? "&refresh=1" : ""}`,
      );
      saveClientSnapshot();
    } catch (err) {
      if (!hadData) {
        main.innerHTML = `<div class="ck-empty">
          <p><strong>Unable to load exchanges</strong></p>
          <p>${esc(err.message)}</p>
          <a href="/" class="ck-btn" data-link>Back to Cryptocurrencies</a>
        </div>`;
        return;
      }
    }
  }

  paintExchangesPage();
}

function paintExchangesPage() {
  const main = document.getElementById("main-content");
  const cur = state.preferences.currency;
  const all = state.exchanges.data?.exchanges || [];

  let list = all;
  if (state.exchanges.filter === "CEX") {
    list = list.filter((e) => e.centralized);
  } else if (state.exchanges.filter === "DEX") {
    list = list.filter((e) => !e.centralized);
  } else if (state.exchanges.filter === "US") {
    list = list.filter((e) => e.usCompliant);
  }

  if (state.exchanges.query.trim()) {
    const q = state.exchanges.query.trim().toLowerCase();
    list = list.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.code.toLowerCase().includes(q),
    );
  }

  const key = state.exchanges.sortKey;
  const dir = state.exchanges.sortDir === "asc" ? 1 : -1;
  const getVal = (ex) => {
    switch (key) {
      case "rank":
        return ex.rank ?? 999999;
      case "depth":
        return ex.depth ?? 0;
      case "markets":
        return ex.markets ?? 0;
      case "visitors":
        return ex.visitors ?? 0;
      case "volPerVisitor":
        return ex.volumePerVisitor ?? 0;
      case "volume":
      default:
        return ex.volume ?? 0;
    }
  };
  const sorted = [...list].sort((a, b) => (getVal(a) - getVal(b)) * dir);

  const sortArrow = (k) => {
    if (state.exchanges.sortKey !== k) return "";
    return `<span class="ck-sort-arrow">${state.exchanges.sortDir === "asc" ? "▲" : "▼"}</span>`;
  };

  const totalVol = all.reduce((acc, e) => acc + (e.volume || 0), 0);
  const filterTabs = [
    ["All", `All (${all.length})`],
    ["CEX", "Centralized (CEX)"],
    ["DEX", "Decentralized (DEX)"],
    ["US", "US Compliant"],
  ];

  main.innerHTML = `
    <section class="ck-page-header">
      <div>
        <h1 class="ck-h1">Top Crypto Exchanges Ranked by 24h Volume</h1>
        <p class="ck-subtitle">
          Tracking <strong>${all.length.toLocaleString()}</strong> cryptocurrency exchanges with <strong>${esc(formatCompactCurrency(totalVol, cur))}</strong> combined 24h volume via Live Coin Watch.
        </p>
      </div>
    </section>

    <section class="ck-filter-bar">
      <div class="ck-tabs-scroll" role="tablist" aria-label="Exchange filters">
        ${filterTabs
          .map(
            ([id, label]) =>
              `<button type="button" class="ck-tab-pill ${state.exchanges.filter === id ? "is-active" : ""}" data-ex-filter="${id}">${esc(label)}</button>`,
          )
          .join("")}
      </div>
      <div class="ck-filter-actions">
        <input
          type="search"
          id="ex-search-input"
          class="ck-input"
          style="height:36px;width:210px;font-size:13px"
          placeholder="Filter exchanges..."
          value="${esc(state.exchanges.query)}"
          aria-label="Filter exchanges"
        />
      </div>
    </section>

    ${
      sorted.length === 0
        ? `<div class="ck-empty">
            <p><strong>No exchanges match your filter.</strong></p>
            <button type="button" class="ck-btn" id="ex-reset-btn">Reset filters</button>
          </div>`
        : `
      <div class="ck-table-wrap">
        <table class="ck-table">
          <thead>
            <tr>
              <th class="ck-col-ex-rank is-left is-sortable" data-ex-sort="rank">${sortArrow("rank")}#</th>
              <th class="ck-col-ex-name is-left">Exchange</th>
              <th class="is-sortable" data-ex-sort="volume">${sortArrow("volume")}24h Volume</th>
              <th class="is-sortable" data-ex-sort="depth">${sortArrow("depth")}±2% Depth</th>
              <th class="is-sortable" data-ex-sort="markets">${sortArrow("markets")}Markets</th>
              <th class="is-sortable" data-ex-sort="visitors">${sortArrow("visitors")}Daily Visitors</th>
              <th class="is-sortable" data-ex-sort="volPerVisitor">${sortArrow("volPerVisitor")}Vol / Visitor</th>
            </tr>
          </thead>
          <tbody>
            ${sorted
              .map(
                (ex) => `
              <tr>
                <td class="ck-col-ex-rank is-left">${ex.rank}</td>
                <td class="ck-col-ex-name is-left">
                  <div class="ck-coin-cell">
                    ${renderAvatar({ code: ex.name.slice(0, 2).toUpperCase(), color: ex.color, icon: ex.icon })}
                    <span class="ck-coin-meta">
                      ${
                        ex.website
                          ? `<a href="${esc(ex.website)}" target="_blank" rel="noopener noreferrer" class="ck-coin-name">${esc(ex.name)} <span class="ck-muted" style="font-size:11px">↗</span></a>`
                          : `<span class="ck-coin-name">${esc(ex.name)}</span>`
                      }
                      <span class="ck-rank-pill">${ex.centralized ? "CEX" : "DEX"}</span>
                    </span>
                  </div>
                </td>
                <td class="ck-price-cell">${esc(formatWholeCurrency(ex.volume, cur))}</td>
                <td>${ex.depth > 0 ? esc(formatCompactCurrency(ex.depth, cur)) : `<span class="ck-muted">—</span>`}</td>
                <td>${ex.markets ? ex.markets.toLocaleString() : `<span class="ck-muted">—</span>`}</td>
                <td>${ex.visitors ? ex.visitors.toLocaleString() : `<span class="ck-muted">—</span>`}</td>
                <td>${ex.volumePerVisitor > 0 ? esc(formatCompactCurrency(ex.volumePerVisitor, cur)) : `<span class="ck-muted">—</span>`}</td>
              </tr>
            `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `
    }
  `;

  main.querySelectorAll("[data-ex-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.exchanges.filter = btn.getAttribute("data-ex-filter");
      paintExchangesPage();
    });
  });

  main.querySelectorAll("[data-ex-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const k = th.getAttribute("data-ex-sort");
      if (state.exchanges.sortKey === k) {
        state.exchanges.sortDir = state.exchanges.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.exchanges.sortKey = k;
        state.exchanges.sortDir = k === "rank" ? "asc" : "desc";
      }
      paintExchangesPage();
    });
  });

  document.getElementById("ex-search-input")?.addEventListener("input", (e) => {
    state.exchanges.query = e.target.value;
    paintExchangesPage();
    const inp = document.getElementById("ex-search-input");
    if (inp) {
      inp.focus();
      inp.setSelectionRange(inp.value.length, inp.value.length);
    }
  });

  document.getElementById("ex-reset-btn")?.addEventListener("click", () => {
    state.exchanges.filter = "All";
    state.exchanges.query = "";
    paintExchangesPage();
  });
}

// ==================== Portfolio Page ====================

function setPortfolioSort(key, dir) {
  const next = normalizePortfolioSort(key, dir);
  if (
    state.preferences.portfolioSortKey === next.key &&
    state.preferences.portfolioSortDir === next.dir
  ) {
    return;
  }
  state.preferences.portfolioSortKey = next.key;
  state.preferences.portfolioSortDir = next.dir;
  saveClientSnapshot();
  savePreferences({
    portfolioSortKey: next.key,
    portfolioSortDir: next.dir,
  });
  renderPortfolioPage();
}

function renderPortfolioPage({ skipQuoteFetch = false } = {}) {
  const main = document.getElementById("main-content");
  const cur = state.preferences.currency;
  const coins = state.markets?.coins || [];
  const coinByCode = new Map(coins.map((c) => [c.code, c]));

  const trackedCodes = getTrackedPortfolioCodes();

  if (!skipQuoteFetch) {
    ensurePortfolioCoinQuotes({ forceRefresh: false });
  }

  const rows = trackedCodes.map((code) => {
    const coin = findKnownCoin(code, coinByCode) || {
      code,
      name: code,
      rank: null,
      rate: null,
      changes: {},
      color: "#64748b",
      sparkline: [],
    };
    const hasPrice =
      typeof coin.rate === "number" && Number.isFinite(coin.rate) && coin.rate > 0;
    const isLoadingPrice = !hasPrice && portfolioQuotesInFlight.has(code);
    const holding = state.portfolio.holdings[code] || null;
    const qty = holding?.quantity || 0;
    const value = hasPrice ? qty * coin.rate : null;
    const hasValidAvgCost =
      typeof holding?.avgCost === "number" &&
      Number.isFinite(holding.avgCost) &&
      holding.avgCost >= 0;
    const cost = qty > 0 && hasValidAvgCost ? qty * holding.avgCost : null;
    const pnl = hasPrice && cost !== null ? value - cost : null;
    const pnlPct = hasPrice && cost !== null && cost > 0 ? (pnl / cost) * 100 : null;

    return { coin, holding, qty, value, cost, pnl, pnlPct, hasPrice, isLoadingPrice };
  });

  const summary = summarizePortfolioRows(rows);
  const {
    totalValue,
    totalPnl,
    totalPnlPct,
    dayPct,
    holdingsCount,
    watchlistOnlyCount,
    holdingsWithCostBasisCount,
  } = summary;
  const pnlMeta = getPortfolioPnlMeta(summary);

  const sort = normalizePortfolioSort(
    state.preferences.portfolioSortKey,
    state.preferences.portfolioSortDir,
  );
  const filteredRows = filterPortfolioRows(rows, state.portfolioFilter);
  const sortedRows = sortPortfolioRows(filteredRows, sort.key, sort.dir);

  const isColActive = (col) =>
    col === "pnl" ? sort.key === "pnl" || sort.key === "pnlPct" : sort.key === col;
  const sortArrow = (col) => {
    if (!isColActive(col)) return "";
    return `<span class="ck-sort-arrow">${sort.dir === "asc" ? "▲" : "▼"}</span>`;
  };
  const ariaSort = (col) => {
    if (!isColActive(col)) return "none";
    return sort.dir === "asc" ? "ascending" : "descending";
  };

  const filterTabs = [
    ["all", `All (${rows.length})`],
    ["holdings", `Holdings (${holdingsCount})`],
    ["watchlist", `Watchlist (${watchlistOnlyCount})`],
  ];

  main.innerHTML = `
    <section class="ck-page-header">
      <div>
        <h1 class="ck-h1">My Portfolio &amp; Watchlist</h1>
        <p class="ck-subtitle">
          Stored privately on your own host in <code>DATA_DIR/portfolio.json</code> — survives container restarts with no account required.
        </p>
      </div>
    </section>

    <section class="ck-summary-grid">
      <div class="ck-card">
        <div class="ck-kpi-label">Total Portfolio Value</div>
        <div class="ck-kpi-val" style="margin-top:4px;font-size:22px">${esc(formatPrice(totalValue, cur))}</div>
      </div>
      <div class="ck-card">
        <div class="ck-kpi-label">Estimated 24h Change</div>
        <div class="ck-kpi-val" style="margin-top:4px;font-size:20px">
          ${dayPct !== null ? formatDeltaHtml(dayPct) : `<span class="ck-muted">—</span>`}
        </div>
      </div>
      <div class="ck-card">
        <div class="ck-kpi-label">${esc(pnlMeta.label)}</div>
        <div class="ck-kpi-val" style="margin-top:4px;font-size:20px">
          ${
            totalPnl !== null
              ? `<span class="${totalPnl >= 0 ? "ck-up" : "ck-down"}">${totalPnl > 0 ? "+" : ""}${esc(formatCompactCurrency(totalPnl, cur))}</span> ${totalPnlPct !== null ? formatDeltaHtml(totalPnlPct) : ""}`
              : holdingsWithCostBasisCount > 0
                ? `<span class="ck-muted">—</span>`
                : `<span class="ck-muted">Set avg cost</span>`
          }
        </div>
        ${pnlMeta.subtext ? `<div class="ck-kpi-sub">${esc(pnlMeta.subtext)}</div>` : ""}
      </div>
      <div class="ck-card">
        <div class="ck-kpi-label">Watched Coins</div>
        <div class="ck-kpi-val" style="margin-top:4px;font-size:22px">${trackedCodes.length}</div>
      </div>
    </section>

    ${
      rows.length === 0
        ? `<div class="ck-empty">
            <p><strong>Your portfolio &amp; watchlist is empty.</strong></p>
            <p>Click the <strong>☆</strong> icon next to any coin on the Cryptocurrencies page to start tracking it locally.</p>
            <a href="/" class="ck-btn ck-btn-primary" style="display:inline-flex;align-items:center" data-link>Explore Cryptocurrencies</a>
          </div>`
        : `
      <section class="ck-filter-bar ck-portfolio-toolbar">
        <div class="ck-tabs-scroll" role="tablist" aria-label="Portfolio filter">
          ${filterTabs
            .map(
              ([id, label]) =>
                `<button type="button" class="ck-tab-pill ${state.portfolioFilter === id ? "is-active" : ""}" data-port-filter="${id}" role="tab" aria-selected="${state.portfolioFilter === id ? "true" : "false"}">${esc(label)}</button>`,
            )
            .join("")}
        </div>
        <div class="ck-filter-actions ck-portfolio-sort-controls">
          <label class="ck-sort-label" for="portfolio-sort-select">Sort by</label>
          <select id="portfolio-sort-select" class="ck-sort-select" aria-label="Sort portfolio holdings">
            ${PORTFOLIO_SORT_OPTIONS.map(
              (opt) =>
                `<option value="${esc(opt.key)}" ${sort.key === opt.key ? "selected" : ""}>${esc(opt.label)}</option>`,
            ).join("")}
          </select>
          <button
            type="button"
            id="portfolio-sort-dir"
            class="ck-btn ck-sort-dir-btn"
            aria-label="Toggle sort direction (currently ${sort.dir === "asc" ? "ascending" : "descending"})"
            title="${sort.dir === "asc" ? "Ascending — click for descending" : "Descending — click for ascending"}"
          >
            <span aria-hidden="true">${sort.dir === "asc" ? "↑" : "↓"}</span>
            <span>${sort.dir === "asc" ? "Asc" : "Desc"}</span>
          </button>
        </div>
      </section>

      ${
        sortedRows.length === 0
          ? `<div class="ck-empty">
              <p><strong>${state.portfolioFilter === "holdings" ? "No holdings added yet." : "No watch-only coins."}</strong></p>
              <p>${state.portfolioFilter === "holdings" ? "Click <strong>+ Add Holding</strong> on any watched coin to track its quantity, value, and P&amp;L." : "All of your watched coins currently have recorded holdings."}</p>
              <button type="button" class="ck-btn" id="btn-port-show-all">Show all (${rows.length})</button>
            </div>`
          : `
      <div class="ck-table-wrap">
        <table class="ck-table">
          <thead>
            <tr>
              <th class="ck-col-star is-left"></th>
              <th class="ck-col-port-coin is-left is-sortable" data-port-sort="coin" aria-sort="${ariaSort("coin")}" tabindex="0">${sortArrow("coin")}Coin</th>
              <th class="is-sortable" data-port-sort="price" aria-sort="${ariaSort("price")}" tabindex="0">${sortArrow("price")}Price</th>
              <th class="is-sortable" data-port-sort="h24" aria-sort="${ariaSort("h24")}" tabindex="0">${sortArrow("h24")}24h</th>
              <th class="is-sortable" data-port-sort="holdings" aria-sort="${ariaSort("holdings")}" tabindex="0">${sortArrow("holdings")}Holdings</th>
              <th class="is-sortable" data-port-sort="value" aria-sort="${ariaSort("value")}" tabindex="0">${sortArrow("value")}Value</th>
              <th class="is-sortable" data-port-sort="pnl" aria-sort="${ariaSort("pnl")}" tabindex="0">${sortArrow("pnl")}${sort.key === "pnlPct" ? "P&amp;L (%)" : "P&amp;L"}</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${sortedRows
              .map(({ coin, qty, value, pnl, pnlPct, hasPrice, isLoadingPrice }) => {
                const allocPct =
                  hasPrice && totalValue > 0 && qty > 0 ? (value / totalValue) * 100 : null;
                return `
              <tr>
                <td class="ck-col-star is-left">
                  <button type="button" class="ck-star-btn is-starred" data-star="${esc(coin.code)}" title="Remove from watchlist">★</button>
                </td>
                <td class="ck-col-port-coin is-left">
                  <a href="/coins/${encodeURIComponent(coin.code)}" class="ck-coin-cell" data-link>
                    ${renderAvatar(coin)}
                    <span class="ck-coin-meta">
                      <span class="ck-coin-name">${esc(coin.name)}</span>
                      <span class="ck-coin-code">${esc(displayCode(coin.code))}</span>
                    </span>
                  </a>
                </td>
                <td class="ck-price-cell">${
                  hasPrice
                    ? esc(formatPrice(coin.rate, cur))
                    : isLoadingPrice
                      ? `<span class="ck-muted">Loading…</span>`
                      : `<span class="ck-muted">—</span>`
                }</td>
                <td>${formatDeltaHtml(coin.changes?.h24)}</td>
                <td>${qty > 0 ? `${qty} ${esc(displayCode(coin.code))}` : `<span class="ck-muted">Watch only</span>`}</td>
                <td class="ck-price-cell">
                  ${
                    qty > 0
                      ? hasPrice
                        ? `<div class="ck-cell-stack">
                            <span>${esc(formatPrice(value, cur))}</span>
                            ${allocPct !== null ? `<span class="ck-cell-sub">${allocPct.toFixed(1)}%</span>` : ""}
                          </div>`
                        : `<span class="ck-muted">—</span>`
                      : `<span class="ck-muted">—</span>`
                  }
                </td>
                <td>
                  ${
                    pnl !== null
                      ? `<div class="ck-cell-stack">
                          <span class="${pnl >= 0 ? "ck-up" : "ck-down"} ck-pnl-amount">${pnl > 0 ? "+" : ""}${esc(formatCompactCurrency(pnl, cur))}</span>
                          ${pnlPct !== null ? `<span class="ck-cell-sub">${formatDeltaHtml(pnlPct)}</span>` : ""}
                        </div>`
                      : `<span class="ck-muted">—</span>`
                  }
                </td>
                <td>
                  <button type="button" class="ck-btn" style="height:30px;padding:0 10px;font-size:12px" data-edit-holding="${esc(coin.code)}">
                    ${qty > 0 ? "Edit" : "+ Add Holding"}
                  </button>
                </td>
              </tr>
            `;
              })
              .join("")}
          </tbody>
        </table>
      </div>
          `
      }
    `
    }
  `;

  main.querySelectorAll("[data-port-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.portfolioFilter = btn.getAttribute("data-port-filter") || "all";
      renderPortfolioPage();
    });
  });

  document.getElementById("btn-port-show-all")?.addEventListener("click", () => {
    state.portfolioFilter = "all";
    renderPortfolioPage();
  });

  document.getElementById("portfolio-sort-select")?.addEventListener("change", (e) => {
    const nextKey = e.target.value;
    setPortfolioSort(nextKey, getDefaultPortfolioSortDir(nextKey));
  });

  document.getElementById("portfolio-sort-dir")?.addEventListener("click", () => {
    setPortfolioSort(sort.key, sort.dir === "asc" ? "desc" : "asc");
  });

  main.querySelectorAll("[data-port-sort]").forEach((th) => {
    const triggerSort = () => {
      const clicked = th.getAttribute("data-port-sort");
      const next = togglePortfolioSort(sort.key, sort.dir, clicked);
      setPortfolioSort(next.key, next.dir);
    };
    th.addEventListener("click", triggerSort);
    th.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        triggerSort();
      }
    });
  });

  main.querySelectorAll("[data-star]").forEach((btn) => {
    btn.addEventListener("click", () => toggleWatchlist(btn.getAttribute("data-star")));
  });

  main.querySelectorAll("[data-edit-holding]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const code = btn.getAttribute("data-edit-holding");
      const coin = findKnownCoin(code, coinByCode) || { code, name: code, rate: 0 };
      openHoldingModal(coin);
    });
  });
}

// ==================== Categories Page ====================

function renderCategoriesPage() {
  const main = document.getElementById("main-content");
  const cur = state.preferences.currency;
  const coins = state.markets?.coins || [];
  const hotCategoryDetails = Array.isArray(state.markets?.hotCategoryDetails)
    ? state.markets.hotCategoryDetails
    : [];
  const hotDetailMap = new Map(hotCategoryDetails.map((d) => [d.name, d]));

  const map = new Map();
  for (const coin of coins) {
    for (const cat of coin.categories || []) {
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat).push(coin);
    }
  }

  const capWeightedDelta = (list, key) => {
    const rows = list
      .filter((c) => typeof c.changes?.[key] === "number" && Number.isFinite(c.changes[key]))
      .map((c) => ({
        val: Math.max(-60, Math.min(150, c.changes[key])),
        w: c.cap > 0 ? c.cap : c.volume > 0 ? c.volume * 2 : 1,
      }));
    if (!rows.length) return null;
    const totalW = rows.reduce((a, r) => a + r.w, 0);
    const maxW = rows.length >= 3 ? totalW * 0.35 : Infinity;
    let wSum = 0;
    let vSum = 0;
    for (const r of rows) {
      const cw = Math.min(r.w, maxW);
      wSum += cw;
      vSum += cw * r.val;
    }
    return wSum > 0 ? Number((vSum / wSum).toFixed(2)) : null;
  };

  const sectors = [...map.entries()]
    .map(([name, list]) => {
      const cap = list.reduce((acc, c) => acc + (c.cap || 0), 0);
      const vol = list.reduce((acc, c) => acc + (c.volume || 0), 0);
      const cw24 = capWeightedDelta(list, "h24");
      const cw7 = capWeightedDelta(list, "d7");
      return { name, coins: list, cap, vol, cw24, cw7, hot: hotDetailMap.get(name) || null };
    })
    .sort((a, b) => b.cap - a.cap);

  main.innerHTML = `
    <section class="ck-page-header">
      <div>
        <h1 class="ck-h1">Top Crypto Categories by Market Cap</h1>
        <p class="ck-subtitle">Sectors grouped by market cap. 🔥 Hot categories require sustained 7d &amp; 24h cap-weighted momentum, market outperformance, broad coin participation, and substantial liquidity.</p>
      </div>
    </section>

    ${
      hotCategoryDetails.length
        ? `
      <section class="ck-hot-section" aria-label="Hot categories right now">
        <div class="ck-hot-section-head">
          <h2 class="ck-h2">🔥 Hot Categories Right Now</h2>
          <span class="ck-muted" style="font-size:12.5px">Smoothed across refreshes with hysteresis to filter out short-term noise</span>
        </div>
        <div class="ck-cat-grid">
          ${hotCategoryDetails
            .map(
              (d) => `
            <div class="ck-card ck-cat-card ck-hot-cat-card" data-open-cat="${esc(d.name)}">
              <div class="ck-card-head">
                <h3 class="ck-card-title">🔥 ${esc(d.name)}</h3>
                <span class="ck-hot-score-pill">${esc(d.score)}/100</span>
              </div>
              <div style="margin:6px 0 8px">
                <span class="ck-hot-signal-pill">${esc(d.signal || "Hot sector")}</span>
              </div>
              <p class="ck-hot-card-reason">${esc(d.reason)}</p>
              <div class="ck-hot-card-stats">
                <span><span class="ck-muted">7d</span> ${formatDeltaHtml(d.metrics?.capWeighted7d)}</span>
                <span><span class="ck-muted">24h</span> ${formatDeltaHtml(d.metrics?.capWeighted24h)}</span>
                <span class="ck-muted">${esc(d.metrics?.advancing24h ?? 0)}/${esc(d.metrics?.activeCoins ?? 0)} up</span>
              </div>
              ${
                d.leaders?.length
                  ? `
                <div class="ck-hot-card-drivers">
                  ${d.leaders
                    .map(
                      (ldr) => `
                    <a href="/coins/${encodeURIComponent(ldr.code)}" class="ck-hot-leader-chip" data-link>
                      <span>${esc(displayCode(ldr.code))}</span>
                      ${formatDeltaHtml(ldr.change24h)}
                    </a>
                  `,
                    )
                    .join("")}
                </div>
              `
                  : ""
              }
            </div>
          `,
            )
            .join("")}
        </div>
      </section>
    `
        : ""
    }

    <section class="ck-cat-grid">
      ${sectors
        .map(
          (sec) => `
        <div class="ck-card ck-cat-card" data-open-cat="${esc(sec.name)}">
          <div class="ck-card-head">
            <h2 class="ck-card-title">${sec.hot ? "🔥 " : ""}${esc(sec.name)}</h2>
            ${formatDeltaHtml(sec.cw24)}
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin:12px 0">
            <div>
              <div class="ck-kpi-label">Sector Market Cap</div>
              <div class="ck-kpi-val">${esc(formatCompactCurrency(sec.cap, cur))}</div>
            </div>
            <div class="ck-avatar-stack">
              ${sec.coins.slice(0, 4).map((c) => renderAvatar(c)).join("")}
            </div>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;gap:8px" class="ck-muted">
            <span>24h Vol: ${esc(formatCompactCurrency(sec.vol, cur))}</span>
            <span>7d: ${formatDeltaHtml(sec.cw7)}</span>
            <span>${sec.coins.length} coin${sec.coins.length === 1 ? "" : "s"}</span>
          </div>
        </div>
      `,
        )
        .join("")}
    </section>
  `;

  main.querySelectorAll("[data-open-cat]").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      state.activeCategory = card.getAttribute("data-open-cat");
      state.page = 1;
      navigate("/");
    });
  });
}

// ==================== Popovers (Settings / Customize / Filter) ====================

function closePopovers() {
  state.openPopover = null;
  document.querySelectorAll(".ck-popover").forEach((el) => el.classList.add("ck-hidden"));
  const dd = document.getElementById("search-dropdown");
  if (dd) dd.classList.add("ck-hidden");
}

function toggleSettingsPopover() {
  const pop = document.getElementById("settings-popover");
  if (!pop) return;
  const opening = state.openPopover !== "settings";
  closePopovers();
  if (!opening) return;

  state.openPopover = "settings";
  const st = state.status;
  pop.innerHTML = `
    <div class="ck-pop-section">
      <p class="ck-pop-title">Currency</p>
      <div class="ck-currency-grid">
        ${Object.keys(CURRENCIES)
          .map(
            (c) =>
              `<button type="button" class="ck-chip-btn ${state.preferences.currency === c ? "is-active" : ""}" data-set-currency="${c}">${c}</button>`,
          )
          .join("")}
      </div>
    </div>

    <div class="ck-pop-section">
      <p class="ck-pop-title">Appearance</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
        <button type="button" class="ck-chip-btn ${state.preferences.theme === "light" ? "is-active" : ""}" data-set-theme="light">☀ Light</button>
        <button type="button" class="ck-chip-btn ${state.preferences.theme === "dark" ? "is-active" : ""}" data-set-theme="dark">☾ Dark</button>
      </div>
    </div>

    <div class="ck-pop-section">
      <p class="ck-pop-title">Live Coin Watch &amp; Request Controls</p>
      <div style="font-size:12.5px;margin-bottom:8px" class="ck-muted">
        ${
          st?.configured
            ? `Connected (${st.source === "env" ? "env var" : `saved ${esc(st.keyHint || "")}`})`
            : "No API key — showing sample data."
        }
        ${
          st?.quota
            ? `<br/>Pulling <strong>${st.quota.coinLimit.toLocaleString()} coins</strong> · TTL <strong>${formatIntervalLabel(st.quota.refreshIntervalSec)}</strong>${st.quota.autoRefresh ? " (auto)" : ""}<br/><strong>${st.quota.refreshesRemainingToday.toLocaleString()}</strong> refreshes left today (${st.quota.dailyCreditsRemaining.toLocaleString()} / ${st.quota.dailyCreditsLimit.toLocaleString()} cr)`
            : ""
        }
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
        <button type="button" class="ck-btn" id="pop-open-controls" style="height:34px;font-size:12.5px">
          Request Controls
        </button>
        <button type="button" class="ck-btn ck-btn-primary" id="pop-open-api" style="height:34px;font-size:12.5px">
          ${st?.configured ? "API Key" : "Add API Key"}
        </button>
      </div>
    </div>
  `;
  pop.classList.remove("ck-hidden");

  pop.querySelectorAll("[data-set-currency]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nextCur = btn.getAttribute("data-set-currency");
      closePopovers();
      switchDisplayCurrency(nextCur);
    });
  });

  pop.querySelectorAll("[data-set-theme]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const theme = btn.getAttribute("data-set-theme");
      state.preferences.theme = theme;
      applyTheme(theme);
      closePopovers();
      await savePreferences({ theme });
    });
  });

  document.getElementById("pop-open-controls")?.addEventListener("click", () => {
    closePopovers();
    openApiKeyModal("controls");
  });

  document.getElementById("pop-open-api")?.addEventListener("click", () => {
    closePopovers();
    openApiKeyModal("key");
  });
}

function toggleCustomizePopover() {
  const pop = document.getElementById("customize-popover");
  if (!pop) return;
  const opening = state.openPopover !== "customize";
  closePopovers();
  if (!opening) return;

  state.openPopover = "customize";
  const labels = {
    h1: "1h Change %",
    h24: "24h Change %",
    d7: "7d Change %",
    d30: "30d Change %",
    volume: "24h Volume",
    liquidity: "Liquidity (±2%)",
    cap: "Market Cap",
    fdv: "Fully Diluted Valuation",
    mcapFdv: "Market Cap / FDV",
    sparkline: "Last 7 Days Sparkline",
  };
  pop.innerHTML = `
    <p class="ck-pop-title">Visible Table Columns</p>
    ${Object.entries(labels)
      .map(
        ([k, label]) => `
      <label class="ck-check-row">
        <span>${label}</span>
        <input type="checkbox" data-col-toggle="${k}" ${state.preferences.columns[k] ? "checked" : ""} />
      </label>
    `,
      )
      .join("")}
  `;
  pop.classList.remove("ck-hidden");

  pop.querySelectorAll("[data-col-toggle]").forEach((cb) => {
    cb.addEventListener("change", async () => {
      const col = cb.getAttribute("data-col-toggle");
      state.preferences.columns[col] = cb.checked;
      refreshMarketsResultsInPlace();
      await savePreferences({ columns: { [col]: cb.checked } });
    });
  });
}

// ==================== Modals (Live Coin Watch API Key & Holding) ====================

function closeModal() {
  const root = document.getElementById("modal-root");
  root.classList.add("ck-hidden");
  root.innerHTML = "";
}

function openApiKeyModal(initialTab = null) {
  const root = document.getElementById("modal-root");
  const st = state.status || {};
  const isEnv = st.source === "env";
  let activeTab =
    initialTab === "controls" || initialTab === "key"
      ? initialTab
      : st.configured
        ? "controls"
        : "key";

  // Draft controls state so the quota calculator updates live before saving.
  const draft = {
    coinLimit: state.preferences.coinLimit || 1000,
    refreshIntervalSec: state.preferences.refreshIntervalSec || 180,
    autoRefresh: Boolean(state.preferences.autoRefresh),
    dailyCreditLimit:
      st.quota?.isLiveCredits && st.quota?.dailyCreditsLimit
        ? st.quota.dailyCreditsLimit
        : state.preferences.dailyCreditLimit || 10_000,
  };

  function computeDraftStats() {
    const listCredits = Math.ceil(draft.coinLimit / 100);
    const creditsPerRefresh = listCredits + 1; // list pages + /overview
    const liveLimit = st.quota?.isLiveCredits ? st.quota.dailyCreditsLimit : null;
    const limit = liveLimit || draft.dailyCreditLimit || 10_000;
    const used = st.quota?.isLiveCredits
      ? Math.max(0, limit - (st.quota.dailyCreditsRemaining ?? limit))
      : st.quota?.requestsToday || 0;
    const remaining = st.quota?.isLiveCredits
      ? Math.max(0, st.quota.dailyCreditsRemaining ?? limit)
      : Math.max(0, limit - used);
    const refreshesLeft = Math.floor(remaining / creditsPerRefresh);
    const maxRefreshesPerDay = Math.floor(limit / creditsPerRefresh);
    const projected24h = Math.round((86_400 / draft.refreshIntervalSec) * creditsPerRefresh);
    const projected8h = Math.round((28_800 / draft.refreshIntervalSec) * creditsPerRefresh);
    const usedPct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
    const remainingPct = Math.max(0, 100 - usedPct);

    let budgetClass = "is-safe";
    let budgetLabel = "Within tier";
    if (projected24h > limit) {
      budgetClass = "is-over";
      budgetLabel = "Exceeds 24/7 tier";
    } else if (projected24h > limit * 0.75) {
      budgetClass = "is-high";
      budgetLabel = "High 24/7 usage";
    }

    return {
      listCredits,
      creditsPerRefresh,
      limit,
      used,
      remaining,
      refreshesLeft,
      maxRefreshesPerDay,
      projected24h,
      projected8h,
      remainingPct,
      budgetClass,
      budgetLabel,
    };
  }

  function renderQuotaBoxInner(q) {
    return `
      <div class="ck-quota-bar-head">
        <strong>${st.quota?.isLiveCredits ? "Daily Credits Remaining (Live)" : "Daily Tier Allowance"}</strong>
        <span class="ck-num"><strong>${q.remaining.toLocaleString()}</strong> / ${q.limit.toLocaleString()} cr</span>
      </div>
      <div class="ck-quota-track">
        <div class="ck-quota-fill ${q.remainingPct < 15 ? "is-over" : q.remainingPct < 35 ? "is-high" : ""}" style="width:${q.remainingPct.toFixed(1)}%"></div>
      </div>
      <div class="ck-quota-stats">
        <div class="ck-quota-stat">
          <div class="ck-quota-stat-val">${q.refreshesLeft.toLocaleString()}</div>
          <div class="ck-quota-stat-label">Refreshes left today</div>
        </div>
        <div class="ck-quota-stat">
          <div class="ck-quota-stat-val">${q.creditsPerRefresh} cr</div>
          <div class="ck-quota-stat-label">Per refresh (${q.listCredits} list + 1)</div>
        </div>
        <div class="ck-quota-stat">
          <div class="ck-quota-stat-val">${q.projected8h.toLocaleString()}</div>
          <div class="ck-quota-stat-label">Est. 8h active / day</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;font-size:12px">
        <span class="ck-muted">
          24/7 continuous at <strong>${formatIntervalLabel(draft.refreshIntervalSec)}</strong>: <strong class="ck-num">${q.projected24h.toLocaleString()} cr/day</strong>
          ${st.quota?.requestsToday ? ` · Used today: <strong>${st.quota.requestsToday.toLocaleString()}</strong>` : ""}
        </span>
        <span class="ck-budget-pill ${q.budgetClass}">${q.budgetLabel}</span>
      </div>
    `;
  }

  function renderModal() {
    const q = computeDraftStats();
    const coinLimits = [100, 300, 500, 1000, 2000, 5000, 10_000];
    const intervals = [
      [60, "1m"],
      [180, "3m"],
      [300, "5m"],
      [600, "10m"],
      [900, "15m"],
      [1800, "30m"],
    ];
    const tiers = [
      [10_000, "Free — 10,000 credits / day"],
      [50_000, "Standard — 50,000 credits / day"],
      [250_000, "Pro — 250,000 credits / day"],
      [1_000_000, "Enterprise — 1,000,000 credits / day"],
    ];

    root.innerHTML = `
      <div class="ck-modal" role="document">
        <div class="ck-modal-head">
          <h2 class="ck-modal-title">Live Coin Watch API</h2>
          <button type="button" class="ck-icon-btn" id="modal-close" aria-label="Close">✕</button>
        </div>

        <div class="ck-underline-tabs" style="margin-bottom:16px">
          <button type="button" class="ck-underline-tab ${activeTab === "controls" ? "is-active" : ""}" data-modal-tab="controls">Request Controls &amp; Quota</button>
          <button type="button" class="ck-underline-tab ${activeTab === "key" ? "is-active" : ""}" data-modal-tab="key">API Key</button>
        </div>

        <div id="api-modal-feedback"></div>

        ${
          activeTab === "controls"
            ? `
          <div class="ck-quota-box" id="draft-quota-box">
            ${renderQuotaBoxInner(q)}
          </div>

          <div class="ck-field">
            <label>Coins to Pull per Market Refresh</label>
            <div class="ck-pill-grid" style="margin-bottom:8px">
              ${coinLimits
                .map(
                  (n) =>
                    `<button type="button" class="ck-chip-btn ${draft.coinLimit === n ? "is-active" : ""}" data-draft-coins="${n}">${n.toLocaleString()}</button>`,
                )
                .join("")}
            </div>
            <div class="ck-input-row" style="align-items:center">
              <label for="draft-custom-coins" style="margin:0;white-space:nowrap;font-size:12px" class="ck-muted">Custom (100–25,000):</label>
              <input
                type="number"
                id="draft-custom-coins"
                class="ck-input"
                style="height:34px;font-variant-numeric:tabular-nums"
                min="100"
                max="25000"
                step="100"
                value="${draft.coinLimit}"
                aria-label="Custom number of coins to fetch"
              />
            </div>
            <div id="draft-large-note" class="ck-muted ${draft.coinLimit >= 5000 ? "" : "ck-hidden"}" style="font-size:11.5px;margin-top:5px">
              Large pulls (5,000+) paginate 50+ requests and take several seconds per refresh.
            </div>
          </div>

          <div class="ck-field">
            <label>Refresh Rate &amp; Server Cache TTL</label>
            <div class="ck-pill-grid is-six">
              ${intervals
                .map(
                  ([sec, lbl]) =>
                    `<button type="button" class="ck-chip-btn ${draft.refreshIntervalSec === sec ? "is-active" : ""}" data-draft-interval="${sec}">${lbl}</button>`,
                )
                .join("")}
            </div>
          </div>

          <div class="ck-toggle-row">
            <div>
              <div style="font-size:13px;font-weight:600">Auto-refresh active tab</div>
              <div class="ck-muted" style="font-size:12px">
                ${
                  draft.autoRefresh
                    ? `Active: pulls fresh prices every ${formatIntervalLabel(draft.refreshIntervalSec)} while visible (pauses when hidden).`
                    : `Currently off (manual refresh only). Turn on to auto-refresh every ${formatIntervalLabel(draft.refreshIntervalSec)}.`
                }
              </div>
            </div>
            <button
              type="button"
              id="draft-auto-refresh"
              class="ck-switch ${draft.autoRefresh ? "is-on" : ""}"
              role="switch"
              aria-checked="${draft.autoRefresh}"
              aria-label="Toggle auto-refresh"
            >
              <span class="ck-switch-thumb">${draft.autoRefresh ? "✓" : ""}</span>
            </button>
          </div>

          <div class="ck-field">
            <label for="draft-credit-tier">API Daily Credit Tier ${st.quota?.isLiveCredits ? "(auto-detected from Live Coin Watch)" : ""}</label>
            <select id="draft-credit-tier" class="ck-input" ${st.quota?.isLiveCredits ? "disabled" : ""}>
              ${tiers
                .map(
                  ([val, lbl]) =>
                    `<option value="${val}" ${q.limit === val ? "selected" : ""}>${lbl}</option>`,
                )
                .join("")}
              ${
                !tiers.some(([val]) => val === q.limit)
                  ? `<option value="${q.limit}" selected>Custom — ${q.limit.toLocaleString()} credits / day</option>`
                  : ""
              }
            </select>
          </div>

          <div class="ck-modal-actions">
            <button type="button" class="ck-btn" id="btn-cancel-key">Cancel</button>
            <button type="button" class="ck-btn ck-btn-primary" id="btn-save-controls">Save Controls</button>
          </div>
        `
            : `
          <p class="ck-muted" style="margin-top:0;font-size:13px">
            CoinKiwi uses <strong>Live Coin Watch</strong> exclusively for real-time prices, global market caps, and historical charts.
            Generate a free key (10,000 daily credits) at
            <a href="https://www.livecoinwatch.com/tools/api" target="_blank" rel="noopener noreferrer" style="color:var(--ck-up);font-weight:600;text-decoration:underline">livecoinwatch.com/tools/api ↗</a>.
          </p>

          ${
            st.previewGatewayMode
              ? `<div class="ck-alert is-info" style="line-height:1.55">
                  <strong>Live API keys aren't active in Pockets Preview</strong><br/>
                  Live Coin Watch requires <code>POST</code> requests with <code>x-api-key</code>, which Pockets Preview's <code>GET/HEAD</code>-only gateway cannot proxy — and Preview discards temporary data on Stop.
                </div>
                <div class="ck-quota-box" style="margin-bottom:14px;font-size:13px;line-height:1.6">
                  <div style="font-weight:700;margin-bottom:6px">How to connect your Live Coin Watch API key:</div>
                  <div><strong>1. Install this Pocket:</strong> In Pockets Desktop, click <strong>Sync source → Build/Update</strong>, then open the installed app and enter your key here (saved persistently in <code>/data/secrets.json</code>).</div>
                  <div style="margin-top:6px"><strong>2. Or use Runtime variables:</strong> Add <code>LIVECOINWATCH_API_KEY</code> in Pockets Desktop's <strong>Runtime variables</strong> so it is automatically injected when installed.</div>
                </div>
                ${
                  isEnv
                    ? `<div class="ck-alert is-success">
                        <code>LIVECOINWATCH_API_KEY</code> is already configured via environment variable (${esc(st.keyHint || "configured")}) and will activate automatically once installed.
                      </div>`
                    : ""
                }
                <div class="ck-modal-actions">
                  <button type="button" class="ck-btn ck-btn-primary" id="btn-cancel-key">Got it</button>
                </div>`
              : `
          ${
            isEnv
              ? `<div class="ck-alert is-success">
                  Managed via <code>LIVECOINWATCH_API_KEY</code> environment variable (${esc(st.keyHint || "configured")}).
                  ${
                    typeof st.dailyCreditsRemaining === "number"
                      ? `<br/>Daily credits remaining: <strong>${st.dailyCreditsRemaining.toLocaleString()}</strong> (${q.refreshesLeft.toLocaleString()} refreshes left)`
                      : ""
                  }
                </div>`
              : st.configured
                ? `<div class="ck-alert is-success">
                    Saved securely in <code>DATA_DIR/secrets.json</code> (${esc(st.keyHint || "configured")}).
                    ${
                      typeof st.dailyCreditsRemaining === "number"
                        ? `<br/>Daily credits remaining: <strong>${st.dailyCreditsRemaining.toLocaleString()}</strong> (${q.refreshesLeft.toLocaleString()} refreshes left)`
                        : ""
                    }
                  </div>`
                : ""
          }

          ${
            !isEnv
              ? `
            <form id="api-key-form">
              <div class="ck-field">
                <label for="lcw-key-input">${st.configured ? "Replace Live Coin Watch API Key" : "Enter Live Coin Watch API Key"}</label>
                <div class="ck-input-row">
                  <input
                    type="password"
                    id="lcw-key-input"
                    class="ck-input"
                    placeholder="Paste your x-api-key..."
                    autocomplete="off"
                    spellcheck="false"
                    required
                  />
                  <button type="button" class="ck-btn" id="btn-toggle-key-vis" style="flex-shrink:0">Show</button>
                </div>
              </div>
              <p class="ck-muted" style="font-size:12px;margin-top:-6px">
                Stored server-side with <code>0600</code> permissions — never sent back to the browser or written to logs.
              </p>
              <div class="ck-modal-actions">
                ${
                  st.configured
                    ? `<button type="button" class="ck-btn ck-btn-danger" id="btn-remove-key" style="margin-right:auto">Remove Key</button>`
                    : ""
                }
                <button type="button" class="ck-btn" id="btn-cancel-key">Cancel</button>
                <button type="submit" class="ck-btn ck-btn-primary" id="btn-save-key">Verify &amp; Save</button>
              </div>
            </form>
          `
              : `<div class="ck-modal-actions">
                  <button type="button" class="ck-btn ck-btn-primary" id="btn-cancel-key">Done</button>
                </div>`
          }`
          }
        `
        }
      </div>
    `;

    root.classList.remove("ck-hidden");
    document.getElementById("modal-close")?.addEventListener("click", closeModal);
    document.getElementById("btn-cancel-key")?.addEventListener("click", closeModal);

    root.querySelectorAll("[data-modal-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeTab = btn.getAttribute("data-modal-tab");
        renderModal();
      });
    });

    if (activeTab === "controls") {
      root.querySelectorAll("[data-draft-coins]").forEach((btn) => {
        btn.addEventListener("click", () => {
          draft.coinLimit = Number(btn.getAttribute("data-draft-coins"));
          renderModal();
        });
      });

      document.getElementById("draft-custom-coins")?.addEventListener("input", (e) => {
        const raw = Math.round(Number(e.target.value));
        if (!Number.isFinite(raw) || raw < 100 || raw > 25_000) return;
        draft.coinLimit = raw;
        root.querySelectorAll("[data-draft-coins]").forEach((btn) => {
          btn.classList.toggle(
            "is-active",
            Number(btn.getAttribute("data-draft-coins")) === raw,
          );
        });
        const box = document.getElementById("draft-quota-box");
        if (box) box.innerHTML = renderQuotaBoxInner(computeDraftStats());
        const note = document.getElementById("draft-large-note");
        if (note) note.classList.toggle("ck-hidden", raw < 5000);
      });

      document.getElementById("draft-custom-coins")?.addEventListener("blur", (e) => {
        const clamped = Math.max(
          100,
          Math.min(25_000, Math.round(Number(e.target.value) || draft.coinLimit)),
        );
        draft.coinLimit = clamped;
        e.target.value = String(clamped);
        renderModal();
      });

      root.querySelectorAll("[data-draft-interval]").forEach((btn) => {
        btn.addEventListener("click", () => {
          draft.refreshIntervalSec = Number(btn.getAttribute("data-draft-interval"));
          renderModal();
        });
      });

      document.getElementById("draft-auto-refresh")?.addEventListener("click", () => {
        draft.autoRefresh = !draft.autoRefresh;
        renderModal();
      });

      document.getElementById("draft-credit-tier")?.addEventListener("change", (e) => {
        draft.dailyCreditLimit = Number(e.target.value) || 10_000;
        renderModal();
      });

      document.getElementById("btn-save-controls")?.addEventListener("click", async () => {
        const coinLimitChanged = draft.coinLimit !== state.preferences.coinLimit;
        const saveBtn = document.getElementById("btn-save-controls");
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving…";
        try {
          await savePreferences({
            coinLimit: draft.coinLimit,
            refreshIntervalSec: draft.refreshIntervalSec,
            autoRefresh: draft.autoRefresh,
            dailyCreditLimit: draft.dailyCreditLimit,
          });
          scheduleAutoRefresh();
          closeModal();
          await loadAllData({ forceRefresh: coinLimitChanged });
        } catch (err) {
          const feedback = document.getElementById("api-modal-feedback");
          if (feedback) {
            feedback.innerHTML = `<div class="ck-alert is-error">${esc(err.message)}</div>`;
          }
          saveBtn.disabled = false;
          saveBtn.textContent = "Save Controls";
        }
      });
    } else {
      const keyInput = document.getElementById("lcw-key-input");
      const toggleBtn = document.getElementById("btn-toggle-key-vis");
      if (keyInput && toggleBtn) {
        keyInput.focus();
        toggleBtn.addEventListener("click", () => {
          const showing = keyInput.type === "text";
          keyInput.type = showing ? "password" : "text";
          toggleBtn.textContent = showing ? "Show" : "Hide";
        });
      }

      document.getElementById("api-key-form")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const feedback = document.getElementById("api-modal-feedback");
        const submitBtn = document.getElementById("btn-save-key");
        const apiKey = keyInput.value.trim();
        if (!apiKey) return;

        submitBtn.disabled = true;
        submitBtn.textContent = "Verifying…";
        feedback.innerHTML = "";

        try {
          state.status = await apiJson("/api/settings/api-key", {
            method: "POST",
            body: JSON.stringify({ apiKey }),
          });
          closeModal();
          await loadAllData({ forceRefresh: true });
        } catch (err) {
          feedback.innerHTML = `<div class="ck-alert is-error">${esc(err.message)}</div>`;
          submitBtn.disabled = false;
          submitBtn.textContent = "Verify & Save";
        }
      });

      document.getElementById("btn-remove-key")?.addEventListener("click", async () => {
        const feedback = document.getElementById("api-modal-feedback");
        try {
          state.status = await apiJson("/api/settings/api-key", { method: "DELETE" });
          closeModal();
          await loadAllData({ forceRefresh: true });
        } catch (err) {
          feedback.innerHTML = `<div class="ck-alert is-error">${esc(err.message)}</div>`;
        }
      });
    }
  }

  renderModal();
}

function openHoldingModal(coin) {
  const root = document.getElementById("modal-root");
  const existing = state.portfolio.holdings[coin.code];
  const cur = state.preferences.currency;
  const fx = getFxRate(cur);
  const existingDisplayCost =
    existing?.avgCost !== null && existing?.avgCost !== undefined
      ? Number((existing.avgCost * fx).toFixed(existing.avgCost * fx >= 1 ? 2 : 6))
      : "";
  const currentDisplayRate = (coin.rate || 0) * fx;

  root.innerHTML = `
    <div class="ck-modal" role="document">
      <div class="ck-modal-head">
        <h2 class="ck-modal-title">${existing ? "Edit" : "Add"} ${esc(coin.name)} Holding</h2>
        <button type="button" class="ck-icon-btn" id="modal-close" aria-label="Close">✕</button>
      </div>
      <form id="holding-form">
        <div class="ck-field">
          <label for="hold-qty">Quantity (${esc(coin.code)})</label>
          <input type="number" id="hold-qty" class="ck-input" step="any" min="0" value="${existing ? existing.quantity : ""}" placeholder="e.g. 0.5" required />
        </div>
        <div class="ck-field">
          <label for="hold-cost">Average Buy Price in ${esc(cur)} (optional)</label>
          <input type="number" id="hold-cost" class="ck-input" step="any" min="0" value="${existingDisplayCost}" placeholder="Current: ${Number(currentDisplayRate.toFixed(currentDisplayRate >= 1 ? 2 : 6))}" />
        </div>
        <div class="ck-modal-actions">
          ${
            existing
              ? `<button type="button" class="ck-btn ck-btn-danger" id="btn-del-holding" style="margin-right:auto">Remove</button>`
              : ""
          }
          <button type="button" class="ck-btn" id="btn-cancel-holding">Cancel</button>
          <button type="submit" class="ck-btn ck-btn-primary">Save Holding</button>
        </div>
      </form>
    </div>
  `;

  root.classList.remove("ck-hidden");
  document.getElementById("modal-close")?.addEventListener("click", closeModal);
  document.getElementById("btn-cancel-holding")?.addEventListener("click", closeModal);
  document.getElementById("hold-qty")?.focus();

  document.getElementById("holding-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const quantity = Number(document.getElementById("hold-qty").value);
    const rawCost = document.getElementById("hold-cost").value.trim();
    const avgCost = rawCost === "" ? null : Number(rawCost) / (fx || 1);
    state.portfolio = await apiJson("/api/portfolio/holding", {
      method: "PUT",
      body: JSON.stringify({ code: coin.code, quantity, avgCost }),
    });
    saveClientSnapshot();
    closeModal();
    renderTopBar();
    renderCurrentRoute();
  });

  document.getElementById("btn-del-holding")?.addEventListener("click", async () => {
    state.portfolio = await apiJson(
      `/api/portfolio/holding/${encodeURIComponent(coin.code)}`,
      { method: "DELETE" },
    );
    saveClientSnapshot();
    closeModal();
    renderTopBar();
    renderCurrentRoute();
  });
}

// ==================== Search Bar & Mobile Navigation ====================

let searchTimer = null;
let mobileSearchTimer = null;

function searchLocalCoins(query, limit = 10) {
  const coins = state.markets?.coins || [];
  if (!coins.length) return null;
  const q = query.toLowerCase();
  if (!q) return coins.slice(0, Math.min(limit, 8));

  const exact = [];
  const prefix = [];
  const contains = [];
  for (const c of coins) {
    const clean = displayCode(c.code).toLowerCase();
    const rawCode = String(c.code || "").toLowerCase();
    const name = String(c.name || "").toLowerCase();
    if (clean === q || rawCode === q || name === q) {
      exact.push(c);
    } else if (clean.startsWith(q) || name.startsWith(q)) {
      prefix.push(c);
    } else if (
      clean.includes(q) ||
      name.includes(q) ||
      (c.categories || []).some((cat) => cat.toLowerCase().includes(q))
    ) {
      contains.push(c);
    }
    if (exact.length + prefix.length >= 16) break;
  }
  return [...exact, ...prefix, ...contains].slice(0, limit);
}

function closeMobileSheets() {
  document.getElementById("mobile-search-sheet")?.classList.add("ck-hidden");
  document.getElementById("mobile-menu-backdrop")?.classList.add("ck-hidden");
  document.body.classList.remove("ck-no-scroll");
}

function openMobileSearch() {
  closePopovers();
  document.getElementById("mobile-menu-backdrop")?.classList.add("ck-hidden");
  const sheet = document.getElementById("mobile-search-sheet");
  const input = document.getElementById("mobile-search-input");
  if (!sheet || !input) return;
  sheet.classList.remove("ck-hidden");
  document.body.classList.add("ck-no-scroll");
  input.value = "";
  renderMobileSearchResults("");
  requestAnimationFrame(() => input.focus());
}

async function renderMobileSearchResults(query, { allowRemote = false } = {}) {
  const resultsEl = document.getElementById("mobile-search-results");
  const input = document.getElementById("mobile-search-input");
  if (!resultsEl) return;
  const cur = state.preferences.currency;

  let list = searchLocalCoins(query, 15);
  if (list === null || (list.length === 0 && allowRemote && query.length >= 2)) {
    try {
      const res = await apiJson(
        `/api/search?q=${encodeURIComponent(query)}&currency=USD`,
      );
      if (input && input.value.trim() !== query) return;
      list = res.results || [];
    } catch {
      list = list || [];
    }
  }

  if (!list.length) {
    resultsEl.innerHTML = `<div class="ck-search-heading">No coins found for "${esc(query)}"</div>`;
    return;
  }

  resultsEl.innerHTML = `
    <div class="ck-search-heading">${query ? "Search Results" : "Top Cryptocurrencies"}</div>
    ${list
      .map(
        (c) => `
      <button type="button" class="ck-search-item ck-mobile-search-item" data-msearch-code="${esc(c.code)}">
        <span class="ck-search-item-left">
          ${renderAvatar(c)}
          <span class="ck-coin-meta">
            <span class="ck-search-item-name">${esc(c.name)}</span>
            <span class="ck-search-item-code">${esc(displayCode(c.code))}</span>
          </span>
        </span>
        <span class="ck-search-item-right">
          <strong class="ck-num">${esc(formatPrice(c.rate, cur))}</strong>
          <span class="ck-muted">${c.rank ? `#${c.rank}` : "—"}</span>
        </span>
      </button>
    `,
      )
      .join("")}
  `;

  resultsEl.querySelectorAll("[data-msearch-code]").forEach((btn) => {
    btn.addEventListener("pointerdown", () => {
      const code = btn.getAttribute("data-msearch-code");
      prefetchCoinMeta(code);
      prefetchCoinHistory(code, "24h");
    });
    btn.addEventListener("click", () => {
      const code = btn.getAttribute("data-msearch-code");
      closeMobileSheets();
      navigate(`/coins/${encodeURIComponent(code)}`);
    });
  });
}

function openMobileMenu() {
  closePopovers();
  document.getElementById("mobile-search-sheet")?.classList.add("ck-hidden");
  const backdrop = document.getElementById("mobile-menu-backdrop");
  const drawer = document.getElementById("mobile-menu-drawer");
  if (!backdrop || !drawer) return;

  const cur = state.preferences.currency;
  const isDark = state.preferences.theme === "dark";
  const st = state.status;
  const statusText = st?.previewGatewayMode
    ? "Preview Sample"
    : st?.configured
      ? `LCW Live${typeof st.quota?.refreshesRemainingToday === "number" ? ` · ${st.quota.refreshesRemainingToday.toLocaleString()} left` : ""}`
      : "Add Live Coin Watch Key";

  drawer.innerHTML = `
    <div class="ck-mobile-drawer-head">
      <a href="/" class="ck-brand" data-link data-reset-markets>
        <span class="ck-brand-icon" aria-hidden="true">
          <img src="/favicon.svg?v=6" alt="" width="32" height="32" />
        </span>
        <span class="ck-brand-text">coinkiwi</span>
      </a>
      <button type="button" id="btn-close-mobile-menu" class="ck-icon-btn" aria-label="Close menu">✕</button>
    </div>

    <div class="ck-mobile-drawer-body">
      <div class="ck-mobile-menu-section">
        <div class="ck-mobile-menu-label">Navigate</div>
        <div class="ck-mobile-menu-links">
          <a href="/" class="ck-mobile-menu-link" data-link data-reset-markets><span>Cryptocurrencies</span><span>›</span></a>
          <a href="/exchanges" class="ck-mobile-menu-link" data-link><span>Exchanges</span><span>›</span></a>
          <a href="/categories" class="ck-mobile-menu-link" data-link><span>Categories</span><span>›</span></a>
          <a href="/portfolio" class="ck-mobile-menu-link" data-link><span>Portfolio (${state.portfolio.watchlist.length})</span><span>›</span></a>
        </div>
      </div>

      <div class="ck-mobile-menu-section">
        <div class="ck-mobile-menu-label">Display Currency</div>
        <div class="ck-mobile-currency-grid">
          ${Object.keys(CURRENCIES)
            .map(
              (c) =>
                `<button type="button" class="ck-mobile-chip ${c === cur ? "is-active" : ""}" data-mmenu-cur="${c}">${c}</button>`,
            )
            .join("")}
        </div>
      </div>

      <div class="ck-mobile-menu-section">
        <div class="ck-mobile-menu-label">Appearance &amp; Data</div>
        <div class="ck-mobile-menu-actions">
          <button type="button" class="ck-mobile-menu-btn" id="mmenu-theme">
            <span>Theme: <strong>${isDark ? "Dark Mode" : "Light Mode"}</strong></span>
            <span>${isDark ? "☾" : "☀"}</span>
          </button>
          <button type="button" class="ck-mobile-menu-btn" id="mmenu-api">
            <span>
              <span class="ck-status-dot ${st?.configured && !st?.previewGatewayMode ? "is-live" : ""}" style="display:inline-block;margin-right:6px"></span>
              ${esc(statusText)}
            </span>
            <span>Settings ›</span>
          </button>
          <button type="button" class="ck-mobile-menu-btn" id="mmenu-refresh">
            <span>Refresh Market Data</span>
            <span>↻</span>
          </button>
        </div>
      </div>
    </div>
  `;

  backdrop.classList.remove("ck-hidden");
  document.body.classList.add("ck-no-scroll");

  document.getElementById("btn-close-mobile-menu")?.addEventListener("click", closeMobileSheets);

  drawer.querySelectorAll("[data-mmenu-cur]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nextCur = btn.getAttribute("data-mmenu-cur");
      closeMobileSheets();
      switchDisplayCurrency(nextCur);
    });
  });

  document.getElementById("mmenu-theme")?.addEventListener("click", async () => {
    const nextTheme = state.preferences.theme === "dark" ? "light" : "dark";
    state.preferences.theme = nextTheme;
    applyTheme(nextTheme);
    openMobileMenu();
    await savePreferences({ theme: nextTheme });
  });

  document.getElementById("mmenu-api")?.addEventListener("click", () => {
    closeMobileSheets();
    openApiKeyModal(state.status?.configured ? "controls" : "key");
  });

  document.getElementById("mmenu-refresh")?.addEventListener("click", () => {
    closeMobileSheets();
    loadAllData({ forceRefresh: true });
  });
}

function setupMobileShell() {
  document.getElementById("btn-mobile-search")?.addEventListener("click", openMobileSearch);
  document.getElementById("btn-close-mobile-search")?.addEventListener("click", closeMobileSheets);
  document.getElementById("btn-mobile-menu")?.addEventListener("click", openMobileMenu);
  document.getElementById("mobile-menu-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "mobile-menu-backdrop") closeMobileSheets();
  });

  document.getElementById("btn-mobile-refresh")?.addEventListener("click", () => {
    loadAllData({ forceRefresh: true });
  });
  document.getElementById("btn-mobile-api")?.addEventListener("click", () => {
    openApiKeyModal(state.status?.configured ? "controls" : "key");
  });

  initGlobalStatsScroller();

  const mSearchInput = document.getElementById("mobile-search-input");
  if (mSearchInput) {
    mSearchInput.addEventListener("input", () => {
      const q = mSearchInput.value.trim();
      renderMobileSearchResults(q, { allowRemote: false });
      clearTimeout(mobileSearchTimer);
      if (q.length >= 2 && (searchLocalCoins(q, 1) || []).length === 0) {
        mobileSearchTimer = setTimeout(
          () => renderMobileSearchResults(q, { allowRemote: true }),
          260,
        );
      }
    });
  }

  const scrollTopBtn = document.getElementById("btn-scroll-top");
  if (scrollTopBtn) {
    scrollTopBtn.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    window.addEventListener(
      "scroll",
      () => {
        scrollTopBtn.classList.toggle("ck-hidden", window.scrollY < 360);
      },
      { passive: true },
    );
  }
}

function setupSearch() {
  const input = document.getElementById("global-search");
  const dropdown = document.getElementById("search-dropdown");
  if (!input || !dropdown) return;

  async function runSearch(query, { allowRemote = false } = {}) {
    const local = searchLocalCoins(query);
    if (local !== null) {
      state.searchResults = local;
      state.searchIndex = -1;
      paintSearchDropdown(query);
      // Only hit /api/search for exact-code LCW lookup when nothing matched locally.
      if (local.length > 0 || !allowRemote || query.length < 2) return;
    }

    try {
      const res = await apiJson(
        `/api/search?q=${encodeURIComponent(query)}&currency=USD`,
      );
      if (input.value.trim() !== query) return;
      state.searchResults = res.results || [];
      state.searchIndex = -1;
      paintSearchDropdown(query);
    } catch {
      if (local === null) dropdown.classList.add("ck-hidden");
    }
  }

  function paintSearchDropdown(query) {
    const cur = state.preferences.currency;
    if (!state.searchResults.length) {
      dropdown.innerHTML = `<div class="ck-search-heading">No coins found for "${esc(query)}"</div>`;
      dropdown.classList.remove("ck-hidden");
      return;
    }

    dropdown.innerHTML = `
      <div class="ck-search-heading">${query ? "Search Results" : "Top Cryptocurrencies"}</div>
      ${state.searchResults
        .map(
          (c, i) => `
        <button type="button" class="ck-search-item ${i === state.searchIndex ? "is-selected" : ""}" data-search-code="${esc(c.code)}">
          <span class="ck-search-item-left">
            ${renderAvatar(c)}
            <span class="ck-search-item-name">${esc(c.name)}</span>
            <span class="ck-search-item-code">${esc(displayCode(c.code))}</span>
          </span>
          <span class="ck-search-item-right">
            <strong class="ck-num">${esc(formatPrice(c.rate, cur))}</strong>
            <span class="ck-muted">${c.rank ? `#${c.rank}` : "—"}</span>
          </span>
        </button>
      `,
        )
        .join("")}
    `;
    dropdown.classList.remove("ck-hidden");

    dropdown.querySelectorAll("[data-search-code]").forEach((btn) => {
      btn.addEventListener("pointerenter", () => {
        const code = btn.getAttribute("data-search-code");
        prefetchCoinMeta(code);
        prefetchCoinHistory(code, "24h");
      });
      btn.addEventListener("pointerdown", () => {
        const code = btn.getAttribute("data-search-code");
        prefetchCoinMeta(code);
        prefetchCoinHistory(code, "24h");
      });
      btn.addEventListener("click", () => {
        const code = btn.getAttribute("data-search-code");
        input.value = "";
        dropdown.classList.add("ck-hidden");
        navigate(`/coins/${encodeURIComponent(code)}`);
      });
    });
  }

  input.addEventListener("focus", () => {
    runSearch(input.value.trim(), { allowRemote: false });
  });

  input.addEventListener("input", () => {
    const q = input.value.trim();
    // Instant local filter on every keystroke; debounce only remote fallback if 0 local hits.
    runSearch(q, { allowRemote: false });
    clearTimeout(searchTimer);
    if (q.length >= 2 && state.searchResults.length === 0) {
      searchTimer = setTimeout(() => runSearch(q, { allowRemote: true }), 260);
    }
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      dropdown.classList.add("ck-hidden");
      input.blur();
      return;
    }
    if (!state.searchResults.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      state.searchIndex = (state.searchIndex + 1) % state.searchResults.length;
      paintSearchDropdown(input.value.trim());
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      state.searchIndex =
        (state.searchIndex - 1 + state.searchResults.length) % state.searchResults.length;
      paintSearchDropdown(input.value.trim());
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target =
        state.searchResults[state.searchIndex >= 0 ? state.searchIndex : 0];
      if (target) {
        input.value = "";
        dropdown.classList.add("ck-hidden");
        navigate(`/coins/${encodeURIComponent(target.code)}`);
      }
    }
  });
}

// ==================== Persistence Actions & Data Loader ====================

async function savePreferences(patch) {
  try {
    state.preferences = await apiJson("/api/preferences", {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  } catch {
    // Keep optimistic client state.
  }
  saveClientSnapshot();
}

async function toggleWatchlist(code) {
  try {
    const res = await apiJson("/api/portfolio/toggle", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    state.portfolio = res.portfolio;
    saveClientSnapshot();
    renderTopBar();
    renderCurrentRoute();
  } catch {
    // Ignore transient failure.
  }
}

function updateRefreshCountdownUi() {
  const badge = document.getElementById("refresh-countdown");
  const btn = document.getElementById("btn-refresh");
  const mBadge = document.getElementById("mobile-refresh-badge");
  const mBtn = document.getElementById("btn-mobile-refresh");
  if (!badge || !btn) return;

  if (isLoadingData) {
    badge.textContent = "Updating…";
    badge.classList.remove("ck-hidden");
    btn.title = "Refreshing market data…";
    if (mBadge) {
      mBadge.textContent = "";
      mBadge.classList.add("ck-hidden");
    }
    if (mBtn) mBtn.title = "Refreshing market data…";
    return;
  }

  const active =
    Boolean(state.preferences.autoRefresh) &&
    Boolean(state.status?.configured) &&
    !state.status?.previewGatewayMode;

  if (!active || !nextAutoRefreshAt) {
    badge.classList.add("ck-hidden");
    badge.textContent = "";
    btn.title = "Refresh market data";
    if (mBadge) {
      mBadge.classList.add("ck-hidden");
      mBadge.textContent = "";
    }
    if (mBtn) mBtn.title = "Refresh market data";
    return;
  }

  const remainingMs = Math.max(0, nextAutoRefreshAt - Date.now());
  const text = formatCountdown(remainingMs);
  badge.textContent = text;
  badge.classList.remove("ck-hidden");
  const title = `Auto-refreshing every ${formatIntervalLabel(state.preferences.refreshIntervalSec)} (next in ${text}) — click to refresh now`;
  btn.title = title;
  if (mBadge) {
    mBadge.textContent = text;
    mBadge.classList.remove("ck-hidden");
  }
  if (mBtn) mBtn.title = title;
}

function scheduleAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }

  const sec = Number(state.preferences.refreshIntervalSec) || 180;
  const active =
    Boolean(state.preferences.autoRefresh) &&
    Boolean(state.status?.configured) &&
    !state.status?.previewGatewayMode &&
    sec >= 60;

  if (!active) {
    nextAutoRefreshAt = 0;
    updateRefreshCountdownUi();
    // Still keep the footer "Updated Xs ago" ticking smoothly every 10s.
    autoRefreshTimer = setInterval(updateFooterTimestamp, 10_000);
    return;
  }

  nextAutoRefreshAt = Date.now() + sec * 1000;
  updateRefreshCountdownUi();

  autoRefreshTimer = setInterval(() => {
    updateFooterTimestamp();
    updateRefreshCountdownUi();
    if (document.visibilityState !== "visible") return;
    if (isLoadingData) return;
    if (Date.now() >= nextAutoRefreshAt) {
      // Force fresh server fetch since the full refresh interval has elapsed,
      // preventing cache-boundary misses by a few milliseconds.
      loadAllData({ forceRefresh: true, isAuto: true });
    }
  }, 1000);
}

function refreshStatusInBackground({ forceCredits = false } = {}) {
  return apiJson(`/api/status${forceCredits ? "?refresh=1" : ""}`)
    .then((status) => {
      if (!status) return;
      state.status = status;
      saveClientSnapshot();
      renderTopBar();
      scheduleAutoRefresh();
    })
    .catch(() => {});
}

function refreshFxInBackground() {
  return apiJson("/api/fx")
    .then((fxRes) => {
      if (!fxRes?.rates) return;
      state.fxRates = { ...state.fxRates, ...fxRes.rates, USD: 1 };
      if (!fxRes.isSample) state.fxRatesLive = true;
      saveClientSnapshot();
      if (state.preferences.currency !== "USD") {
        renderTopBar();
        renderCurrentRoute();
      }
    })
    .catch(() => {});
}

async function loadAllData({ forceRefresh = false, isAuto = false } = {}) {
  if (isLoadingData) return;
  isLoadingData = true;
  const refreshBtn = document.getElementById("btn-refresh");
  const mobileRefreshBtn = document.getElementById("btn-mobile-refresh");
  if (refreshBtn) refreshBtn.classList.add("is-spinning");
  if (mobileRefreshBtn) mobileRefreshBtn.classList.add("is-spinning");
  updateRefreshCountdownUi();

  const q = `currency=USD${forceRefresh ? "&refresh=1" : ""}`;

  try {
    if (!state.fxRatesLive) {
      refreshFxInBackground();
    }

    const hadMarketsBefore = Boolean(state.markets?.coins?.length);
    const marketsPromise = apiJson(`/api/markets?${q}`).then((markets) => {
      // On a truly cold start (empty volume), paint the coin table as soon as /api/markets
      // resolves rather than waiting for /api/overview (which also loads exchanges/history).
      if (!hadMarketsBefore && !state.markets && markets?.coins) {
        state.markets = markets;
        prevPrices = new Map(markets.coins.map((c) => [c.code, c.rate]));
        renderTopBar();
        if (currentRoute().name === "markets") {
          renderMarketsPage({ skipBackgroundFetch: true });
        }
      }
      return markets;
    });

    const [markets, overview] = await Promise.all([
      marketsPromise,
      apiJson(`/api/overview?${q}`),
    ]);

    // Record price directional flashes for visual feedback on live refreshes.
    const nextFlash = new Map();
    if (prevPrices.size > 0 && Array.isArray(markets?.coins)) {
      for (const c of markets.coins) {
        const prev = prevPrices.get(c.code);
        if (typeof prev === "number" && typeof c.rate === "number" && prev !== c.rate) {
          nextFlash.set(c.code, c.rate > prev ? "up" : "down");
        }
      }
    }
    priceFlash = nextFlash;
    prevPrices = new Map((markets?.coins || []).map((c) => [c.code, c.rate]));

    state.overview = overview;
    state.fearAndGreed = overview.fearAndGreed;
    state.markets = markets;
    saveClientSnapshot();
    renderTopBar();

    // Update credit status in the background so /credits never delays rendering markets.
    refreshStatusInBackground({ forceCredits: forceRefresh && !isAuto });

    const route = currentRoute();
    if (route.name === "coin" && forceRefresh) {
      await renderCoinDetailPage(route.code, { forceRefresh: true });
    } else if (route.name === "exchanges" && forceRefresh) {
      await renderExchangesPage({ forceRefresh: true });
    } else {
      if (forceRefresh) {
        state.detail.data = null;
        state.exchanges.data = null;
      }
      await renderCurrentRoute();
    }
    if (forceRefresh || route.name === "portfolio") {
      ensurePortfolioCoinQuotes({ forceRefresh });
    }
    scheduleAutoRefresh();
  } catch {
    // Keep existing UI data intact on transient auto-refresh failure and reschedule.
    scheduleAutoRefresh();
  } finally {
    isLoadingData = false;
    if (refreshBtn) refreshBtn.classList.remove("is-spinning");
    if (mobileRefreshBtn) mobileRefreshBtn.classList.remove("is-spinning");
    updateRefreshCountdownUi();
  }
}

// ==================== Boot ====================

function paintInitialBootRoute() {
  const route = currentRoute();
  updateActiveNav(route.name);
  const main = document.getElementById("main-content");

  if (route.name === "coin") {
    if (state.detail.data) {
      paintCoinDetail();
    } else if (main) {
      main.innerHTML = `<div class="ck-card" style="padding:36px">
        <div class="ck-skeleton-line" style="width:200px;height:22px;margin-bottom:16px"></div>
        <div class="ck-skeleton-line" style="width:100%;height:360px"></div>
      </div>`;
    }
  } else if (route.name === "exchanges") {
    if (state.exchanges.data) {
      paintExchangesPage();
    } else if (main) {
      main.innerHTML = `<div class="ck-card" style="padding:36px">
        <div class="ck-skeleton-line" style="width:280px;height:24px;margin-bottom:16px"></div>
        <div class="ck-skeleton-line" style="width:100%;height:340px"></div>
      </div>`;
    }
  } else if (route.name === "portfolio") {
    renderPortfolioPage({ skipQuoteFetch: true });
  } else if (route.name === "categories") {
    renderCategoriesPage();
  } else {
    renderMarketsPage({ skipBackgroundFetch: true });
  }
}

function stopBootRefreshIndicator() {
  const refreshBtn = document.getElementById("btn-refresh");
  const mobileRefreshBtn = document.getElementById("btn-mobile-refresh");
  if (refreshBtn) refreshBtn.classList.remove("is-spinning");
  if (mobileRefreshBtn) mobileRefreshBtn.classList.remove("is-spinning");
  updateRefreshCountdownUi();
}

async function boot() {
  // Kick off the cache-only server bootstrap immediately so a brand-new browser
  // hydrates from the persisted Podman volume (/data/cache) in ~5ms without
  // waiting on any upstream Live Coin Watch requests.
  const initialRoute = currentRoute();
  const bootParams = new URLSearchParams();
  if (initialRoute.name === "exchanges") {
    bootParams.set("include", "exchanges");
  } else if (initialRoute.name === "coin" && initialRoute.code) {
    bootParams.set("coin", initialRoute.code);
  }
  const bootstrapUrl = bootParams.toString()
    ? `/api/bootstrap?${bootParams.toString()}`
    : "/api/bootstrap";
  const bootstrapPromise = apiJson(bootstrapUrl).catch(() => null);

  // 0ms instant restore: show last known data immediately on page refresh instead of
  // leaving a blank screen while fresh market data loads in the background.
  restoreClientSnapshot();
  applyTheme(state.preferences.theme);
  renderTopBar();
  paintInitialBootRoute();

  // Indicate background refresh is starting right away.
  const refreshBtn = document.getElementById("btn-refresh");
  const mobileRefreshBtn = document.getElementById("btn-mobile-refresh");
  if (refreshBtn) refreshBtn.classList.add("is-spinning");
  if (mobileRefreshBtn) mobileRefreshBtn.classList.add("is-spinning");
  const refreshBadge = document.getElementById("refresh-countdown");
  if (refreshBadge) {
    refreshBadge.textContent = "Updating…";
    refreshBadge.classList.remove("ck-hidden");
  }

  // Hover & pointerdown prefetch: quietly warm coin metadata + 24h chart on hover intent
  // (or immediately on pointerdown, ~150ms before click) so charts open instantly.
  let hoverPrefetchTimer = null;
  document.addEventListener("pointerover", (e) => {
    const link = e.target.closest?.('a[data-link][href^="/coins/"]');
    if (!link) return;
    const match = link.getAttribute("href")?.match(/^\/coins\/([^/]+)$/);
    if (!match) return;
    const code = decodeURIComponent(match[1]);
    clearTimeout(hoverPrefetchTimer);
    hoverPrefetchTimer = setTimeout(() => {
      prefetchCoinMeta(code);
      prefetchCoinHistory(code, "24h");
    }, 350);
  });
  document.addEventListener("pointerout", (e) => {
    if (e.target.closest?.('a[data-link][href^="/coins/"]')) {
      clearTimeout(hoverPrefetchTimer);
    }
  });
  document.addEventListener("pointerdown", (e) => {
    const link = e.target.closest?.('a[data-link][href^="/coins/"]');
    if (!link) return;
    const match = link.getAttribute("href")?.match(/^\/coins\/([^/]+)$/);
    if (!match) return;
    const code = decodeURIComponent(match[1]);
    clearTimeout(hoverPrefetchTimer);
    prefetchCoinMeta(code);
    prefetchCoinHistory(code, "24h");
  });

  // Global SPA link interception
  document.addEventListener("click", (e) => {
    const link = e.target.closest("a[data-link]");
    if (link && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (link.hasAttribute("data-reset-markets") || link.classList.contains("ck-brand")) {
        resetMarketsView();
      }
      navigate(link.getAttribute("href"));
      return;
    }

    // Close popovers when clicking outside
    if (
      !e.target.closest(".ck-popover-anchor") &&
      !e.target.closest("#search-wrap")
    ) {
      closePopovers();
    }
  });

  // Modal backdrop click
  document.getElementById("modal-root")?.addEventListener("click", (e) => {
    if (e.target.id === "modal-root") closeModal();
  });

  // Top bar actions
  document.getElementById("btn-api-status")?.addEventListener("click", () => {
    openApiKeyModal(state.status?.configured ? "controls" : "key");
  });
  document.getElementById("footer-api-btn")?.addEventListener("click", () => {
    openApiKeyModal("controls");
  });
  document.getElementById("btn-settings")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleSettingsPopover();
  });
  document.getElementById("btn-theme-quick")?.addEventListener("click", async () => {
    const nextTheme = state.preferences.theme === "dark" ? "light" : "dark";
    state.preferences.theme = nextTheme;
    applyTheme(nextTheme);
    await savePreferences({ theme: nextTheme });
  });
  document.getElementById("btn-refresh")?.addEventListener("click", () => {
    loadAllData({ forceRefresh: true });
  });

  // Keyboard shortcuts ("/" focuses search, Escape closes modals/popovers)
  document.addEventListener("keydown", (e) => {
    if (
      e.key === "/" &&
      !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)
    ) {
      e.preventDefault();
      document.getElementById("global-search")?.focus();
    } else if (e.key === "Escape") {
      closeModal();
      closePopovers();
      closeMobileSheets();
    }
  });

  window.addEventListener("popstate", () => renderCurrentRoute());

  // When returning to a hidden tab after the refresh interval has elapsed, refresh immediately.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (
      state.preferences.autoRefresh &&
      state.status?.configured &&
      !state.status?.previewGatewayMode &&
      nextAutoRefreshAt &&
      Date.now() >= nextAutoRefreshAt &&
      !isLoadingData
    ) {
      loadAllData({ forceRefresh: true, isAuto: true });
    }
  });

  setupSearch();
  setupMobileShell();

  // Hydrate immediately from persisted server volume data (preferences, portfolio,
  // status, FX, and cached markets/overview/exchanges/detail) before triggering
  // any upstream refresh.
  const bootstrap = await bootstrapPromise;

  if (bootstrap) {
    if (bootstrap.preferences) state.preferences = bootstrap.preferences;
    if (bootstrap.portfolio) state.portfolio = bootstrap.portfolio;
    if (bootstrap.extraCoins && typeof bootstrap.extraCoins === "object") {
      for (const [code, coin] of Object.entries(bootstrap.extraCoins)) {
        if (coin && typeof coin === "object" && Number.isFinite(coin.rate) && coin.rate > 0) {
          state.extraCoins[code] = { ...(state.extraCoins[code] || {}), ...coin };
        }
      }
    }
    if (bootstrap.status) state.status = bootstrap.status;
    if (bootstrap.fx?.rates) {
      state.fxRates = { ...state.fxRates, ...bootstrap.fx.rates, USD: 1 };
      if (!bootstrap.fx.isSample) state.fxRatesLive = true;
    }
    applyTheme(state.preferences.theme);

    const serverOverviewAt = bootstrap.overview?.meta?.fetchedAt || 0;
    const localOverviewAt = state.overview?.meta?.fetchedAt || 0;
    if (bootstrap.overview && (!state.overview || serverOverviewAt >= localOverviewAt)) {
      state.overview = bootstrap.overview;
      state.fearAndGreed = bootstrap.overview.fearAndGreed || null;
    }

    const serverMarketsAt = bootstrap.markets?.meta?.fetchedAt || 0;
    const localMarketsAt = state.markets?.meta?.fetchedAt || 0;
    if (
      bootstrap.markets?.coins &&
      (!state.markets || serverMarketsAt >= localMarketsAt)
    ) {
      state.markets = bootstrap.markets;
      prevPrices = new Map(bootstrap.markets.coins.map((c) => [c.code, c.rate]));
    }

    const serverExAt = bootstrap.exchanges?.meta?.fetchedAt || 0;
    const localExAt = state.exchanges.data?.meta?.fetchedAt || 0;
    if (
      bootstrap.exchanges?.exchanges &&
      (!state.exchanges.data || serverExAt >= localExAt)
    ) {
      state.exchanges.data = bootstrap.exchanges;
      state.exchanges.fromSnapshot = Boolean(bootstrap.needsRefresh?.exchanges);
    }

    const activeRoute = currentRoute();
    if (
      activeRoute.name === "coin" &&
      activeRoute.code === initialRoute.code &&
      bootstrap.detail?.coin
    ) {
      const serverDetailAt = bootstrap.detail.meta?.fetchedAt || 0;
      const localDetailAt = state.detail.data?.meta?.fetchedAt || 0;
      if (!state.detail.data || state.detail.fromSnapshot || serverDetailAt >= localDetailAt) {
        const hist24 = Array.isArray(bootstrap.detail.history24h)
          ? bootstrap.detail.history24h
          : [];
        const historyCache = new Map();
        if (hist24.length) historyCache.set("24h", hist24);
        state.detail = {
          code: activeRoute.code,
          data: bootstrap.detail,
          fromSnapshot: Boolean(bootstrap.needsRefresh?.detail),
          range: "24h",
          metric: "rate",
          tab: "overview",
          historyCache,
          loadingHistory: hist24.length === 0,
        };
      }
    }

    saveClientSnapshot();
    renderTopBar();

    const needsCoreRefresh = Boolean(
      bootstrap.needsRefresh?.markets || bootstrap.needsRefresh?.overview,
    );

    if (activeRoute.name === "coin") {
      if (state.detail.data) paintCoinDetail();
      if (!state.detail.data || bootstrap.needsRefresh?.detail) {
        renderCoinDetailPage(activeRoute.code);
      }
    } else if (activeRoute.name === "exchanges") {
      if (state.exchanges.data) paintExchangesPage();
      if (!state.exchanges.data || bootstrap.needsRefresh?.exchanges) {
        renderExchangesPage();
      }
    } else if (needsCoreRefresh) {
      // Paint persisted volume data immediately while fresh data fetches in background.
      paintInitialBootRoute();
    } else {
      // Volume data is already fresh — render full route (including live sparklines).
      await renderCurrentRoute();
    }

    if (needsCoreRefresh) {
      await loadAllData({ forceRefresh: false });
    } else {
      scheduleAutoRefresh();
      stopBootRefreshIndicator();
      if (bootstrap.needsRefresh?.fx) {
        refreshFxInBackground();
      }
      if (bootstrap.needsRefresh?.status) {
        refreshStatusInBackground();
      }
      if (bootstrap.needsRefresh?.portfolioCoins) {
        ensurePortfolioCoinQuotes({ forceRefresh: true });
      }
    }
    return;
  }

  // Fallback if /api/bootstrap was unavailable.
  const [prefs, portfolio, fxData] = await Promise.all([
    apiJson("/api/preferences").catch(() => state.preferences),
    apiJson("/api/portfolio").catch(() => state.portfolio),
    apiJson("/api/fx").catch(() => null),
  ]);
  state.preferences = prefs;
  state.portfolio = portfolio;
  if (fxData?.rates) {
    state.fxRates = { ...state.fxRates, ...fxData.rates, USD: 1 };
    if (!fxData.isSample) state.fxRatesLive = true;
  }
  applyTheme(state.preferences.theme);

  const fallbackRoute = currentRoute();
  if (fallbackRoute.name === "coin") {
    renderCoinDetailPage(fallbackRoute.code);
  } else if (fallbackRoute.name === "exchanges") {
    renderExchangesPage();
  }

  await loadAllData({ forceRefresh: false });
}

boot();
