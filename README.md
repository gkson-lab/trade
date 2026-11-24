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
| Headless | `node cli.js --mult 2 --gens 6 --days 10 --seed 42` (add `--gzip` or `--lean` for smaller files, `--xlsx` for Excel copies) |
| Endless | Browser: **New run → Run forever**, then **Finish** when you want to stop. CLI: `node cli.js --forever` (Ctrl+C finishes the current generation and saves everything; `--max-gens N` and `--max-minutes M` also work) |
| Combine CSVs | `node tools/combine.js out/run-20270104-x1` or `node tools/combine.js a.zip b/*.csv --out merged.xlsx`. In the browser: **Data → Combine CSVs into one spreadsheet** |
| Update checker | Built into the page: checks GitHub every 5-10 minutes and shows a **Reload** bar when a new commit lands on `main`. For a local clone: `node tools/check-updates.js` (add `--pull` to fast-forward automatically, `--branch` to pick a branch, `--once` for a single check) |
| Tests | `node tests/run.js`, `node tests/final.js` and `node tests/docs.js` |

## Final training mode: the trading bot

Flip the **Final training mode** switch in the top bar. The simulation pauses, the bar turns amber, and a banner stays on screen while you're in this mode. It says the bot is learning from *your* data, that results are estimates and not investment advice, and that nothing places orders. **Back to the simulation** (or the switch) leaves the mode.

1. **Price data in.** Load daily prices: one CSV per symbol (a Yahoo Finance download works, and adjusted prices are used when present), one CSV with a symbol column, or a .zip of CSVs. Bad rows, short histories and likely unadjusted splits are reported. Pick an index fund you loaded (SPY, QQQ ...) as the market, or let the bot average your symbols. **Try it with simulated prices** loads practice data, marked as such everywhere.
2. **Settings.** Holding period (1 to 20 days), big-move size, model (boosted decision trees or logistic regression), dollars per trade, buy level, trading cost, stop loss and take profit, shorting. **Use the best simulated bot's risk rules** copies the stop, target and position count from the top bot of your simulation run.
3. **Train and test.** 26 inputs from prices and volume only, each using data up to that day's close: momentum, volatility, RSI, ATR, moving averages, volume surge, gaps, 1-year range, market trend and volatility, beta, cross-stock ranks. Every trade enters at the *next* open.
   - The bot trains on the oldest 70% of dates, tunes on the next 15%, and is scored on the newest 15%, with gaps so no label overlaps the next period.
   - It then retrains on all the data for the final predictions.
4. **How it did on dates it never saw.** A plain verdict (skill / weak / none, including "it's only timing the whole market"), AUC, daily rank correlation, top-minus-bottom spread, and a backtest with costs and stops against buying everything equally. It also shows whether its chances are honest (calibration), what it pays attention to, and outcomes by confidence group.
5. **Predictions and chances of profit or loss.** For every symbol's latest day:
   - **Calibrated chances:** of rising, of rising more than the big-move size, and of falling more than it. These come from how often that really happened on held-out dates for similar scores.
   - **Expected return and likely range:** the 10th to 90th percentile of past outcomes.
   - **Dollar figures:** expected profit or loss and its range for your trade size.
   - **Decision:** a confidence level, a capped quarter-Kelly size, and Buy / Hold / Avoid / Short.

   A warning sits above the signals whenever the test found weak or no skill.
6. **Results out, model in.**
   - **Full results .xlsx**, with 9 sheets: summary, predictions, calibration, outcome ranges, backtest, trades, feature importance, test predictions, data quality.
   - **Predictions .csv.**
   - **Trained model .json:** load it later to predict on new prices without retraining. If the new prices run past its training dates, it's also scored on them.
   - **Training table .csv:** `x_` inputs and `y_` outcomes.

From the command line, the same engine runs:

```bash
node tools/final_train.js --data prices/ --benchmark SPY --horizon 5 --out final
node tools/final_train.js --data new-prices/ --model final/model.json --out final
node tools/final_train.js --sample            # practice data
```

