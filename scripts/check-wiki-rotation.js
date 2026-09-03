// Checks the live wiki for a new Black Lion Chest rotation and/or new
// retirements into the Vintage Black Lion Weapon Box, and patches data.json /
// skin-ids.json to match. Also auto-retires a set once its appearance count
// hits AUTO_RETIRE_AT for its slot (see there), ahead of any wiki
// confirmation. Runs unattended via GitHub Actions (check-rotation.yml),
// scheduled Wed + Thu 00:00 UTC.
//
// Reconciles against the live wiki each run with no stored diff, so it's
// mostly idempotent: delete a skin-ids.json entry or a set's "added" date
// and rerun to restore it. Exception: the rotation-appearance check compares
// each slot (long/short) to the most recent set already in data.json for
// that slot. If neither slot changed, treated as no update happened (a
// skipped check just re-showing the same pair), no new appearance recorded.
// If either slot changed, a real Chest update happened, and both slots get a
// fresh appearance date, including the one whose set stayed the same, since
// it was re-featured as part of that pair.
//
// Usage:
//   node scripts/check-wiki-rotation.js
//   FORCE_DATE=2026-08-12 node scripts/check-wiki-rotation.js   # pretend "today" is this date
//
// FORCE_DATE matters for testing: the anchor date is always the most recent
// Tuesday before the run (matching the real Tue-release / Wed-Thu-check
// schedule), so an un-forced re-add dates to *this week's* Tuesday, not the
// original release date.

const fs = require('fs');
const path = require('path');
const {
  getCurrentRotation,
  getVintageThemeNames,
  getRecentReleases,
  scrapeThemeSkinIds,
} = require('./lib/wiki');

const DIR = path.join(__dirname, '..');
const DATA_PATH = path.join(DIR, 'data.json');
const SKIN_IDS_PATH = path.join(DIR, 'skin-ids.json');

// Appearance count at which a set is auto-retired, per slot type. Purely a
// judgment call, not a wiki-confirmed fact, so bump these if the real
// cadence changes; already-retired sets are untouched either way.
const AUTO_RETIRE_AT = { long: 4, short: 8 };

function mostRecentTuesdayISO(d) {
  const day = d.getUTCDay(); // Sun=0 .. Sat=6, Tue=2
  const diff = (day - 2 + 7) % 7;
  const out = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  out.setUTCDate(out.getUTCDate() - diff);
  return out.toISOString().slice(0, 10);
}

function findEntry(data, name) {
  return data.find((s) => s.name.toLowerCase() === name.toLowerCase());
}

// "added" is the first-for-sale date on the Claim Ticket page, not the first
// Chest appearance (can be months apart). `releases` is newest-first, so
// only position 0 gets dated to this run's anchor Tuesday; any other new
// entry means an earlier check was missed and its real date is unrecoverable.
function reconcileNewReleases(data, skinIds, releases, anchorTuesday, changes) {
  releases.forEach((release, i) => {
    let entry = findEntry(data, release.name);
    if (!entry) {
      const added = i === 0 ? anchorTuesday : null;
      entry = { name: release.name, added, appearances: [], retired: false, type: null, vintage: null };
      data.push(entry);
      changes.push(
        i === 0
          ? `new release "${release.name}", added ${anchorTuesday}`
          : `new release "${release.name}" found on claim ticket page at a non-newest position (a check was likely missed) — added date unknown, needs manual backfill`
      );
    }
    if (release.ids.length && (!skinIds[entry.name] || skinIds[entry.name].length === 0)) {
      skinIds[entry.name] = release.ids;
      changes.push(`recorded ${release.ids.length} skin ids for "${entry.name}" from the claim ticket page`);
    }
  });
}

// Finds the entry of a given slot type with the most recent known date
// (added or latest appearance): our own record of what was last in that
// slot, used to tell a genuine rotation change from the same set still
// being live because a check was skipped.
function mostRecentForSlot(data, slotType) {
  let best = null;
  for (const e of data) {
    if (e.type !== slotType) continue;
    const dates = [e.added, ...(e.appearances || [])].filter(Boolean);
    if (!dates.length) continue;
    const last = dates.sort().at(-1);
    if (!best || last > best.date) best = { name: e.name, date: last };
  }
  return best;
}

