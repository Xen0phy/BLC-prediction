// Wiki scraping helpers for the rotation checker.
//
// Three data sources on wiki.guildwars2.com:
//   - Black_Lion_Claim_Ticket: "Items offered" lists purchasable sets, newest
//     first (1/2/3 tickets = newest/next/older). First place a set becomes
//     visible, weeks before the Chest. Gives each skin's item id via its
//     data-id attribute. Source for data.json's "added" date and skin-ids.json.
//   - Black_Lion_Chest: Uncommon section = this week's long-cadence set, Rare
//     section = short-cadence (matches index.html's typeTag()). Source for
//     data.json's "appearances", which lag "added" by weeks to months.
//   - Vintage_Black_Lion_Weapon_Box: flat list of sets ArenaNet has retired.
//     Flips data.json's "retired" flag.
//
// scrapeThemeSkinIds() (theme page -> skin subpages -> item id) is a fallback
// for a rotation-only theme missing from both skin-ids.json and the Claim
// Ticket page.

const BASE = 'https://wiki.guildwars2.com';
// The wiki sits behind Cloudflare, which returns 403 to requests that look like
// bots (non-browser User-Agent, no Accept headers), especially from GitHub
// Actions IP ranges. Send browser-like headers, retry, and fall back to the
// MediaWiki API (api.php), which is usually filtered less aggressively.
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, attempts = 3) {
  let lastStatus = 0;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(2000 * i);
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.ok) return res;
      lastStatus = res.status;
      if (res.status !== 403 && res.status !== 429 && res.status < 500) break;
    } catch (e) {
      lastStatus = `network error: ${e.message}`;
    }
  }
  throw new Error(`HTTP ${lastStatus} fetching ${url}`);
}

async function fetchHtml(url) {
  try {
    return await (await fetchWithRetry(url)).text();
  } catch (e) {
    const m = url.match(/^https:\/\/wiki\.guildwars2\.com\/wiki\/([^?#]+)/);
    if (!m) throw e;
    console.error(`  ! ${e.message}; retrying via api.php`);
    const apiUrl = `${BASE}/api.php?action=parse&page=${m[1]}&prop=text&redirects=1&format=json&formatversion=2`;
    const json = await (await fetchWithRetry(apiUrl)).json();
    if (!json.parse || typeof json.parse.text !== 'string') {
      throw new Error(`api.php returned no content for ${url}`);
    }
    return json.parse.text;
  }
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

// Returns Black_Lion_Claim_Ticket's "Items offered" section as { name, ids }[],
// newest release first (matches the site's 1/2/3-ticket cost order). Ids come
// from each theme's own data-id="NNNN" table rows, no per-skin fetches needed.
async function getRecentReleases() {
  const html = await fetchHtml(`${BASE}/wiki/Black_Lion_Claim_Ticket`);
  const section = sliceBetween(html, 'id="Items_offered"', 'id="Previously_offered"') || html;

  // Match only real section headlines (class="mw-headline"); themes with an
  // apostrophe (Painter's, Calligrapher's) render an extra empty anchor span
  // right before this one, so we match on the classed span specifically.
  // Assuming it's the first child of <h3> would grab that empty span.
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