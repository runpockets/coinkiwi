// Market data orchestration layer for CoinKiwi:
// - Enforces Live Coin Watch (api.livecoinwatch.com) as the market provider
// - Supports LIVECOINWATCH_API_KEY env var OR server-persisted key in DATA_DIR
// - Two-tier memory + disk cache with in-flight request deduplication
// - Graceful stale-on-error and clearly labeled sample fallback

import { createLcwClient, LcwApiError } from "./lcw-client.js";
import {
  generateSeries,
  getSampleCoinHistory,
  getSampleCoins,
  getSampleExchanges,
  getSampleFearAndGreed,
  getSampleOverview,
  SAMPLE_FX,
} from "./sample-data.js";
import { SUPPORTED_CURRENCIES } from "./store.js";

const TTL_MARKETS_MS = 180_000; // 3m (10 pages = 10 credits -> <=4,800/day even 24/7)
const TTL_OVERVIEW_MS = 120_000; // 2m
const TTL_OVERVIEW_HISTORY_MS = 5 * 60_000; // 5m
const TTL_COIN_DETAIL_MS = 3 * 60_000; // 3m
const TTL_COIN_HISTORY_MS = 5 * 60_000; // 5m
const TTL_SPARKLINE_MS = 6 * 60 * 60_000; // 6h (saves LCW daily credits)
const TTL_COIN_META_MS = 24 * 60 * 60_000; // 24h (contracts/chains/links rarely change)
const TTL_CG_PLATFORMS_MS = 24 * 60 * 60_000; // 24h (1 keyless GET covers all 15,000+ coins)
const TTL_EXCHANGES_MS = 15 * 60_000; // 15m
const TTL_FNG_MS = 30 * 60_000; // 30m
const TTL_FX_MS = 6 * 60 * 60_000; // 6h (4 tiny LCW calls -> 0-credit instant currency switching)
const TTL_CREDITS_MS = 60_000; // 1m
const FX_FIATS = ["NZD", "EUR", "GBP", "AUD"];
const MARKETS_PAGE_SIZE = 100;
const MARKETS_MAX_PAGES = 250; // Supports up to 25,000 coins (default 1,000)

const FALLBACK_COLORS = [
  "#F7931A",
  "#627EEA",
  "#26A17B",
  "#9945FF",
  "#2775CA",
  "#E84142",
  "#0098EA",
  "#B6509E",
  "#00C08B",
  "#4DA2FF",
  "#E6007A",
  "#345D9D",
];

const CATEGORY_MAP = new Map([
  ["layer1", "Layer 1"],
  ["layer-1", "Layer 1"],
  ["layer_1", "Layer 1"],
  ["smart_contract_platforms", "Smart Contract Platform"],
  ["smart-contract-platform", "Smart Contract Platform"],
  ["smart_contracts", "Smart Contract Platform"],
  ["defi", "DeFi"],
  ["decentralized_finance", "DeFi"],
  ["stablecoins", "Stablecoins"],
  ["stablecoin", "Stablecoins"],
  ["usd_stablecoin", "Stablecoins"],
  ["meme", "Meme"],
  ["memes", "Meme"],
  ["ai", "AI"],
  ["artificial_intelligence", "AI"],
  ["exchange", "Exchange"],
  ["centralized_exchange", "Exchange"],
  ["dex", "DeFi"],
  ["gaming", "Gaming"],
  ["nft", "NFT"],
  ["layer2", "Layer 2"],
  ["layer_2", "Layer 2"],
]);

function normalizeCurrency(raw) {
  const upper = String(raw || "USD").toUpperCase();
  return SUPPORTED_CURRENCIES.includes(upper) ? upper : "USD";
}

function normalizeCode(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9._-]/g, "")
    .slice(0, 24);
}

export function deltaToPercent(ratio) {
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio <= 0) {
    return null;
  }
  return Number(((ratio - 1) * 100).toFixed(2));
}

export function maskApiKey(key) {
  if (!key || typeof key !== "string") return null;
  const trimmed = key.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 6) return "••••";
  return `••••${trimmed.slice(-4)}`;
}

function colorForCode(code) {
  let sum = 0;
  for (let i = 0; i < code.length; i += 1) {
    sum = (sum * 31 + code.charCodeAt(i)) >>> 0;
  }
  return FALLBACK_COLORS[sum % FALLBACK_COLORS.length];
}

const KNOWN_COIN_CATEGORIES = {
  // Stablecoins
  USDT: ["Stablecoins"],
  USDC: ["Stablecoins"],
  USDS: ["Stablecoins", "DeFi"],
  USDE: ["Stablecoins", "DeFi"],
  DAI: ["Stablecoins", "DeFi"],
  FDUSD: ["Stablecoins"],
  PYUSD: ["Stablecoins"],
  RLUSD: ["Stablecoins"],
  TUSD: ["Stablecoins"],
  FRAX: ["Stablecoins", "DeFi"],
  USDD: ["Stablecoins"],
  USD0: ["Stablecoins", "DeFi"],
  USD1: ["Stablecoins"],
  USDY: ["Stablecoins", "DeFi"],
  GHO: ["Stablecoins", "DeFi"],
  CRVUSD: ["Stablecoins", "DeFi"],
  EURC: ["Stablecoins"],
  XAUT: ["Stablecoins"],
  PAXG: ["Stablecoins"],
  // Meme coins
  DOGE: ["Meme", "Layer 1"],
  SHIB: ["Meme"],
  PEPE: ["Meme"],
  TRUMP: ["Meme"],
  BONK: ["Meme"],
  PENGU: ["Meme"],
  WIF: ["Meme"],
  FLOKI: ["Meme"],
  SPX: ["Meme"],
  FARTCOIN: ["Meme"],
  BRETT: ["Meme"],
  POPCAT: ["Meme"],
  MOG: ["Meme"],
  BOME: ["Meme"],
  MEW: ["Meme"],
  TURBO: ["Meme"],
  PNUT: ["Meme"],
  NEIRO: ["Meme"],
  MEME: ["Meme"],
  TOSHI: ["Meme"],
  // Layer 2
  ARB: ["Layer 2", "DeFi"],
  OP: ["Layer 2", "DeFi"],
  POL: ["Layer 2", "Smart Contract Platform"],
  MATIC: ["Layer 2", "Smart Contract Platform"],
  MNT: ["Layer 2", "Smart Contract Platform"],
  IMX: ["Layer 2"],
  STRK: ["Layer 2"],
  ZK: ["Layer 2"],
  STX: ["Layer 2"],
  METIS: ["Layer 2"],
  // AI
  TAO: ["AI", "Layer 1"],
  NEAR: ["AI", "Layer 1", "Smart Contract Platform"],
  ICP: ["AI", "Layer 1", "Smart Contract Platform"],
  RENDER: ["AI"],
  RNDR: ["AI"],
  FET: ["AI"],
  VIRTUAL: ["AI"],
  GRT: ["AI", "DeFi"],
  AKT: ["AI"],
  AR: ["AI"],
  AIOZ: ["AI"],
  IO: ["AI"],
  OCEAN: ["AI"],
  // DeFi
  UNI: ["DeFi"],
  AAVE: ["DeFi"],
  LINK: ["DeFi"],
  HYPE: ["DeFi", "Layer 1"],
  ONDO: ["DeFi"],
  ENA: ["DeFi"],
  JUP: ["DeFi"],
  LDO: ["DeFi"],
  PENDLE: ["DeFi"],
  CRV: ["DeFi"],
  MKR: ["DeFi"],
  SKY: ["DeFi"],
  RAY: ["DeFi"],
  CAKE: ["DeFi"],
  COMP: ["DeFi"],
  SNX: ["DeFi"],
  DYDX: ["DeFi"],
  GMX: ["DeFi"],
  RUNE: ["DeFi"],
  // Layer 1
  BTC: ["Layer 1"],
  ETH: ["Layer 1", "Smart Contract Platform", "DeFi"],
  BNB: ["Layer 1", "Smart Contract Platform"],
  XRP: ["Layer 1"],
  SOL: ["Layer 1", "Smart Contract Platform", "DeFi"],
  TRX: ["Layer 1", "Smart Contract Platform"],
  ADA: ["Layer 1", "Smart Contract Platform"],
  AVAX: ["Layer 1", "Smart Contract Platform", "DeFi"],
  SUI: ["Layer 1", "Smart Contract Platform"],
  TON: ["Layer 1", "Smart Contract Platform"],
  HBAR: ["Layer 1", "Smart Contract Platform"],
  LTC: ["Layer 1"],
  BCH: ["Layer 1"],
  DOT: ["Layer 1", "Smart Contract Platform"],
  XLM: ["Layer 1"],
  XMR: ["Layer 1"],
  APT: ["Layer 1", "Smart Contract Platform"],
  ATOM: ["Layer 1"],
  KAS: ["Layer 1"],
  SEI: ["Layer 1"],
  ALGO: ["Layer 1"],
};

function normalizeCategories(rawList, code = "") {
  const out = [];
  const add = (label) => {
    if (label && !out.includes(label)) out.push(label);
  };

  if (Array.isArray(rawList)) {
    for (const item of rawList) {
      const raw = String(item || "").trim();
      if (!raw) continue;
      const key = raw.toLowerCase().replace(/[\s-]+/g, "_");
      if (CATEGORY_MAP.has(key)) {
        add(CATEGORY_MAP.get(key));
      } else if (key.includes("stable")) {
        add("Stablecoins");
      } else if (
        key.includes("meme") ||
        key.includes("dog_themed") ||
        key.includes("cat_themed") ||
        key.includes("frog")
      ) {
        add("Meme");
      } else if (
        key === "ai" ||
        key.includes("artificial_intelligence") ||
        key.includes("ai_agent") ||
        key.includes("machine_learning")
      ) {
        add("AI");
      } else if (
        key.includes("layer_2") ||
        key.includes("layer2") ||
        key.includes("rollup")
      ) {
        add("Layer 2");
      } else if (key.includes("layer_1") || key.includes("layer1")) {
        add("Layer 1");
      } else if (key.includes("smart_contract")) {
        add("Smart Contract Platform");
      } else if (
        key.includes("defi") ||
        key.includes("dex") ||
        key.includes("lending") ||
        key.includes("staking") ||
        key.includes("yield")
      ) {
        add("DeFi");
      } else {
        add(
          raw
            .replace(/[_-]+/g, " ")
            .replace(/\b\w/g, (ch) => ch.toUpperCase()),
        );
      }
    }
  }

  const known = KNOWN_COIN_CATEGORIES[normalizeCode(code)];
  if (known) {
    for (const cat of known) add(cat);
  }
  return out;
}

const CHAIN_REGISTRY = {
  BTC: { name: "Bitcoin", home: "https://mempool.space/" },
  BITCOIN: { name: "Bitcoin", home: "https://mempool.space/" },
  ETH: { name: "Ethereum", home: "https://etherscan.io/", token: (a) => `https://etherscan.io/token/${encodeURIComponent(a)}` },
  ETHEREUM: { name: "Ethereum", home: "https://etherscan.io/", token: (a) => `https://etherscan.io/token/${encodeURIComponent(a)}` },
  ERC20: { name: "Ethereum", home: "https://etherscan.io/", token: (a) => `https://etherscan.io/token/${encodeURIComponent(a)}` },
  SOL: { name: "Solana", home: "https://solscan.io/", token: (a) => `https://solscan.io/token/${encodeURIComponent(a)}` },
  SOLANA: { name: "Solana", home: "https://solscan.io/", token: (a) => `https://solscan.io/token/${encodeURIComponent(a)}` },
  BNB: { name: "BNB Smart Chain", home: "https://bscscan.com/", token: (a) => `https://bscscan.com/token/${encodeURIComponent(a)}` },
  BSC: { name: "BNB Smart Chain", home: "https://bscscan.com/", token: (a) => `https://bscscan.com/token/${encodeURIComponent(a)}` },
  BINANCE_SMART_CHAIN: { name: "BNB Smart Chain", home: "https://bscscan.com/", token: (a) => `https://bscscan.com/token/${encodeURIComponent(a)}` },
  BASE: { name: "Base", home: "https://basescan.org/", token: (a) => `https://basescan.org/token/${encodeURIComponent(a)}` },
  ARB: { name: "Arbitrum", home: "https://arbiscan.io/", token: (a) => `https://arbiscan.io/token/${encodeURIComponent(a)}` },
  ARBITRUM: { name: "Arbitrum", home: "https://arbiscan.io/", token: (a) => `https://arbiscan.io/token/${encodeURIComponent(a)}` },
  ARBITRUM_ONE: { name: "Arbitrum", home: "https://arbiscan.io/", token: (a) => `https://arbiscan.io/token/${encodeURIComponent(a)}` },
  OP: { name: "Optimism", home: "https://optimistic.etherscan.io/", token: (a) => `https://optimistic.etherscan.io/token/${encodeURIComponent(a)}` },
  OPTIMISM: { name: "Optimism", home: "https://optimistic.etherscan.io/", token: (a) => `https://optimistic.etherscan.io/token/${encodeURIComponent(a)}` },
  OPTIMISTIC_ETHEREUM: { name: "Optimism", home: "https://optimistic.etherscan.io/", token: (a) => `https://optimistic.etherscan.io/token/${encodeURIComponent(a)}` },
  POL: { name: "Polygon", home: "https://polygonscan.com/", token: (a) => `https://polygonscan.com/token/${encodeURIComponent(a)}` },
  MATIC: { name: "Polygon", home: "https://polygonscan.com/", token: (a) => `https://polygonscan.com/token/${encodeURIComponent(a)}` },
  POLYGON: { name: "Polygon", home: "https://polygonscan.com/", token: (a) => `https://polygonscan.com/token/${encodeURIComponent(a)}` },
  POLYGON_POS: { name: "Polygon", home: "https://polygonscan.com/", token: (a) => `https://polygonscan.com/token/${encodeURIComponent(a)}` },
  AVAX: { name: "Avalanche", home: "https://snowtrace.io/", token: (a) => `https://snowtrace.io/token/${encodeURIComponent(a)}` },
  AVALANCHE: { name: "Avalanche", home: "https://snowtrace.io/", token: (a) => `https://snowtrace.io/token/${encodeURIComponent(a)}` },
  TRX: { name: "TRON", home: "https://tronscan.org/", token: (a) => `https://tronscan.org/#/token20/${encodeURIComponent(a)}` },
  TRON: { name: "TRON", home: "https://tronscan.org/", token: (a) => `https://tronscan.org/#/token20/${encodeURIComponent(a)}` },
  SUI: { name: "Sui", home: "https://suiscan.xyz/", token: (a) => `https://suiscan.xyz/mainnet/coin/${encodeURIComponent(a)}` },
  TON: { name: "TON", home: "https://tonviewer.com/", token: (a) => `https://tonviewer.com/${encodeURIComponent(a)}` },
  THE_OPEN_NETWORK: { name: "TON", home: "https://tonviewer.com/", token: (a) => `https://tonviewer.com/${encodeURIComponent(a)}` },
  ADA: { name: "Cardano", home: "https://cardanoscan.io/" },
  CARDANO: { name: "Cardano", home: "https://cardanoscan.io/" },
  XRP: { name: "XRP Ledger", home: "https://xrpscan.com/" },
  XRPL: { name: "XRP Ledger", home: "https://xrpscan.com/" },
  DOGE: { name: "Dogecoin", home: "https://dogechain.info/" },
  LTC: { name: "Litecoin", home: "https://litecoinspace.org/" },
  BCH: { name: "Bitcoin Cash", home: "https://blockchair.com/bitcoin-cash" },
  DOT: { name: "Polkadot", home: "https://polkadot.subscan.io/" },
  NEAR: { name: "NEAR Protocol", home: "https://nearblocks.io/", token: (a) => `https://nearblocks.io/token/${encodeURIComponent(a)}` },
  NEAR_PROTOCOL: { name: "NEAR Protocol", home: "https://nearblocks.io/", token: (a) => `https://nearblocks.io/token/${encodeURIComponent(a)}` },
  HBAR: { name: "Hedera", home: "https://hashscan.io/mainnet/", token: (a) => `https://hashscan.io/mainnet/token/${encodeURIComponent(a)}` },
  HEDERA_HASHGRAPH: { name: "Hedera", home: "https://hashscan.io/mainnet/", token: (a) => `https://hashscan.io/mainnet/token/${encodeURIComponent(a)}` },
  FTM: { name: "Fantom", home: "https://ftmscan.com/", token: (a) => `https://ftmscan.com/token/${encodeURIComponent(a)}` },
  FANTOM: { name: "Fantom", home: "https://ftmscan.com/", token: (a) => `https://ftmscan.com/token/${encodeURIComponent(a)}` },
  SONIC: { name: "Sonic", home: "https://sonicscan.org/", token: (a) => `https://sonicscan.org/token/${encodeURIComponent(a)}` },
  CRO: { name: "Cronos", home: "https://cronoscan.com/", token: (a) => `https://cronoscan.com/token/${encodeURIComponent(a)}` },
  CRONOS: { name: "Cronos", home: "https://cronoscan.com/", token: (a) => `https://cronoscan.com/token/${encodeURIComponent(a)}` },
  MNT: { name: "Mantle", home: "https://mantlescan.xyz/", token: (a) => `https://mantlescan.xyz/token/${encodeURIComponent(a)}` },
  MANTLE: { name: "Mantle", home: "https://mantlescan.xyz/", token: (a) => `https://mantlescan.xyz/token/${encodeURIComponent(a)}` },
  STRK: { name: "Starknet", home: "https://starkscan.co/", token: (a) => `https://starkscan.co/contract/${encodeURIComponent(a)}` },
  STARKNET: { name: "Starknet", home: "https://starkscan.co/", token: (a) => `https://starkscan.co/contract/${encodeURIComponent(a)}` },
  ZKSYNC: { name: "zkSync Era", home: "https://explorer.zksync.io/", token: (a) => `https://explorer.zksync.io/address/${encodeURIComponent(a)}` },
  LINEA: { name: "Linea", home: "https://lineascan.build/", token: (a) => `https://lineascan.build/token/${encodeURIComponent(a)}` },
  SCROLL: { name: "Scroll", home: "https://scrollscan.com/", token: (a) => `https://scrollscan.com/token/${encodeURIComponent(a)}` },
  BLAST: { name: "Blast", home: "https://blastscan.io/", token: (a) => `https://blastscan.io/token/${encodeURIComponent(a)}` },
  GNOSIS: { name: "Gnosis", home: "https://gnosisscan.io/", token: (a) => `https://gnosisscan.io/token/${encodeURIComponent(a)}` },
  XDAI: { name: "Gnosis", home: "https://gnosisscan.io/", token: (a) => `https://gnosisscan.io/token/${encodeURIComponent(a)}` },
  CELO: { name: "Celo", home: "https://celoscan.io/", token: (a) => `https://celoscan.io/token/${encodeURIComponent(a)}` },
  RONIN: { name: "Ronin", home: "https://app.roninchain.com/", token: (a) => `https://app.roninchain.com/token/${encodeURIComponent(a)}` },
  BERACHAIN: { name: "Berachain", home: "https://berascan.com/", token: (a) => `https://berascan.com/token/${encodeURIComponent(a)}` },
  ALGORAND: { name: "Algorand", home: "https://explorer.perawallet.app/" },
  STELLAR: { name: "Stellar", home: "https://stellar.expert/explorer/public" },
  APT: { name: "Aptos", home: "https://explorer.aptoslabs.com/" },
  APTOS: { name: "Aptos", home: "https://explorer.aptoslabs.com/" },
  ATOM: { name: "Cosmos", home: "https://www.mintscan.io/cosmos" },
  COSMOS: { name: "Cosmos", home: "https://www.mintscan.io/cosmos" },
  OSMOSIS: { name: "Osmosis", home: "https://www.mintscan.io/osmosis" },
  SEI_NETWORK: { name: "Sei", home: "https://seitrace.com/" },
  TAO: { name: "Bittensor", home: "https://taostats.io/" },
  ICP: { name: "Internet Computer", home: "https://dashboard.internetcomputer.org/" },
  HYPE: { name: "Hyperliquid", home: "https://app.hyperliquid.xyz/explorer" },
  HYPERLIQUID: { name: "Hyperliquid", home: "https://app.hyperliquid.xyz/explorer" },
};

