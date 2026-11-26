// Portfolio sorting and filtering engine shared by the CoinKiwi UI and tests.

export const PORTFOLIO_SORT_OPTIONS = [
  { key: "value", label: "Value", defaultDir: "desc" },
  { key: "pnl", label: "P&L ($)", defaultDir: "desc" },
  { key: "pnlPct", label: "P&L (%)", defaultDir: "desc" },
  { key: "h24", label: "24h Change", defaultDir: "desc" },
  { key: "price", label: "Price", defaultDir: "desc" },
  { key: "holdings", label: "Holdings (Qty)", defaultDir: "desc" },
  { key: "coin", label: "Name", defaultDir: "asc" },
  { key: "rank", label: "Market Cap Rank", defaultDir: "asc" },
];

export const VALID_PORTFOLIO_SORT_KEYS = PORTFOLIO_SORT_OPTIONS.map((opt) => opt.key);

export const DEFAULT_PORTFOLIO_SORT = {
  key: "value",
  dir: "desc",
};

const SORT_OPTION_MAP = new Map(PORTFOLIO_SORT_OPTIONS.map((opt) => [opt.key, opt]));

export function getDefaultPortfolioSortDir(key) {
  return SORT_OPTION_MAP.get(key)?.defaultDir || "desc";
}

export function normalizePortfolioSort(key, dir) {
  const validKey = SORT_OPTION_MAP.has(key) ? key : DEFAULT_PORTFOLIO_SORT.key;
  const validDir =
    dir === "asc" || dir === "desc" ? dir : getDefaultPortfolioSortDir(validKey);
  return { key: validKey, dir: validDir };
}

/**
 * Compute next sort state when clicking a table header column.
 * Clicking the P&L column preserves pnlPct if it is currently active and flips direction.
 */
export function togglePortfolioSort(currentKey, currentDir, clickedKey) {
  const cur = normalizePortfolioSort(currentKey, currentDir);
  if (!SORT_OPTION_MAP.has(clickedKey)) return cur;

  if (clickedKey === "pnl" && (cur.key === "pnl" || cur.key === "pnlPct")) {
    return {
      key: cur.key,
      dir: cur.dir === "asc" ? "desc" : "asc",
    };
  }

  if (cur.key === clickedKey) {
    return {
      key: cur.key,
      dir: cur.dir === "asc" ? "desc" : "asc",
    };
  }

  return {
    key: clickedKey,
    dir: getDefaultPortfolioSortDir(clickedKey),
  };
}

export function filterPortfolioRows(rows, filter = "all") {
  const list = Array.isArray(rows) ? rows : [];
  if (filter === "holdings") {
    return list.filter((row) => (row?.qty || 0) > 0);
  }
  if (filter === "watchlist") {
    return list.filter((row) => !(row?.qty > 0));
  }
  return list;
}

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getNumericSortValue(row, key) {
  switch (key) {
    case "value":
      return row.qty > 0 ? finiteOrNull(row.value) : null;
    case "holdings":
      return row.qty > 0 ? finiteOrNull(row.qty) : null;
    case "pnl":
      return finiteOrNull(row.pnl);
    case "pnlPct":
      return finiteOrNull(row.pnlPct);
    case "h24":
      return finiteOrNull(row.coin?.changes?.h24);
    case "price": {
      const rate = finiteOrNull(row.coin?.rate);
      return rate !== null && rate > 0 ? rate : null;
    }
    case "rank": {
      const rank = finiteOrNull(row.coin?.rank);
      return rank !== null && rank > 0 ? rank : null;
    }
    default:
      return null;
  }
}

function compareText(a, b) {
  return String(a || "").localeCompare(String(b || ""), undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

function compareTieBreakers(a, b) {
  // Owned holdings with higher value come first when tied
  const valA = a.qty > 0 && Number.isFinite(a.value) ? a.value : -1;
  const valB = b.qty > 0 && Number.isFinite(b.value) ? b.value : -1;
  if (valA !== valB) return valB - valA;

  // Then by market cap rank ascending
  const rankA = finiteOrNull(a.coin?.rank) ?? Number.POSITIVE_INFINITY;
  const rankB = finiteOrNull(b.coin?.rank) ?? Number.POSITIVE_INFINITY;
  if (rankA !== rankB) return rankA - rankB;

  // Finally alphabetically by name / code
  const nameCmp = compareText(a.coin?.name, b.coin?.name);
  if (nameCmp !== 0) return nameCmp;
  return compareText(a.coin?.code, b.coin?.code);
}

/**
 * Sort portfolio rows deterministically. Missing/watch-only values for numeric
 * metrics (e.g. Value, Holdings, P&L) always sort after rows with data, even
 * when sorting ascending.
 */
export function sortPortfolioRows(rows, sortKey = "value", sortDir = "desc") {
  const list = Array.isArray(rows) ? [...rows] : [];
  const { key, dir } = normalizePortfolioSort(sortKey, sortDir);
  const mult = dir === "asc" ? 1 : -1;

  return list.sort((a, b) => {
    if (key === "coin") {
      const nameCmp = compareText(a.coin?.name || a.coin?.code, b.coin?.name || b.coin?.code);
      if (nameCmp !== 0) return nameCmp * mult;
      const codeCmp = compareText(a.coin?.code, b.coin?.code);
      if (codeCmp !== 0) return codeCmp * mult;
      return compareTieBreakers(a, b);
    }

    const valA = getNumericSortValue(a, key);
    const valB = getNumericSortValue(b, key);

    if (valA === null && valB === null) {
      return compareTieBreakers(a, b);
    }
    if (valA === null) return 1;
    if (valB === null) return -1;

    if (valA !== valB) {
      return (valA - valB) * mult;
    }

    return compareTieBreakers(a, b);
  });
}
