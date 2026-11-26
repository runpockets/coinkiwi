// Live Coin Watch API client (POST + x-api-key) and optional Alternative.me
// Fear & Greed fetcher (GET, Pockets HTTPS gateway compatible).
// Never logs or returns raw API keys in errors.

export const DEFAULT_LCW_BASE_URL = "https://api.livecoinwatch.com";
export const DEFAULT_FNG_URL = "https://api.alternative.me/fng/?limit=1";
export const DEFAULT_CG_PLATFORMS_URL =
  "https://api.coingecko.com/api/v3/coins/list?include_platform=true";

export class LcwApiError extends Error {
  constructor(message, { status = 500, code = "LCW_ERROR" } = {}) {
    super(message);
    this.name = "LcwApiError";
    this.status = status;
    this.code = code;
  }
}

export function buildGatewayUrl(gatewayBase, targetUrl) {
  const base = String(gatewayBase || "").replace(/\/+$/, "");
  return `${base}/fetch?url=${encodeURIComponent(targetUrl)}`;
}

export function createLcwClient(options = {}) {
  const baseUrl = String(options.baseUrl || DEFAULT_LCW_BASE_URL).replace(/\/+$/, "");
  const fngUrl = options.fngUrl || DEFAULT_FNG_URL;
  const cgPlatformsUrl = options.cgPlatformsUrl || DEFAULT_CG_PLATFORMS_URL;
  const timeoutMs = Number(options.timeoutMs) || 15_000;
  const maxRetries = Number.isInteger(options.retries) ? options.retries : 1;
  const retryDelayMs = Number(options.retryDelayMs) || 350;
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  async function post(path, apiKey, body = {}) {
    if (!apiKey) {
      throw new LcwApiError("Live Coin Watch API key is not configured.", {
        status: 401,
        code: "NO_API_KEY",
      });
    }

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      let res;
      try {
        res = await fetchImpl(`${baseUrl}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
          continue;
        }
        throw new LcwApiError("Unable to reach Live Coin Watch API.", {
          status: 503,
          code: err?.name === "TimeoutError" ? "TIMEOUT" : "NETWORK_ERROR",
        });
      }

      let parsed = null;
      try {
        parsed = await res.json();
      } catch {
        parsed = null;
      }

      if (!res.ok) {
        const apiMsg = parsed?.error?.description || parsed?.error?.status;
        if (res.status === 401 || res.status === 403) {
          throw new LcwApiError(
            apiMsg || "Invalid Live Coin Watch API key. Please check your key and try again.",
            { status: 401, code: "INVALID_API_KEY" },
          );
        }
        if (res.status === 429) {
          throw new LcwApiError(
            apiMsg || "Live Coin Watch daily credit or rate limit reached.",
            { status: 429, code: "RATE_LIMITED" },
          );
        }
        if (res.status >= 500 && attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
          continue;
        }
        throw new LcwApiError(
          apiMsg || `Live Coin Watch API returned HTTP ${res.status}.`,
          { status: res.status, code: "UPSTREAM_ERROR" },
        );
      }

      return parsed;
    }
  }

  return {
    checkCredits(apiKey) {
      return post("/credits", apiKey, {});
    },

    getOverview(apiKey, currency = "USD") {
      return post("/overview", apiKey, { currency });
    },

    getOverviewHistory(apiKey, { currency = "USD", start, end }) {
      return post("/overview/history", apiKey, { currency, start, end });
    },

    getCoinsList(
      apiKey,
      {
        currency = "USD",
        sort = "rank",
        order = "ascending",
        offset = 0,
        limit = 100,
        meta = true,
      } = {},
    ) {
      return post("/coins/list", apiKey, {
        currency,
        sort,
        order,
        offset,
        limit,
        meta,
      });
    },

    getCoinsMap(
      apiKey,
      {
        codes = [],
        currency = "USD",
        sort = "rank",
        order = "ascending",
        offset = 0,
        limit,
        meta = true,
      } = {},
    ) {
      return post("/coins/map", apiKey, {
        codes,
        currency,
        sort,
        order,
        offset,
        limit: limit ?? codes.length,
        meta,
      });
    },

    getCoinSingle(apiKey, { currency = "USD", code, meta = true }) {
      return post("/coins/single", apiKey, {
        currency,
        code,
        meta,
      });
    },

    getCoinHistory(apiKey, { currency = "USD", code, start, end, meta = false }) {
      return post("/coins/single/history", apiKey, {
        currency,
        code,
        start,
        end,
        meta,
      });
    },

    getExchangesList(
      apiKey,
      {
        currency = "USD",
        sort = "volume",
        order = "descending",
        limit = 100,
        offset = 0,
        meta = true,
      } = {},
    ) {
      return post("/exchanges/list", apiKey, {
        currency,
        sort,
        order,
        offset,
        limit,
        meta,
      });
    },

    async getFearAndGreed({ gatewayUrl } = {}) {
      const target = gatewayUrl ? buildGatewayUrl(gatewayUrl, fngUrl) : fngUrl;
      const res = await fetchImpl(target, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        throw new Error(`Fear & Greed HTTP ${res.status}`);
      }
      const data = await res.json();
      const first = data?.data?.[0];
      if (!first) throw new Error("Missing Fear & Greed payload");
      return {
        value: Number(first.value),
        classification: String(first.value_classification || "Neutral"),
        updatedAt: Number(first.timestamp) ? Number(first.timestamp) * 1000 : Date.now(),
        isSample: false,
      };
    },

    async getCoinGeckoPlatforms({ gatewayUrl } = {}) {
      const target = gatewayUrl
        ? buildGatewayUrl(gatewayUrl, cgPlatformsUrl)
        : cgPlatformsUrl;
      const res = await fetchImpl(target, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        throw new Error(`CoinGecko platforms HTTP ${res.status}`);
      }
      const data = await res.json();
      if (!Array.isArray(data)) {
        throw new Error("Invalid CoinGecko platforms payload");
      }
      return data;
    },
  };
}
