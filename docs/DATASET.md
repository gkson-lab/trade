# Training data

Every run produces data you can stack across runs and train one model on. The naming rule is the same everywhere:

- `x_*`: inputs. Only information available at that moment; no look-ahead.
- `y_*`: targets, filled in after the fact.
- Everything else is an identifier or a human-readable label (`gen`, `date`, `symbol`, `bot`, ...).

Where to get it:

| Where | Files |
|---|---|
| Browser | **Data → Training data (.zip)**: `training/market-samples.csv`, `round-trips.csv`, `bot-generations.csv`, `family-tree.csv` |
| CLI | `out/run-*/gen-NNNN/market-samples.csv` and `round-trips.csv` in every generation folder, plus run-level `family-tree.csv`, `pedigree.csv`, `bots.csv` |
| Many runs | Point `tools/train_model.py` at any number of run folders or zips; it stacks them and adds a `run` column |

```bash
python3 tools/train_model.py out/run-1-x1 out/run-2-x1 out/run-3-x1
```

## 1. Market samples: stock → future return

At every close the box samples about 150 liquid stocks at random, plus every stock a bot holds and every stock with news that day. Each row is one stock on one date. Forward labels arrive 1, 5 and 10 trading days later. The row is written to the generation folder in which its 10-day label completes. Rows still waiting when a run ends go into `market-samples-partial.csv` with the labels that are known so far.

Identifiers: `gen, date, symbol, sector, regime, sampleReason (random | held | news), botsHolding`.

**Inputs**

| Column | Meaning |
|---|---|
| `x_price` | Close price |
| `x_logMcap` | log10 of market cap in $ |
| `x_beta`, `x_idioVol` | The stock's market beta and its stock-specific annual volatility |
| `x_realVol` | Realized annual volatility (EWMA of daily returns) |
| `x_ret1d`, `x_ret5d`, `x_ret20d` | Return over the last 1, 5 and 20 sessions |
| `x_z20` | Distance from the 20-day mean, in standard deviations |
| `x_rsi14`, `x_atrPct` | RSI(14) and ATR(14) as % of price |
| `x_vwapDist` | Close vs the session VWAP |
| `x_volSurge` | Session volume / average daily volume |
| `x_sentiment` | Decayed news sentiment, −1..1 |
| `x_daysToEarnings` | Sessions until the next scheduled earnings report |
| `x_divYield`, `x_shortInt`, `x_epsYield` | Dividend yield, short interest (% of float), EPS / price |
| `x_rangePos` | Position inside the 6-month high-low range, 0..1 |
| `x_spreadBps` | Quoted bid/ask spread in basis points |
| `x_sp500`, `x_sectorCode`, `x_exchangeCode`, `x_halted` | Category codes (sector order is `T.SECTORS` in `js/symbols.js`) |
| `x_vix`, `x_regimeCode` | SIM VIX and regime (0 bull, 1 neutral, 2 bear, 3 crash) |
| `x_idxRet1d`, `x_idxRet5d`, `x_sectorRet1d` | SIM 500 and sector-index returns |
| `x_adRatio`, `x_pctAbove20d` | Market breadth |
| `x_fedFunds`, `x_cpi`, `x_unemployment` | Macro state |
| `x_f_*` (15 columns) | The exact normalized inputs the bots' neural networks see |

**Targets**

| Column | Meaning |
|---|---|
| `y_fwdRet1d`, `y_fwdRet5d`, `y_fwdRet10d` | Split-adjusted price return over the next 1, 5 and 10 sessions |
| `y_fwdIdxRet5d` | SIM 500 return over the same 5 sessions |
| `y_fwdExcess5d`, `y_fwdExcess10d` | Stock minus index |
| `y_up5d` | 1 if `y_fwdRet5d` > 0 |
| `y_maxUp5d`, `y_maxDown5d` | Best and worst close-to-close return seen within those 5 sessions |

## 2. Round trips: a bot's decision → its outcome

One row per completed trade, from entry to exit. Each row carries:

