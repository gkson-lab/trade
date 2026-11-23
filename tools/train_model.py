#!/usr/bin/env python3
"""Train one model on the data from any number of Trade Box runs.

  pip install pandas scikit-learn
  python3 tools/train_model.py out/run-1-x1 out/run-2-x1 ...            # predict a stock's 5-day return vs the SIM 500
  python3 tools/train_model.py out/run-* --task trips                   # predict whether a bot's trade wins
  python3 tools/train_model.py out/run-* --task bots                    # predict a bot's generation return from its genes and traits
  python3 tools/train_model.py trade-box-...-training.zip --target y_up5d --save model.joblib

Inputs can be CLI run folders, the browser's "Training data" or "Generation CSVs" .zip files, or CSV files.
Columns that start with x_ are inputs, y_ are targets (see docs/DATASET.md). The test set is the last 20% of
dates, so the model is always scored on days it never saw.
"""
import argparse, glob, io, os, sys, zipfile

try:
    import numpy as np
    import pandas as pd
    from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
    from sklearn.inspection import permutation_importance
    from sklearn.metrics import r2_score, roc_auc_score
except ImportError:
    sys.exit("Needs pandas and scikit-learn:  pip install pandas scikit-learn")

TABLES = {"market": ("market-samples", "y_fwdExcess5d", "date"),
          "trips": ("round-trips", "y_win", "entryDate"),
          "bots": ("bots", "returnPct", None)}


