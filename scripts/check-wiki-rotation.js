// Checks the live wiki for a new Black Lion Chest rotation and/or new
// retirements into the Vintage Black Lion Weapon Box, and patches data.json /
// skin-ids.json to match. Designed to run unattended (see the GitHub Actions
// workflow: check-rotation.yml), scheduled Wed + Thu 00:00 UTC.
//
// Because it always reconciles against the live wiki (not a "since last run"
// diff), it's naturally idempotent: delete a set's most recent appearance
// date and/or its skin-ids.json entry, run this again, and it comes back.
//
// Usage:
//   node scripts/check-wiki-rotation.js
//   FORCE_DATE=2026-08-12 node scripts/check-wiki-rotation.js   # pretend "today" is a given date
//
// FORCE_DATE matters for testing: the anchor date is always "the most recent
// Tuesday relative to when this script runs" (matching the real Tue-release /
// Wed-or-Thu-check schedule). Run it un-forced on some other weekday months
// later and it will (correctly, per that rule) date a re-added entry to
// *this* week's Tuesday, not the original release date. Use FORCE_DATE to
// simulate a specific Wednesday/Thursday when testing.

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

// A set's "added" date is when it first shows up for sale on the Claim Ticket
// page, not when it first appears in the Chest — those can be months apart.
// `releases` is newest-first (per the site's ticket-cost ordering), so only
// position 0 can be safely dated to *this run's* anchor Tuesday; anything
// else missing means a release was missed on an earlier check and its real
// date can't be recovered from this page alone.
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

async function reconcileCurrentRotation(data, skinIds, anchorTuesday, changes) {
  const { long, short } = await getCurrentRotation();

  for (const [slotType, hit] of [['long', long], ['short', short]]) {
    if (!hit) continue;

    let entry = findEntry(data, hit.name);
    if (!entry) {
      // A set appearing in the live rotation without ever having been caught
      // on the Claim Ticket page (checker was down for a long stretch). Add
      // a stub; its "added" date is unrecoverable from this page alone.
      entry = { name: hit.name, added: null, appearances: [], retired: false, type: slotType, vintage: null };
      data.push(entry);
      changes.push(`new set "${hit.name}" (${slotType}) found only in rotation — added date unknown, needs manual backfill`);
    } else if (!entry.type) {
      entry.type = slotType;
      changes.push(`set type for "${entry.name}" -> ${slotType}`);
    }

    const alreadyRecorded = entry.added === anchorTuesday || (entry.appearances || []).includes(anchorTuesday);
    if (!alreadyRecorded) {
      entry.appearances = [...(entry.appearances || []), anchorTuesday].sort();
      changes.push(`appearance for "${entry.name}" on ${anchorTuesday}`);
    }

    // Should already be populated by reconcileNewReleases; this is just a
    // safety net for a rotation theme that somehow has no ids on record.
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

async function reconcileRetirements(data, anchorTuesday, changes) {
  const vintageNames = await getVintageThemeNames();
  for (const name of vintageNames) {
    let entry = findEntry(data, name);
    if (!entry) {
      // Present on the vintage page but entirely unknown to us. Add a stub;
      // "added"/"appearances" history is unrecoverable from this page alone
      // and needs a manual backfill from Black_Lion_Chest/historical.
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