- the stock's `x_*` snapshot at the moment of entry (same columns as above)
- the bot's genetics as `bot_*`: house, lineage depth, inbreeding coefficient, `bot_gt_<trait>` genotype, `bot_trait_<trait>` phenotype, and its decoded genes (thresholds, position size, stops, holding limits)

Targets: `y_return`, `y_pnl`, `y_win`, `y_holdDays`, `y_mfe` (best move in the trade's favour), `y_mae` (worst move against it).

## 3. Bot generations: genes → performance

`bots.csv` / `bot-generations.csv` has one row per bot per generation. It holds:

- genes: `maxPositions`, `positionSize`, `stopLoss`, ...
- traits: `trait_*`, `genotype`, `house`, `inbreeding`, `lineageDepth`
- breeding: `breedingRule` (preset), `breedingDetail` (pool, pairing and brackets in words), `parentRanks`, `parentReturns`, `parentBrackets`, `breedingNote` (set when fewer than 2 bots qualified)
- outcomes: about 50 metrics, such as `returnPct`, `sharpe`, `alphaAnn` and `maxDrawdown`

Use it to learn which genetic make-ups do well.

## 4. Family tree and pedigree

`family-tree.csv` has one row per bot ever born:

- parents and grandparents
- house, `breedingRule`, `parentRanks`, `inbreeding`
- children and grandchildren counts
- each `gt_*` and `trait_*`
- lifetime compounded return

`pedigree.csv` lists parent → child edges, ready for graph tools.

## Genetics in brief

17 Mendelian genes on 4 chromosomes. Each bot carries two copies of every gene, one from each parent.

- **Crossing over:** a parent passes on one copy of each chromosome, switching copies between neighbouring genes 25% of the time, so genes on the same chromosome tend to be inherited together.
- **Mutation:** each allele has a 2% chance of mutating, scaled by the run's Mutation setting and tripled for parents with the Mutator trait.

| Chromosome | Trait | Alleles | Inheritance | Looks |
|---|---|---|---|---|
| 1 Risk | Temperament | A / a | A dominant | Aggressive / Cautious |
| 1 Risk | Conviction | K / k | K dominant | Bold / Measured |
| 1 Risk | Greed | G / g | codominant | Greedy (GG) / Balanced (Gg) / Quick to bank (gg) |
| 1 Risk | Loss handling | L / l | L dominant | Loss tolerant / Loss averse (ll) |
| 2 Style | Horizon | Q / q | Q dominant | Scalper / Swing trader |
| 2 Style | Trading hours | E / e | codominant | Morning (EE) / All-day (Ee) / Afternoon (ee) |
| 2 Style | Stops | T / t | T dominant | Trailing stops / Fixed stops |
| 2 Style | Portfolio spread | D / d | D dominant | Diversifier / Concentrated (dd) |
| 3 Signals | News sense | N / n | N dominant | Newshound / Skeptic |
| 3 Signals | Herding | H / h | codominant | Herd follower (HH) / Mixed (Hh) / Independent (hh) |
| 3 Signals | Momentum view | C / c | C dominant | Trend reader / Contrarian (cc) |
| 3 Signals | Volatility appetite | V / v | codominant | Volatility seeker (VV) / Neutral (Vv) / Calm seeker (vv) |
| 4 Focus | Size taste | B / b | codominant | Big caps (BB) / Any size (Bb) / Small caps (bb) |
| 4 Focus | Short selling | R / r | r recessive | Long only / Short seller (rr only) |
| 4 Focus | Focus | S / s | S dominant | Generalist / Sector specialist (ss) |
| 4 Focus | Favourite sectors | 12 sector alleles | both copies count | Which sectors a specialist trades |
| 4 Focus | Genome stability | M / m | M dominant | Stable genome / Mutator (mm) |

In the exports, `gt_<trait>` is the genotype (dominant allele first; sectors by name) and `trait_<trait>` is how it shows.

On top of the traits, each child gets crossed-over and mutated neural-network weights and continuous genes from its parents.

- **House:** a child takes the house name of its better-ranked parent.
- **Inbreeding coefficient:** Wright's F, computed exactly from the pedigree over the last 12 generations. It's 0.25 for a child of full siblings and 0.0625 for a child of first cousins.
