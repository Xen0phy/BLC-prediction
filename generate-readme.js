// Regenerates the "Most likely next two" section of README.md by running
// the actual prediction + pricing logic from index.html headlessly (via jsdom),
// so the README can never drift from what the page itself computes.
//
// Usage:
//   npm install jsdom          (one-time)
//   node generate-readme.js
//
// Needs network access to api.guildwars2.com for live prices. Run it locally,
// or wire it into a scheduled GitHub Action (see README.md) to keep it fresh.

const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const README_PATH = path.join(DIR, 'README.md');
const START_MARKER = '<!-- MOST-LIKELY:START -->';
const END_MARKER = '<!-- MOST-LIKELY:END -->';

function copperToStr(copper) {
  copper = Math.round(copper || 0);
  const g = Math.floor(copper / 10000);
  const s = Math.floor((copper % 10000) / 100);
  const c = copper % 100;
  return `${g}g ${s}s ${c}c`;
}

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
        if (url.includes('commerce/prices')) {
          // Real network call to the live GW2 API.
          const res = await fetch(url);
          return { ok: res.ok, status: res.status, json: async () => res.json() };
        }
        if (url.includes('thatshaman.com')) {
          return { ok: false, status: 404 }; // not needed for this script
        }
        return { ok: false, status: 404 };
      };
    },
  });

  let windowError = null;
  dom.window.onerror = (msg, src, line, col, err) => { windowError = err || new Error(String(msg)); };

  // Let the page's own init() (loadSets -> loadSkinIds -> render -> loadPrices) run.
  await new Promise((r) => setTimeout(r, 300));
  await new Promise((r) => setTimeout(r, 4000)); // give the live price fetch time to finish

  if (windowError) throw windowError;

  const pricesStatus = dom.window.eval('pricesStatus');

  const top2 = dom.window.eval(`
    (function(){
      const {scored} = buildPredictions();
      const top2 = scored.slice().sort((a,b)=>b.pct-a.pct).slice(0,2);
      return top2.map(x=>{
        const p = x.p, s = x.s;
        const price = prices[s.name] || null;
        return {
          name: s.name,
          pct: x.pct,
          type: p.type,
          count: p.count,
          lastDate: p.lastDate ? p.lastDate.toISOString().slice(0,10) : null,
          predicted: p.predicted.toISOString().slice(0,10),
          daysDiff: p.daysDiff,
          buy: price ? price.buy : null,
          sell: price ? price.sell : null,
          missing: price ? price.missing : null
        };
      });
    })()
  `);

  const fmtDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso + 'T00:00:00Z');
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  };
  const overdue = (d) => (d > 0 ? `**${d}d** overdue` : `due in **${Math.abs(d)}d**`);

  let section = `${START_MARKER}\n`;
  section += `### Most likely next two\n\n`;
  section += `_Generated ${new Date().toISOString().slice(0, 10)}${pricesStatus === 'loaded' ? ' — prices live from the GW2 API' : ' — prices unavailable this run'}_\n\n`;

  top2.forEach((x, i) => {
    const priceLine = (x.buy != null && x.sell != null)
      ? `Buy total: **${copperToStr(x.buy)}** &nbsp;·&nbsp; Sell total: **${copperToStr(x.sell)}**${x.missing ? ' _(partial — some skins unlisted)_' : ''}`
      : '_price unavailable_';
    section += `**${i + 1}. ${x.name}** — ${x.pct.toFixed(1)}% (${x.type})\n`;
    section += `Last seen: ${fmtDate(x.lastDate)} · Estimated next: ${fmtDate(x.predicted)} (${overdue(x.daysDiff)})\n`;
    section += `${priceLine}\n\n`;
  });

  section += `[Open the full tool](https://xen0phy.github.io/BLC-prediction/) for the complete roster, retired sets, and timeline.\n`;
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
    readme = `# Black Lion Chest — Rotation Predictor\n\nPredicts the next Black Lion Chest weapon skin rotation and shows live Trading Post prices for each set.\n\n${section}\n`;
  }

  fs.writeFileSync(README_PATH, readme);
  console.log('README.md updated.');
}

main().catch((e) => {
  console.error('Failed to generate README section:', e);
  process.exit(1);
});
