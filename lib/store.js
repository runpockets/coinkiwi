// Atomic JSON persistence under DATA_DIR for CoinKiwi:
// - portfolio.json (watchlist + local holdings)
// - preferences.json (currency, theme, highlights toggle, table columns)
// - secrets.json (saved Live Coin Watch API key with 0600 permissions)
// - cache/*.json (rate-limit-friendly disk cache)

import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DEFAULT_PORTFOLIO_SORT,
  VALID_PORTFOLIO_SORT_KEYS,
} from "../public/portfolio.js";

export const SUPPORTED_CURRENCIES = ["USD", "NZD", "EUR", "GBP", "AUD", "BTC"];
export const ALLOWED_PORTFOLIO_SORT_KEYS = VALID_PORTFOLIO_SORT_KEYS;
export const ALLOWED_SORT_DIRS = ["asc", "desc"];
export const MIN_COIN_LIMIT = 100;
export const MAX_COIN_LIMIT = 25_000;
export const ALLOWED_COIN_LIMITS = [100, 300, 500, 1000, 2000, 5000, 10_000];
export const ALLOWED_REFRESH_INTERVALS = [60, 180, 300, 600, 900, 1800];
export const ALLOWED_CREDIT_TIERS = [10_000, 50_000, 250_000, 1_000_000];

function parseCoinLimit(raw) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < MIN_COIN_LIMIT || n > MAX_COIN_LIMIT) return null;
  return n;
}

export const DEFAULT_PREFERENCES = {
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
};

export const DEFAULT_PORTFOLIO = {
  watchlist: [],
  holdings: {},
};

function createQueue() {
  let tail = Promise.resolve();
  return function enqueue(task) {
    const result = tail.then(task, task);
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  };
}

async function readJsonSafe(filePath, fallback) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return structuredClone(fallback);
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : structuredClone(fallback);
  } catch {
    return structuredClone(fallback);
  }
}

async function atomicWriteJson(filePath, value, options = {}) {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: options.mode ?? 0o644,
  });
  if (options.mode !== undefined) {
    try {
      await chmod(tmp, options.mode);
    } catch {
      // Ignore chmod issues on filesystems that don't support POSIX modes.
    }
  }
  await rename(tmp, filePath);
}

function sanitizeCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9._-]/g, "")
    .slice(0, 24);
}

function sanitizeCacheKey(key) {
  return String(key || "item")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
}

