// Reusable market filter presets, number parsing, and coin filtering engine.

export const MCAP_PRESETS = [
  { id: "all", label: "All" },
  { id: "large", label: "Large: >$1B", min: 1e9, max: null, gt: true },
  { id: "mid", label: "Mid: $100M to $1B", min: 1e8, max: 1e9 },
  { id: "small", label: "Small: $10M to $100M", min: 1e7, max: 1e8 },
  { id: "micro", label: "Micro: <$10M", min: null, max: 1e7, lt: true },
  { id: "custom", label: "Custom" },
];

export const VOLUME_PRESETS = [
  { id: "all", label: "All" },
  { id: "100k", label: "> $100K", min: 1e5, gt: true },
  { id: "1m", label: "> $1M", min: 1e6, gt: true },
  { id: "10m", label: "> $10M", min: 1e7, gt: true },
  { id: "50m", label: "> $50M", min: 5e7, gt: true },
  { id: "100m", label: "> $100M", min: 1e8, gt: true },
  { id: "custom", label: "Custom" },
];

export const CHANGE_TIMEFRAMES = [
  { id: "h1", label: "1h" },
  { id: "h24", label: "24h" },
  { id: "d7", label: "7d" },
  { id: "d30", label: "30d" },
  { id: "d90", label: "90d" },
  { id: "y1", label: "1y" },
];

export const CHANGE_PRESETS = [
  { id: "all", label: "All" },
  { id: "gt0", label: ">0%", min: 0, gt: true },
  { id: "gt10", label: ">10%", min: 10, gt: true },
  { id: "gt20", label: ">20%", min: 20, gt: true },
  { id: "gt50", label: ">50%", min: 50, gt: true },
  { id: "lt-10", label: "<-10%", max: -10, lt: true },
  { id: "lt-20", label: "<-20%", max: -20, lt: true },
  { id: "lt-50", label: "<-50%", max: -50, lt: true },
  { id: "custom", label: "Custom" },
];

export const LIQUIDITY_PRESETS = [
  { id: "all", label: "All" },
  { id: "50k", label: "> $50K", min: 5e4, gt: true },
  { id: "100k", label: "> $100K", min: 1e5, gt: true },
  { id: "500k", label: "> $500K", min: 5e5, gt: true },
  { id: "1m", label: "> $1M", min: 1e6, gt: true },
  { id: "custom", label: "Custom" },
];

export const FDV_PRESETS = [
  { id: "all", label: "All" },
  { id: "10m", label: "> $10M", min: 1e7, gt: true },
  { id: "100m", label: "> $100M", min: 1e8, gt: true },
  { id: "1b", label: "> $1B", min: 1e9, gt: true },
  { id: "custom", label: "Custom" },
];

export const RATIO_PRESETS = [
  { id: "all", label: "All" },
  { id: "0.25", label: ">0.25", min: 0.25, gt: true },
  { id: "0.5", label: ">0.5", min: 0.5, gt: true },
  { id: "0.75", label: ">0.75", min: 0.75, gt: true },
  { id: "1.0", label: "1.0", min: 0.995 },
  { id: "custom", label: "Custom" },
];

export function createDefaultFilterState() {
  return {
    query: "",
    chain: "All",
    mcapPreset: "all",
    mcapMin: "",
    mcapMax: "",
    volPreset: "all",
    volMin: "",
    volMax: "",
    changeTimeframe: "h24",
    changePreset: "all",
    changeMin: "",
    changeMax: "",
    liqPreset: "all",
    liqMin: "",
    liqMax: "",
    fdvPreset: "all",
    fdvMin: "",
    fdvMax: "",
    ratioPreset: "all",
    ratioMin: "",
    ratioMax: "",
  };
}

const SUFFIX_MULTIPLIERS = {
  k: 1e3,
  m: 1e6,
  b: 1e9,
  t: 1e12,
};

/**
 * Parse a user-entered numeric filter bound.
 * Supports plain numbers, commas, `$`/`%` prefixes/suffixes, and K/M/B/T shorthands (e.g. "50M", "$1.5B").
 */
export function parseCompactNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).trim().replace(/[$,%\s,]/g, "");
  if (!cleaned) return null;
  const match = cleaned.match(/^([+-]?(?:\d+\.?\d*|\.\d+))([kmbt])?$/i);
  if (!match) return null;
  const num = Number(match[1]);
  if (!Number.isFinite(num)) return null;
  const mult = match[2] ? SUFFIX_MULTIPLIERS[match[2].toLowerCase()] : 1;
  return num * mult;
}