const CHAIN_PRIORITY = [
  "Ethereum",
  "Solana",
  "Base",
  "Arbitrum",
  "BNB Smart Chain",
  "Polygon",
  "Optimism",
  "Avalanche",
  "TRON",
  "Sui",
  "TON",
];

function sortContractsByPriority(list) {
  return [...list].sort((a, b) => {
    const idxA = CHAIN_PRIORITY.indexOf(a.chain);
    const idxB = CHAIN_PRIORITY.indexOf(b.chain);
    const rankA = idxA === -1 ? 999 : idxA;
    const rankB = idxB === -1 ? 999 : idxB;
    if (rankA !== rankB) return rankA - rankB;
    return a.chain.localeCompare(b.chain);
  });
}

function normName(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function buildPlatformIndex(cgList) {
  const bySymName = new Map();
  const byName = new Map();
  const bySym = new Map();

  for (const item of cgList) {
    if (!item || typeof item !== "object") continue;
    const rawPlatforms = item.platforms;
    if (!rawPlatforms || typeof rawPlatforms !== "object") continue;
    const entries = Object.entries(rawPlatforms).filter(
      ([k, v]) => k && typeof v === "string" && v.trim().length > 0,
    );
    if (entries.length === 0) continue;

    const sym = String(item.symbol || "").trim().toLowerCase();
    const name = normName(item.name);
    const id = String(item.id || "").trim().toLowerCase();
    const platforms = Object.fromEntries(entries.map(([k, v]) => [k, v.trim()]));
    const record = { id, sym, name, platforms, count: entries.length };

    if (sym && name) {
      const k = `${sym}|${name}`;
      const prev = bySymName.get(k);
      if (!prev || record.count > prev.count) bySymName.set(k, record);
    }
    if (name) {
      const prev = byName.get(name);
      if (!prev || record.count > prev.count) byName.set(name, record);
    }
    if (sym) {
      if (!bySym.has(sym)) bySym.set(sym, []);
      bySym.get(sym).push(record);
    }
  }

  for (const list of bySym.values()) {
    list.sort((a, b) => b.count - a.count);
  }

  return { bySymName, byName, bySym };
}

function matchPlatformsFromIndex(index, code, coinName) {
  if (!index) return null;
  const sym = normalizeCode(code).replace(/^_+/, "").toLowerCase();
  const name = normName(coinName);

  // 1. Exact (symbol + name) match
  const exact = index.bySymName.get(`${sym}|${name}`);
  if (exact) return exact.platforms;

  // 2. Exact name match
  const byName = index.byName.get(name);
  if (byName && (!sym || byName.sym === sym || byName.count >= 2)) {
    return byName.platforms;
  }

  // 3. Symbol match — prefer candidate whose name matches/contains coinName, else
  //    canonical multi-chain token (e.g., USDC -> usd-coin) when symbol is unambiguous.
  const candidates = index.bySym.get(sym);
  if (!candidates || candidates.length === 0) return null;

  if (name) {
    const nameMatch = candidates.find(
      (c) =>
        c.name === name ||
        c.name.includes(name) ||
        name.includes(c.name) ||
        (sym === "usdc" && c.id === "usd-coin") ||
        (sym === "usdt" && c.id === "tether"),
    );
    if (nameMatch) return nameMatch.platforms;
  }

  // Only fall back to top symbol candidate if there's 1 match or a clear dominant canonical token
  if (candidates.length === 1 || candidates[0].count >= 3) {
    return candidates[0].platforms;
  }
  return null;
}

function lookupChain(rawChain) {
  const key = String(rawChain || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  const entry = CHAIN_REGISTRY[key];
  if (entry) return { key, ...entry };
  if (!key) return null;
  const label = String(rawChain)
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
  return { key, name: label, home: null, token: null };
}

function extractContractsAndChains(raw, code) {
  const contracts = [];
  const chains = [];
  const seenContract = new Set();
  const seenChain = new Set();

  const addChain = (rawChain) => {
    const info = lookupChain(rawChain);
    if (!info || seenChain.has(info.name)) return info;
    seenChain.add(info.name);
    chains.push({
      code: info.key,
      name: info.name,
      explorerUrl: info.home || null,
    });
    return info;
  };

  const addContract = (rawChain, rawAddr) => {
    const addr = typeof rawAddr === "string" ? rawAddr.trim() : "";
    const info = addChain(rawChain);
    if (!addr) return;
    const dedup = `${info?.name || rawChain}:${addr.toLowerCase()}`;
    if (seenContract.has(dedup)) return;
    seenContract.add(dedup);
    contracts.push({
      chainCode: info?.key || String(rawChain || "").toUpperCase(),
      chain: info?.name || String(rawChain || "Contract"),
      address: addr,
      explorerUrl: info?.token ? info.token(addr) : info?.home || null,
    });
  };

  // Handle Live Coin Watch `contracts` object ({ ETH: "0x...", SOL: "..." }) or array
  if (raw.contracts && typeof raw.contracts === "object") {
    if (Array.isArray(raw.contracts)) {
      for (const item of raw.contracts) {
        if (item && typeof item === "object") {
          addContract(item.platform || item.chain || item.code, item.address || item.contract);
        }
      }
    } else {
      for (const [chainKey, addr] of Object.entries(raw.contracts)) {
        addContract(chainKey, addr);
      }
    }
  }

  // Handle Live Coin Watch `platforms` object ({ ETH: "0x..." | "" }) or array (["ETH"])
  if (raw.platforms && typeof raw.platforms === "object") {
    if (Array.isArray(raw.platforms)) {
      for (const p of raw.platforms) {
        if (typeof p === "string") addChain(p);
        else if (p && typeof p === "object") addContract(p.platform || p.code || p.name, p.address || p.contract);
      }
    } else {
      for (const [chainKey, val] of Object.entries(raw.platforms)) {
        if (typeof val === "string" && (val.startsWith("0x") || val.length >= 24)) {
          addContract(chainKey, val);
        } else {
          addChain(chainKey);
        }
      }
    }
  }

  // Handle single-chain fields if present
  if (raw.platform || raw.contract || raw.address) {
    addContract(raw.platform || code, raw.contract || raw.address);
  }

  // If no explicit chain returned yet and this coin itself is a known native L1/L2, attach its native chain
  if (chains.length === 0) {
    const clean = normalizeCode(code).replace(/^_+/, "");
    if (CHAIN_REGISTRY[clean]) {
      addChain(clean);
    }
  }

  return { contracts: sortContractsByPriority(contracts), chains };
}

function cleanLinks(rawLinks) {
  if (!rawLinks || typeof rawLinks !== "object") return {};
  const allowed = [
    "website",
    "whitepaper",
    "twitter",
    "reddit",
    "telegram",
    "discord",
    "medium",
    "github",
  ];
  const links = {};
  for (const key of allowed) {
    const val = rawLinks[key];
    if (typeof val === "string" && /^https?:\/\//i.test(val.trim())) {
      links[key] = val.trim();
    }
  }
  return links;
}

function buildFallbackSparkline(code, rate, changes) {
  if (!Number.isFinite(rate) || rate <= 0) return [];
  const pct = Number.isFinite(changes?.d7)
    ? changes.d7
    : Number.isFinite(changes?.h24)
      ? changes.h24
      : 0;
  const now = Date.now();
  const series = generateSeries({
    endPrice: rate,
    pctChange: pct,
    pointsCount: 18,
    seedKey: `fallback:${code}:${Math.round(pct * 10)}`,
    startTimeMs: now - 7 * 24 * 60 * 60 * 1000,
    endTimeMs: now,
    stable: Math.abs(pct) < 0.25 && Math.abs(rate - 1) < 0.05,
  });
  return series.map((p) => p.rate);
}

function normalizeLcwCoin(raw, index = 0) {
  const code = normalizeCode(raw.code || raw.symbol || `COIN${index + 1}`);
  const rate = Number(raw.rate) || 0;
  const volume = Number(raw.volume) || 0;
  const liquidity = Number(raw.liquidity) || 0;
  const circulatingSupply = Number(raw.circulatingSupply) || null;
  const totalSupply = Number(raw.totalSupply) || null;
  const maxSupply = Number(raw.maxSupply) || null;
  const rawCap = Number(raw.cap) || 0;
  const cap =
    rawCap > 0
      ? rawCap
      : circulatingSupply && rate > 0
        ? circulatingSupply * rate
        : 0;
  const fdv =
    maxSupply && rate > 0
      ? maxSupply * rate
      : totalSupply && rate > 0
        ? totalSupply * rate
        : cap;

  const delta = raw.delta || {};
  const changes = {
    h1: deltaToPercent(delta.hour),
    h24: deltaToPercent(delta.day),
    d7: deltaToPercent(delta.week),
    d30: deltaToPercent(delta.month),
    d90: deltaToPercent(delta.quarter),
    y1: deltaToPercent(delta.year),
  };

  const categories = normalizeCategories(raw.categories, code);
  const { contracts, chains } = extractContractsAndChains(raw, code);
  const icon =
    typeof raw.webp64 === "string" && /^https?:\/\//i.test(raw.webp64)
      ? raw.webp64
      : typeof raw.png64 === "string" && /^https?:\/\//i.test(raw.png64)
        ? raw.png64
        : typeof raw.png32 === "string" && /^https?:\/\//i.test(raw.png32)
          ? raw.png32
          : null;

  return {
    rank: Number(raw.rank) || (Number.isInteger(index) && index >= 0 ? index + 1 : null),
    code,
    name: String(raw.name || code),
    color: typeof raw.color === "string" && /^#[0-9a-f]{3,8}$/i.test(raw.color)
      ? raw.color
      : colorForCode(code),
    icon,
    rate,
    volume,
    cap,
    liquidity,
    fdv,
    circulatingSupply,
    totalSupply,
    maxSupply,
    allTimeHighUSD: Number(raw.allTimeHighUSD) || null,
    allTimeHigh: Number(raw.allTimeHighUSD) || null,
    marketsCount: Number(raw.markets) || null,
    exchangesCount: Number(raw.exchanges) || null,
    pairsCount: Number(raw.pairs) || null,
    changes,
    categories,
    contracts,
    chains,
    links: cleanLinks(raw.links),
    about: `${String(raw.name || code)} (${code}) live market data provided via Live Coin Watch.`,
    sparkline: index < 100 ? buildFallbackSparkline(code, rate, changes) : [],
    sparklineEstimated: true,
  };
}

function normalizeLcwExchange(raw, index = 0) {
  const code = String(raw.code || `exchange_${index + 1}`).trim();
  const name = String(raw.name || code);
  const volume = Number(raw.volume) || 0;
  const bidTotal = Number(raw.bidTotal) || 0;
  const askTotal = Number(raw.askTotal) || 0;
  const depth = Number(raw.depth) || bidTotal + askTotal;
  const visitors = Number(raw.visitors) || 0;
  const markets = Number(raw.markets) || 0;
  const volumePerVisitor =
    Number(raw.volumePerVisitor) || (visitors > 0 ? volume / visitors : 0);
  const icon =
    typeof raw.webp64 === "string" && /^https?:\/\//i.test(raw.webp64)
      ? raw.webp64
      : typeof raw.png64 === "string" && /^https?:\/\//i.test(raw.png64)
        ? raw.png64
        : typeof raw.png32 === "string" && /^https?:\/\//i.test(raw.png32)
          ? raw.png32
          : null;
  const website =
    typeof raw.links?.website === "string" && /^https?:\/\//i.test(raw.links.website)
      ? raw.links.website.trim()
      : null;

  return {
    rank: index + 1,
    code,
    name,
    color: colorForCode(code.toUpperCase()),
    icon,
    centralized: raw.centralized !== false,
    usCompliant: Boolean(raw.usCompliant),
    markets,
    volume,
    bidTotal,
    askTotal,
    depth,
    visitors,
    volumePerVisitor,
    website,
  };
}

const HOT_CATEGORY_EXCLUDED_RE =
  /\b(stablecoins?|fiat[\s-]?backed|usd[\s-]?pegged|eur[\s-]?pegged|pegged|wrapped|bridged|synthetic[\s-]?dollar)\b/i;
const HOT_CAT_EMA_TAU_MS = 45 * 60_000;
const HOT_CAT_STATE_MAX_AGE_MS = 6 * 60 * 60_000;
const HOT_CAT_DWELL_MS = 60 * 60_000;
const HOT_CAT_DWELL_MARGIN = 8;
const HOT_CAT_STEADY_MARGIN = 4;

function clampNum(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function round2(v) {
  return Number.isFinite(v) ? Number(v.toFixed(2)) : 0;
}

function medianOf(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function formatCompactUsdShort(val) {
  const n = Number(val) || 0;
  const abs = Math.abs(n);
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function formatSignedPct(val) {
  const n = Number(val) || 0;
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function cappedCapWeightedAverage(list, getter, capLimitRatio = 0.35) {
  const rows = [];
  let totalRawWeight = 0;
  for (const c of list) {
    const val = getter(c);
    if (typeof val !== "number" || !Number.isFinite(val)) continue;
    const rawW =
      (c.cap || 0) > 0
        ? c.cap
        : (c.volume || 0) > 0
          ? c.volume * 2
          : 1;
    rows.push({ c, val, rawW });
    totalRawWeight += rawW;
  }
  if (!rows.length || totalRawWeight <= 0) {
    return { avg: 0, maxPositiveShare: 0, contributions: [] };
  }

  const maxW = rows.length >= 3 ? totalRawWeight * capLimitRatio : Infinity;
  let weightSum = 0;
  let weightedSum = 0;
  let posContribSum = 0;
  let maxPosContrib = 0;
  const contributions = [];

  for (const row of rows) {
    const w = Math.min(row.rawW, maxW);
    const contrib = w * row.val;
    weightSum += w;
    weightedSum += contrib;
    if (contrib > 0) {
      posContribSum += contrib;
      if (contrib > maxPosContrib) maxPosContrib = contrib;
    }
    contributions.push({ coin: row.c, weight: w, val: row.val, contrib });
  }

  return {
    avg: weightSum > 0 ? weightedSum / weightSum : 0,
    maxPositiveShare: posContribSum > 0 ? maxPosContrib / posContribSum : 0,
    contributions,
  };
}

function isExcludedHotCategory(cat, list) {
  if (!cat || cat === "Stablecoins") return true;
  if (HOT_CATEGORY_EXCLUDED_RE.test(cat)) return true;
  if (!list.length) return true;
  const stableCount = list.filter((c) => c.categories?.includes("Stablecoins")).length;
  return stableCount / list.length >= 0.5;
}

function buildHotCategoryNarrative(candidate) {
  const { metrics, relativeActivity } = candidate;
  const {
    capWeighted24h,
    capWeighted7d,
    alpha24h,
    alpha7d,
    breadth24h,
    breadth7d,
    advancing24h,
    activeCoins,
    totalVolume,
  } = metrics;

  let signal = "Resilient leadership";
  if (capWeighted7d >= 5 && capWeighted24h >= 3 && breadth24h >= 0.6) {
    signal = "Multi-day breakout";
  } else if (alpha7d >= 4 && capWeighted7d > 0 && capWeighted24h >= 0) {
    signal = "Outperforming market";
  } else if (capWeighted7d >= 4 && breadth7d >= 0.55) {
    signal = "Sustained 7d rally";
  } else if (capWeighted24h >= 4 && relativeActivity >= 1.2) {
    signal = "High-volume surge";
  } else if (alpha24h >= 3 && alpha7d >= 1) {
    signal = "Relative strength";
  } else if (breadth24h >= 0.65 && capWeighted24h > 0) {
    signal = "Broad sector rally";
  } else if (capWeighted24h < 0 && capWeighted7d < 0) {
    signal = "Defensive leader";
  }

  const volStr = formatCompactUsdShort(totalVolume);
  const breadthText = `${advancing24h}/${activeCoins} active coins up`;

  let reason;
  if (capWeighted7d >= 0 && capWeighted24h >= 0) {
    const vsMkt =
      alpha7d >= 1.5
        ? `, outpacing the market by ${formatSignedPct(alpha7d)} over 7d`
        : alpha24h >= 1.5
          ? `, outpacing the market by ${formatSignedPct(alpha24h)} over 24h`
          : "";
    reason = `Up ${formatSignedPct(capWeighted7d)} (7d) and ${formatSignedPct(capWeighted24h)} (24h) cap-weighted${vsMkt}, with ${breadthText} and ${volStr} in 24h volume.`;
  } else if (capWeighted24h >= 0) {
    const vsMkt =
      alpha24h >= 1.5
        ? `, beating the market by ${formatSignedPct(alpha24h)} today`
        : "";
    reason = `Up ${formatSignedPct(capWeighted24h)} (24h) cap-weighted (${formatSignedPct(capWeighted7d)} 7d)${vsMkt}, with ${breadthText} and ${volStr} in 24h volume.`;
  } else if (capWeighted7d >= 0) {
    reason = `Up ${formatSignedPct(capWeighted7d)} over 7d (${formatSignedPct(capWeighted24h)} 24h) cap-weighted, backed by ${volStr} in 24h volume across ${activeCoins} active coins.`;
  } else {
    const rel =
      alpha7d > 0.5
        ? `outperforming the market by ${formatSignedPct(alpha7d)} over 7d`
        : `holding relative strength`;
    reason = `Defensive sector at ${formatSignedPct(capWeighted7d)} (7d) and ${formatSignedPct(capWeighted24h)} (24h), ${rel} with ${volStr} in 24h volume.`;
  }

  return { signal, reason };
}

export function computeHotCategories(
  coins,
  { prevState = null, now = Date.now(), count = 3 } = {},
) {
  const catBuckets = new Map();
  for (const c of coins || []) {
    for (const cat of c.categories || []) {
      if (!catBuckets.has(cat)) catBuckets.set(cat, []);
      catBuckets.get(cat).push(c);
    }
  }

  // Order all categories by total sector market cap.
  const categories = [...catBuckets.entries()]
    .map(([cat, list]) => ({
      cat,
      cap: list.reduce((acc, c) => acc + (c.cap || 0), 0),
    }))
    .sort((a, b) => b.cap - a.cap)
    .map((x) => x.cat);

  const nonStables = (coins || []).filter(
    (c) => !c.categories?.includes("Stablecoins") && (c.rate || 0) > 0,
  );
  const isLargeDataset = (coins || []).length >= 100;
  const isActiveCoin = (c) =>
    isLargeDataset
      ? (c.cap || 0) >= 5_000_000 || (c.volume || 0) >= 250_000
      : (c.rate || 0) > 0;

  const activeMarketCoinsRaw = nonStables.filter(isActiveCoin);
  const activeMarketCoins =
    activeMarketCoinsRaw.length >= 10 ? activeMarketCoinsRaw : nonStables;

  const marketTotalCap = activeMarketCoins.reduce((acc, c) => acc + (c.cap || 0), 0);
  const marketTotalVol = activeMarketCoins.reduce((acc, c) => acc + (c.volume || 0), 0);
  const marketTurnover =
    marketTotalCap > 0 ? marketTotalVol / marketTotalCap : 0.05;

  const market24h = cappedCapWeightedAverage(
    activeMarketCoins,
    (c) =>
      typeof c.changes?.h24 === "number" && Number.isFinite(c.changes.h24)
        ? clampNum(c.changes.h24, -40, 80)
        : null,
    0.25,
  ).avg;

  const market7d = cappedCapWeightedAverage(
    activeMarketCoins,
    (c) =>
      typeof c.changes?.d7 === "number" && Number.isFinite(c.changes.d7)
        ? clampNum(c.changes.d7, -60, 150)
        : null,
    0.25,
  ).avg;

  const marketMedian24h = medianOf(
    activeMarketCoins
      .map((c) => c.changes?.h24)
      .filter((v) => typeof v === "number" && Number.isFinite(v))
      .map((v) => clampNum(v, -40, 80)),
  );

  // Build candidate profiles for all non-excluded categories
  const rawBuckets = [...catBuckets.entries()]
    .filter(([cat, list]) => !isExcludedHotCategory(cat, list))
    .map(([name, allCoins]) => {
      const nonStableCoins = allCoins.filter(
        (c) => !c.categories?.includes("Stablecoins") && (c.rate || 0) > 0,
      );
      const basePool = nonStableCoins.length ? nonStableCoins : allCoins;
      const activeList = basePool.filter(isActiveCoin);
      const activeCoins = activeList.length ? activeList : basePool;
      const totalCap = basePool.reduce((acc, c) => acc + (c.cap || 0), 0);
      const totalVolume = basePool.reduce((acc, c) => acc + (c.volume || 0), 0);
      const liquidLeaders = activeCoins.filter(
        (c) => (c.volume || 0) >= 10_000_000 || (c.cap || 0) >= 100_000_000,
      ).length;
      return {
        name,
        allCoins,
        activeCoins,
        totalCap,
        totalVolume,
        liquidLeaders,
      };
    });

  // Progressive materiality gates: strict for full live markets so tiny 3-coin
  // micro-cap categories can never hijack Hot Categories, with clean fallback
  // for smaller sample or test datasets.
  const volFloorStrict = Math.max(
    25_000_000,
    Math.min(75_000_000, marketTotalVol * 0.001),
  );
  const strictCandidates =
    isLargeDataset && marketTotalCap >= 10_000_000_000
      ? rawBuckets.filter(
          (b) =>
            b.activeCoins.length >= 5 &&
            b.totalCap >= 500_000_000 &&
            b.totalVolume >= volFloorStrict &&
            b.liquidLeaders >= 2,
        )
      : [];

  const moderateCandidates =
    (coins || []).length >= 30
      ? rawBuckets.filter(
          (b) =>
            b.activeCoins.length >= 3 &&
            b.totalCap >= Math.min(100_000_000, marketTotalCap * 0.002) &&
            b.totalVolume >= Math.min(10_000_000, marketTotalVol * 0.002),
        )
      : [];

  const minCoinsFallback = (coins || []).length >= 30 ? 3 : 2;
  const fallbackCandidates = rawBuckets.filter(
    (b) => b.allCoins.length >= minCoinsFallback,
  );

  const eligible =
    strictCandidates.length >= count
      ? strictCandidates
      : moderateCandidates.length >= count
        ? moderateCandidates
        : fallbackCandidates.length > 0
          ? fallbackCandidates
          : rawBuckets;

  const maxEligibleVol = Math.max(...eligible.map((b) => b.totalVolume || 0), 1);

  const scored = eligible.map((bucket) => {
    const { name, allCoins, activeCoins, totalCap, totalVolume } = bucket;

    const cw24 = cappedCapWeightedAverage(
      activeCoins,
      (c) =>
        typeof c.changes?.h24 === "number" && Number.isFinite(c.changes.h24)
          ? clampNum(c.changes.h24, -40, 80)
          : null,
      0.35,
    );

    const cw7 = cappedCapWeightedAverage(
      activeCoins,
      (c) =>
        typeof c.changes?.d7 === "number" && Number.isFinite(c.changes.d7)
          ? clampNum(c.changes.d7, -60, 150)
          : null,
      0.35,
    );

    const vals24 = activeCoins
      .map((c) => c.changes?.h24)
      .filter((v) => typeof v === "number" && Number.isFinite(v))
      .map((v) => clampNum(v, -40, 80));

    const vals7 = activeCoins
      .map((c) => c.changes?.d7)
      .filter((v) => typeof v === "number" && Number.isFinite(v))
      .map((v) => clampNum(v, -60, 150));

    const median24h = medianOf(vals24);
    const median7d = vals7.length ? medianOf(vals7) : median24h;
    const capWeighted24h = cw24.avg;
    const capWeighted7d = vals7.length ? cw7.avg : capWeighted24h;

    const advancing24h = vals24.filter((v) => v > 0).length;
    const breadth24h = vals24.length ? advancing24h / vals24.length : 0;
    const advancing7d = vals7.filter((v) => v > 0).length;
    const breadth7d = vals7.length ? advancing7d / vals7.length : breadth24h;
    const outperforming24h = vals24.length
      ? vals24.filter((v) => v > marketMedian24h).length / vals24.length
      : 0;

    // Dampen single-coin spikes where 1 outlier drives >65% of positive return
    // while the majority of the sector is flat or red.
    let blended24h = 0.65 * capWeighted24h + 0.35 * median24h;
    if (cw24.maxPositiveShare > 0.65 && breadth24h < 0.45 && blended24h > median24h) {
      blended24h = median24h + (blended24h - median24h) * 0.45;
    }

    let blended7d = 0.65 * capWeighted7d + 0.35 * median7d;
    if (cw7.maxPositiveShare > 0.65 && breadth7d < 0.45 && blended7d > median7d) {
      blended7d = median7d + (blended7d - median7d) * 0.45;
    }

    const alpha24h = blended24h - market24h;
    const alpha7d = blended7d - market7d;

    // Aggregate (cap-weighted) sector turnover vs market turnover — immune to
    // single micro-cap wash trading.
    const sectorTurnover =
      totalCap > 0 ? Math.min(0.5, totalVolume / totalCap) : 0;
    const relativeActivity = clampNum(
      sectorTurnover / Math.max(marketTurnover, 0.015),
      0,
      2.5,
    );
    const volumeDepth =
      Math.log10(Math.max(1, totalVolume)) /
      Math.log10(Math.max(10, maxEligibleVol));
    const coinDepth = clampNum(
      Math.log2(Math.max(2, activeCoins.length)) / Math.log2(20),
      0.3,
      1,
    );

    // 1. Multi-day (7d) sustained momentum & alpha (34%)
    const signal7d = blended7d * 0.55 + alpha7d * 0.45;
    const score7d = clampNum(50 + signal7d * 2.2, 0, 100);

    // 2. Daily (24h) momentum & alpha (24%)
    const signal24h = blended24h * 0.55 + alpha24h * 0.45;
    const score24h = clampNum(50 + signal24h * 3.2, 0, 100);

    // 3. Sector participation breadth & timeframe alignment (22%)
    const breadthMix =
      breadth24h * 0.45 + breadth7d * 0.35 + outperforming24h * 0.2;
    let alignmentBonus = 0;
    if (blended24h > 0 && blended7d > 0) alignmentBonus += 10;
    if (alpha24h > 0 && alpha7d > 0) alignmentBonus += 5;
    if (blended24h < -1 && blended7d < -2) alignmentBonus -= 10;
    const scoreBreadth = clampNum(breadthMix * 90 + alignmentBonus, 0, 100);

    // 4. Liquidity depth & directional trading conviction (20%)
    // Panic selloffs with high volume are damped so crashing sectors aren't "Hot".
    const rawActivity =
      clampNum(relativeActivity / 1.8, 0, 1) * 55 +
      clampNum(volumeDepth, 0, 1) * 30 +
      coinDepth * 15;
    let directionMult = 1;
    if (blended24h < -1.5 && blended7d < -2) {
      directionMult = 0.35;
    } else if (blended24h < 0 && blended7d < 0 && alpha7d < 1.5) {
      directionMult = 0.6;
    } else if (blended24h < -2 && alpha24h < -1) {
      directionMult = 0.7;
    }
    const scoreActivity = clampNum(rawActivity * directionMult, 0, 100);

    const rawScore = clampNum(
      score7d * 0.34 +
        score24h * 0.24 +
        scoreBreadth * 0.22 +
        scoreActivity * 0.2,
      0,
      100,
    );

    // Top 3 coins driving the sector (weighted by scale + positive momentum)
    const leaders = [...activeCoins]
      .sort((a, b) => {
        const capA = Math.log10(Math.max(10, a.cap || a.volume || 10));
        const capB = Math.log10(Math.max(10, b.cap || b.volume || 10));
        const momA =
          clampNum(a.changes?.d7 ?? a.changes?.h24 ?? 0, -30, 80) * 0.55 +
          clampNum(a.changes?.h24 ?? 0, -25, 60) * 0.45;
        const momB =
          clampNum(b.changes?.d7 ?? b.changes?.h24 ?? 0, -30, 80) * 0.55 +
          clampNum(b.changes?.h24 ?? 0, -25, 60) * 0.45;
        return capB * 2.2 + momB - (capA * 2.2 + momA);
      })
      .slice(0, 3)
      .map((c) => ({
        code: c.code,
        name: c.name,
        change24h:
          typeof c.changes?.h24 === "number" ? round2(c.changes.h24) : null,
        change7d:
          typeof c.changes?.d7 === "number" ? round2(c.changes.d7) : null,
      }));

    const metrics = {
      capWeighted24h: round2(capWeighted24h),
      capWeighted7d: round2(capWeighted7d),
      median24h: round2(median24h),
      median7d: round2(median7d),
      blended24h: round2(blended24h),
      blended7d: round2(blended7d),
      alpha24h: round2(alpha24h),
      alpha7d: round2(alpha7d),
      breadth24h: round2(breadth24h),
      breadth7d: round2(breadth7d),
      advancing24h,
      activeCoins: activeCoins.length,
      totalCoins: allCoins.length,
      totalCap,
      totalVolume,
      sectorTurnover: round2(sectorTurnover * 100), // percentage
    };

    const candidate = {
      name,
      rawScore: round2(rawScore),
      smoothedScore: round2(rawScore),
      relativeActivity: round2(relativeActivity),
      metrics,
      leaders,
    };

    return {
      ...candidate,
      ...buildHotCategoryNarrative(candidate),
    };
  });

  // Apply time-aware EMA smoothing + incumbent hysteresis when prior state is fresh.
  const hasFreshState =
    prevState &&
    typeof prevState === "object" &&
    Number.isFinite(prevState.updatedAt) &&
    now - prevState.updatedAt >= 0 &&
    now - prevState.updatedAt <= HOT_CAT_STATE_MAX_AGE_MS;

  const prevIncumbentMap = new Map();
  if (hasFreshState) {
    const dt = Math.max(0, now - prevState.updatedAt);
    const alpha =
      dt === 0 ? 0.15 : clampNum(1 - Math.exp(-dt / HOT_CAT_EMA_TAU_MS), 0.15, 0.85);
    const prevScores = prevState.scores || {};
    for (const c of scored) {
      const prev = prevScores[c.name];
      if (typeof prev === "number" && Number.isFinite(prev)) {
        c.smoothedScore = round2(prev * (1 - alpha) + c.rawScore * alpha);
      }
    }
    for (const inc of prevState.incumbents || []) {
      if (inc && typeof inc.name === "string") {
        prevIncumbentMap.set(inc.name, inc);
      }
    }
  }

  // Rank candidates using hysteresis margins for healthy incumbents so close ties
  // do not flip back and forth on every 3-minute refresh.
  const ranked = [...scored]
    .map((c) => {
      const inc = prevIncumbentMap.get(c.name);
      let hysteresisBonus = 0;
      if (inc) {
        const turnedCold =
          c.metrics.blended24h < -2 && c.metrics.blended7d < -3;
        if (!turnedCold) {
          const dwellAge = now - (inc.enteredAt || prevState.updatedAt);
          hysteresisBonus =
            dwellAge < HOT_CAT_DWELL_MS
              ? HOT_CAT_DWELL_MARGIN
              : HOT_CAT_STEADY_MARGIN;
        }
      }
      return {
        ...c,
        effectiveRankScore: c.smoothedScore + hysteresisBonus,
        heldSince: inc?.enteredAt ?? now,
      };
    })
    .sort((a, b) => {
      if (b.effectiveRankScore !== a.effectiveRankScore) {
        return b.effectiveRankScore - a.effectiveRankScore;
      }
      if (b.smoothedScore !== a.smoothedScore) {
        return b.smoothedScore - a.smoothedScore;
      }
      return (b.metrics.totalVolume || 0) - (a.metrics.totalVolume || 0);
    });

  const winners = ranked
    .slice(0, count)
    .sort((a, b) => {
      if (b.smoothedScore !== a.smoothedScore) {
        return b.smoothedScore - a.smoothedScore;
      }
      return (b.metrics.totalVolume || 0) - (a.metrics.totalVolume || 0);
    });

  const hotCategories = winners.map((w) => w.name);
  const hotCategoryDetails = winners.map((w) => ({
    name: w.name,
    score: Math.round(w.smoothedScore),
    rawScore: Math.round(w.rawScore),
    signal: w.signal,
    reason: w.reason,
    metrics: w.metrics,
    leaders: w.leaders,
    heldSince: w.heldSince,
  }));

  const nextScores = {};
  for (const c of scored) {
    nextScores[c.name] = c.smoothedScore;
  }
  const nextState = {
    updatedAt: now,
    scores: nextScores,
    incumbents: winners.map((w) => ({
      name: w.name,
      enteredAt: w.heldSince,
      lastScore: w.smoothedScore,
    })),
  };

  return {
    hotCategories,
    hotCategoryDetails,
    categories,
    nextState,
  };
}

function deriveHighlights(coins, { hotCategoryState = null, now = Date.now() } = {}) {
  const nonStables = coins.filter(
    (c) => !c.categories.includes("Stablecoins") && c.rate > 0,
  );
  const pool = nonStables.length >= 5 ? nonStables : coins;

  // Top Gainers: scan ALL loaded coins (up to 1,000) with a light volume floor
  // ($50k 24h vol to skip dead/illiquid dust, falling back if few qualify) so
  // Top Gainers matches the real biggest positive 24h % movers.
  const positivePool = pool.filter(
    (c) => typeof c.changes.h24 === "number" && c.changes.h24 > 0,
  );
  const gainerPool50k = positivePool.filter((c) => (c.volume || 0) >= 50_000);
  const gainerPool =
    gainerPool50k.length >= 5
      ? gainerPool50k
      : positivePool.length >= 5
        ? positivePool
        : pool.filter((c) => typeof c.changes.h24 === "number");

  const gainers = [...gainerPool]
    .sort((a, b) => (b.changes.h24 ?? -999) - (a.changes.h24 ?? -999))
    .slice(0, 5)
    .map((c) => ({
      code: c.code,
      name: c.name,
      icon: c.icon,
      color: c.color,
      rate: c.rate,
      change24h: c.changes.h24,
    }));

  // Trending: positive 24h gainers with active liquidity ($1M+ 24h vol preferred),
  // ranked by volume/cap turnover + positive 1h velocity + liquidity prominence
  // so Trending highlights lively positive buzz distinct from micro-cap spikes.
  const trendPool1m = positivePool.filter((c) => (c.volume || 0) >= 1_000_000);
  const trendPool100k = positivePool.filter((c) => (c.volume || 0) >= 100_000);
  const trendPool =
    trendPool1m.length >= 5
      ? trendPool1m
      : trendPool100k.length >= 5
        ? trendPool100k
        : gainerPool;
  const maxVol = Math.max(...trendPool.map((c) => c.volume || 0), 1);

  const trending = [...trendPool]
    .sort((a, b) => {
      const turnA = a.cap > 0 ? Math.min(4, (a.volume || 0) / a.cap) : 0.35;
      const turnB = b.cap > 0 ? Math.min(4, (b.volume || 0) / b.cap) : 0.35;
      const h1A = Math.min(15, Math.max(0, a.changes.h1 ?? 0));
      const h1B = Math.min(15, Math.max(0, b.changes.h1 ?? 0));
      const h24A = Math.min(40, Math.max(0, a.changes.h24 ?? 0));
      const h24B = Math.min(40, Math.max(0, b.changes.h24 ?? 0));
      const volA = Math.log10(Math.max(1, a.volume || 1)) / Math.log10(maxVol);
      const volB = Math.log10(Math.max(1, b.volume || 1)) / Math.log10(maxVol);

      const scoreA = Math.log1p(turnA * 4) * 28 + h1A * 4.5 + h24A * 0.7 + volA * 26;
      const scoreB = Math.log1p(turnB * 4) * 28 + h1B * 4.5 + h24B * 0.7 + volB * 26;
      return scoreB - scoreA;
    })
    .slice(0, 5)
    .map((c) => ({
      code: c.code,
      name: c.name,
      icon: c.icon,
      color: c.color,
      rate: c.rate,
      change24h: c.changes.h24,
    }));

  // Dynamic Hot Categories: substantial multi-timeframe sector conviction with
  // materiality floors, outlier resistance, market-relative alpha, and hysteresis.
  const {
    hotCategories,
    hotCategoryDetails,
    categories,
    nextState: nextHotCategoryState,
  } = computeHotCategories(coins, { prevState: hotCategoryState, now });

  return {
    trending,
    gainers,
    hotCategories,
    hotCategoryDetails,
    categories,
    nextHotCategoryState,
  };
}

function getRangeWindow(range) {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  switch (range) {
    case "7d":
      return { start: now - 7 * DAY, end: now };
    case "1m":
      return { start: now - 30 * DAY, end: now };
    case "3m":
      return { start: now - 90 * DAY, end: now };
    case "1y":
      return { start: now - 365 * DAY, end: now };
    case "max":
      return { start: now - 3 * 365 * DAY, end: now };
    case "24h":
    default:
      return { start: now - DAY, end: now };
  }
}

export function createMarketService({ store, env = process.env, clientOptions = {} }) {
  const client = createLcwClient(clientOptions);
  const memCache = new Map();
  const inFlight = new Map();
  let lastCredits = null;
  let lastCreditsAt = 0;
  let platformIndex = null;
  let platformIndexAt = 0;
  let platformFailedAt = 0;

  async function getPlatformDirectory() {
    const now = Date.now();
    if (platformIndex && now - platformIndexAt < TTL_CG_PLATFORMS_MS) {
      return platformIndex;
    }
    if (platformFailedAt && now - platformFailedAt < 5 * 60_000) {
      return platformIndex;
    }

    const cacheKey = "cg_platforms_v1";
    const cached = await getCached(cacheKey, TTL_CG_PLATFORMS_MS);
    if (cached.hit && Array.isArray(cached.entry.data)) {
      platformIndex = buildPlatformIndex(cached.entry.data);
      platformIndexAt = cached.entry.fetchedAt;
      return platformIndex;
    }

    try {
      const compactList = await coalesced(cacheKey, async () => {
        const raw = await client.getCoinGeckoPlatforms({
          gatewayUrl: getPreviewGateway(),
        });
        // Keep only records with at least one non-empty contract address so disk cache stays lean.
        return raw
          .filter((item) => {
            if (!item?.platforms || typeof item.platforms !== "object") return false;
            return Object.values(item.platforms).some(
              (v) => typeof v === "string" && v.trim().length > 0,
            );
          })
          .map((item) => ({
            id: item.id,
            symbol: item.symbol,
            name: item.name,
            platforms: item.platforms,
          }));
      });
      const entry = await setCached(cacheKey, compactList);
      platformIndex = buildPlatformIndex(compactList);
      platformIndexAt = entry.fetchedAt;
      platformFailedAt = 0;
      return platformIndex;
    } catch {
      platformFailedAt = Date.now();
      if (cached.stale && Array.isArray(cached.stale.data)) {
        platformIndex = buildPlatformIndex(cached.stale.data);
        platformIndexAt = cached.stale.fetchedAt;
        return platformIndex;
      }
      return platformIndex;
    }
  }

  function enrichCoinWithPlatforms(coin, index) {
    if (!coin || !index) return coin;
    if (coin.contracts?.length > 0) return coin;
    const matched = matchPlatformsFromIndex(index, coin.code, coin.name);
    if (!matched) return coin;
    const { contracts, chains } = extractContractsAndChains(
      { contracts: matched },
      coin.code,
    );
    if (!contracts.length && !chains.length) return coin;
    const mergedChains = [...(coin.chains || [])];
    const seen = new Set(mergedChains.map((c) => c.name));
    for (const ch of chains) {
      if (!seen.has(ch.name)) {
        seen.add(ch.name);
        mergedChains.push(ch);
      }
    }
    return {
      ...coin,
      contracts,
      chains: mergedChains,
    };
  }

  function noteLcwRequests(count = 1) {
    const n = Math.max(1, Math.round(Number(count) || 1));
    if (lastCredits && typeof lastCredits.dailyCreditsRemaining === "number") {
      lastCredits = {
        ...lastCredits,
        dailyCreditsRemaining: Math.max(0, lastCredits.dailyCreditsRemaining - n),
      };
    }
    // Best-effort persistent daily request counter.
    store.recordApiRequests(n).catch(() => {});
  }

  function buildQuotaStats(prefs, usageToday, { isLive }) {
    const coinLimit = prefs.coinLimit || 1000;
    const refreshIntervalSec = prefs.refreshIntervalSec || 180;
    const autoRefresh = Boolean(prefs.autoRefresh);
    const listCredits = Math.ceil(coinLimit / MARKETS_PAGE_SIZE);
    const creditsPerRefresh = listCredits + 1; // list pages + /overview
    const liveLimit =
      isLive &&
      typeof lastCredits?.dailyCreditsLimit === "number" &&
      Number.isFinite(lastCredits.dailyCreditsLimit) &&
      lastCredits.dailyCreditsLimit > 0
        ? lastCredits.dailyCreditsLimit
        : null;
    const dailyCreditsLimit = liveLimit ?? (prefs.dailyCreditLimit || 10_000);
    const requestsToday = usageToday?.requests || 0;
    const liveRemaining =
      isLive &&
      typeof lastCredits?.dailyCreditsRemaining === "number" &&
      Number.isFinite(lastCredits.dailyCreditsRemaining)
        ? lastCredits.dailyCreditsRemaining
        : null;
    const dailyCreditsRemaining =
      liveRemaining ?? Math.max(0, dailyCreditsLimit - requestsToday);
    const refreshesRemainingToday = Math.floor(
      dailyCreditsRemaining / creditsPerRefresh,
    );
    const projectedDailyCredits24h = Math.round(
      (86_400 / refreshIntervalSec) * creditsPerRefresh,
    );
    const projectedActive8hCredits = Math.round(
      (28_800 / refreshIntervalSec) * creditsPerRefresh,
    );

    let budgetStatus = "safe";
    if (projectedDailyCredits24h > dailyCreditsLimit) {
      budgetStatus = "over";
    } else if (projectedDailyCredits24h > dailyCreditsLimit * 0.75) {
      budgetStatus = "high";
    }

    return {
      coinLimit,
      refreshIntervalSec,
      autoRefresh,
      listCredits,
      creditsPerRefresh,
      dailyCreditsLimit,
      dailyCreditsRemaining,
      requestsToday,
      refreshesRemainingToday,
      projectedDailyCredits24h,
      projectedActive8hCredits,
      budgetStatus,
      isLiveCredits: liveRemaining !== null,
    };
  }

  function getPreviewGateway() {
    const val = String(env.POCKETS_HTTPS_GATEWAY || "").trim();
    return val || null;
  }

  async function resolveApiKey() {
    const envKey = String(env.LIVECOINWATCH_API_KEY || "").trim();
    if (envKey) {
      return { key: envKey, source: "env" };
    }
    const savedKey = await store.getSavedApiKey();
    if (savedKey) {
      return { key: savedKey, source: "saved" };
    }
    return { key: null, source: "none" };
  }

  async function getCached(cacheKey, ttlMs, { forceRefresh = false } = {}) {
    const now = Date.now();
    let entry = memCache.get(cacheKey);
    if (!entry) {
      const disk = await store.readCache(cacheKey);
      if (disk && disk.data !== undefined && Number.isFinite(disk.fetchedAt)) {
        entry = disk;
        memCache.set(cacheKey, entry);
      }
    }
    if (entry && !forceRefresh && now - entry.fetchedAt < ttlMs) {
      return { hit: true, entry };
    }
    return { hit: false, stale: entry || null };
  }

  async function setCached(cacheKey, data) {
    const entry = { data, fetchedAt: Date.now() };
    memCache.set(cacheKey, entry);
    await store.writeCache(cacheKey, entry);
    return entry;
  }

  async function coalesced(key, fn) {
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = Promise.resolve()
      .then(fn)
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, promise);
    return promise;
  }

  async function clearAllCaches() {
    memCache.clear();
    lastCredits = null;
    lastCreditsAt = 0;
    await store.clearCache();
  }

  async function getStatus({ refreshCredits = false, cachedOnly = false } = {}) {
    const [{ key, source }, prefs, usageToday] = await Promise.all([
      resolveApiKey(),
      store.getPreferences(),
      store.getUsageToday(),
    ]);
    const previewGatewayMode = Boolean(getPreviewGateway());

    if (
      !cachedOnly &&
      key &&
      !previewGatewayMode &&
      (refreshCredits || !lastCredits || Date.now() - lastCreditsAt > TTL_CREDITS_MS)
    ) {
      try {
        const res = await client.checkCredits(key);
        const rem = Number(res?.dailyCreditsRemaining);
        const lim = Number(res?.dailyCreditsLimit);
        lastCredits = {
          dailyCreditsRemaining: Number.isFinite(rem) ? rem : null,
          dailyCreditsLimit: Number.isFinite(lim) && lim > 0 ? lim : null,
        };
        lastCreditsAt = Date.now();
      } catch {
        // Keep previously known credits if transient failure.
      }
    }

    let dataMode = "sample";
    if (previewGatewayMode) {
      dataMode = "preview_sample";
    } else if (key) {
      dataMode = "live";
    }

    const isLive = Boolean(key && !previewGatewayMode);
    const quota = buildQuotaStats(prefs, usageToday, { isLive });

    return {
      provider: "Live Coin Watch",
      configured: Boolean(key),
      source,
      keyHint: maskApiKey(key),
      previewGatewayMode,
      dataMode,
      dailyCreditsRemaining: isLive ? quota.dailyCreditsRemaining : null,
      dailyCreditsLimit: isLive ? quota.dailyCreditsLimit : null,
      quota,
    };
  }

  async function saveApiKey(rawKey) {
    const trimmed = String(rawKey || "").trim();
    if (!trimmed) {
      throw new LcwApiError("Please enter your Live Coin Watch API key.", {
        status: 400,
        code: "EMPTY_KEY",
      });
    }

    const previewGatewayMode = Boolean(getPreviewGateway());
    let credits = null;
    if (!previewGatewayMode) {
      const verified = await client.checkCredits(trimmed);
      credits = {
        dailyCreditsRemaining: Number(verified?.dailyCreditsRemaining ?? null),
        dailyCreditsLimit: Number(verified?.dailyCreditsLimit ?? null),
      };
    }

    await store.setSavedApiKey(trimmed);
    await clearAllCaches();
    if (credits) {
      lastCredits = credits;
      lastCreditsAt = Date.now();
    }
    return getStatus({ refreshCredits: false });
  }

  async function removeApiKey() {
    await store.clearSavedApiKey();
    await clearAllCaches();
    return getStatus({ refreshCredits: false });
  }

  async function getFearAndGreed() {
    const cacheKey = "fng_latest";
    const cached = await getCached(cacheKey, TTL_FNG_MS);
    if (cached.hit) return cached.entry.data;

    try {
      const fresh = await coalesced(cacheKey, () =>
        client.getFearAndGreed({ gatewayUrl: getPreviewGateway() }),
      );
      await setCached(cacheKey, fresh);
      return fresh;
    } catch {
      if (cached.stale) return { ...cached.stale.data, isStale: true };
      return getSampleFearAndGreed();
    }
  }

  function getCachedBtcUsdRate() {
    for (const [k, entry] of memCache.entries()) {
      if (k.startsWith("markets_USD_") && Array.isArray(entry?.data?.coins)) {
        const btc = entry.data.coins.find((c) => c.code === "BTC");
        if (btc?.rate > 0) return btc.rate;
      }
    }
    return null;
  }

  function scaleNum(val, fx) {
    return typeof val === "number" && Number.isFinite(val) ? val * fx : val;
  }

  function scaleHistoryByFx(history, fx) {
    if (!Array.isArray(history) || fx === 1) return history;
    return history.map((pt) => ({
      ...pt,
      rate: scaleNum(pt.rate, fx),
      volume: scaleNum(pt.volume, fx),
      cap: scaleNum(pt.cap, fx),
    }));
  }

  function scaleCoinByFx(coin, fx) {
    if (!coin || fx === 1) return coin;
    return {
      ...coin,
      rate: scaleNum(coin.rate, fx),
      volume: scaleNum(coin.volume, fx),
      cap: scaleNum(coin.cap, fx),
      fdv: scaleNum(coin.fdv, fx),
      liquidity: scaleNum(coin.liquidity, fx),
      allTimeHigh: scaleNum(coin.allTimeHigh, fx),
      low24h: scaleNum(coin.low24h, fx),
      high24h: scaleNum(coin.high24h, fx),
      sparkline: Array.isArray(coin.sparkline)
        ? coin.sparkline.map((v) => scaleNum(v, fx))
        : coin.sparkline,
    };
  }

  function scaleExchangeByFx(ex, fx) {
    if (!ex || fx === 1) return ex;
    return {
      ...ex,
      volume: scaleNum(ex.volume, fx),
      depth: scaleNum(ex.depth, fx),
      bidTotal: scaleNum(ex.bidTotal, fx),
      askTotal: scaleNum(ex.askTotal, fx),
      volumePerVisitor: scaleNum(ex.volumePerVisitor, fx),
    };
  }

  function scaleOverviewByFx(ov, fx) {
    if (!ov || fx === 1) return ov;
    return {
      ...ov,
      cap: scaleNum(ov.cap, fx),
      volume: scaleNum(ov.volume, fx),
      liquidity: scaleNum(ov.liquidity, fx),
      history: Array.isArray(ov.history)
        ? ov.history.map((pt) => ({
            ...pt,
            cap: scaleNum(pt.cap, fx),
            volume: scaleNum(pt.volume, fx),
          }))
        : ov.history,
    };
  }

  async function getFxRates({ forceRefresh = false } = {}) {
    const { key } = await resolveApiKey();
    const previewGatewayMode = Boolean(getPreviewGateway());
    const liveBtcUsd = getCachedBtcUsdRate();

    if (previewGatewayMode || !key) {
      return {
        base: "USD",
        rates: {
          ...SAMPLE_FX,
          ...(liveBtcUsd > 0 ? { BTC: 1 / liveBtcUsd } : {}),
        },
        isSample: true,
        updatedAt: Date.now(),
      };
    }

    const cacheKey = "fx_rates_v1";
    const cached = await getCached(cacheKey, TTL_FX_MS, { forceRefresh });
    if (cached.hit) {
      const rates = {
        ...cached.entry.data.rates,
        USD: 1,
        ...(liveBtcUsd > 0 ? { BTC: 1 / liveBtcUsd } : {}),
      };
      return {
        base: "USD",
        rates,
        isSample: false,
        updatedAt: cached.entry.fetchedAt,
      };
    }

    try {
      const payload = await coalesced(cacheKey, async () => {
        const rates = { ...SAMPLE_FX, USD: 1 };
        let btcUsd = liveBtcUsd;
        if (!(btcUsd > 0)) {
          const usdRaw = await client.getCoinSingle(key, {
            currency: "USD",
            code: "BTC",
            meta: false,
          });
          noteLcwRequests(1);
          btcUsd = Number(usdRaw?.rate) || 0;
        }

        if (btcUsd > 0) {
          rates.BTC = 1 / btcUsd;
          const results = await Promise.allSettled(
            FX_FIATS.map(async (fiat) => {
              const raw = await client.getCoinSingle(key, {
                currency: fiat,
                code: "BTC",
                meta: false,
              });
              noteLcwRequests(1);
              return [fiat, Number(raw?.rate) || 0];
            }),
          );
          for (const res of results) {
            if (res.status === "fulfilled") {
              const [fiat, fiatBtc] = res.value;
              if (fiatBtc > 0) {
                rates[fiat] = Number((fiatBtc / btcUsd).toFixed(6));
              }
            }
          }
        }
        return { base: "USD", rates, isSample: false };
      });
      const entry = await setCached(cacheKey, payload);
      return { ...payload, updatedAt: entry.fetchedAt };
    } catch {
      if (cached.stale) {
        return {
          base: "USD",
          rates: {
            ...cached.stale.data.rates,
            USD: 1,
            ...(liveBtcUsd > 0 ? { BTC: 1 / liveBtcUsd } : {}),
          },
          isSample: false,
          isStale: true,
          updatedAt: cached.stale.fetchedAt,
        };
      }
      return {
        base: "USD",
        rates: {
          ...SAMPLE_FX,
          ...(liveBtcUsd > 0 ? { BTC: 1 / liveBtcUsd } : {}),
        },
        isSample: true,
        updatedAt: Date.now(),
      };
    }
  }

  const HOT_CAT_STATE_KEY = "hot_categories_state_v1";
  let hotCatStateMem = null;

  async function loadHotCategoryState() {
    if (hotCatStateMem) return hotCatStateMem;
    const disk = await store.readCache(HOT_CAT_STATE_KEY);
    if (disk && typeof disk === "object" && Number.isFinite(disk.updatedAt)) {
      hotCatStateMem = disk;
      return disk;
    }
    return null;
  }

  async function saveHotCategoryState(nextState) {
    if (!nextState) return;
    hotCatStateMem = nextState;
    try {
      await store.writeCache(HOT_CAT_STATE_KEY, nextState);
    } catch {
      // Best-effort persistence; never fail a market load.
    }
  }

  function ensureHotCategoryDetails(payload) {
    if (
      Array.isArray(payload?.hotCategoryDetails) &&
      payload.hotCategoryDetails.length > 0
    ) {
      return payload;
    }
    const { hotCategories, hotCategoryDetails, categories } = computeHotCategories(
      payload?.coins || [],
      { prevState: hotCatStateMem },
    );
    return {
      ...payload,
      hotCategories,
      hotCategoryDetails,
      categories: payload?.categories?.length ? payload.categories : categories,
    };
  }

  async function getMarkets({ currency = "USD", forceRefresh = false } = {}) {
    const cur = normalizeCurrency(currency);
    if (cur !== "USD") {
      const [usdData, fxData] = await Promise.all([
        getMarkets({ currency: "USD", forceRefresh }),
        getFxRates(),
      ]);
      const fx = fxData.rates[cur] ?? 1;
      const coins = (usdData.coins || []).map((c) => scaleCoinByFx(c, fx));
      const trending = (usdData.trending || []).map((c) => ({
        ...c,
        rate: (c.rate || 0) * fx,
      }));
      const gainers = (usdData.gainers || []).map((c) => ({
        ...c,
        rate: (c.rate || 0) * fx,
      }));
      const hotCategoryDetails = (usdData.hotCategoryDetails || []).map((d) => ({
        ...d,
        metrics: {
          ...d.metrics,
          totalCap: (d.metrics?.totalCap || 0) * fx,
          totalVolume: (d.metrics?.totalVolume || 0) * fx,
        },
      }));
      return {
        ...usdData,
        currency: cur,
        coins,
        trending,
        gainers,
        hotCategories: usdData.hotCategories,
        hotCategoryDetails,
        categories: usdData.categories,
      };
    }
    const [{ key, source }, prefs] = await Promise.all([
      resolveApiKey(),
      store.getPreferences(),
    ]);
    const previewGatewayMode = Boolean(getPreviewGateway());
    const coinLimit = prefs.coinLimit || 1000;
    const ttlMs = (prefs.refreshIntervalSec || 180) * 1000;

    if (previewGatewayMode || !key) {
      const coins = getSampleCoins(cur).slice(0, coinLimit);
      const { trending, gainers, hotCategories, hotCategoryDetails, categories } =
        deriveHighlights(coins);
      return {
        currency: cur,
        coins,
        trending,
        gainers,
        hotCategories,
        hotCategoryDetails,
        categories,
        meta: {
          provider: "Live Coin Watch",
          isSample: true,
          isStale: false,
          previewGatewayMode,
          configured: Boolean(key),
          source,
          coinLimit,
          reason: previewGatewayMode
            ? "Pockets Preview uses a GET/HEAD gateway; Live Coin Watch POST requests run directly when installed or run locally."
            : "Add your Live Coin Watch API key to load live market prices.",
          fetchedAt: Date.now(),
        },
      };
    }

    const cacheKey = `markets_${cur}_${coinLimit}`;
    // Warm the 24h CoinGecko contract directory in the background (1 keyless GET/day)
    // so every coin's Contract & Chains are ready in memory before you click.
    getPlatformDirectory().catch(() => {});
    const cached = await getCached(cacheKey, ttlMs, { forceRefresh });
    if (cached.hit) {
      const upgraded = ensureHotCategoryDetails(cached.entry.data);
      const hydrated = await hydrateCachedSparklines(upgraded.coins, cur);
      return {
        ...upgraded,
        coins: hydrated,
        meta: {
          ...upgraded.meta,
          isCached: true,
          fetchedAt: cached.entry.fetchedAt,
        },
      };
    }

    try {
      const payload = await coalesced(cacheKey, async () => {
        // Fetch up to coinLimit top coins (pages of 100) with polite concurrency (max 3).
        const pageSize = MARKETS_PAGE_SIZE;
        const maxPages = Math.max(
          1,
          Math.min(MARKETS_MAX_PAGES, Math.ceil(coinLimit / pageSize)),
        );
        const pageResults = new Array(maxPages);

        const firstRaw = await client.getCoinsList(key, {
          currency: cur,
          sort: "rank",
          order: "ascending",
          offset: 0,
          limit: pageSize,
          meta: true,
        });
        noteLcwRequests(1);
        const firstRows = Array.isArray(firstRaw) ? firstRaw : [];
        pageResults[0] = firstRows;
        let exhausted = firstRows.length < pageSize;

        if (!exhausted && maxPages > 1) {
          let nextPage = 1;
          const concurrency = maxPages > 10 ? 4 : 3;

          async function fetchWorker() {
            while (!exhausted) {
              const p = nextPage++;
              if (p >= maxPages) break;
              try {
                const rawPage = await client.getCoinsList(key, {
                  currency: cur,
                  sort: "rank",
                  order: "ascending",
                  offset: p * pageSize,
                  limit: pageSize,
                  meta: true,
                });
                noteLcwRequests(1);
                const rows = Array.isArray(rawPage) ? rawPage : [];
                pageResults[p] = rows;
                if (rows.length < pageSize) {
                  exhausted = true;
                }
              } catch {
                // Keep successfully fetched pages if a later page hits a transient limit.
                pageResults[p] = [];
              }
            }
          }

          await Promise.all(
            Array.from({ length: concurrency }, () => fetchWorker()),
          );
        }

        const combined = [];
        const seen = new Set();
        for (const rows of pageResults) {
          if (!Array.isArray(rows)) continue;
          for (const item of rows) {
            if (combined.length >= coinLimit) break;
            const c = normalizeCode(item?.code || item?.symbol);
            if (c && !seen.has(c)) {
              seen.add(c);
              combined.push(item);
            }
          }
          if (combined.length >= coinLimit) break;
        }

        const coins = combined.map((item, idx) => normalizeLcwCoin(item, idx));
        const prevHotState = await loadHotCategoryState();
        const {
          trending,
          gainers,
          hotCategories,
          hotCategoryDetails,
          categories,
          nextHotCategoryState,
        } = deriveHighlights(coins, { hotCategoryState: prevHotState });
        await saveHotCategoryState(nextHotCategoryState);
        const hasMore = !exhausted && coins.length >= coinLimit;
        return {
          currency: cur,
          coins,
          trending,
          gainers,
          hotCategories,
          hotCategoryDetails,
          categories,
          meta: {
            provider: "Live Coin Watch",
            isSample: false,
            isStale: false,
            previewGatewayMode: false,
            configured: true,
            source,
            hasMore,
          },
        };
      });

      const entry = await setCached(cacheKey, payload);
      const hydrated = await hydrateCachedSparklines(payload.coins, cur);
      return {
        ...payload,
        coins: hydrated,
        meta: { ...payload.meta, fetchedAt: entry.fetchedAt },
      };
    } catch (err) {
      if (cached.stale) {
        const upgraded = ensureHotCategoryDetails(cached.stale.data);
        const hydrated = await hydrateCachedSparklines(upgraded.coins, cur);
        return {
          ...upgraded,
          coins: hydrated,
          meta: {
            ...upgraded.meta,
            isStale: true,
            warning: err.message,
            warningCode: err.code || null,
            fetchedAt: cached.stale.fetchedAt,
          },
        };
      }
      const sampleCoins = getSampleCoins(cur);
      const { trending, gainers, hotCategories, hotCategoryDetails, categories } =
        deriveHighlights(sampleCoins);
      return {
        currency: cur,
        coins: sampleCoins,
        trending,
        gainers,
        hotCategories,
        hotCategoryDetails,
        categories,
        meta: {
          provider: "Live Coin Watch",
          isSample: true,
          isStale: false,
          previewGatewayMode: false,
          configured: true,
          source,
          warning: err.message,
          fetchedAt: Date.now(),
        },
      };
    }
  }

  function hydrateCachedSparklines(coins, cur) {
    const now = Date.now();
    return coins.map((coin) => {
      let next = coin;
      const spKey = `spark_${cur}_${coin.code}`;
      const cached = memCache.get(spKey);
      if (cached && now - cached.fetchedAt < TTL_SPARKLINE_MS && cached.data.length > 2) {
        next = { ...next, sparkline: cached.data, sparklineEstimated: false };
      }
      const metaKey = `coinmeta_${coin.code}`;
      const metaCached = memCache.get(metaKey);
      if (metaCached && now - metaCached.fetchedAt < TTL_COIN_META_MS && metaCached.data) {
        const m = metaCached.data;
        next = {
          ...next,
          contracts: next.contracts?.length ? next.contracts : m.contracts || [],
          chains: next.chains?.length ? next.chains : m.chains || [],
          links: Object.keys(next.links || {}).length ? next.links : m.links || {},
          exchangesCount: next.exchangesCount || m.exchangesCount || null,
          marketsCount: next.marketsCount || m.marketsCount || null,
          pairsCount: next.pairsCount || m.pairsCount || null,
        };
      }
      if (platformIndex) {
        next = enrichCoinWithPlatforms(next, platformIndex);
      }
      return next;
    });
  }

  async function saveCoinMetaCache(coin) {
    if (!coin?.code) return;
    await setCached(`coinmeta_${coin.code}`, {
      contracts: coin.contracts || [],
      chains: coin.chains || [],
      links: coin.links || {},
      exchangesCount: coin.exchangesCount || null,
      marketsCount: coin.marketsCount || null,
      pairsCount: coin.pairsCount || null,
    });
  }

  async function getSparklines({ codes = [], currency = "USD" } = {}) {
    const cur = normalizeCurrency(currency);
    const { key } = await resolveApiKey();
    const previewGatewayMode = Boolean(getPreviewGateway());
    const cleanCodes = [...new Set(codes.map(normalizeCode).filter(Boolean))].slice(0, 12);

    const results = {};
    if (!cleanCodes.length) return { currency: cur, sparklines: results };

    if (previewGatewayMode || !key) {
      const sample = getSampleCoins(cur);
      for (const code of cleanCodes) {
        const found = sample.find((c) => c.code === code);
        if (found) results[code] = { points: found.sparkline, estimated: false };
      }
      return { currency: cur, sparklines: results, isSample: true };
    }

    // Fetch up to 3 concurrently to stay polite on LCW rate/credit budgets.
    const pending = [];
    for (const code of cleanCodes) {
      const spKey = `spark_${cur}_${code}`;
      const cached = await getCached(spKey, TTL_SPARKLINE_MS);
      if (cached.hit && Array.isArray(cached.entry.data)) {
        results[code] = { points: cached.entry.data, estimated: false };
      } else {
        pending.push(code);
      }
    }

    const { start, end } = getRangeWindow("7d");
    const concurrency = 3;
    let cursor = 0;

    async function worker() {
      while (cursor < pending.length) {
        const code = pending[cursor++];
        const spKey = `spark_${cur}_${code}`;
        try {
          const points = await coalesced(spKey, async () => {
            const raw = await client.getCoinHistory(key, {
              currency: cur,
              code,
              start,
              end,
              meta: false,
            });
            noteLcwRequests(1);
            const history = Array.isArray(raw?.history) ? raw.history : [];
            const rates = history
              .map((h) => Number(h.rate))
              .filter((n) => Number.isFinite(n) && n > 0);
            if (rates.length < 2) return null;
            // Downsample to <= 42 points for crisp lightweight SVG polylines.
            const step = Math.max(1, Math.floor(rates.length / 42));
            const sampled = rates.filter((_, idx) => idx % step === 0);
            if (sampled[sampled.length - 1] !== rates[rates.length - 1]) {
              sampled.push(rates[rates.length - 1]);
            }
            return sampled;
          });
          if (points) {
            await setCached(spKey, points);
            results[code] = { points, estimated: false };
          }
        } catch {
          // Skip failed sparkline quietly; UI keeps delta-estimated curve.
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()),
    );

    return { currency: cur, sparklines: results, isSample: false };
  }

  async function getExchanges({ currency = "USD", forceRefresh = false } = {}) {
    const cur = normalizeCurrency(currency);
    if (cur !== "USD") {
      const [usdData, fxData] = await Promise.all([
        getExchanges({ currency: "USD", forceRefresh }),
        getFxRates(),
      ]);
      const fx = fxData.rates[cur] ?? 1;
      return {
        ...usdData,
        currency: cur,
        exchanges: (usdData.exchanges || []).map((ex) => scaleExchangeByFx(ex, fx)),
      };
    }
    const { key, source } = await resolveApiKey();
    const previewGatewayMode = Boolean(getPreviewGateway());

    if (previewGatewayMode || !key) {
      return {
        currency: cur,
        exchanges: getSampleExchanges(cur),
        meta: {
          provider: "Live Coin Watch",
          isSample: true,
          isStale: false,
          previewGatewayMode,
          configured: Boolean(key),
          source,
          hasMore: false,
          fetchedAt: Date.now(),
        },
      };
    }

    const cacheKey = `exchanges_${cur}`;
    const cached = await getCached(cacheKey, TTL_EXCHANGES_MS, { forceRefresh });
    if (cached.hit) {
      return {
        ...cached.entry.data,
        meta: {
          ...cached.entry.data.meta,
          isCached: true,
          fetchedAt: cached.entry.fetchedAt,
        },
      };
    }

    try {
      const payload = await coalesced(cacheKey, async () => {
        const pageSize = 100;
        const maxPages = 5;
        const combined = [];
        const seen = new Set();
        let exhausted = false;

        for (let page = 0; page < maxPages; page += 1) {
          const rawPage = await client.getExchangesList(key, {
            currency: cur,
            sort: "volume",
            order: "descending",
            offset: page * pageSize,
            limit: pageSize,
            meta: true,
          });
          noteLcwRequests(1);
          const rows = Array.isArray(rawPage) ? rawPage : [];
          for (const item of rows) {
            const c = String(item?.code || "").trim();
            if (c && !seen.has(c)) {
              seen.add(c);
              combined.push(item);
            }
          }
          if (rows.length < pageSize) {
            exhausted = true;
            break;
          }
        }

        const exchanges = combined.map((item, idx) => normalizeLcwExchange(item, idx));
        return {
          currency: cur,
          exchanges,
          meta: {
            provider: "Live Coin Watch",
            isSample: false,
            isStale: false,
            previewGatewayMode: false,
            configured: true,
            source,
            hasMore: !exhausted && exchanges.length >= maxPages * pageSize,
          },
        };
      });

      const entry = await setCached(cacheKey, payload);
      return {
        ...payload,
        meta: { ...payload.meta, fetchedAt: entry.fetchedAt },
      };
    } catch (err) {
      if (cached.stale) {
        return {
          ...cached.stale.data,
          meta: {
            ...cached.stale.data.meta,
            isStale: true,
            warning: err.message,
            warningCode: err.code || null,
            fetchedAt: cached.stale.fetchedAt,
          },
        };
      }
      return {
        currency: cur,
        exchanges: getSampleExchanges(cur),
        meta: {
          provider: "Live Coin Watch",
          isSample: true,
          isStale: false,
          previewGatewayMode: false,
          configured: true,
          source,
          hasMore: false,
          warning: err.message,
          fetchedAt: Date.now(),
        },
      };
    }
  }

  async function getOverview({ currency = "USD", forceRefresh = false } = {}) {
    const cur = normalizeCurrency(currency);
    if (cur !== "USD") {
      const [usdData, fxData] = await Promise.all([
        getOverview({ currency: "USD", forceRefresh }),
        getFxRates(),
      ]);
      const fx = fxData.rates[cur] ?? 1;
      return {
        ...usdData,
        currency: cur,
        overview: scaleOverviewByFx(usdData.overview, fx),
      };
    }
    const [{ key, source }, prefs] = await Promise.all([
      resolveApiKey(),
      store.getPreferences(),
    ]);
    const previewGatewayMode = Boolean(getPreviewGateway());
    const fearAndGreedPromise = getFearAndGreed();
    const overviewTtlMs = (prefs.refreshIntervalSec || 180) * 1000;

    if (previewGatewayMode || !key) {
      const overview = getSampleOverview(cur);
      const fearAndGreed = await fearAndGreedPromise;
      return {
        currency: cur,
        overview,
        fearAndGreed,
        meta: {
          provider: "Live Coin Watch",
          isSample: true,
          isStale: false,
          previewGatewayMode,
          configured: Boolean(key),
          source,
          fetchedAt: Date.now(),
        },
      };
    }

    const cacheKey = `overview_${cur}`;
    const cached = await getCached(cacheKey, overviewTtlMs, { forceRefresh });
    if (cached.hit) {
      return {
        ...cached.entry.data,
        fearAndGreed: await fearAndGreedPromise,
        meta: {
          ...cached.entry.data.meta,
          isCached: true,
          fetchedAt: cached.entry.fetchedAt,
        },
      };
    }

    try {
      const data = await coalesced(cacheKey, async () => {
        const histKey = `overview_hist_${cur}`;
        const histCached = await getCached(histKey, TTL_OVERVIEW_HISTORY_MS, {
          forceRefresh: false,
        });
        const { start, end } = getRangeWindow("24h");
        const [ovRaw, histRaw, marketsRes, exchangesRes] = await Promise.all([
          client.getOverview(key, cur).then((r) => {
            noteLcwRequests(1);
            return r;
          }),
          histCached.hit
            ? Promise.resolve(histCached.entry.data)
            : client
                .getOverviewHistory(key, { currency: cur, start, end })
                .then(async (r) => {
                  noteLcwRequests(1);
                  if (Array.isArray(r) && r.length > 1) {
                    await setCached(histKey, r);
                  }
                  return r;
                })
                .catch(() => histCached.stale?.data || []),
          getMarkets({ currency: cur, forceRefresh: false }).catch(() => null),
          getExchanges({ currency: cur, forceRefresh: false }).catch(() => null),
        ]);

        const history = Array.isArray(histRaw)
          ? histRaw
              .map((p) => ({
                date: Number(p.date),
                cap: Number(p.cap) || 0,
                volume: Number(p.volume) || 0,
              }))
              .filter((p) => Number.isFinite(p.date) && p.cap > 0)
          : [];

        const cap = Number(ovRaw?.cap) || 0;
        const volume = Number(ovRaw?.volume) || 0;
        const liquidity = Number(ovRaw?.liquidity) || 0;
        const btcDominance =
          typeof ovRaw?.btcDominance === "number"
            ? Number((ovRaw.btcDominance * 100).toFixed(2))
            : null;

        let ethDominance = null;
        const ethCoin = marketsRes?.coins?.find((c) => c.code === "ETH");
        if (ethCoin && cap > 0 && ethCoin.cap > 0) {
          ethDominance = Number(((ethCoin.cap / cap) * 100).toFixed(2));
        }

        let capChange24h = null;
        let volumeChange24h = null;
        if (history.length >= 2) {
          const first = history[0];
          const last = history[history.length - 1];
          if (first.cap > 0) {
            capChange24h = Number((((last.cap - first.cap) / first.cap) * 100).toFixed(2));
          }
          if (first.volume > 0) {
            volumeChange24h = Number(
              (((last.volume - first.volume) / first.volume) * 100).toFixed(2),
            );
          }
        }

        const coinsCount = marketsRes?.coins?.length || 0;
        const coinsDisplay = coinsCount
          ? marketsRes.meta?.hasMore
            ? `${coinsCount.toLocaleString()}+`
            : coinsCount
          : "—";
        const exCount =
          exchangesRes && !exchangesRes.meta?.isSample
            ? exchangesRes.exchanges?.length || 0
            : 0;
        const exchangesDisplay = exCount
          ? exchangesRes.meta?.hasMore
            ? `${exCount.toLocaleString()}+`
            : exCount
          : "—";

        return {
          currency: cur,
          overview: {
            coins: coinsDisplay,
            exchanges: exchangesDisplay,
            cap,
            capChange24h,
            volume,
            volumeChange24h,
            liquidity,
            btcDominance,
            ethDominance,
            history,
          },
          meta: {
            provider: "Live Coin Watch",
            isSample: false,
            isStale: false,
            previewGatewayMode: false,
            configured: true,
            source,
          },
        };
      });

      const entry = await setCached(cacheKey, data);
      return {
        ...data,
        fearAndGreed: await fearAndGreedPromise,
        meta: { ...data.meta, fetchedAt: entry.fetchedAt },
      };
    } catch (err) {
      const fearAndGreed = await fearAndGreedPromise;
      if (cached.stale) {
        return {
          ...cached.stale.data,
          fearAndGreed,
          meta: {
            ...cached.stale.data.meta,
            isStale: true,
            warning: err.message,
            warningCode: err.code || null,
            fetchedAt: cached.stale.fetchedAt,
          },
        };
      }
      return {
        currency: cur,
        overview: getSampleOverview(cur),
        fearAndGreed,
        meta: {
          provider: "Live Coin Watch",
          isSample: true,
          isStale: false,
          previewGatewayMode: false,
          configured: true,
          source,
          warning: err.message,
          fetchedAt: Date.now(),
        },
      };
    }
  }

  async function getCoinDetail({
    code,
    currency = "USD",
    forceRefresh = false,
    metaOnly = false,
  } = {}) {
    const cleanCode = normalizeCode(code);
    if (!cleanCode) {
      throw new LcwApiError("Invalid coin code.", { status: 400, code: "INVALID_CODE" });
    }
    const cur = normalizeCurrency(currency);
    if (cur !== "USD") {
      const [usdData, fxData] = await Promise.all([
        getCoinDetail({ code: cleanCode, currency: "USD", forceRefresh, metaOnly }),
        getFxRates(),
      ]);
      const fx = fxData.rates[cur] ?? 1;
      return {
        ...usdData,
        currency: cur,
        coin: scaleCoinByFx(usdData.coin, fx),
        history24h: scaleHistoryByFx(usdData.history24h, fx),
      };
    }
    const [{ key, source }, prefs] = await Promise.all([
      resolveApiKey(),
      store.getPreferences(),
    ]);
    const previewGatewayMode = Boolean(getPreviewGateway());
    const detailTtlMs = Math.min(
      TTL_COIN_DETAIL_MS,
      (prefs.refreshIntervalSec || 180) * 1000,
    );

    if (previewGatewayMode || !key) {
      const sample = getSampleCoins(cur);
      const coin = sample.find((c) => c.code === cleanCode);
      if (!coin) {
        throw new LcwApiError(`Coin "${cleanCode}" was not found in sample data.`, {
          status: 404,
          code: "NOT_FOUND",
        });
      }
      const history24h = metaOnly ? [] : getSampleCoinHistory(cleanCode, cur, "24h") || [];
      const rates = history24h.map((h) => h.rate);
      const low24h = rates.length ? Math.min(...rates) : coin.rate * 0.97;
      const high24h = rates.length ? Math.max(...rates) : coin.rate * 1.03;

      return {
        currency: cur,
        coin: { ...coin, low24h, high24h },
        history24h,
        meta: {
          provider: "Live Coin Watch",
          isSample: true,
          isStale: false,
          previewGatewayMode,
          configured: Boolean(key),
          source,
          fetchedAt: Date.now(),
        },
      };
    }

    const fullCacheKey = `coin_${cur}_${cleanCode}`;
    const fullCached = await getCached(fullCacheKey, detailTtlMs, { forceRefresh });
    if (fullCached.hit) {
      const enrichedCoin = enrichCoinWithPlatforms(fullCached.entry.data.coin, platformIndex);
      return {
        ...fullCached.entry.data,
        coin: enrichedCoin,
        meta: {
          ...fullCached.entry.data.meta,
          isCached: true,
          fetchedAt: fullCached.entry.fetchedAt,
        },
      };
    }

    const cacheKey = metaOnly ? `coin_meta_${cur}_${cleanCode}` : fullCacheKey;
    const cached = metaOnly
      ? await getCached(cacheKey, detailTtlMs, { forceRefresh })
      : fullCached;
    if (cached.hit) {
      const enrichedCoin = enrichCoinWithPlatforms(cached.entry.data.coin, platformIndex);
      return {
        ...cached.entry.data,
        coin: enrichedCoin,
        meta: {
          ...cached.entry.data.meta,
          isCached: true,
          fetchedAt: cached.entry.fetchedAt,
        },
      };
    }

    try {
      const payload = await coalesced(cacheKey, async () => {
        // Reuse fresh coin metadata from /api/markets + 24h coinmeta cache when complete
        // so repeated visits cost 0 extra /coins/single calls.
        const marketsCacheKey = `markets_${cur}_${prefs.coinLimit || 1000}`;
        const [freshMarkets, diskMeta] = await Promise.all([
          !forceRefresh
            ? getCached(marketsCacheKey, (prefs.refreshIntervalSec || 180) * 1000)
            : Promise.resolve({ hit: false }),
          !forceRefresh
            ? getCached(`coinmeta_${cleanCode}`, TTL_COIN_META_MS)
            : Promise.resolve({ hit: false }),
        ]);

        let candidateCoin = freshMarkets.hit
          ? freshMarkets.entry.data.coins?.find((c) => c.code === cleanCode)
          : null;
        if (candidateCoin && diskMeta.hit && diskMeta.entry?.data) {
          const m = diskMeta.entry.data;
          candidateCoin = {
            ...candidateCoin,
            contracts: candidateCoin.contracts?.length ? candidateCoin.contracts : m.contracts || [],
            chains: candidateCoin.chains?.length ? candidateCoin.chains : m.chains || [],
            links: Object.keys(candidateCoin.links || {}).length ? candidateCoin.links : m.links || {},
            exchangesCount: candidateCoin.exchangesCount || m.exchangesCount || null,
            marketsCount: candidateCoin.marketsCount || m.marketsCount || null,
            pairsCount: candidateCoin.pairsCount || m.pairsCount || null,
          };
        }

        const cachedMarketCoin =
          candidateCoin &&
          candidateCoin.rate > 0 &&
          candidateCoin.exchangesCount &&
          candidateCoin.marketsCount &&
          (candidateCoin.contracts?.length > 0 || candidateCoin.chains?.length > 0)
            ? candidateCoin
            : null;

        const { start, end } = getRangeWindow("24h");
        const [rawCoin, rawHist] = await Promise.all([
          cachedMarketCoin
            ? Promise.resolve(null)
            : client.getCoinSingle(key, { currency: cur, code: cleanCode, meta: true }).then((r) => {
                noteLcwRequests(1);
                return r;
              }),
          metaOnly
            ? Promise.resolve(null)
            : client
                .getCoinHistory(key, {
                  currency: cur,
                  code: cleanCode,
                  start,
                  end,
                  meta: false,
                })
                .then((r) => {
                  noteLcwRequests(1);
                  return r;
                })
                .catch(() => null),
        ]);

        if (!cachedMarketCoin && (!rawCoin || rawCoin.rate === undefined)) {
          throw new LcwApiError(`Coin "${cleanCode}" not found on Live Coin Watch.`, {
            status: 404,
            code: "NOT_FOUND",
          });
        }

        const rawMergedCoin =
          cachedMarketCoin || normalizeLcwCoin({ ...rawCoin, code: cleanCode }, 0);
        // Enrich with 24h CoinGecko contract/platform directory (1 keyless GET/day).
        // Bound wait to 4s on cold boot so coin pages stay snappy if CoinGecko is slow.
        const dir =
          platformIndex ||
          (await Promise.race([
            getPlatformDirectory(),
            new Promise((resolve) => {
              const timer = setTimeout(() => resolve(null), 4_000);
              if (typeof timer.unref === "function") timer.unref();
            }),
          ]));
        const coin = enrichCoinWithPlatforms(rawMergedCoin, dir);
        if (!cachedMarketCoin || coin.contracts?.length > (rawMergedCoin.contracts?.length || 0)) {
          await saveCoinMetaCache(coin);
        }
        const history24h = Array.isArray(rawHist?.history)
          ? rawHist.history
              .map((h) => ({
                date: Number(h.date),
                rate: Number(h.rate),
                volume: Number(h.volume) || 0,
                cap: Number(h.cap) || 0,
              }))
              .filter((h) => Number.isFinite(h.date) && Number.isFinite(h.rate))
          : [];

        const rates = history24h.map((h) => h.rate);
        const low24h = rates.length ? Math.min(...rates, coin.rate) : coin.rate;
        const high24h = rates.length ? Math.max(...rates, coin.rate) : coin.rate;

        return {
          currency: cur,
          coin: { ...coin, low24h, high24h },
          history24h,
          meta: {
            provider: "Live Coin Watch",
            isSample: false,
            isStale: false,
            previewGatewayMode: false,
            configured: true,
            source,
          },
        };
      });

      const entry = await setCached(cacheKey, payload);
      return {
        ...payload,
        meta: { ...payload.meta, fetchedAt: entry.fetchedAt },
      };
    } catch (err) {
      if (err instanceof LcwApiError && err.status === 404) throw err;
      if (cached.stale) {
        return {
          ...cached.stale.data,
          meta: {
            ...cached.stale.data.meta,
            isStale: true,
            warning: err.message,
            warningCode: err.code || null,
            fetchedAt: cached.stale.fetchedAt,
          },
        };
      }
      const sample = getSampleCoins(cur).find((c) => c.code === cleanCode);
      if (sample) {
        const history24h = getSampleCoinHistory(cleanCode, cur, "24h") || [];
        const rates = history24h.map((h) => h.rate);
        return {
          currency: cur,
          coin: {
            ...sample,
            low24h: rates.length ? Math.min(...rates) : sample.rate,
            high24h: rates.length ? Math.max(...rates) : sample.rate,
          },
          history24h,
          meta: {
            provider: "Live Coin Watch",
            isSample: true,
            isStale: false,
            warning: err.message,
            fetchedAt: Date.now(),
          },
        };
      }
      throw err;
    }
  }

  async function getCoinQuotes({ codes = [], currency = "USD", forceRefresh = false } = {}) {
    const cleanCodes = [
      ...new Set((Array.isArray(codes) ? codes : []).map(normalizeCode).filter(Boolean)),
    ].slice(0, 100);
    const cur = normalizeCurrency(currency);
    if (cleanCodes.length === 0) {
      return {
        currency: cur,
        coins: {},
        meta: {
          provider: "Live Coin Watch",
          isSample: false,
          isStale: false,
          fetchedAt: Date.now(),
        },
      };
    }

    if (cur !== "USD") {
      const [usdData, fxData] = await Promise.all([
        getCoinQuotes({ codes: cleanCodes, currency: "USD", forceRefresh }),
        getFxRates(),
      ]);
      const fx = fxData.rates[cur] ?? 1;
      const scaled = {};
      for (const [code, coin] of Object.entries(usdData.coins || {})) {
        scaled[code] = scaleCoinByFx(coin, fx);
      }
      return {
        ...usdData,
        currency: cur,
        coins: scaled,
      };
    }

    const [{ key, source }, prefs] = await Promise.all([
      resolveApiKey(),
      store.getPreferences(),
    ]);
    const previewGatewayMode = Boolean(getPreviewGateway());
    const ttlMs = (prefs.refreshIntervalSec || 180) * 1000;
    const quoteTtlMs = Math.min(TTL_COIN_DETAIL_MS, ttlMs);

    if (previewGatewayMode || !key) {
      const sampleMap = new Map(getSampleCoins("USD").map((c) => [c.code, c]));
      const coins = {};
      for (const code of cleanCodes) {
        const hit = sampleMap.get(code);
        if (hit) coins[code] = hit;
      }
      return {
        currency: "USD",
        coins,
        meta: {
          provider: "Live Coin Watch",
          isSample: true,
          isStale: false,
          previewGatewayMode,
          configured: Boolean(key),
          source,
          fetchedAt: Date.now(),
        },
      };
    }

    const marketsCacheKey = `markets_USD_${prefs.coinLimit || 1000}`;
    const [marketsCached, perCodeCaches] = await Promise.all([
      getCached(marketsCacheKey, ttlMs, { forceRefresh }),
      Promise.all(
        cleanCodes.map(async (code) => {
          const [quoteC, fullC, metaC] = await Promise.all([
            getCached(`quote_USD_${code}`, quoteTtlMs, { forceRefresh }),
            getCached(`coin_USD_${code}`, quoteTtlMs, { forceRefresh }),
            getCached(`coin_meta_USD_${code}`, quoteTtlMs, { forceRefresh }),
          ]);
          return { code, quoteC, fullC, metaC };
        }),
      ),
    ]);

    const freshMarketsByCode = new Map(
      marketsCached.hit
        ? (marketsCached.entry.data?.coins || []).map((c) => [c.code, c])
        : [],
    );
    const staleMarketsByCode = new Map(
      marketsCached.stale
        ? (marketsCached.stale.data?.coins || []).map((c) => [c.code, c])
        : [],
    );

    const coins = {};
    const staleByCode = new Map();
    const missingCodes = [];

    for (const { code, quoteC, fullC, metaC } of perCodeCaches) {
      const marketHit = freshMarketsByCode.get(code);
      const freshCandidate =
        (marketHit && marketHit.rate > 0 ? marketHit : null) ||
        (quoteC.hit && quoteC.entry?.data?.rate > 0 ? quoteC.entry.data : null) ||
        (fullC.hit && fullC.entry?.data?.coin?.rate > 0 ? fullC.entry.data.coin : null) ||
        (metaC.hit && metaC.entry?.data?.coin?.rate > 0 ? metaC.entry.data.coin : null);

      if (freshCandidate) {
        coins[code] = enrichCoinWithPlatforms(freshCandidate, platformIndex);
        continue;
      }

      const staleMarket = staleMarketsByCode.get(code);
      const staleCandidate =
        (quoteC.stale?.data?.rate > 0 ? quoteC.stale.data : null) ||
        (fullC.stale?.data?.coin?.rate > 0 ? fullC.stale.data.coin : null) ||
        (metaC.stale?.data?.coin?.rate > 0 ? metaC.stale.data.coin : null) ||
        (staleMarket && staleMarket.rate > 0 ? staleMarket : null);
      if (staleCandidate) {
        staleByCode.set(code, enrichCoinWithPlatforms(staleCandidate, platformIndex));
      }
      missingCodes.push(code);
    }

    let isStale = false;
    let warning = null;
    let warningCode = null;

    if (missingCodes.length > 0) {
      const batchKey = `quotes_USD_${missingCodes.slice().sort().join(",")}`;
      const fetched = await coalesced(batchKey, async () => {
        const found = new Map();
        let fatalErr = null;

        // Fetch in chunks of 50 via POST /coins/map (1 credit per chunk)
        const CHUNK_SIZE = 50;
        for (let i = 0; i < missingCodes.length; i += CHUNK_SIZE) {
          const chunk = missingCodes.slice(i, i + CHUNK_SIZE);
          try {
            const rawList = await client.getCoinsMap(key, {
              codes: chunk,
              currency: "USD",
              meta: true,
            });
            noteLcwRequests(1);
            if (Array.isArray(rawList)) {
              for (const raw of rawList) {
                if (!raw || typeof raw !== "object") continue;
                const c = normalizeCode(raw.code || raw.symbol);
                if (!c || !(Number(raw.rate) > 0)) continue;
                const normalized = enrichCoinWithPlatforms(
                  normalizeLcwCoin({ ...raw, code: c }, null),
                  platformIndex,
                );
                found.set(c, normalized);
              }
            }
          } catch (err) {
            if (
              err instanceof LcwApiError &&
              (err.code === "INVALID_API_KEY" ||
                err.code === "NO_API_KEY" ||
                err.code === "RATE_LIMITED" ||
                err.code === "NETWORK_ERROR" ||
                err.code === "TIMEOUT")
            ) {
              fatalErr = err;
              break;
            }
          }

          // Fall back to /coins/single for any codes omitted by /coins/map (or if /coins/map isn't available)
          const stillMissing = chunk.filter((c) => !found.has(c));
          if (stillMissing.length > 0 && !fatalErr) {
            let idx = 0;
            const concurrency = Math.min(3, stillMissing.length);
            async function singleWorker() {
              while (idx < stillMissing.length && !fatalErr) {
                const targetCode = stillMissing[idx++];
                try {
                  const rawCoin = await client.getCoinSingle(key, {
                    currency: "USD",
                    code: targetCode,
                    meta: true,
                  });
                  noteLcwRequests(1);
                  if (rawCoin && Number(rawCoin.rate) > 0) {
                    const normalized = enrichCoinWithPlatforms(
                      normalizeLcwCoin({ ...rawCoin, code: targetCode }, null),
                      platformIndex,
                    );
                    found.set(targetCode, normalized);
                  }
                } catch (err) {
                  if (
                    err instanceof LcwApiError &&
                    (err.code === "INVALID_API_KEY" ||
                      err.code === "NO_API_KEY" ||
                      err.code === "RATE_LIMITED" ||
                      err.code === "NETWORK_ERROR" ||
                      err.code === "TIMEOUT")
                  ) {
                    fatalErr = err;
                    break;
                  }
                  // Ignore per-coin 404/not-found so other portfolio coins still resolve.
                }
              }
            }
            await Promise.all(Array.from({ length: concurrency }, () => singleWorker()));
          }
        }

        await Promise.all(
          [...found.entries()].map(([code, coin]) => setCached(`quote_USD_${code}`, coin)),
        );
        return { found, fatalErr };
      });

      for (const [code, coin] of fetched.found.entries()) {
        coins[code] = coin;
      }

      if (fetched.fatalErr) {
        warning = fetched.fatalErr.message;
        warningCode = fetched.fatalErr.code || null;
      }

      for (const code of missingCodes) {
        if (!coins[code] && staleByCode.has(code)) {
          coins[code] = staleByCode.get(code);
          isStale = true;
        }
      }
    }

    return {
      currency: "USD",
      coins,
      meta: {
        provider: "Live Coin Watch",
        isSample: false,
        isStale,
        previewGatewayMode: false,
        configured: true,
        source,
        warning,
        warningCode,
        fetchedAt: Date.now(),
      },
    };
  }

  async function getCoinHistory({ code, currency = "USD", range = "24h" } = {}) {
    const cleanCode = normalizeCode(code);
    const cur = normalizeCurrency(currency);
    if (cur !== "USD") {
      const [usdData, fxData] = await Promise.all([
        getCoinHistory({ code: cleanCode, currency: "USD", range }),
        getFxRates(),
      ]);
      const fx = fxData.rates[cur] ?? 1;
      return {
        ...usdData,
        currency: cur,
        history: scaleHistoryByFx(usdData.history, fx),
      };
    }
    const cleanRange = ["24h", "7d", "1m", "3m", "1y", "max"].includes(range)
      ? range
      : "24h";
    const { key } = await resolveApiKey();
    const previewGatewayMode = Boolean(getPreviewGateway());

    if (previewGatewayMode || !key) {
      const series = getSampleCoinHistory(cleanCode, cur, cleanRange);
      if (!series) {
        throw new LcwApiError(`No history found for "${cleanCode}".`, {
          status: 404,
          code: "NOT_FOUND",
        });
      }
      return {
        code: cleanCode,
        currency: cur,
        range: cleanRange,
        history: series,
        isSample: true,
      };
    }

    const cacheKey = `hist_${cur}_${cleanCode}_${cleanRange}`;
    const cached = await getCached(cacheKey, TTL_COIN_HISTORY_MS);
    if (cached.hit) {
      return { ...cached.entry.data, isCached: true };
    }

    try {
      const { start, end } = getRangeWindow(cleanRange);
      const data = await coalesced(cacheKey, async () => {
        const raw = await client.getCoinHistory(key, {
          currency: cur,
          code: cleanCode,
          start,
          end,
          meta: false,
        });
        noteLcwRequests(1);
        const history = Array.isArray(raw?.history)
          ? raw.history
              .map((h) => ({
                date: Number(h.date),
                rate: Number(h.rate),
                volume: Number(h.volume) || 0,
                cap: Number(h.cap) || 0,
              }))
              .filter((h) => Number.isFinite(h.date) && Number.isFinite(h.rate))
          : [];
        return {
          code: cleanCode,
          currency: cur,
          range: cleanRange,
          history,
          isSample: false,
        };
      });
      await setCached(cacheKey, data);
      return data;
    } catch (err) {
      if (cached.stale) {
        return { ...cached.stale.data, isStale: true, warning: err.message };
      }
      const fallback = getSampleCoinHistory(cleanCode, cur, cleanRange);
      if (fallback) {
        return {
          code: cleanCode,
          currency: cur,
          range: cleanRange,
          history: fallback,
          isSample: true,
          warning: err.message,
        };
      }
      throw err;
    }
  }

  async function searchCoins({ query = "", currency = "USD" } = {}) {
    const q = String(query || "").trim().toLowerCase();
    const cur = normalizeCurrency(currency);
    const prefs = await store.getPreferences();
    // Use existing cached markets (even if slightly stale) so search never blocks
    // waiting for a multi-page market list refresh.
    const cacheKey = `markets_${cur}_${prefs.coinLimit || 1000}`;
    const existing = await getCached(cacheKey, Number.MAX_SAFE_INTEGER);
    const markets = existing.hit
      ? existing.entry.data
      : await getMarkets({ currency: cur });
    const coins = markets.coins || [];

    if (!q) {
      return { results: coins.slice(0, 8), isSample: Boolean(markets.meta?.isSample) };
    }

    const matches = coins.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.code.toLowerCase().includes(q) ||
        c.categories.some((cat) => cat.toLowerCase().includes(q)),
    );

    // If user typed an exact ticker not in top 100 and LCW is live, try single coin lookup.
    const exactCode = normalizeCode(q);
    if (
      matches.length === 0 &&
      exactCode.length >= 2 &&
      exactCode.length <= 12 &&
      !markets.meta?.isSample
    ) {
      try {
        const detail = await getCoinDetail({ code: exactCode, currency: cur });
        if (detail?.coin) {
          return { results: [detail.coin], isSample: false };
        }
      } catch {
        // Ignore not found.
      }
    }

    return {
      results: matches.slice(0, 10),
      isSample: Boolean(markets.meta?.isSample),
    };
  }

  async function getBootstrap({ includeExchanges = false, coinCode = null } = {}) {
    const [{ key, source }, preferences, portfolio, status] = await Promise.all([
      resolveApiKey(),
      store.getPreferences(),
      store.getPortfolio(),
      getStatus({ refreshCredits: false, cachedOnly: true }),
    ]);
    const previewGatewayMode = Boolean(getPreviewGateway());
    const isLive = Boolean(key && !previewGatewayMode);
    const coinLimit = preferences.coinLimit || 1000;
    const ttlMs = (preferences.refreshIntervalSec || 180) * 1000;
    const cleanCode = coinCode ? normalizeCode(coinCode) : null;

    const pickEntry = (cached) => (cached?.hit ? cached.entry : cached?.stale || null);
    const cleanMeta = (meta, fetchedAt) => ({
      ...(meta || {}),
      isCached: true,
      isStale: false,
      warning: null,
      warningCode: null,
      fetchedAt,
    });

    if (!isLive) {
      const fngCached = await getCached("fng_latest", TTL_FNG_MS);
      const fngEntry = pickEntry(fngCached);
      const fearAndGreed = fngEntry?.data || getSampleFearAndGreed();
      const now = Date.now();
      const coins = getSampleCoins("USD").slice(0, coinLimit);
      const { trending, gainers, hotCategories, hotCategoryDetails, categories } =
        deriveHighlights(coins);
      const sampleMeta = {
        provider: "Live Coin Watch",
        isSample: true,
        isStale: false,
        previewGatewayMode,
        configured: Boolean(key),
        source,
        fetchedAt: now,
      };
      const markets = {
        currency: "USD",
        coins,
        trending,
        gainers,
        hotCategories,
        hotCategoryDetails,
        categories,
        meta: {
          ...sampleMeta,
          coinLimit,
          reason: previewGatewayMode
            ? "Pockets Preview uses a GET/HEAD gateway; Live Coin Watch POST requests run directly when installed or run locally."
            : "Add your Live Coin Watch API key to load live market prices.",
        },
      };
      const overview = {
        currency: "USD",
        overview: getSampleOverview("USD"),
        fearAndGreed,
        meta: sampleMeta,
      };
      const fx = {
        base: "USD",
        rates: { ...SAMPLE_FX },
        isSample: true,
        updatedAt: now,
      };
      const exchanges = includeExchanges
        ? {
            currency: "USD",
            exchanges: getSampleExchanges("USD"),
            meta: { ...sampleMeta, hasMore: false },
          }
        : null;

      let detail = null;
      if (cleanCode) {
        const sampleCoin = getSampleCoins("USD").find((c) => c.code === cleanCode);
        if (sampleCoin) {
          const history24h = getSampleCoinHistory(cleanCode, "USD", "24h") || [];
          const rates = history24h.map((h) => h.rate);
          detail = {
            currency: "USD",
            coin: {
              ...sampleCoin,
              low24h: rates.length ? Math.min(...rates) : sampleCoin.rate * 0.97,
              high24h: rates.length ? Math.max(...rates) : sampleCoin.rate * 1.03,
            },
            history24h,
            meta: sampleMeta,
          };
        }
      }

      return {
        preferences,
        portfolio,
        status,
        fx,
        overview,
        markets,
        exchanges,
        detail,
        extraCoins: {},
        needsRefresh: {
          markets: false,
          overview: !fngCached.hit,
          fx: false,
          status: false,
          exchanges: false,
          detail: false,
          portfolioCoins: false,
        },
      };
    }

    const detailTtlMs = Math.min(TTL_COIN_DETAIL_MS, ttlMs);
    const [
      marketsCached,
      overviewCached,
      fngCached,
      fxCached,
      exchangesCached,
      detailFullCached,
      detailMetaCached,
      hist24hCached,
      coinMetaCached,
    ] = await Promise.all([
      getCached(`markets_USD_${coinLimit}`, ttlMs),
      getCached("overview_USD", ttlMs),
      getCached("fng_latest", TTL_FNG_MS),
      getCached("fx_rates_v1", TTL_FX_MS),
      includeExchanges ? getCached("exchanges_USD", TTL_EXCHANGES_MS) : Promise.resolve(null),
      cleanCode ? getCached(`coin_USD_${cleanCode}`, detailTtlMs) : Promise.resolve(null),
      cleanCode ? getCached(`coin_meta_USD_${cleanCode}`, detailTtlMs) : Promise.resolve(null),
      cleanCode ? getCached(`hist_USD_${cleanCode}_24h`, TTL_COIN_HISTORY_MS) : Promise.resolve(null),
      cleanCode ? getCached(`coinmeta_${cleanCode}`, TTL_COIN_META_MS) : Promise.resolve(null),
    ]);

    const marketsEntry = pickEntry(marketsCached);
    let markets = null;
    if (marketsEntry?.data) {
      const upgraded = ensureHotCategoryDetails(marketsEntry.data);
      const hydrated = hydrateCachedSparklines(upgraded.coins, "USD");
      markets = {
        ...upgraded,
        coins: hydrated,
        meta: cleanMeta(upgraded.meta, marketsEntry.fetchedAt),
      };
    }

    const fngEntry = pickEntry(fngCached);
    const fearAndGreed = fngEntry?.data || getSampleFearAndGreed();

    const overviewEntry = pickEntry(overviewCached);
    const overview = overviewEntry?.data
      ? {
          ...overviewEntry.data,
          fearAndGreed,
          meta: cleanMeta(overviewEntry.data.meta, overviewEntry.fetchedAt),
        }
      : null;

    const liveBtcUsd = getCachedBtcUsdRate();
    const fxEntry = pickEntry(fxCached);
    const fx = fxEntry?.data?.rates
      ? {
          base: "USD",
          rates: {
            ...fxEntry.data.rates,
            USD: 1,
            ...(liveBtcUsd > 0 ? { BTC: 1 / liveBtcUsd } : {}),
          },
          isSample: false,
          updatedAt: fxEntry.fetchedAt,
        }
      : {
          base: "USD",
          rates: {
            ...SAMPLE_FX,
            ...(liveBtcUsd > 0 ? { BTC: 1 / liveBtcUsd } : {}),
          },
          isSample: true,
          updatedAt: Date.now(),
        };

    const exchangesEntry = pickEntry(exchangesCached);
    const exchanges = exchangesEntry?.data
      ? {
          ...exchangesEntry.data,
          meta: cleanMeta(exchangesEntry.data.meta, exchangesEntry.fetchedAt),
        }
      : null;

    let detail = null;
    if (cleanCode) {
      const detailFullEntry = pickEntry(detailFullCached);
      const detailMetaEntry = pickEntry(detailMetaCached);
      const histEntry = pickEntry(hist24hCached);
      const coinMetaEntry = pickEntry(coinMetaCached);

      const baseDetailEntry = detailFullEntry || detailMetaEntry;
      let coin = baseDetailEntry?.data?.coin || markets?.coins?.find((c) => c.code === cleanCode) || null;
      if (coin) {
        if (coinMetaEntry?.data) {
          const m = coinMetaEntry.data;
          coin = {
            ...coin,
            contracts: coin.contracts?.length ? coin.contracts : m.contracts || [],
            chains: coin.chains?.length ? coin.chains : m.chains || [],
            links: Object.keys(coin.links || {}).length ? coin.links : m.links || {},
            exchangesCount: coin.exchangesCount || m.exchangesCount || null,
            marketsCount: coin.marketsCount || m.marketsCount || null,
            pairsCount: coin.pairsCount || m.pairsCount || null,
          };
        }
        coin = enrichCoinWithPlatforms(coin, platformIndex);
        const histFromKey = Array.isArray(histEntry?.data?.history) ? histEntry.data.history : [];
        const histFromFull = Array.isArray(detailFullEntry?.data?.history24h)
          ? detailFullEntry.data.history24h
          : [];
        const history24h = histFromKey.length >= histFromFull.length ? histFromKey : histFromFull;
        const rates = history24h.map((h) => h.rate);
        if (rates.length) {
          coin = {
            ...coin,
            low24h: Math.min(...rates, coin.rate),
            high24h: Math.max(...rates, coin.rate),
          };
        }
        const fetchedAt =
          baseDetailEntry?.fetchedAt || marketsEntry?.fetchedAt || Date.now();
        detail = {
          currency: "USD",
          coin,
          history24h,
          meta: cleanMeta(baseDetailEntry?.data?.meta || markets?.meta, fetchedAt),
        };
      }
    }

    const marketByCode = new Map(
      (markets?.coins || []).filter((c) => c && c.rate > 0).map((c) => [c.code, c]),
    );
    const trackedPortfolioCodes = [
      ...new Set([
        ...(portfolio.watchlist || []),
        ...Object.keys(portfolio.holdings || {}),
      ]),
    ].filter((c) => !marketByCode.has(c));

    const extraCoins = {};
    let needsPortfolioCoinsRefresh = false;
    if (trackedPortfolioCodes.length > 0) {
      const cachedExtra = await Promise.all(
        trackedPortfolioCodes.map(async (c) => {
          const [quoteC, fullC, metaC] = await Promise.all([
            getCached(`quote_USD_${c}`, detailTtlMs),
            getCached(`coin_USD_${c}`, detailTtlMs),
            getCached(`coin_meta_USD_${c}`, detailTtlMs),
          ]);
          return { code: c, quoteC, fullC, metaC };
        }),
      );
      for (const { code: c, quoteC, fullC, metaC } of cachedExtra) {
        const freshCoin =
          (quoteC.hit && quoteC.entry?.data?.rate > 0 ? quoteC.entry.data : null) ||
          (fullC.hit && fullC.entry?.data?.coin?.rate > 0 ? fullC.entry.data.coin : null) ||
          (metaC.hit && metaC.entry?.data?.coin?.rate > 0 ? metaC.entry.data.coin : null);
        if (freshCoin) {
          extraCoins[c] = enrichCoinWithPlatforms(freshCoin, platformIndex);
          continue;
        }
        const staleCoin =
          (quoteC.stale?.data?.rate > 0 ? quoteC.stale.data : null) ||
          (fullC.stale?.data?.coin?.rate > 0 ? fullC.stale.data.coin : null) ||
          (metaC.stale?.data?.coin?.rate > 0 ? metaC.stale.data.coin : null);
        if (staleCoin) {
          extraCoins[c] = enrichCoinWithPlatforms(staleCoin, platformIndex);
        }
        needsPortfolioCoinsRefresh = true;
      }
    }

    return {
      preferences,
      portfolio,
      status,
      fx,
      overview,
      markets,
      exchanges,
      detail,
      extraCoins,
      needsRefresh: {
        markets: !marketsCached.hit,
        overview: !overviewCached.hit || !fngCached.hit,
        fx: !fxCached.hit,
        status: !lastCredits || Date.now() - lastCreditsAt > TTL_CREDITS_MS,
        exchanges: includeExchanges ? !exchangesCached?.hit : false,
        detail: cleanCode
          ? !(detailFullCached?.hit || (detailMetaCached?.hit && hist24hCached?.hit))
          : false,
        portfolioCoins: needsPortfolioCoinsRefresh,
      },
    };
  }

  return {
    getStatus,
    getBootstrap,
    saveApiKey,
    removeApiKey,
    getFxRates,
    getMarkets,
    getExchanges,
    getOverview,
    getSparklines,
    getCoinQuotes,
    getCoinDetail,
    getCoinHistory,
    searchCoins,
    clearAllCaches,
  };
}
