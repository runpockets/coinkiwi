# CoinKiwi

A self-hosted, ad-free cryptocurrency market and portfolio tracker built as a single-container [Pockets](https://github.com/runpockets/pockets) app, powered by [Live Coin Watch](https://www.livecoinwatch.com/).

## Features

- **Live market overview:** Global market stats bar, Highlights cards (Market Cap, Trending, Top Gainers), category & preset filters, and a sortable market table with 7-day SVG sparklines.
- **Coin detail pages:** Interactive price and volume charts, currency converter, market stats, verified contract addresses, and block explorer links.
- **Watchlist & portfolio:** Track favorite coins and holdings locally — persisted in `/data` with no accounts, ads, or third-party trackers.
- **Light & dark themes** with responsive desktop and mobile layouts.
- **Zero runtime dependencies:** Pure Node.js HTTP server (`server.js`) with disk-backed stale-while-revalidate caching under `/data/cache` and graceful sample fallback before an API key is configured.

## Run in Pockets

1. Open Pockets and choose **New pocket**.
2. Click **Pull Pocket** on **CoinKiwi** in **Pockets Hub** (or pull `runpockets/coinkiwi` directly from GitHub).
3. *(Optional)* Add your Live Coin Watch API key (`LIVECOINWATCH_API_KEY`) under **Runtime variables** in Pockets, or enter it inside CoinKiwi's in-app Settings modal.
4. Click **Build & start** (or **Start** in Preview) and open CoinKiwi in your browser.

### External APIs used

- `api.livecoinwatch.com` — live prices, global market stats, exchanges, and historical charts (requires your own Live Coin Watch API key).
- `api.coingecko.com` — read-only daily token contract & blockchain platform directory (fetched at most once every 24 hours).
- `api.alternative.me` — daily Crypto Fear & Greed Index.

## Local development

```sh
HOST=127.0.0.1 DATA_DIR=./data npm start
npm test
```

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
