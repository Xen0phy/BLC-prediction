// Wiki scraping helpers for the rotation checker.
//
// Three data sources on wiki.guildwars2.com:
//   - Black_Lion_Claim_Ticket: "Items offered" lists every set still purchasable
//     with claim tickets, newest first (1 ticket = newest, 2 = next, 3 = older
//     still). This is where a set becomes visible FIRST, weeks before it shows
//     up in the Black Lion Chest itself, and it gives every skin's numeric item
//     id directly via each row's data-id attribute. This is the source for
//     data.json's "added" date and for skin-ids.json.
//   - Black_Lion_Chest: "Uncommon" section names this week's long-cadence set,
//     "Rare" section names this week's short-cadence set (confirmed against
//     index.html's typeTag(): Uncommon -> type "long", Rare -> type "short").
//     This is where a set's *rotation* appearances (data.json's "appearances")
//     come from, distinct from and much later than its "added" date.
//   - Vintage_Black_Lion_Weapon_Box: flat list of every set ArenaNet has retired
//     into the vintage pool. Used to flip data.json's "retired" flag.
//
// scrapeThemeSkinIds() (two-hop: theme page -> skin subpages -> item id) is
// kept only as a fallback for the rare case a rotation-only theme has no
// skin-ids.json entry and also isn't on the Claim Ticket page anymore.

const BASE = 'https://wiki.guildwars2.com';
const UA = 'gw2-blc-prediction-bot/1.0 (+https://github.com/; automated rotation check)';

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

function sliceBetween(html, startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  if (start === -1) return null;
  const end = endMarker ? html.indexOf(endMarker, start) : -1;
  return end === -1 ? html.slice(start) : html.slice(start, end);
}

// Find the first "<Name> weapon skins" wikilink in a chunk of HTML.
function firstWeaponSkinsLink(html) {
  const m = html.match(/href="\/wiki\/([^"]+?)_weapon_skins"[^>]*>([^<]+?) weapon skins</i);
  if (!m) return null;
  return { slug: decodeURIComponent(m[1]), name: decodeHtmlEntities(m[2].trim()) };
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// Returns { long: {slug,name}|null, short: {slug,name}|null } for the sets
// currently featured in the Black Lion Chest.
async function getCurrentRotation() {
  const html = await fetchHtml(`${BASE}/wiki/Black_Lion_Chest`);
  const uncommon = sliceBetween(html, 'id="Uncommon_', 'id="Rare_');
  const rare = sliceBetween(html, 'id="Rare_', 'id="Super_Rare_');
  return {
    long: uncommon ? firstWeaponSkinsLink(uncommon) : null,
    short: rare ? firstWeaponSkinsLink(rare) : null,
  };
}

// Returns a Set of theme names (e.g. "Mystical Beast") currently listed in the
// Vintage Black Lion Weapon Box's contents.
async function getVintageThemeNames() {
  const html = await fetchHtml(`${BASE}/wiki/Vintage_Black_Lion_Weapon_Box`);
  const contents = sliceBetween(html, 'id="Contents"', 'id="Notes"') || html;
  const names = new Set();
  const re = /href="\/wiki\/([^"]+?)_Weapon_Box"[^>]*>([^<]+?) Weapon Box</gi;
  let m;
  while ((m = re.exec(contents))) names.add(decodeHtmlEntities(m[2].trim()));
  return names;
}

// Fetch a theme's "<Name> weapon skins" page, follow every "<Skin> Skin" subpage
// link, and collect the numeric item id from each. Returns a sorted number[].
async function scrapeThemeSkinIds(themeSlug, { concurrency = 4 } = {}) {
  const html = await fetchHtml(`${BASE}/wiki/${themeSlug}_weapon_skins`);

  const subpages = new Set();
  const hrefRe = /href="(\/wiki\/[^"#]+?_Skin)"/gi;
  let m;
  while ((m = hrefRe.exec(html))) subpages.add(decodeURIComponent(m[1]));

  const idRe = /api\.guildwars2\.com\/v2\/items\?ids=(\d+)/i;
  const ids = new Set();
  const queue = Array.from(subpages);

  async function worker() {
    while (queue.length) {
      const p = queue.shift();
      try {
        const subHtml = await fetchHtml(`${BASE}${p}`);
        const idMatch = subHtml.match(idRe);
        if (idMatch) ids.add(Number(idMatch[1]));
      } catch (e) {
        console.error(`  ! failed to fetch ${p}: ${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) || 1 }, worker));
  return Array.from(ids).sort((a, b) => a - b);
}

// Returns the "Items offered" section of Black_Lion_Claim_Ticket as an array
// of { name, ids: number[] }, ordered newest release first (matches the
// site's 1-ticket / 2-ticket / 3-ticket cost ordering). Each theme's ids come
// straight from that theme's own table rows (data-id="NNNN" on the TP price
// spans), so no per-skin subpage fetches are needed here.
async function getRecentReleases() {
  const html = await fetchHtml(`${BASE}/wiki/Black_Lion_Claim_Ticket`);
  const section = sliceBetween(html, 'id="Items_offered"', 'id="Previously_offered"') || html;

  // Match only real section headlines (class="mw-headline"); themes with an
  // apostrophe (Painter's, Calligrapher's) render an extra empty anchor span
  // right before this one, so we match on the classed span specifically
  // rather than assuming it's the first child of <h3>.
  const headlineRe = /<span class="mw-headline" id="[^"]*">\s*([^<]+?)\s*<\/span>/g;
  const matches = [];
  let m;
  while ((m = headlineRe.exec(section))) {
    matches.push({ name: decodeHtmlEntities(m[1].trim()), end: headlineRe.lastIndex });
  }

  const releases = [];
  for (let i = 0; i < matches.length; i++) {
    const { name, end } = matches[i];
    if (!/Weapons$/i.test(name)) continue; // skips "Vintage Edition Spears" / "General Offerings"
    const nextHeadlineStart = section.indexOf('<span class="mw-headline"', end);
    const body = section.slice(end, nextHeadlineStart === -1 ? section.length : nextHeadlineStart);
    const ids = new Set();
    const idRe = /data-id="(\d+)"/g;
    let im;
    while ((im = idRe.exec(body))) ids.add(Number(im[1]));
    releases.push({ name: name.replace(/\s*Weapons$/i, '').trim(), ids: Array.from(ids).sort((a, b) => a - b) });
  }
  return releases; // newest -> oldest
}

module.exports = { getCurrentRotation, getVintageThemeNames, getRecentReleases, scrapeThemeSkinIds };
