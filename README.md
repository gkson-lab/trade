# Trade Box

A box of AI trading bots that breed across generations while trading a simulated US stock market.
It's a static web app with no build step and no server. Open `index.html` in any modern browser (desktop, tablet or phone) and press **Start**.
There is also a headless CLI that writes the same data sheets.

The market is fictional. The 6,138 symbols are real NASDAQ, NYSE and AMEX listings, and each starts from its real price, market cap, volume and sector. Every price after that is simulated.

## On your phone

**Easiest: the hosted link.** Open https://claude.ai/artifact/LXnD6DYBZJpWWAFite1hLW on your phone while signed in to claude.ai, in a browser or the Claude app. Downloads open your phone's save prompt (on iPhone, the share sheet: pick *Save to Files*). To make it feel like an app, add it to your home screen: in Safari, tap **Share → Add to Home Screen**; in Chrome on Android, tap **⋮ → Add to Home screen**.

**Offline: one file.** [`dist/trade-box.html`](dist/trade-box.html) is the whole app in a single 1.5 MB file, with no server or internet needed after the first load of the fonts. On Android, download it from GitHub (open the file, then the **⋯ → Download** button), then open it from the *Files* app in Chrome. On iPhone, Safari won't run a local HTML file, so use the hosted link instead.

Rebuild both after changing the code: `node tools/build_single.js` writes `dist/trade-box.html`; `node tools/build_single.js --artifact` writes the hosted-link version.

## Run it

| Where | How |
|---|---|
| Any browser | Open `index.html` directly, or serve the folder: `python3 -m http.server 8080` |
| Phone / tablet | Host the folder (GitHub Pages: Settings → Pages → Deploy from branch `main`, root) and open the URL. It installs as an app and works offline after the first visit. |
| Headless | `node cli.js --mult 2 --gens 6 --days 10 --seed 42` |
| Endless | Browser: **New run → Run forever**, then **Finish** when you want to stop. CLI: `node cli.js --forever` (Ctrl+C finishes the current generation and saves everything; `--max-gens N` and `--max-minutes M` also work) |
| Combine CSVs | `node tools/combine.js out/run-20270104-x1` or `node tools/combine.js a.zip b/*.csv --out merged.xlsx`. In the browser: **Data → Combine CSVs into one spreadsheet** |
| Update checker | Built into the page: checks GitHub every 5-10 minutes and shows a **Reload** bar when a new commit lands on `main`. For a local clone: `node tools/check-updates.js` (add `--pull` to fast-forward automatically, `--branch` to pick a branch, `--once` for a single check) |
| Tests | `node tests/run.js` |

## The bots

Each bot is a small neural network: 15 market features → 8 hidden units → 1 score. On top of that are 12 behaviour genes: buy and sell thresholds, number of positions, position size, stop loss, trailing stop, take profit, how often it decides, max hold time, cash reserve, shorting on or off, and conviction sizing.

The 15 features are short, day and week momentum, distance from the 20-day mean, decayed news sentiment, realized volatility, volume surge, market trend, sector trend, beta, size, RSI, distance from VWAP, earnings yield and short interest.

Every bot starts each generation with $100,000 by default. Change it in **New run → Starting cash per bot**, or with `--cash` on the CLI. Trades pay the real costs of trading:

- bid/ask spread scaled by liquidity
- size-based price impact
- $0.005/share commission ($1 minimum)
- SEC fee on sells
- borrow fees on shorts
- margin calls

### Breeding schedule

| Generation | Bots (×1) | How |
|---|---|---|
| 1 | 20 | Random genomes |
| 2 | 10 | Ranked neighbours pair up (1+2, 3+4, …); each pair breeds one child |
| 3 | 20 | The 10 pair up and have twins: 10 children + 10 parents |
| 4+ | 20 | Top 10 survive, pair up, have twins: back to 20 |

**New run → Double** scales every number: ×2 is 40 → 20 → 40, ×4 is 80 → 40 → 80, and so on. Parents are ranked by total return. You can switch this to return minus half the max drawdown. Crossover swaps whole hidden units between the parents. Mutation shrinks each generation.