`node tests/final.js` checks the engine:

- **Planted signal:** synthetic stocks with real persistent momentum must be found on unseen dates.
- **Pure noise:** a random walk must not earn a "skill" verdict.
- **No look-ahead:** changing every later price must leave earlier inputs untouched.
- **Saved model:** must reload and give identical predictions.

Most models trained on prices alone land close to chance. The screen says so when that happens, so treat any signal as something to paper-trade first.

## Trading data bot: everything goes to the internal documents repo

Everything the bots collect can go straight to **gk-research-group/internal-documents-** as a pull request authored by you. It lands under `shelf-12-trading-data/`, following that repo's handling rules:

- every folder gets a README with the confidential header and its own document ID
- no tokens are ever written anywhere

| From | How |
|---|---|
| The app | The **Trading data bot** button in the top bar. Choose this simulation run or the latest final training and press **Open pull request**. Tick **Send automatically** to open a pull request whenever a run or a training finishes; endless runs update their pull request every 25 generations. |
| Command line | `node cli.js --push-docs` (endless runs update the pull request every `--docs-every` generations) and `node tools/final_train.js --push-docs`. Uses `DOCS_TOKEN`, `GH_TOKEN` or `GITHUB_TOKEN`, or your `gh auth login`. With `--docs-git <local clone>` it writes into a clone, commits, `git push`es and opens the pull request with `gh` instead (no API token needed). |
| Cloud | The **Simulate** workflow sends each run when the repository secret `DOCS_TOKEN` is set. The pull request links the full archive in the run's release. |

**What a simulation run sends:**

- summary, generations, genetics, bot profiles, family tree, pedigree, bots, genomes, market and sector days, symbols
- the training tables (market samples, round trips)
- trades, bot days, positions, news, intraday equity

**What a final training sends:**

- verdict and metrics, predictions, calibration, outcome ranges, backtest and trades, feature importance, test predictions
- the trained model and the training table

Big tables are gzipped CSV. Anything past 90 MB is left out and listed in the folder README.

**The token:** a fine-grained personal access token.

- Resource owner `gk-research-group`, only the `internal-documents-` repository.
- **Contents** and **Pull requests** set to read and write.
- In the app it stays in your browser (only for the session unless you tick *Remember*) and is sent only to api.github.com.

**Where it can't send directly:** the claude.ai phone link can't reach GitHub. There, use **Download the bundle** and **GitHub's upload page**, which opens a pull request from the web.

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

### Genetics and family trees

Every bot carries **17 Mendelian genes on 4 chromosomes**, two copies of each, one inherited from each parent. They work like real inheritance:

- **Expression:** genes can be dominant, recessive or codominant. One gene has 12 sector alleles.
- **Crossing over:** genes on the same chromosome tend to be inherited together.
- **Mutation:** a mutator gene makes a bot's children mutate more.

The traits change how a bot trades:

- **Risk:** Aggressive or Cautious · Bold or Measured · Greedy, Balanced or Quick to bank · Loss tolerant or Loss averse
- **Style:** Scalper or Swing trader · Morning, All-day or Afternoon trader · Trailing or Fixed stops · Diversifier or Concentrated
- **Signals:** Newshound or Skeptic · Herd follower, Mixed or Independent · Trend reader or Contrarian · Volatility seeker or Calm seeker
- **Focus:** Big caps or Small caps · Short seller (only `rr`) · Sector specialist (only `ss`, trades just its two favourite sectors) · Mutator (`mm`)

