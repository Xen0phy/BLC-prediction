# Black Lion Chest - Rotation Predictor

Predicts the next Black Lion Chest weapon skin rotation and shows live Trading Post prices for each set.

**Live tool: https://xen0phy.github.io/BLC-prediction/**

## How it works

`index.html` is a single-page app with no build step. In the browser it:

- loads the rotation history from `data.json` and the skin item ids from `skin-ids.json`
- reads the next update date from thatshaman.com (falls back to today's date if unreachable)
- predicts the next long-cadence and short-cadence sets from past appearances
- fetches live prices and item names from the Guild Wars 2 API (`/v2/commerce/prices`, `/v2/items`)

## Data files

| File | Contents |
| --- | --- |
| `data.json` | Every weapon set: date added, chest appearances, retired flag, slot type |
| `skin-ids.json` | Item ids per set, used for the price panel |
| `glyph-rotation.json` | Glyph pair rotation order and current pair |
| `tonic-rotation.json` | Tonic rotation order and current tonic |
| `node-rotation.json` | State of the Rare node/rack rotation stream |

## Automatic updates

`.github/workflows/check-rotation.yml` runs `scripts/check-wiki-rotation.js` on Wednesday and Thursday at 00:00 UTC. It reads the Guild Wars 2 wiki (Black Lion Claim Ticket, Black Lion Chest, Vintage Black Lion Weapon Box), updates `data.json` and `skin-ids.json`, and commits the result. The wiki helpers live in `scripts/lib/wiki.js`.

Run it locally with Node 20 or newer:

```
node scripts/check-wiki-rotation.js
FORCE_DATE=2026-08-12 node scripts/check-wiki-rotation.js   # pretend today is this date
```

The rotation JSON files other than `data.json` and `skin-ids.json` are edited by hand.