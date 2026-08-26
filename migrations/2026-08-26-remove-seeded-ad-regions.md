# 2026-08-26 — remove seeded ad_regions rows for six national chains

Data-only migration. No code changed.

## Predicate

```sql
DELETE FROM ad_regions
WHERE store IN ('costco','dollar_general','save_a_lot','target','trader_joes','walmart');
```

Run against production on 2026-08-26, after a pre-delete assertion that the
predicate selected exactly 9,000 rows across exactly 6 distinct stores. The
delete was gated on both numbers matching.

## Counts

| | rows |
|---|---|
| before | 15,545 |
| deleted | 9,000 |
| after | 6,545 |

Distinct zip3 with any coverage fell from 1,000 to 922. The 78 zip3 prefixes
that lost all coverage had only seeded rows, so they were never served
anything from them.

## Why

All six covered all 1,000 zip3 prefixes. Real regional footprints in the same
table look like kroger 476, albertsons 441, publix 158, food_lion 138,
giant_eagle 43. Full coverage is the signature of rows seeded into every zip3
rather than measured.

Five of the six have no source and produced nothing. They appeared in
`availableChains` with no rows behind them.

`save_a_lot` has a source, so its rows passed the region filter and it served
28 rows into every market, including Seattle and Boston where Google Places
finds no Save-A-Lot. After the delete, every market total dropped by exactly
28 and by nothing else.

## Predicates that were rejected

**`division_code = 'NAT'`** — matches **18** stores, not 6. It also carries
aldi, meijer, food_lion, lidl, grocery_outlet, hyvee, piggly_wiggly,
shoprite, sprouts, wegmans, winco and winn_dixie. Deleting on it would have
removed 13,571 of 15,545 rows, taken 45402 to zero and left every other
market under 150. In this table `division_code` is a division tag, not a
national flag.

**`division = 'National'`** — matches **8** stores, adding aldi and sprouts.
ALDI is the only chain serving Boston, so this would have emptied that
market.

The explicit six-store list was used instead. It is the only predicate tested
that selects exactly the intended set.

## Backup

`migrations/2026-08-26-ad-regions-seeded-six-backup.json` holds all 9,000
deleted rows with every column (`id, store, banner, division, division_code,
zip3, ad_cycle, notes`). It was written immediately before the delete and
verified to contain exactly the rows the predicate selected. It is committed
to the repo: it is public store-coverage data and contains no credentials.

Two other backups from the same day are **untracked and machine-local only**:
`ladysavings-purge-backup-2026-08-26.json` and `commitF-pre-backup.json`.

## Known-remaining over-broad footprints

Not addressed here.

- **`sprouts`, 554 zip3s.** Now the largest footprint in the table, larger
  than kroger and albertsons, for a chain with roughly 400 stores
  concentrated in CA, TX, AZ, CO and FL. It is sourced and serving 56 rows.
  Same shape as what this migration removed, but it is not part of the seeded
  set: `division = 'National'` with `division_code = 'NAT'`, yet it stops at
  554 rather than covering everything. Needs a measured footprint.
- **`grocery_outlet`, 188 zip3s.** Inert since ladysavings.com was cut on
  2026-08-26. The rows remain but no source can produce anything for them, so
  the chain can only reach `availableChains` if it is re-sourced.