Founders each start a **house**, and children take the house of their better-ranked parent. Every bot records its parents, grandparents, children, lineage depth and inbreeding coefficient (Wright's F). Open a bot's panel to see its family and its genes chromosome by chromosome; the **Family Tree** and **Pedigree** tables export all of it. Details are in [docs/DATASET.md](docs/DATASET.md#genetics-in-brief).

### Breeding rules

In **New run → Breeding**, pick a preset or build your own from three parts. On the CLI, use `--breeding PRESET`, or `--pool`, `--pairing` and `--brackets`; run `node cli.js --list-breeding` to see every choice.

**Presets**

| Group | Presets |
|---|---|
| Winners and losers | Ranked neighbours (default) · Winners with winners · Losers with losers · Winners with winners and losers with losers · Winners with losers |
| By profit | Only profitable bots · Only losing bots · Only bots that beat the SIM 500 · Only bots above a return you set · Only bots in a return range you set · Top 25% mate at random · Bottom 25% mate at random |
| By bracket | Within each quartile · Each quartile with the one below · Top quartile with bottom quartile · Top two quartiles only · Within profit levels (below -2%, -2 to 0%, 0 to 2%, above 2%) |
| Other | Random mating · Tournament · Rank roulette · Avoid relatives · Keep it in the family |

**Build your own** (changing any of these switches the preset to Custom):

| Part | Choices |
|---|---|
| Who can breed (`--pool`) | The usual breeders · Everyone · Winners (top half) · Losers (bottom half) · Winners and losers kept apart · Profitable bots · Unprofitable bots · Beat the SIM 500 · Lost to the SIM 500 · Return at or above a level · Return below a level · Return between two levels · Top X% · Bottom X% · Chosen brackets |
| How they pair up (`--pairing`) | Similar rank · Opposite rank · Random · Closest profit · Same bracket only · Next bracket down · Mirror brackets (top with bottom) · Tournament · Rank roulette · Least related · Most related |
| Brackets (`--brackets`) | Halves · Thirds · Quartiles · Fifths · Tenths · Profit levels you set (`--levels -2,0,2`) |
| Settings | Return levels in % (`--threshold`, `--threshold2`), share for Top/Bottom X% (`--pct`), which brackets may breed (`--allowed 1,2`, where 1 is the top bracket) |

Example: `node cli.js --pool brackets --brackets profit --levels -3,0,3 --allowed 1,4 --pairing mirrorBracket` lets only bots above +3% and bots below -3% breed, each high earner paired with a big loser.

**How it works**

- The schedule never changes (20 → 10 → 20). Rules choose who *parents* the children; from Gen 3 on, the top half still survives into the next generation.
- If a rule's pool has fewer bots than the pairs needed, bots in it parent more than one pair. If fewer than 2 bots qualify, the next in line fill in, and the child's record says so.
- Every child records its parents' ranks, returns and brackets, plus the rule that paired them (`parentRanks`, `parentReturns`, `parentBrackets`, `breedingDetail`).

**Mutation** (Low / Normal / High / Wild, `--mutation`) scales how far children drift from their parents.

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

## Training a model

Every run writes model-ready data: inputs are `x_*` columns, targets are `y_*` columns. There are three datasets:

- **Market samples:** about 150+ stocks a day, ~50 inputs, with 1/5/10-day forward returns.
- **Round trips:** every bot trade, with the stock's inputs at entry and the bot's genes, labeled win/loss and return.
- **Bot generations:** genes and traits labeled with performance.

To get them, use **Data → Training data (.zip)** in the browser; the CLI writes them into every generation folder. Stack any number of runs and train:

```bash
pip install pandas scikit-learn
python3 tools/train_model.py out/run-1-x1 out/run-2-x1 out/run-3-x1                 # stock vs SIM 500 over 5 days
python3 tools/train_model.py out/run-* --task trips --save trips-model.joblib       # will this bot's trade win?
python3 tools/train_model.py out/run-* --task bots                                  # which genes and traits pay?
```

The test set is always the latest 20% of dates. Every column is documented in [docs/DATASET.md](docs/DATASET.md).

### Why the data gets big, and how to keep it small

A 60-trading-day run makes about **18 MB of real data**. The biggest tables are:

- training samples: ~150+ stocks a day × ~60 columns
- round trips: ~90 columns each, because every trade carries the stock's inputs and the bot's genes

Earlier versions also wrote the same rows three more times (two Excel workbooks and a folder per bot), which made the same run **98 MB**. Now:

- **CLI default:** writes each row once, as CSV. The extra copies are opt-in: `--xlsx` and `--bot-folders`.
- **`--gzip`:** writes `.csv.gz`, about 3x smaller. pandas, `tools/train_model.py` and `tools/combine.js` read it directly.
- **`--lean`:** gzip plus 50 training samples a day instead of 150. The same 60-day run is **4.7 MB**.
- **In the app:** New run → *Training samples per day* (Off / 50 / 150 / 400) sets the biggest table. *Memory for trade-level data* (about 150 MB, 400 MB or 1.5 GB) caps how much an endless run holds.
- **Memory is counted in cells** (rows × columns, about 50 bytes each), because a training row has ~90 columns. Per-bot history and retired bots are kept for the last 300 generations (`--history`), so endless runs stay flat in memory. The CLI's generation folders, including `births.csv` for every bot born, always hold everything.

### Run it in the cloud for free

The repo is public, so **GitHub Actions minutes are free**, on 4-core, 16 GB runners with up to 6 hours per job. Two workflows are ready:

1. **Simulate** (Actions tab → *Simulate* → *Run workflow*). It runs the box for 60 minutes by default (up to 330), endless, with your choice of days, population, breeding and samples.
   - A runner simulates roughly 200 trading days a minute, so an hour is decades of market history: about 650 MB of gzipped data at 50 samples a day (measured). That speed is why the data gets big.
   - Archives over 1.9 GB are split into parts, which *Train* joins back together.
   - The gzipped data is saved as a workflow artifact for 90 days.
   - It's also saved as a **GitHub Release** `run-N`, which is kept until you delete it; each file can be up to 2 GB.
   - Uncomment the `schedule:` lines in `.github/workflows/simulate.yml` to run it every day automatically.
2. **Train** (Actions tab → *Train* → *Run workflow*). It downloads every `run-*` release, stacks them, trains one model with `tools/train_model.py`, and saves `model.joblib`, the report and the predictions. Tick *release* to keep them as a `model-N` release. It uses at most 3 million rows (a random sample, `--max-rows`) so training fits the runner's 16 GB.

Free places to go bigger:

- **Kaggle Notebooks:** free CPU, plus about 30 GPU hours a week. Upload the release files as a Kaggle dataset.
- **Google Colab:** free notebooks.
- **Hugging Face Datasets:** free hosting for large public datasets.
- **Oracle Cloud Always Free:** a small ARM virtual machine that can run `node cli.js --forever` around the clock.

## Data

Open **Data** at any time, even mid-run, to see the report and export. The exports are:

| Export | What's in it |
|---|---|
| Master workbook (.xlsx) | All 18 tables below, with every generation stacked and a `gen` column, plus one `Gen N` sheet per generation |
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
| Market Samples | Labeled training rows: a stock's inputs at the close and its 1/5/10-day forward returns |
| Family Tree | Every bot ever born: house, parents, grandparents, genotype, traits, inbreeding, children, lifetime return |
| Pedigree | Parent → child edges |
| Symbols | All 6,138 symbols: price and return since start (split-adjusted), market cap, EPS, P/E, dividend yield and amount paid, short interest, beta, volatility, RSI, ATR, 6-month range, news/earnings/split counts, bot round trips and P/L |

**Endless runs** keep the Generations and Genetics tables in full, per-bot tables for the last 300 generations, and trade-level tables up to a memory budget (New run → *Memory for trade-level data*). Past that, the oldest rows are dropped from memory, and the exports say which ones. The CLI writes every generation's CSVs to disk as it goes, so nothing is lost there.

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
js/final.js, js/final-ui.js   final training mode: the trading bot for real price data
js/docs-push.js, js/docs-ui.js Trading data bot: pull requests to the internal documents repo
tools/docs_node.js           Trading data bot from Node (token or gh login)
tools/final_train.js         final training mode from the command line
tools/train_model.py         train one model on any number of runs (pandas + scikit-learn)
.github/workflows/simulate.yml   run the box on GitHub's free runners, save data as a release
.github/workflows/train.yml      train one model on every saved run
docs/DATASET.md              every training column explained
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
