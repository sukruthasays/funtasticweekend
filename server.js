const express = require('express');
const cheerio = require('cheerio');
const axios = require('axios');
const cron = require('node-cron');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const db = new Pool(process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
  : { database: 'funtasticweekend' });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

function makeId() {
  return 'ev_' + Math.random().toString(36).slice(2, 10);
}

let lastScraped = null;

// ── Scrapers ────────────────────────────────────────────────────────────────

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function scrapeRonnie() {
  const events = [];
  try {
    const { data } = await axios.get('https://www.ronniesawesomelist.com/ronnies-awesome-list', { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(data);
    $('.eventlist-event').each((_, el) => {
      // Title link has href like /ronnies-awesome-list/slug — skip category filter links (?category=...)
      const titleAnchor = $(el).find('a[href^="/ronnies-awesome-list/"]').not('.eventlist-column-thumbnail, .eventlist-column-date').first();
      const title = titleAnchor.text().trim();
      const url   = titleAnchor.attr('href')
        ? 'https://www.ronniesawesomelist.com' + titleAnchor.attr('href')
        : 'https://www.ronniesawesomelist.com/ronnies-awesome-list';

      const startMonth = $(el).find('.eventlist-datetag-startdate--month').text().trim();
      const startDay   = $(el).find('.eventlist-datetag-startdate--day').text().trim();
      const endText    = $(el).find('.eventlist-datetag-enddate').text().replace('to', '').trim();
      const dateText   = startMonth && startDay ? `${startMonth} ${startDay}, ${new Date().getFullYear()}` : '';
      const addrEl     = $(el).find('.eventlist-meta-address');
      const venueName  = addrEl.clone().find('a').remove().end().text().trim().replace(/\s+/g, ' ');
      const mapHref    = addrEl.find('a.eventlist-meta-address-maplink').attr('href') || '';
      const mapAddr    = mapHref ? decodeURIComponent(mapHref.replace(/.*\?q=/, '')) : '';
      const location   = mapAddr || venueName || 'Bay Area';
      const desc       = $(el).find('.eventlist-excerpt p').first().text().trim().slice(0, 200);

      if (title) {
        events.push({
          id: makeId(), source: 'Ronnies Awesome List', title, url,
          description: desc, dateText, date: parseDate(dateText),
          location: venueName || mapAddr || 'Bay Area',
          region: normalizeRegion(location, 'Ronnies Awesome List'),
          category: 'Kids & Family',
        });
      }
    });
  } catch (e) { console.error('scrapeRonnie:', e.message); }
  return events;
}

async function scrapeMarinMommiesDay(dateStr) {
  // dateStr is YYYY-MM-DD
  const events = [];
  try {
    const { data } = await axios.get(`https://www.marinmommies.com/calendar/${dateStr}`, { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(data);
    $('.views-row').each((_, el) => {
      const titleAnchor = $(el).find('.views-field-title a').first();
      const title = titleAnchor.text().trim();
      const path  = titleAnchor.attr('href') || '';
      const url   = path ? 'https://www.marinmommies.com' + path : 'https://www.marinmommies.com/calendar';
      const timeEl = $(el).find('[content]').first();
      const isoDate = timeEl.attr('content') ? timeEl.attr('content').split('T')[0] : dateStr;
      const location = $(el).find('.views-field-field-address-locality').text().trim();
      const desc = $(el).find('.views-field-body').text().trim().slice(0, 200);
      if (title) {
        events.push({
          id: makeId(), source: 'Marin Mommies', title, url,
          description: desc, dateText: isoDate, date: isoDate,
          location: location || 'Marin County', region: normalizeRegion(location, 'Marin Mommies'),
          category: 'Kids & Family',
        });
      }
    });
  } catch (e) { console.error(`scrapeMarinMommies ${dateStr}:`, e.message); }
  return events;
}

async function scrapeMarinMommies() {
  const today = new Date();
  const dates = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    dates.push(d.toISOString().split('T')[0]);
  }
  const results = await Promise.allSettled(dates.map(d => scrapeMarinMommiesDay(d)));
  return results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
}

const FUNCHEAP_REGION_MAP = {
  'region-san-francisco': 'San Francisco',
  'region-east-bay':      'East Bay',
  'region-north-bay':     'North Bay',
  'region-peninsula':     'Peninsula',
  'region-south-bay':     'South Bay',
};

function parseFuncheapPage($) {
  const events = [];
  $('.post.hentry').each((_, el) => {
    const titleAnchor = $(el).find('.entry-title a, span.title a').first();
    const title = titleAnchor.text().trim();
    const url   = titleAnchor.attr('href') || 'https://sf.funcheap.com';
    const metaEl = $(el).find('.meta[data-event-date]').first();
    const isoDate = metaEl.attr('data-event-date')
      ? metaEl.attr('data-event-date').split(' ')[0]
      : null;
    const location = metaEl.find('span').last().text().trim()
      || $(el).find('.location').text().trim();
    const desc = $(el).find('.entry-content p, .entry-summary p').first().text().trim().slice(0, 200);
    const cls = $(el).attr('class') || '';
    const regionMatch = cls.match(/\bregion-([\w-]+)/);
    const regionKey = regionMatch ? 'region-' + regionMatch[1] : null;
    const region = FUNCHEAP_REGION_MAP[regionKey] || normalizeRegion(location, 'SF Funcheap');
    if (title) {
      events.push({
        id: makeId(), source: 'SF Funcheap', title, url,
        description: desc, dateText: isoDate, date: isoDate,
        location: location || 'San Francisco', region,
        category: 'Kids & Family',
      });
    }
  });
  return events;
}

async function scrapeDSE() {
  const events = [];
  const DSE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://dserunners.com/',
  };
  try {
    const [r5k, rkids] = await Promise.all([
      axios.get('https://dserunners.com/race-schedule/tag_ids~18/', { headers: DSE_HEADERS, timeout: 15000 }),
      axios.get('https://dserunners.com/race-schedule/tag_ids~45/', { headers: DSE_HEADERS, timeout: 15000 }),
    ]);
    const seen = new Set();
    [r5k.data, rkids.data].forEach(html => {
      const $ = cheerio.load(html);
      $('.ai1ec-event').each((_, el) => {
        const url = $(el).find('a.ai1ec-load-event').attr('href') || 'https://dserunners.com/race-schedule/';
        if (seen.has(url)) return;
        seen.add(url);
        const title    = $(el).find('.ai1ec-event-title').text().trim();
        const timeText = $(el).find('.ai1ec-event-time').text().trim();
        // timeText format: "Jul 5 @ 9:00 am – 10:00 am"
        const datePart = timeText.split('@')[0].trim();
        const isoDate  = parseDate(datePart + ', ' + new Date().getFullYear());
        const descRaw  = $(el).find('.ai1ec-event-description').text().replace(/\s+/g, ' ').trim();
        // Extract Start/Finish location from description
        const locMatch = descRaw.match(/Start\/Finish(?:\s+location)?[:\s]+([^.]{5,80?})(?:Start [Tt]ime|Race start|Course|$)/i);
        const location = locMatch ? locMatch[1].replace(/\s+/g, ' ').trim() : 'San Francisco';
        const desc     = descRaw.slice(0, 200);
        if (title) {
          events.push({
            id: makeId(), source: 'DSE Runners', title, url,
            description: desc, dateText: datePart, date: isoDate,
            location, region: normalizeRegion(location, 'DSE Runners'),
            category: 'Running',
          });
        }
      });
    });
  } catch (e) { console.error('scrapeDSE:', e.message); }
  return events;
}

async function scrapeFuncheap() {
  const BASE = 'https://sf.funcheap.com/category/event/event-types/kids-families';
  const pageUrls = [BASE + '/'].concat(
    Array.from({length: 9}, (_, i) => `${BASE}/page/${i + 2}/`)
  );
  const results = await Promise.allSettled(
    pageUrls.map(url => axios.get(url, { headers: HEADERS, timeout: 15000 })
      .then(({data}) => parseFuncheapPage(cheerio.load(data))))
  );
  return results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
}

function parse510Page($) {
  const events = [];
  let currentDate = null;
  $('.em-events-list-grouped').children().each((_, el) => {
    const tag = el.tagName;
    if (tag === 'h3' && !$(el).hasClass('em-item-title')) {
      currentDate = parseDate($(el).text().trim());
    } else if ($(el).hasClass('em-event')) {
      const titleAnchor = $(el).find('.em-item-title a').first();
      const title    = titleAnchor.text().trim();
      const url      = titleAnchor.attr('href') || 'https://www.510families.com/calendar/';
      const location = $(el).find('.em-event-location a, .em-event-location').first().text().trim();
      const desc     = $(el).find('.em-event-description, p').first().text().trim().slice(0, 200);
      if (title) {
        events.push({
          id: makeId(), source: '510 Families', title, url,
          description: desc, dateText: currentDate, date: currentDate,
          location: location || 'East Bay', region: normalizeRegion(location, '510 Families'),
          category: 'Kids & Family',
        });
      }
    }
  });
  return events;
}

async function scrape510Families() {
  // Scrape all pages (site shows up to pno=14)
  const pageUrls = Array.from({length: 14}, (_, i) =>
    i === 0 ? 'https://www.510families.com/calendar/' : `https://www.510families.com/calendar/?pno=${i + 1}`
  );
  const results = await Promise.allSettled(
    pageUrls.map(url => axios.get(url, { headers: HEADERS, timeout: 15000 })
      .then(({data}) => parse510Page(cheerio.load(data))))
  );
  // Deduplicate by URL since recurring events appear on multiple pages
  const seen = new Set();
  const events = [];
  results.flatMap(r => r.status === 'fulfilled' ? r.value : []).forEach(ev => {
    const key = ev.url + '|' + ev.date;
    if (!seen.has(key)) { seen.add(key); events.push(ev); }
  });
  return events;
}

async function scrapeSFPLDay(dateStr) {
  // dateStr is YYYY-MM-DD
  const events = [];
  try {
    const { data } = await axios.get(
      `https://sfpl.org/events?field_event_audience_target_id=27&field_event_date_value=${dateStr}`,
      { headers: HEADERS, timeout: 15000 }
    );
    const $ = cheerio.load(data);
    $('.event').each((_, el) => {
      const titleAnchor = $(el).find('.event__title a').first();
      const title    = titleAnchor.find('span').text().trim() || titleAnchor.text().trim();
      const path     = titleAnchor.attr('href') || '';
      const url      = path ? 'https://sfpl.org' + path : 'https://sfpl.org/events';
      const dateText = $(el).find('.date-display-range').text().trim();
      // Parse date from path (/events/YYYY/MM/DD/slug) or dateText
      const pathDate = path.match(/\/events\/(\d{4}\/\d{2}\/\d{2})\//);
      const isoDate  = pathDate ? pathDate[1].replace(/\//g, '-') : dateStr;
      const location = $(el).find('.event__location').first().text().trim().split('\n')[0].trim();
      const desc     = $(el).find('.event__description, .field--name-body').first().text().trim().slice(0, 200);
      if (title) {
        const loc = location ? `${location} Branch, San Francisco` : 'San Francisco';
        events.push({
          id: makeId(), source: 'SFPL Kids Events', title, url,
          description: desc, dateText, date: isoDate,
          location: loc, region: normalizeRegion(loc, 'SFPL Kids Events'),
          category: 'Library / Education',
        });
      }
    });
  } catch (e) { console.error(`scrapeSFPL ${dateStr}:`, e.message); }
  return events;
}

async function scrapeSFPL() {
  const today = new Date();
  const dates = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    dates.push(d.toISOString().split('T')[0]);
  }
  const results = await Promise.allSettled(dates.map(d => scrapeSFPLDay(d)));
  return results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
}

// ── Region normalization ──────────────────────────────────────────────────────

const REGION_KEYWORDS = {
  'San Francisco': [
    'san francisco', ', sf,', ', sf ', '(sf)', 'sfpl', 'sfmoma',
    'soma', 'south of market',
    'mission district', 'mission dolores', 'dolores park', 'dolores st',
    'castro', 'noe valley', 'glen park', 'bernal',
    'sunset district', 'inner sunset', 'outer sunset',
    'richmond district', 'inner richmond', 'outer richmond',
    'golden gate park', 'golden gate valley', 'panhandle', 'haight',
    'cole valley', 'cole street',
    'potrero hill', 'potrero',
    'marina district', 'pacific heights', 'cow hollow', 'presidio',
    'fillmore', 'western addition', 'japantown',
    'north beach', 'fisherman', 'fishermans wharf',
    'chinatown', 'tenderloin', 'civic center', 'hayes valley',
    'bayview', 'hunters point', 'excelsior', 'portola district', 'visitacion',
    'spreckels', 'spreckles', 'yerba buena', 'ybca',
    'thrive city', 'chase center', 'oracle park',
    'ocean beach', 'baker beach', 'crissy field',
    'new farm', 'bay natives',
    'stonestown', 'west portal', 'forest hill',
    'faces sf', 'faces sf,',
    'persia and mission', 'excelsior district',
    'elk glen', 'stow lake',
    ' sf, ca',  // "SF, CA" abbreviation in addresses
    ', ca 941', // SF zip codes start with 941
  ],
  'North Bay':  [
    'marin ', 'marin,', 'marin county', 'north bay',
    'sausalito', 'mill valley', 'san rafael', 'novato', 'tiburon',
    'corte madera', 'larkspur', 'san anselmo', 'fairfax', 'ross',
    'kentfield', 'greenbrae', 'san quentin',
    'sonoma', 'napa', 'petaluma', 'santa rosa', 'sebastopol',
    'healdsburg', 'wine country', 'vallejo', 'benicia',
    'guerneville', 'stinson beach', 'point reyes', 'olema',
    'yountville', 'st. helena', 'calistoga',
    'williamson ranch',
  ],
  'East Bay':   [
    'east bay', 'oakland', 'berkeley', 'alameda',
    'el cerrito', 'albany', 'emeryville', 'hayward', 'fremont',
    'union city', 'newark', 'san leandro', 'castro valley',
    'walnut creek', 'concord', 'pleasant hill', 'antioch', 'pittsburg',
    'orinda', 'moraga', 'lafayette', 'danville', 'san ramon',
    'pleasanton', 'livermore', 'dublin', 'crockett', 'pinole',
    'richmond,', 'richmond ca', 'el sobrante', 'rodeo',
    'lake merritt', 'rockridge', 'temescal', 'montclair',
    'lawrence hall', 'children\'s fairyland', 'tilden',
    'jean sweeney', 'sunol',
    'macarthur blvd', 'college avenue',
    '510 families',
    ', ca 946', ', ca 945', ', ca 944', // East Bay zip prefixes
  ],
  'Peninsula':  [
    'peninsula', 'san mateo', 'palo alto', 'redwood city',
    'menlo park', 'burlingame', 'san carlos', 'belmont',
    'foster city', 'millbrae', 'south san francisco', 'daly city',
    'pacifica', 'half moon bay', 'los altos', 'atherton',
    'portola valley', 'woodside', 'filoli',
    'baylands', 'eco center',
  ],
  'South Bay':  [
    'south bay', 'san jose', 'santa clara', 'sunnyvale',
    'campbell', 'los gatos', 'saratoga', 'milpitas',
    'morgan hill', 'gilroy', 'silicon valley', 'cupertino', 'mountain view',
    'oshman family jcc',
  ],
};

const REGION_ORDER = ['San Francisco', 'North Bay', 'East Bay', 'Peninsula', 'South Bay'];

function normalizeRegion(location, source) {
  const text = ((location || '') + ' ' + (source || '')).toLowerCase();
  for (const region of REGION_ORDER) {
    if (REGION_KEYWORDS[region].some(k => text.includes(k))) return region;
  }
  // Source-based fallback — only for sources with a clear home region
  if (source === 'Marin Mommies') return 'North Bay';
  if (source === '510 Families') return 'East Bay';
  if (source === 'SFPL Kids Events') return 'San Francisco';
  // Ronnie's and Funcheap cover all regions — return null if unresolved
  return null;
}

// ── Date parsing ─────────────────────────────────────────────────────────────

function parseDate(text) {
  if (!text) return null;
  // Try ISO first
  const iso = Date.parse(text);
  if (!isNaN(iso)) return new Date(iso).toISOString().split('T')[0];
  // Try common formats: "June 28, 2025", "Jun 28", "Saturday, June 28"
  const cleaned = text.replace(/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s*/i, '').trim();
  const parsed = Date.parse(cleaned + (cleaned.match(/\d{4}/) ? '' : ', ' + new Date().getFullYear()));
  if (!isNaN(parsed)) return new Date(parsed).toISOString().split('T')[0];
  return null;
}

// ── Scrape all sources ────────────────────────────────────────────────────────

async function scrapeAll() {
  console.log('Scraping all sources…');
  const [r, m, f, e, s, d] = await Promise.allSettled([
    scrapeRonnie(), scrapeMarinMommies(), scrapeFuncheap(), scrape510Families(), scrapeSFPL(), scrapeDSE()
  ]);
  const all = [
    ...(r.status === 'fulfilled' ? r.value : []),
    ...(m.status === 'fulfilled' ? m.value : []),
    ...(f.status === 'fulfilled' ? f.value : []),
    ...(e.status === 'fulfilled' ? e.value : []),
    ...(s.status === 'fulfilled' ? s.value : []),
    ...(d.status === 'fulfilled' ? d.value : []),
  ];

  // Replace all scraped events in one transaction
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM events WHERE is_manual = FALSE`);
    for (const ev of all) {
      await client.query(
        `INSERT INTO events (id,source,title,url,description,date_text,date,location,region,category,is_manual)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,FALSE)`,
        [ev.id, ev.source, ev.title, ev.url || null, ev.description || null,
         ev.dateText || null, ev.date || null, ev.location || null,
         ev.region || null, ev.category || null]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  lastScraped = new Date().toISOString();
  console.log(`Scraped ${all.length} events.`);
  return all;
}

// Run on startup + every 6 hours
scrapeAll();
cron.schedule('0 */6 * * *', scrapeAll);

// ── URL scraper for manual event add ────────────────────────────────────────

async function scrapeEventUrl(url) {
  const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  const $ = cheerio.load(data);

  // 1. JSON-LD structured data (most reliable)
  let jsonld = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const obj = JSON.parse($(el).html());
      const candidates = Array.isArray(obj) ? obj : [obj];
      for (const c of candidates) {
        if (c['@type'] === 'Event') { jsonld = c; return false; }
      }
    } catch {}
  });

  if (jsonld) {
    const loc = jsonld.location?.name || jsonld.location?.address?.streetAddress || jsonld.location?.address || '';
    const fullAddr = [
      jsonld.location?.name,
      jsonld.location?.address?.streetAddress,
      jsonld.location?.address?.addressLocality,
      jsonld.location?.address?.addressRegion,
    ].filter(Boolean).join(', ');
    const startRaw = jsonld.startDate || '';
    const date = startRaw ? startRaw.slice(0, 10) : null;
    return {
      title:       jsonld.name || '',
      date,
      location:    fullAddr || loc,
      description: jsonld.description || '',
      url,
    };
  }

  // 2. Open Graph / meta tags fallback
  const title =
    $('meta[property="og:title"]').attr('content') ||
    $('meta[name="twitter:title"]').attr('content') ||
    $('title').text().trim() || '';

  const description =
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') || '';

  // Try to find a date from common patterns
  const datePatterns = [
    /(\d{4}-\d{2}-\d{2})/,
    /([A-Z][a-z]+ \d{1,2},? \d{4})/,
  ];
  let date = null;
  const bodyText = $('body').text();
  for (const pat of datePatterns) {
    const m = bodyText.match(pat);
    if (m) {
      const d = new Date(m[1]);
      if (!isNaN(d)) { date = d.toISOString().slice(0, 10); break; }
    }
  }

  const location =
    $('[class*="location"],[class*="venue"],[class*="address"]').first().text().trim().slice(0, 150) || '';

  return { title, date, location, description, url };
}

// ── API routes ────────────────────────────────────────────────────────────────

// GET all events (scraped + manual), optional filters
app.get('/api/events', async (req, res) => {
  try {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

    const { date, weekend, source, region, q } = req.query;
    const params = [today];
    const conditions = ['(date IS NULL OR date >= $1)'];

    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      const i = params.length;
      conditions.push(`(LOWER(title) LIKE $${i} OR LOWER(description) LIKE $${i} OR LOWER(location) LIKE $${i})`);
    }
    if (source) { params.push(source); conditions.push(`source = $${params.length}`); }
    if (region) { params.push(region); conditions.push(`region = $${params.length}`); }
    if (date)   { params.push(date);   conditions.push(`date = $${params.length}`); }
    if (weekend === 'true') {
      conditions.push(`EXTRACT(DOW FROM date) IN (0, 6)`);
    }

    const sql = `SELECT id, source, title, url, description, date_text AS "dateText",
                        TO_CHAR(date, 'YYYY-MM-DD') AS date, location, region, category, is_manual AS manual
                 FROM events
                 WHERE ${conditions.join(' AND ')}
                 ORDER BY date ASC NULLS LAST, title ASC`;

    const { rows } = await db.query(sql, params);
    res.json({ events: rows, lastScraped });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST manual event
app.post('/api/events', async (req, res) => {
  const { title, date, location, description, url, category, region } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  const loc = location || '';
  const ev = {
    id: makeId(), source: 'Manual', title,
    date: date || null, location: loc,
    region: region || normalizeRegion(loc, 'Manual'),
    description: description || '', url: url || '',
    category: category || 'Kids & Family',
  };
  try {
    await db.query(
      `INSERT INTO events (id,source,title,url,description,date_text,date,location,region,category,is_manual)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE)`,
      [ev.id, ev.source, ev.title, ev.url, ev.description, null, ev.date, ev.location, ev.region, ev.category]
    );
    res.json(ev);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE event
app.delete('/api/events/:id', async (req, res) => {
  try {
    const { rowCount } = await db.query(`DELETE FROM events WHERE id = $1`, [req.params.id]);
    res.json({ deleted: rowCount > 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST scrape a single URL and save as manual event
app.post('/api/scrape-url', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  try {
    const fields = await scrapeEventUrl(url);
    if (!fields.title) return res.status(422).json({ error: 'Could not extract event details from that URL' });
    const loc = fields.location || '';
    const ev = {
      id: makeId(), source: 'Manual',
      title: fields.title,
      date: fields.date || null,
      location: loc,
      region: normalizeRegion(loc, 'Manual'),
      description: fields.description || '',
      url: fields.url,
      category: 'Kids & Family',
    };
    await db.query(
      `INSERT INTO events (id,source,title,url,description,date_text,date,location,region,category,is_manual)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE)`,
      [ev.id, ev.source, ev.title, ev.url, ev.description, null, ev.date, ev.location, ev.region, ev.category]
    );
    res.json(ev);
  } catch (err) {
    console.error('scrape-url error:', err.message);
    res.status(500).json({ error: 'Failed to fetch or parse that URL' });
  }
});

// POST trigger manual re-scrape
app.post('/api/scrape', async (req, res) => {
  try {
    const events = await scrapeAll();
    res.json({ count: events.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Scrape failed' });
  }
});

// GET sources list
app.get('/api/sources', async (req, res) => {
  try {
    const { rows } = await db.query(`SELECT DISTINCT source FROM events ORDER BY source`);
    res.json(rows.map(r => r.source));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FuntasticWeekend running on http://localhost:${PORT}`));