## The market

Every 5-minute bar, for every symbol:

- **Regimes**: bull, neutral, bear and crash, driven by a Markov chain. Macro news can push the market between them.
- **GARCH(1,1) market volatility**: calm and stormy stretches cluster.
- **12 sector factors**, each with its own volatility.
- **Fat-tailed idiosyncratic noise**: small caps and biotech move more, and per-stock volatility clusters after big moves.
- **Intraday U-shape** in both volatility and volume. Overnight gaps.
- **Poisson jumps**.
- **News**:
  - scheduled jobs reports, CPI, GDP and FOMC decisions
  - quarterly earnings with EPS and revenue vs estimates
  - analyst calls, guidance, contracts, lawsuits, buybacks, offerings, recalls, short reports, M&A rumours, FDA decisions and trial readouts
  - sector stories

  News moves prices through gaps, multi-bar price discovery, post-news drift and volatility spikes.
- **LULD single-stock halts** and **market-wide circuit breakers** at -7%, -13% and -20% on the SIM 500.
- **SIM 500**: a cap-weighted index of S&P 500 members, plus a cap-weighted index for each sector. **SIM VIX**: a volatility index read from the market's volatility state.
- **Fundamentals**: EPS that rolls forward with each earnings report, P/E, dividend yields with quarterly ex-dividend drops (paid to bots holding long, charged to shorts), and short interest.
- **Technicals**: RSI 14, ATR, intraday VWAP, a 6-month range, breadth, new highs/lows.
- **Corporate actions**: 1-for-10 reverse splits after 30 sessions under $1, and occasional 4-for-1 splits for very high-priced large caps. Bots' positions adjust, with cash paid for fractional shares.

`node tests/market_stats.js 250` prints the realized statistics for a simulated year:

- annual volatility around 17-21%
- daily-return kurtosis around 5-8
- positive autocorrelation of absolute returns
- regime mix
- how many stocks move more than 10% a day

## Screen

The layout is Kraken-style:

- **Markets list** (left): search, S&P / gainers / losers / held filters and a sector filter.
- **Chart** (centre): candlestick chart (5m or 1D) with volume, a 20-bar SMA and a crosshair.
- **Live charts**: six mini charts showing the names the bots hold most, then the biggest movers.
- **News**, **bot trades** and **sector heatmap** tabs under the chart.
- **Bot board** (right): each bot's equity sparkline and live P/L. Click a bot to see its genes, positions and trades.

On phones, a bottom tab bar switches between panels.

At the end of a run, the report shows run-wide averages (return, P/L, win rate, Sharpe, drawdown), a per-generation chart and table, and the top bot runs. It also offers downloads.

## Data

Open **Data** at any time, even mid-run, to see the report and export. The exports are:

| Export | What's in it |
|---|---|
| Master workbook (.xlsx) | All 15 tables below, with every generation stacked and a `gen` column, plus one `Gen N` sheet per generation |
| Generation CSVs (.zip) | `gen-0001/`, `gen-0002/` ... with that generation's bots, trades, round trips, bot daily, intraday equity, positions, market, sectors, news and genetics, plus run-level CSVs |
| Every bot (.zip) | `bots/<name>/` for every bot: profile (with genome), per-generation results, daily ledger, round trips, trades, intraday equity, positions, sector P/L, symbol P/L |
| Bot ledger workbook (.xlsx) | An index of every bot, then one daily-ledger sheet per bot |
| One bot (.xlsx) | Everything about one bot. Also available from the bot's own panel |
| Combine | Merges any CSVs or ZIPs (from this run or earlier ones) into one spreadsheet. Same-named files are stacked with a `source` column |

Sheets that would pass Excel's row limit continue on a `(2)` sheet.