export function formatShortThreshold(value, { currency = false, percent = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  if (percent) {
    return `${value}%`;
  }
  if (!currency) {
    return String(Number(value.toFixed(3)));
  }
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}$${Number((abs / 1e12).toFixed(2))}T`;
  if (abs >= 1e9) return `${sign}$${Number((abs / 1e9).toFixed(2))}B`;
  if (abs >= 1e6) return `${sign}$${Number((abs / 1e6).toFixed(2))}M`;
  if (abs >= 1e3) return `${sign}$${Number((abs / 1e3).toFixed(2))}K`;
  return `${sign}$${Number(abs.toFixed(2))}`;
}

export function getCoinMcapFdvRatio(coin) {
  if (!coin) return null;
  const cap = Number(coin.cap);
  const fdv = Number(coin.fdv);
  if (!Number.isFinite(cap) || !Number.isFinite(fdv) || cap <= 0 || fdv <= 0) {
    return null;
  }
  return cap / fdv;
}

function resolveRange(presetList, presetId, customMinRaw, customMaxRaw) {
  if (!presetId || presetId === "all") return null;
  if (presetId === "custom") {
    const min = parseCompactNumber(customMinRaw);
    const max = parseCompactNumber(customMaxRaw);
    if (min === null && max === null) return null;
    return { min, max, gt: false, lt: false, isCustom: true };
  }
  const found = presetList.find((p) => p.id === presetId);
  if (!found || found.id === "all") return null;
  return {
    min: found.min ?? null,
    max: found.max ?? null,
    gt: Boolean(found.gt),
    lt: Boolean(found.lt),
    isCustom: false,
    label: found.label,
  };
}

function matchesNumericRange(value, range, { requirePositive = false } = {}) {
  if (!range) return true;
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (requirePositive && value <= 0) return false;

  if (range.min !== null) {
    if (range.gt ? !(value > range.min) : !(value >= range.min)) {
      return false;
    }
  }
  if (range.max !== null) {
    if (range.lt ? !(value < range.max) : !(value <= range.max)) {
      return false;
    }
  }
  return true;
}

export function applyCoinFilters(coins, filter, { activeCategory = "All", watchlist = [] } = {}) {
  let list = Array.isArray(coins) ? coins : [];
  const f = filter || createDefaultFilterState();

  if (activeCategory === "Watchlist") {
    const watchSet = new Set(watchlist);
    list = list.filter((c) => watchSet.has(c.code));
  } else if (activeCategory && activeCategory !== "All") {
    list = list.filter((c) => Array.isArray(c.categories) && c.categories.includes(activeCategory));
  }

  if (f.chain && f.chain !== "All") {
    list = list.filter(
      (c) => Array.isArray(c.chains) && c.chains.some((ch) => ch.name === f.chain),
    );
  }

  const query = String(f.query || "").trim().toLowerCase();
  if (query) {
    list = list.filter(
      (c) =>
        String(c.name || "").toLowerCase().includes(query) ||
        String(c.code || "").toLowerCase().includes(query),
    );
  }

  const mcapRange = resolveRange(MCAP_PRESETS, f.mcapPreset, f.mcapMin, f.mcapMax);
  if (mcapRange) {
    list = list.filter((c) => matchesNumericRange(c.cap, mcapRange, { requirePositive: true }));
  }

  const volRange = resolveRange(VOLUME_PRESETS, f.volPreset, f.volMin, f.volMax);
  if (volRange) {
    list = list.filter((c) => matchesNumericRange(c.volume, volRange, { requirePositive: true }));
  }

  const changeRange = resolveRange(CHANGE_PRESETS, f.changePreset, f.changeMin, f.changeMax);
  if (changeRange) {
    const tf = CHANGE_TIMEFRAMES.some((t) => t.id === f.changeTimeframe)
      ? f.changeTimeframe
      : "h24";
    list = list.filter((c) => matchesNumericRange(c.changes?.[tf], changeRange));
  }

  const liqRange = resolveRange(LIQUIDITY_PRESETS, f.liqPreset, f.liqMin, f.liqMax);
  if (liqRange) {
    list = list.filter((c) =>
      matchesNumericRange(c.liquidity, liqRange, { requirePositive: true }),
    );
  }

  const fdvRange = resolveRange(FDV_PRESETS, f.fdvPreset, f.fdvMin, f.fdvMax);
  if (fdvRange) {
    list = list.filter((c) => matchesNumericRange(c.fdv, fdvRange, { requirePositive: true }));
  }

  const ratioRange = resolveRange(RATIO_PRESETS, f.ratioPreset, f.ratioMin, f.ratioMax);
  if (ratioRange) {
    list = list.filter((c) => matchesNumericRange(getCoinMcapFdvRatio(c), ratioRange));
  }

  return list;
}

export function getAvailableChains(coins) {
  const counts = new Map();
  for (const coin of coins || []) {
    if (!Array.isArray(coin.chains)) continue;
    const seen = new Set();
    for (const ch of coin.chains) {
      if (!ch?.name || seen.has(ch.name)) continue;
      seen.add(ch.name);
      counts.set(ch.name, (counts.get(ch.name) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function getAvailableCategories(coins, orderedCategories = []) {
  const counts = new Map();
  for (const coin of coins || []) {
    if (!Array.isArray(coin.categories)) continue;
    for (const cat of coin.categories) {
      if (!cat) continue;
      counts.set(cat, (counts.get(cat) || 0) + 1);
    }
  }
  const result = [];
  const added = new Set();
  for (const cat of orderedCategories || []) {
    if (counts.has(cat) && !added.has(cat)) {
      added.add(cat);
      result.push({ name: cat, count: counts.get(cat) });
    }
  }
  for (const [name, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!added.has(name)) {
      result.push({ name, count });
    }
  }
  return result;
}

function formatCustomRangeLabel(range, opts) {
  const minText = range.min !== null ? formatShortThreshold(range.min, opts) : null;
  const maxText = range.max !== null ? formatShortThreshold(range.max, opts) : null;
  if (minText && maxText) return `${minText} – ${maxText}`;
  if (minText) return `≥ ${minText}`;
  if (maxText) return `≤ ${maxText}`;
  return "";
}

export function getActiveFilterChips(filter, { activeCategory = "All" } = {}) {
  const f = filter || createDefaultFilterState();
  const chips = [];

  if (f.chain && f.chain !== "All") {
    chips.push({ key: "chain", label: "Chain", value: f.chain });
  }
  if (activeCategory && activeCategory !== "All" && activeCategory !== "Watchlist") {
    chips.push({ key: "category", label: "Category", value: activeCategory });
  }
  if (String(f.query || "").trim()) {
    chips.push({ key: "query", label: "Coin", value: `"${String(f.query).trim()}"` });
  }

  const mcapRange = resolveRange(MCAP_PRESETS, f.mcapPreset, f.mcapMin, f.mcapMax);
  if (mcapRange) {
    chips.push({
      key: "mcap",
      label: "Market Cap",
      value: mcapRange.isCustom
        ? formatCustomRangeLabel(mcapRange, { currency: true })
        : mcapRange.label,
    });
  }

  const volRange = resolveRange(VOLUME_PRESETS, f.volPreset, f.volMin, f.volMax);
  if (volRange) {
    chips.push({
      key: "vol",
      label: "24h Vol",
      value: volRange.isCustom
        ? formatCustomRangeLabel(volRange, { currency: true })
        : volRange.label,
    });
  }

  const changeRange = resolveRange(CHANGE_PRESETS, f.changePreset, f.changeMin, f.changeMax);
  if (changeRange) {
    const tfLabel =
      CHANGE_TIMEFRAMES.find((t) => t.id === f.changeTimeframe)?.label || "24h";
    chips.push({
      key: "change",
      label: `${tfLabel} Change`,
      value: changeRange.isCustom
        ? formatCustomRangeLabel(changeRange, { percent: true })
        : changeRange.label,
    });
  }

  const liqRange = resolveRange(LIQUIDITY_PRESETS, f.liqPreset, f.liqMin, f.liqMax);
  if (liqRange) {
    chips.push({
      key: "liq",
      label: "Liquidity",
      value: liqRange.isCustom
        ? formatCustomRangeLabel(liqRange, { currency: true })
        : liqRange.label,
    });
  }

  const fdvRange = resolveRange(FDV_PRESETS, f.fdvPreset, f.fdvMin, f.fdvMax);
  if (fdvRange) {
    chips.push({
      key: "fdv",
      label: "FDV",
      value: fdvRange.isCustom
        ? formatCustomRangeLabel(fdvRange, { currency: true })
        : fdvRange.label,
    });
  }

  const ratioRange = resolveRange(RATIO_PRESETS, f.ratioPreset, f.ratioMin, f.ratioMax);
  if (ratioRange) {
    chips.push({
      key: "ratio",
      label: "MCap / FDV",
      value: ratioRange.isCustom
        ? formatCustomRangeLabel(ratioRange, {})
        : ratioRange.label,
    });
  }

  return chips;
}

export function countActivePanelFilters(filter) {
  const chips = getActiveFilterChips(filter, { activeCategory: "All" });
  return chips.length;
}