export function createStore(dataDir) {
  const portfolioFile = join(dataDir, "portfolio.json");
  const preferencesFile = join(dataDir, "preferences.json");
  const secretsFile = join(dataDir, "secrets.json");
  const usageFile = join(dataDir, "usage.json");
  const cacheDir = join(dataDir, "cache");

  const portfolioQueue = createQueue();
  const prefsQueue = createQueue();
  const secretsQueue = createQueue();
  const usageQueue = createQueue();

  function utcDayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  return {
    dataDir,

    async getPreferences() {
      const stored = await readJsonSafe(preferencesFile, DEFAULT_PREFERENCES);
      const currency = SUPPORTED_CURRENCIES.includes(String(stored.currency).toUpperCase())
        ? String(stored.currency).toUpperCase()
        : DEFAULT_PREFERENCES.currency;
      const theme = stored.theme === "dark" ? "dark" : "light";
      const showHighlights =
        typeof stored.showHighlights === "boolean"
          ? stored.showHighlights
          : DEFAULT_PREFERENCES.showHighlights;
      const perPage = [25, 50, 100].includes(Number(stored.perPage))
        ? Number(stored.perPage)
        : DEFAULT_PREFERENCES.perPage;
      const coinLimit =
        parseCoinLimit(stored.coinLimit) ?? DEFAULT_PREFERENCES.coinLimit;
      const refreshIntervalSec = ALLOWED_REFRESH_INTERVALS.includes(
        Number(stored.refreshIntervalSec),
      )
        ? Number(stored.refreshIntervalSec)
        : DEFAULT_PREFERENCES.refreshIntervalSec;
      const autoRefresh =
        typeof stored.autoRefresh === "boolean"
          ? stored.autoRefresh
          : DEFAULT_PREFERENCES.autoRefresh;
      const rawTier = Number(stored.dailyCreditLimit);
      const dailyCreditLimit =
        Number.isFinite(rawTier) && rawTier >= 100 && rawTier <= 10_000_000
          ? Math.round(rawTier)
          : DEFAULT_PREFERENCES.dailyCreditLimit;
      const portfolioSortKey = ALLOWED_PORTFOLIO_SORT_KEYS.includes(stored.portfolioSortKey)
        ? stored.portfolioSortKey
        : DEFAULT_PREFERENCES.portfolioSortKey;
      const portfolioSortDir = ALLOWED_SORT_DIRS.includes(stored.portfolioSortDir)
        ? stored.portfolioSortDir
        : DEFAULT_PREFERENCES.portfolioSortDir;
      const columns = {
        ...DEFAULT_PREFERENCES.columns,
        ...(stored.columns && typeof stored.columns === "object" ? stored.columns : {}),
      };
      for (const k of Object.keys(DEFAULT_PREFERENCES.columns)) {
        columns[k] = Boolean(columns[k]);
      }
      return {
        currency,
        theme,
        showHighlights,
        perPage,
        coinLimit,
        refreshIntervalSec,
        autoRefresh,
        dailyCreditLimit,
        portfolioSortKey,
        portfolioSortDir,
        columns,
      };
    },

    updatePreferences(patch = {}) {
      return prefsQueue(async () => {
        const current = await this.getPreferences();
        const rawTier = Number(patch.dailyCreditLimit);
        const next = {
          ...current,
          ...(patch.currency &&
          SUPPORTED_CURRENCIES.includes(String(patch.currency).toUpperCase())
            ? { currency: String(patch.currency).toUpperCase() }
            : {}),
          ...(patch.theme === "dark" || patch.theme === "light"
            ? { theme: patch.theme }
            : {}),
          ...(typeof patch.showHighlights === "boolean"
            ? { showHighlights: patch.showHighlights }
            : {}),
          ...([25, 50, 100].includes(Number(patch.perPage))
            ? { perPage: Number(patch.perPage) }
            : {}),
          ...(parseCoinLimit(patch.coinLimit) !== null
            ? { coinLimit: parseCoinLimit(patch.coinLimit) }
            : {}),
          ...(ALLOWED_REFRESH_INTERVALS.includes(Number(patch.refreshIntervalSec))
            ? { refreshIntervalSec: Number(patch.refreshIntervalSec) }
            : {}),
          ...(typeof patch.autoRefresh === "boolean"
            ? { autoRefresh: patch.autoRefresh }
            : {}),
          ...(Number.isFinite(rawTier) && rawTier >= 100 && rawTier <= 10_000_000
            ? { dailyCreditLimit: Math.round(rawTier) }
            : {}),
          ...(ALLOWED_PORTFOLIO_SORT_KEYS.includes(patch.portfolioSortKey)
            ? { portfolioSortKey: patch.portfolioSortKey }
            : {}),
          ...(ALLOWED_SORT_DIRS.includes(patch.portfolioSortDir)
            ? { portfolioSortDir: patch.portfolioSortDir }
            : {}),
          columns: {
            ...current.columns,
            ...(patch.columns && typeof patch.columns === "object"
              ? Object.fromEntries(
                  Object.keys(DEFAULT_PREFERENCES.columns)
                    .filter((k) => typeof patch.columns[k] === "boolean")
                    .map((k) => [k, patch.columns[k]]),
                )
              : {}),
          },
        };
        await atomicWriteJson(preferencesFile, next);
        return next;
      });
    },

    async readUsageRaw() {
      const today = utcDayKey();
      const stored = await readJsonSafe(usageFile, { day: today, requests: 0 });
      if (stored.day !== today) {
        return { day: today, requests: 0 };
      }
      const requests = Number.isInteger(stored.requests) && stored.requests >= 0 ? stored.requests : 0;
      return { day: today, requests };
    },

    getUsageToday() {
      return usageQueue(() => this.readUsageRaw());
    },

    recordApiRequests(count = 1) {
      const delta = Math.max(0, Math.round(Number(count) || 0));
      if (delta === 0) return this.getUsageToday();
      return usageQueue(async () => {
        const current = await this.readUsageRaw();
        const next = { day: current.day, requests: current.requests + delta };
        try {
          await atomicWriteJson(usageFile, next);
        } catch {
          // Best-effort telemetry persistence.
        }
        return next;
      });
    },

    async getPortfolio() {
      const stored = await readJsonSafe(portfolioFile, DEFAULT_PORTFOLIO);
      const watchlist = Array.isArray(stored.watchlist)
        ? [...new Set(stored.watchlist.map(sanitizeCode).filter(Boolean))]
        : [];
      const holdings = {};
      if (stored.holdings && typeof stored.holdings === "object") {
        for (const [rawCode, entry] of Object.entries(stored.holdings)) {
          const code = sanitizeCode(rawCode);
          if (!code || !entry || typeof entry !== "object") continue;
          const quantity = Number(entry.quantity);
          if (!Number.isFinite(quantity) || quantity < 0) continue;
          const avgCost =
            entry.avgCost === null || entry.avgCost === undefined || entry.avgCost === ""
              ? null
              : Number(entry.avgCost);
          holdings[code] = {
            quantity,
            avgCost: Number.isFinite(avgCost) && avgCost >= 0 ? avgCost : null,
            updatedAt: Number(entry.updatedAt) || Date.now(),
          };
        }
      }
      return { watchlist, holdings };
    },

    toggleWatchlist(rawCode) {
      return portfolioQueue(async () => {
        const code = sanitizeCode(rawCode);
        if (!code) throw new Error("Invalid coin code");
        const current = await this.getPortfolio();
        const exists = current.watchlist.includes(code);
        const watchlist = exists
          ? current.watchlist.filter((c) => c !== code)
          : [...current.watchlist, code];
        const next = { watchlist, holdings: current.holdings };
        await atomicWriteJson(portfolioFile, next);
        return { portfolio: next, starred: !exists, code };
      });
    },

    setHolding(rawCode, { quantity, avgCost }) {
      return portfolioQueue(async () => {
        const code = sanitizeCode(rawCode);
        if (!code) throw new Error("Invalid coin code");
        const qty = Number(quantity);
        if (!Number.isFinite(qty) || qty < 0) {
          throw new Error("Quantity must be a non-negative number");
        }
        const parsedAvg =
          avgCost === null || avgCost === undefined || avgCost === ""
            ? null
            : Number(avgCost);
        if (parsedAvg !== null && (!Number.isFinite(parsedAvg) || parsedAvg < 0)) {
          throw new Error("Average cost must be a non-negative number");
        }

        const current = await this.getPortfolio();
        const watchlist = current.watchlist.includes(code)
          ? current.watchlist
          : [...current.watchlist, code];
        const holdings = { ...current.holdings };
        if (qty === 0) {
          delete holdings[code];
        } else {
          holdings[code] = {
            quantity: qty,
            avgCost: parsedAvg,
            updatedAt: Date.now(),
          };
        }
        const next = { watchlist, holdings };
        await atomicWriteJson(portfolioFile, next);
        return next;
      });
    },

    deleteHolding(rawCode) {
      return portfolioQueue(async () => {
        const code = sanitizeCode(rawCode);
        if (!code) throw new Error("Invalid coin code");
        const current = await this.getPortfolio();
        const holdings = { ...current.holdings };
        delete holdings[code];
        const next = { watchlist: current.watchlist, holdings };
        await atomicWriteJson(portfolioFile, next);
        return next;
      });
    },

    async getSavedApiKey() {
      const stored = await readJsonSafe(secretsFile, { liveCoinWatchApiKey: null });
      const key =
        typeof stored.liveCoinWatchApiKey === "string"
          ? stored.liveCoinWatchApiKey.trim()
          : "";
      return key || null;
    },

    setSavedApiKey(rawKey) {
      return secretsQueue(async () => {
        const key = typeof rawKey === "string" ? rawKey.trim() : "";
        if (!key) {
          throw new Error("API key cannot be empty");
        }
        await atomicWriteJson(
          secretsFile,
          { liveCoinWatchApiKey: key, updatedAt: Date.now() },
          { mode: 0o600 },
        );
      });
    },

    clearSavedApiKey() {
      return secretsQueue(async () => {
        try {
          await rm(secretsFile, { force: true });
        } catch {
          // Ignore if already absent.
        }
      });
    },

    async readCache(key) {
      const file = join(cacheDir, `${sanitizeCacheKey(key)}.json`);
      return readJsonSafe(file, null);
    },

    async writeCache(key, entry) {
      const file = join(cacheDir, `${sanitizeCacheKey(key)}.json`);
      try {
        await atomicWriteJson(file, entry);
      } catch {
        // Disk cache writes are best-effort; never fail an HTTP request on cache error.
      }
    },

    async clearCache() {
      try {
        const entries = await readdir(cacheDir);
        await Promise.all(
          entries.map((name) => rm(join(cacheDir, name), { force: true })),
        );
      } catch (err) {
        if (err.code !== "ENOENT") {
          // Best-effort clear.
        }
      }
    },
  };
}
