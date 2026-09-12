// Regenerates the "Most likely next two" section of README.md by running
// the actual prediction logic from index.html headlessly (via jsdom), so
// the README can never drift from what the page itself computes.
//
// Deliberately excludes live Trading Post prices: those change essentially
// every run, which meant the "commit only if README.md changed" step in
// the GitHub Action was never actually a no-op, and every scheduled run /
// qualifying push produced a new commit. Sticking to the reference date,
// prediction percentage, and dates keeps the README byte-identical between
// runs until something that's actually worth re-announcing changes (a new
// rotation, a re-estimated date, etc) - so the Action goes quiet again.
// Prices still update live on the page itself; just not here.
//
// Usage:
//   npm install jsdom          (one-time)
//   node generate-readme.js
//
// Needs network access to thatshaman.com for the next reference date. Run
// it locally, or wire it into a scheduled GitHub Action (see README.md) to
// keep it fresh.

const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const README_PATH = path.join(DIR, 'README.md');
const START_MARKER = '<!-- MOST-LIKELY:START -->';
const END_MARKER = '<!-- MOST-LIKELY:END -->';

async function main() {
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');

  const dom = new JSDOM(html, {
    url: 'http://localhost/index.html',
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = async (url) => {
        if (url.includes('data.json')) {
          return { ok: true, json: async () => JSON.parse(fs.readFileSync(path.join(DIR, 'data.json'), 'utf8')) };
        }
        if (url.includes('skin-ids.json')) {
          return { ok: true, json: async () => JSON.parse(fs.readFileSync(path.join(DIR, 'skin-ids.json'), 'utf8')) };
        }
        if (url.includes('thatshaman.com')) {
          // Real network call: thatshaman.com for the next reference date,
          // the same live source the page itself uses.
          const res = await fetch(url);
          return { ok: res.ok, status: res.status, json: async () => res.json() };
        }
        // Deliberately stub out commerce/prices (and anything else) as a
        // no-op 404: this generator doesn't use price data, and letting the
        // page's price fetch actually run would just add live-fluctuating
        // numbers we're not even reading, plus needless network flakiness.
        return { ok: false, status: 404 };
      };
    },
  });

  let windowError = null;
  dom.window.onerror = (msg, src, line, col, err) => { windowError = err || new Error(String(msg)); };

  // Let the page's own init() (loadSets -> loadSkinIds -> render) run, then
  // wait for window.__shamanPromise (set by init() in index.html) so we
  // read state only once the reference-date fetch has actually settled,
  // instead of guessing with a fixed delay.
  async function waitForGlobalPromise(name, maxWaitMs = 5000) {
    const start = Date.now();
    while (dom.window.eval(`typeof window.${name}`) === 'undefined') {
      if (Date.now() - start > maxWaitMs) return undefined;
      await new Promise((r) => setTimeout(r, 50));
    }
    return dom.window.eval(`window.${name}`);
  }

  await new Promise((r) => setTimeout(r, 300));
  const shamanPromise = await waitForGlobalPromise('__shamanPromise');
  await Promise.race([
    Promise.resolve(shamanPromise),
    new Promise((r) => setTimeout(r, 15000)), // don't hang the workflow if the fetch stalls
  ]);

  if (windowError) throw windowError;

  const shamanStatus = dom.window.eval('shamanStatus');
  const nextUpdateDate = dom.window.eval('nextUpdateDate'); // ISO date string from thatshaman.com, or null if the fetch failed

  const top2 = dom.window.eval(`
    (function(){
      const {scored} = buildPredictions();
      const top2 = scored.slice().sort((a,b)=>b.pct-a.pct).slice(0,2);
      return top2.map(x=>{
        const p = x.p, s = x.s;
        return {
          name: s.name,
          pct: x.pct,
          type: p.type,
          count: p.count,
          lastDate: p.lastDate ? p.lastDate.toISOString().slice(0,10) : null,
          predicted: p.predicted.toISOString().slice(0,10),
          daysDiff: p.daysDiff
        };
      });
    })()
  `);

  const fmtDate = (iso) => {
    if (!iso) return '-';
    const d = new Date(iso + 'T00:00:00Z');
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  };
  const overdue = (d) => (d > 0 ? `**${d}d** overdue` : `due in **${Math.abs(d)}d**`);

  // Fall back to today only if the live thatshaman.com fetch failed - same
  // fallback the page itself uses (see getRefDate() in index.html).
  const refDateIso = nextUpdateDate || new Date().toISOString().slice(0, 10);
  const refDateNote = shamanStatus === 'loaded'
    ? ''
    : ' _(thatshaman.com unreachable - falling back to today\'s date)_';

  let section = `${START_MARKER}\n`;
  section += `### Most likely next two\n\n`;
  section += `_Reference date: ${fmtDate(refDateIso)}${refDateNote}_\n\n`;

  top2.forEach((x, i) => {
    section += `**${i + 1}. ${x.name}** - ${x.pct.toFixed(1)}% (${x.type})\n`;
    section += `Last seen: ${fmtDate(x.lastDate)} · Estimated next: ${fmtDate(x.predicted)} (${overdue(x.daysDiff)})\n\n`;
  });

  section += `[Open the full tool](https://xen0phy.github.io/BLC-prediction/) for the complete roster, retired sets, live prices, and timeline.\n`;
  section += `${END_MARKER}`;

  let readme;
  if (fs.existsSync(README_PATH)) {
    readme = fs.readFileSync(README_PATH, 'utf8');
    if (readme.includes(START_MARKER) && readme.includes(END_MARKER)) {
      const before = readme.slice(0, readme.indexOf(START_MARKER));
      const after = readme.slice(readme.indexOf(END_MARKER) + END_MARKER.length);
      readme = before + section + after;
    } else {
      readme = readme.trimEnd() + '\n\n' + section + '\n';
    }
  } else {
    readme = `# Black Lion Chest - Rotation Predictor\n\nPredicts the next Black Lion Chest weapon skin rotation and shows live Trading Post prices for each set.\n\n${section}\n`;
  }

  fs.writeFileSync(README_PATH, readme);
  console.log('README.md updated.');
}

main().catch((e) => {
  console.error('Failed to generate README section:', e);
  process.exit(1);
});