def read_any(paths, table):
    frames = []
    for p in paths:
        run = os.path.basename(os.path.normpath(p))
        if os.path.isdir(p):
            files = sorted(glob.glob(os.path.join(p, "**", table + "*.csv"), recursive=True) +
                           glob.glob(os.path.join(p, "**", table + "*.csv.gz"), recursive=True))
            files = [f for f in files if os.sep + "bots" + os.sep not in f]
            if table == "bots":   # one row per bot per generation lives in each gen folder; avoid the run-level copy
                files = [f for f in files if "gen-" in f] or files
            for f in files:
                frames.append(pd.read_csv(f, low_memory=False).assign(run=run))
        elif p.endswith(".zip"):
            with zipfile.ZipFile(p) as z:
                for name in z.namelist():
                    base = os.path.basename(name)
                    if base.startswith(table) and base.endswith(".csv") and not name.startswith("bots/"):
                        if table == "bots" and "gen-" not in name and any("gen-" in n for n in z.namelist()):
                            continue
                        frames.append(pd.read_csv(io.BytesIO(z.read(name)), low_memory=False).assign(run=run))
        elif (p.endswith(".csv") or p.endswith(".csv.gz")) and table in os.path.basename(p):
            frames.append(pd.read_csv(p, low_memory=False).assign(run=run))
    if not frames:
        sys.exit("No %s CSVs found in %s" % (table, ", ".join(paths)))
    return pd.concat(frames, ignore_index=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--task", choices=TABLES, default="market")
    ap.add_argument("--target", help="target column (default depends on --task)")
    ap.add_argument("--save", help="write the fitted model here (joblib)")
    ap.add_argument("--predictions", help="write test-set predictions to this CSV")
    ap.add_argument("--max-rows", type=int, default=0, help="use a random sample of at most this many rows (0 = all)")
    a = ap.parse_args()

    table, default_target, date_col = TABLES[a.task]
    df = read_any(a.paths, table)
    target = a.target or default_target
    if target not in df:
        sys.exit("Column %s not found. Targets available: %s" % (target, ", ".join(c for c in df if c.startswith("y_"))))
    df = df[pd.to_numeric(df[target], errors="coerce").notna()].copy()
    if a.max_rows and len(df) > a.max_rows:
        print("Sampling %d of %d rows (--max-rows)." % (a.max_rows, len(df)))
        df = df.sample(a.max_rows, random_state=0)
    df[target] = pd.to_numeric(df[target])

    if a.task == "bots":
        num = ["buyThreshold", "sellThreshold", "maxPositions", "positionSize", "stopLoss", "takeProfit", "decisionEveryBars",
               "maxHoldDays", "inbreeding", "lineageDepth", "age"]
        cats = [c for c in df if c.startswith("trait_")] + ["style", "breedingRule"]
    else:
        num = [c for c in df if c.startswith("x_") or (c.startswith("bot_") and pd.api.types.is_numeric_dtype(df[c]))]
        cats = [c for c in df if c.startswith("bot_trait_")] + (["sector"] if "sector" in df else [])
    num = [c for c in num if c in df]
    cats = [c for c in cats if c in df]
    X = pd.concat([df[num].apply(pd.to_numeric, errors="coerce"),
                   pd.get_dummies(df[cats].astype(str), prefix=cats, dtype=float)], axis=1)
    X = X.loc[:, X.notna().any()]                      # drop inputs that are empty in every row
    y = df[target]

    # time split: train on earlier dates, test on later ones
    if date_col and date_col in df:
        order = pd.to_datetime(df[date_col])
        cutoff = order.quantile(0.8)
        test = order > cutoff
    else:
        gen = df.get("gen", pd.Series(range(len(df)), index=df.index))
        test = gen > gen.quantile(0.8)
        if test.sum() < 20:
            test = gen == gen.max()
    if test.sum() < 20 or (~test).sum() < 50:
        sys.exit("Not enough rows to train and test (%d rows). Run more generations or more days." % len(df))

    classify = set(y.dropna().unique()) <= {0, 1}
    if not classify:
        # fat-tailed returns: clip the training target to its 1st-99th percentile so a few jumps don't dominate
        lo, hi = y[~test].quantile([0.01, 0.99])
        y = y.where(test, y.clip(lo, hi))
    model = (HistGradientBoostingClassifier if classify else HistGradientBoostingRegressor)(max_iter=300, learning_rate=0.05,
                                                                                       early_stopping=True, random_state=0)
    model.fit(X[~test], y[~test])
    print("%s: %d rows from %d run(s), %d inputs, target %s. Train %d / test %d (later dates)." %
          (table, len(df), df["run"].nunique(), X.shape[1], target, (~test).sum(), test.sum()))

    if classify:
        prob = model.predict_proba(X[test])[:, 1]
        print("Test AUC %.3f  (0.5 = coin flip)   base rate %.1f%%" % (roc_auc_score(y[test], prob), 100 * y[test].mean()))
        pred = prob
    else:
        pred = model.predict(X[test])
        print("Test R2 %.4f (raw target), %.4f (target clipped to the training range; rare jumps excluded)" %
              (r2_score(y[test], pred), r2_score(y[test].clip(lo, hi), pred)))
        if date_col and date_col in df:
            t = df[test].assign(pred=pred)
            ic = t.groupby(date_col).apply(lambda g: g["pred"].corr(g[target], method="spearman") if len(g) > 5 else np.nan, include_groups=False)
            print("Mean daily rank IC %.4f over %d days (above 0 means the model ranks stocks better than chance)" % (ic.mean(), ic.notna().sum()))
            q = pd.qcut(t["pred"], 10, labels=False, duplicates="drop")
            spread = t[target][q == q.max()].mean() - t[target][q == q.min()].mean()
            print("Top-decile minus bottom-decile %s: %+.3f%%" % (target, 100 * spread))

    sample = X[test].sample(min(3000, int(test.sum())), random_state=0)
    imp = permutation_importance(model, sample, y[test].loc[sample.index], n_repeats=3, random_state=0)
    top = pd.Series(imp.importances_mean, index=X.columns).sort_values(ascending=False).head(15)
    print("\nMost useful inputs (permutation importance):")
    for k, v in top.items():
        print("  %-34s %.5f" % (k, v))

    if a.predictions:
        df[test].assign(prediction=pred).to_csv(a.predictions, index=False)
        print("\nTest predictions: " + a.predictions)
    if a.save:
        import joblib
        joblib.dump({"model": model, "columns": list(X.columns), "target": target, "task": a.task}, a.save)
        print("Model saved: " + a.save)


if __name__ == "__main__":
    main()