async function reconcileCurrentRotation(data, skinIds, anchorTuesday, changes) {
  const { long, short } = await getCurrentRotation();

  // Snapshot both slots' "last known" set before touching data, and work out
  // per-slot whether it changed. A Chest update happens to both slots
  // together, so if either slot changed, this is a real update and BOTH get
  // a fresh appearance date, even the slot whose set stayed the same, since
  // that set was re-featured as part of this pairing. Only when neither slot
  // changed do we treat it as no update happened (a skipped check re-showing
  // the same pair).
  const slots = [['long', long], ['short', short]]
    .filter(([, hit]) => hit)
    .map(([slotType, hit]) => {
      const lastKnown = mostRecentForSlot(data, slotType);
      const isContinuation = lastKnown && lastKnown.name.toLowerCase() === hit.name.toLowerCase();
      return { slotType, hit, lastKnown, isContinuation };
    });
  const rotationChanged = slots.some((s) => !s.isContinuation);

  for (const { slotType, hit, lastKnown, isContinuation } of slots) {
    let entry = findEntry(data, hit.name);
    if (!entry) {
      // Live in rotation but never caught on the Claim Ticket page (checker
      // down a while). Stub it; "added" is unrecoverable here.
      entry = { name: hit.name, added: null, appearances: [], retired: false, type: slotType, vintage: null };
      data.push(entry);
      changes.push(`new set "${hit.name}" (${slotType}) found only in rotation — added date unknown, needs manual backfill`);
    } else if (!entry.type) {
      entry.type = slotType;
      changes.push(`set type for "${entry.name}" -> ${slotType}`);
    }

    const alreadyRecorded = entry.added === anchorTuesday || (entry.appearances || []).includes(anchorTuesday);
    if (!alreadyRecorded && rotationChanged) {
      entry.appearances = [...(entry.appearances || []), anchorTuesday].sort();
      changes.push(
        `appearance for "${entry.name}" on ${anchorTuesday}` +
          (isContinuation ? ` (slot unchanged, recorded because the other slot rotated)` : '')
      );
    } else if (!alreadyRecorded) {
      changes.push(`"${entry.name}" (${slotType}) still in rotation since ${lastKnown.date}, no new appearance recorded for ${anchorTuesday}`);
    }

    // Normally set by reconcileNewReleases; fallback for a theme with no ids on record.
    if (!skinIds[entry.name] || skinIds[entry.name].length === 0) {
      try {
        const ids = await scrapeThemeSkinIds(hit.slug);
        if (ids.length) {
          skinIds[entry.name] = ids;
          changes.push(`scraped ${ids.length} skin ids for "${entry.name}" (fallback, theme page)`);
        }
      } catch (e) {
        console.error(`  ! fallback id scrape failed for "${entry.name}": ${e.message}`);
      }
    }
  }
}

// Auto-retires a set once its appearance count hits AUTO_RETIRE_AT for its
// slot. Doesn't touch "vintage": that's set only once the wiki's vintage
// page actually confirms it, which may lag this guess or never happen if
// the guessed threshold is wrong for that particular set.
function reconcileAutoRetirement(data, changes) {
  for (const entry of data) {
    if (entry.retired || !entry.type) continue;
    const threshold = AUTO_RETIRE_AT[entry.type];
    if (threshold && (entry.appearances || []).length >= threshold) {
      entry.retired = true;
      changes.push(`auto-retired "${entry.name}" (${entry.type}) after ${entry.appearances.length} appearances`);
    }
  }
}

async function reconcileRetirements(data, anchorTuesday, changes) {
  const vintageNames = await getVintageThemeNames();
  for (const name of vintageNames) {
    let entry = findEntry(data, name);
    if (!entry) {
      // Unknown set found on the vintage page. Stub it; history needs
      // manual backfill from Black_Lion_Chest/historical.
      entry = { name, added: null, appearances: [], retired: true, type: null, vintage: anchorTuesday };
      data.push(entry);
      changes.push(`new retired set "${name}" found only in vintage box (needs manual history backfill)`);
      continue;
    }
    if (!entry.retired) {
      entry.retired = true;
      if (!entry.vintage) entry.vintage = anchorTuesday;
      changes.push(`retired "${entry.name}" (entered vintage pool)`);
    }
  }
}

async function main() {
  const runDate = process.env.FORCE_DATE ? new Date(`${process.env.FORCE_DATE}T00:00:00Z`) : new Date();
  const anchorTuesday = mostRecentTuesdayISO(runDate);
  console.log(`Run date: ${runDate.toISOString().slice(0, 10)} -> anchor Tuesday: ${anchorTuesday}`);

  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const skinIds = JSON.parse(fs.readFileSync(SKIN_IDS_PATH, 'utf8'));
  const changes = [];

  const releases = await getRecentReleases();
  reconcileNewReleases(data, skinIds, releases, anchorTuesday, changes);

  await reconcileCurrentRotation(data, skinIds, anchorTuesday, changes);
  reconcileAutoRetirement(data, changes);
  await reconcileRetirements(data, anchorTuesday, changes);

  if (changes.length === 0) {
    console.log('No changes detected, data.json and skin-ids.json already match the wiki.');
    return;
  }

  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + '\n');
  fs.writeFileSync(SKIN_IDS_PATH, JSON.stringify(skinIds, null, 2) + '\n');
  console.log(`Changes:\n${changes.map((c) => ` - ${c}`).join('\n')}`);
}

main().catch((e) => {
  console.error('check-wiki-rotation failed:', e);
  process.exit(1);
});