| Table | Rows |
|---|---|
| Summary | Run settings and run-wide averages: return, P/L, Sharpe, Sortino, alpha, beta, win rate, drawdown, compounded bot vs index |
| Generations | Per generation: avg / median / quartiles / best / worst return, profitable bots, bots beating the index, Sharpe, Sortino, alpha, beta, profit factor, exposure, turnover, fees, dividends, survivors vs children, change vs previous gen, cumulative returns, index volatility, average VIX, regime days |
| Genetics | Per generation: genome diversity, average of every gene, share of shorters and trailers, average weight on each of the 15 inputs, style mix |
| Bots | One row per bot per generation, about 75 columns: return, annualized return, volatility, Sharpe, Sortino, Calmar, drawdown and its duration, alpha, beta, correlation, R², tracking error, information ratio, VaR/CVaR 95, skew, kurtosis, win rate, profit factor, expectancy, payoff, largest win/loss, MFE/MAE, edge ratio, streaks, long vs short P/L, exposure, turnover, fees, borrow, dividends, best/worst sector and symbol, genes |
| Bot Profiles | One row per bot ever born: lineage, children, generations lived, compounded return, best/worst generation, totals, average and best rank, status, genes |
| Genomes | Every bot's genes, top input features and full network weights |
| Trades | Every fill: price, mid, spread and impact in bps, notional, fee, realized P/L, reason, signal strength, cash after |
| Round Trips | Every entry-to-exit: hold time, P/L, return, max favourable/adverse excursion, entry signal and RSI, entry/exit reason, regime in/out, fees |
| Bot Daily | Each bot's close-of-day ledger: equity, cash, daily P/L, drawdown, positions, gross/net exposure, trades, notional, realized P/L, fees, borrow, dividends |
| Equity Intraday | Every bot's equity every 30 minutes, next to the SIM 500 |
| Positions | End-of-day holdings: side, qty, cost, close, market value, unrealized P/L, days held |
| Market Daily | SIM 500 OHLC, SIM VIX, regime, fed funds, CPI, unemployment, GDP, advancers/decliners, up/down volume, new highs/lows, % above the 20-day average, dollar volume, halts |
| Sector Daily | Daily return and level of all 12 sector indices |
| News | Every headline with impact, sentiment, VIX at the time, and EPS actual/estimate/surprise for earnings |
| Symbols | All 6,138 symbols: price and return since start (split-adjusted), market cap, EPS, P/E, dividend yield and amount paid, short interest, beta, volatility, RSI, ATR, 6-month range, news/earnings/split counts, bot round trips and P/L |

**Endless runs** keep every summary table in full. Trade-level tables keep the newest rows up to a memory budget (New run → *Trade-level rows kept in memory*); past that, the oldest generations' trade-level rows are dropped from memory, and the exports say which ones. The CLI writes every generation's CSVs to disk as it goes, so nothing is lost there.

## Files

```
index.html, css/app.css      UI
js/market.js                 price engine, index, halts, candles
js/news.js                   news wire and macro state
js/bots.js                   bot brain, execution, risk
js/sim.js                    generations and breeding
js/report.js                 sheets (XLSX / CSV)
js/charts.js                 canvas charts
js/symbols.js                generated by tools/build_symbols.py from data/source/
js/updates.js                GitHub update checker (in the page)
cli.js                       headless runner (endless mode, writes each generation to disk)
tools/combine.js             merge generation CSVs / ZIPs into one workbook
tools/check-updates.js       update checker for a local clone
vendor/xlsx.full.min.js      SheetJS 0.18.5 (Apache-2.0)
```

UI design follows the [AntiSlopUI](https://github.com/Vanszs/AntiSlopUI) contract:

- its warm-dark surface tokens
- the money-domain teal accent instead of a purple one
- Bricolage Grotesque display type with an Inter body
- a radius scale
- colour plus a +/− sign for every gain or loss
- visible focus rings
- `<dialog>` overlays
- no `innerHTML`
- `prefers-reduced-motion` support

Symbol snapshots come from [rreichel3/US-Stock-Symbols](https://github.com/rreichel3/US-Stock-Symbols) and [datasets/s-and-p-500-companies](https://github.com/datasets/s-and-p-500-companies).

Not investment advice.
