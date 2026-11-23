# Trade Box

A box of AI trading bots that breed across generations while trading a simulated US stock market.
It's a static web app with no build step and no server. Open `index.html` in any modern browser (desktop, tablet or phone) and press **Start**.
There is also a headless CLI that writes the same data sheets.

The market is fictional. The 6,138 symbols are real NASDAQ, NYSE and AMEX listings, and each starts from its real price, market cap, volume and sector. Every price after that is simulated.

## Run it

| Where | How |
|---|---|
| Any browser | Open `index.html` directly, or serve the folder: `python3 -m http.server 8080` |
| Phone / tablet | Host the folder (GitHub Pages: Settings → Pages → Deploy from branch `main`, root) and open the URL. It installs as an app and works offline after the first visit. |
| Headless | `node cli.js --mult 2 --gens 6 --days 10 --seed 42` writes `out/run-*/trade-run.xlsx` plus one CSV per sheet |
| Tests | `node tests/run.js` |

## The bots

Each bot is a small neural network: 11 market features → 8 hidden units → 1 score. On top of that are 12 behaviour genes: buy and sell thresholds, number of positions, position size, stop loss, trailing stop, take profit, how often it decides, max hold time, cash reserve, shorting on or off, and conviction sizing.

The 11 features are short, day and week momentum, distance from the 20-day mean, decayed news sentiment, realized volatility, volume surge, market trend, sector trend, beta and size.

Every bot starts each generation with $100,000. Trades pay the real costs of trading:

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
- **SIM 500**: a cap-weighted index of S&P 500 members, plus a cap-weighted index for each sector.

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

## Data sheets

The workbook (`.xlsx`) has these sheets. Each one is also available as a CSV.

| Sheet | Rows |
|---|---|
| Summary | Run settings and averages |
| Generations | Avg / median / best / worst return, profitable bots, bots beating the index, Sharpe, win rate, fees, regime days |
| Bots | One row per bot per generation: rank, lineage, style, return, P/L, drawdown, Sharpe, trades, win rate, profit factor, genes |
| Trades | Every fill with price, fee, realized P/L and reason |
| Equity Daily | Each bot's equity at every close |
| Market Daily | SIM 500 OHLC, regime, fed funds, CPI, unemployment, advancers/decliners |
| News | Every headline with its price impact |
| Genomes | Full network weights and genes for every bot ever born |

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
cli.js                       headless runner
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
