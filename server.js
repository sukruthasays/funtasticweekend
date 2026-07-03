const express = require('express');
const cheerio = require('cheerio');
const axios = require('axios');
const cron = require('node-cron');
const cors = require('cors');
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
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
      // Use full address (from map link) for both region detection and display;
      // fall back to venue name only if no map address is available.
      const fullAddr   = mapAddr || venueName || 'Bay Area';
      const desc       = $(el).find('.eventlist-excerpt p').first().text().trim().slice(0, 200);

      if (title) {
        events.push({
          id: makeId(), source: 'Ronnies Awesome List', title, url,
          description: desc, dateText, date: parseDate(dateText),
          location: fullAddr,
          region: normalizeRegion(fullAddr, 'Ronnies Awesome List'),
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

async function scrapeExploratorium() {
  const events = [];
  try {
    const { data } = await axios.get('https://www.exploratorium.edu/visit/calendar', { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(data);
    $('a.card.card--experience').each((_, el) => {
      const title = $(el).find('.card-title').text().trim();
      const href  = $(el).attr('href') || '';
      const url   = href ? 'https://www.exploratorium.edu' + href : 'https://www.exploratorium.edu/visit/calendar';
      // Use the first <time> datetime attr in next_instance (most relevant upcoming date)
      const timeEl = $(el).find('.next_instance time').first();
      const isoRaw = timeEl.attr('datetime') || '';
      const date   = isoRaw ? isoRaw.slice(0, 10) : null;
      const dateText = timeEl.text().trim();
      const desc  = $(el).find('.field--name-field-short-description-rte').text().trim().slice(0, 200);
      // Filter out adult After Dark events (18+)
      if (title && !/after dark/i.test(title)) {
        events.push({
          id: makeId(), source: 'Exploratorium', title, url,
          description: desc, dateText, date,
          location: 'Pier 15, San Francisco, CA 94111',
          region: 'San Francisco',
          category: 'Kids & Family',
        });
      }
    });
  } catch (e) { console.error('scrapeExploratorium:', e.message); }
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
  const seen = new Set();
  const events = [];
  results.flatMap(r => r.status === 'fulfilled' ? r.value : []).forEach(ev => {
    const key = ev.url + '|' + ev.date;
    if (!seen.has(key)) { seen.add(key); events.push(ev); }
  });
  return events;
}

// ── Region normalization ──────────────────────────────────────────────────────

// Bay Area zip code → region. Covers the most common zips; falls back to city/keyword scan.
const ZIP_REGION_MAP = (() => {
  const m = {};
  const add = (region, zips) => zips.forEach(z => { m[z] = region; });

  add('San Francisco', [
    94102,94103,94104,94105,94107,94108,94109,94110,94111,94112,94114,94115,94116,
    94117,94118,94119,94120,94121,94122,94123,94124,94125,94126,94127,94128,94129,
    94130,94131,94132,94133,94134,94143,94158,94188,
  ]);
  add('North Bay', [
    // Marin
    94901,94903,94904,94920,94925,94930,94933,94937,94938,94939,94940,94941,94942,
    94945,94947,94948,94949,94956,94960,94963,94964,94965,94966,94970,94971,94972,
    94973,94974,94976,94977,94978,94979,
    // Sonoma
    94922,94923,94924,94926,94927,94928,94929,94931,94951,94952,94953,94954,94955,
    94975,95401,95402,95403,95404,95405,95406,95407,95409,95416,95419,95421,95425,
    95430,95431,95433,95436,95441,95442,95444,95446,95448,95450,95452,95462,95465,
    95471,95472,95476,
    // Napa
    94508,94515,94558,94559,94560,94562,94574,94576,94581,94589,94590,94591,94592,94599,
    // Solano (Vallejo/Benicia)
    94510,94589,94590,94591,94592,
  ]);
  add('East Bay', [
    // Alameda county
    94501,94502,94536,94537,94538,94539,94540,94541,94542,94543,94544,94545,94546,
    94550,94551,94552,94555,94560,94566,94568,94577,94578,94579,94580,94586,94587,94588,
    // Oakland / Berkeley
    94601,94602,94603,94604,94605,94606,94607,94608,94609,94610,94611,94612,94613,
    94614,94615,94618,94619,94620,94621,94702,94703,94704,94705,94706,94707,94708,
    94709,94710,94720,
    // Contra Costa
    94509,94520,94521,94522,94523,94524,94525,94526,94527,94528,94529,94530,94531,
    94547,94549,94553,94556,94563,94564,94565,94569,94572,94582,94583,94595,94596,
    94597,94598,94801,94802,94803,94804,94805,94806,94807,94808,94820,94850,
  ]);
  add('Peninsula', [
    94005,94010,94011,94013,94014,94015,94016,94017,94019,94020,94021,94025,94026,
    94027,94028,94030,94037,94038,94044,94061,94062,94063,94064,94065,94066,94070,
    94074,94080,94083,94401,94402,94403,94404,94497,
  ]);
  add('South Bay', [
    // Santa Clara county / San Jose
    94022,94023,94024,94035,94039,94040,94041,94042,94043,94085,94086,94087,94088,
    94089,94301,94302,94303,94304,94305,94306,94309,
    95002,95008,95013,95014,95015,95020,95021,95023,95026,95032,95033,95035,95036,
    95037,95038,95045,95046,95050,95051,95052,95053,95054,95055,95056,95070,95071,
    95101,95102,95103,95106,95108,95109,95110,95111,95112,95113,95115,95116,95117,
    95118,95119,95120,95121,95122,95123,95124,95125,95126,95127,95128,95129,95130,
    95131,95132,95133,95134,95135,95136,95138,95139,95140,95141,95148,95150,95151,
    95152,95153,95154,95155,95156,95157,95158,95159,95160,95161,95164,95170,95172,
    95173,95190,95191,95192,95193,95194,95196,
  ]);

  return m;
})();

function extractZip(location) {
  if (!location) return null;
  const m = (location || '').match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? parseInt(m[1], 10) : null;
}

const CITY_REGION_MAP = {
  // San Francisco
  'san francisco': 'San Francisco',
  // North Bay
  'sausalito': 'North Bay', 'mill valley': 'North Bay', 'san rafael': 'North Bay',
  'novato': 'North Bay', 'tiburon': 'North Bay', 'corte madera': 'North Bay',
  'larkspur': 'North Bay', 'san anselmo': 'North Bay', 'fairfax': 'North Bay',
  'ross': 'North Bay', 'kentfield': 'North Bay', 'greenbrae': 'North Bay',
  'vallejo': 'North Bay', 'benicia': 'North Bay', 'sonoma': 'North Bay',
  'napa': 'North Bay', 'petaluma': 'North Bay', 'santa rosa': 'North Bay',
  'sebastopol': 'North Bay', 'healdsburg': 'North Bay', 'guerneville': 'North Bay',
  'yountville': 'North Bay', 'st. helena': 'North Bay', 'calistoga': 'North Bay',
  // East Bay
  'oakland': 'East Bay', 'berkeley': 'East Bay', 'alameda': 'East Bay',
  'el cerrito': 'East Bay', 'albany': 'East Bay', 'emeryville': 'East Bay',
  'hayward': 'East Bay', 'fremont': 'East Bay', 'union city': 'East Bay',
  'newark': 'East Bay', 'san leandro': 'East Bay', 'castro valley': 'East Bay',
  'walnut creek': 'East Bay', 'concord': 'East Bay', 'pleasant hill': 'East Bay',
  'antioch': 'East Bay', 'pittsburg': 'East Bay', 'orinda': 'East Bay',
  'moraga': 'East Bay', 'lafayette': 'East Bay', 'danville': 'East Bay',
  'san ramon': 'East Bay', 'pleasanton': 'East Bay', 'livermore': 'East Bay',
  'dublin': 'East Bay', 'crockett': 'East Bay', 'pinole': 'East Bay',
  'richmond': 'East Bay', 'el sobrante': 'East Bay', 'rodeo': 'East Bay',
  'sunol': 'East Bay',
  // Peninsula
  'san mateo': 'Peninsula', 'palo alto': 'Peninsula', 'redwood city': 'Peninsula',
  'menlo park': 'Peninsula', 'burlingame': 'Peninsula', 'san carlos': 'Peninsula',
  'belmont': 'Peninsula', 'foster city': 'Peninsula', 'millbrae': 'Peninsula',
  'south san francisco': 'Peninsula', 'daly city': 'Peninsula', 'pacifica': 'Peninsula',
  'half moon bay': 'Peninsula', 'los altos': 'Peninsula', 'atherton': 'Peninsula',
  'portola valley': 'Peninsula', 'woodside': 'Peninsula',
  // South Bay
  'san jose': 'South Bay', 'santa clara': 'South Bay', 'sunnyvale': 'South Bay',
  'campbell': 'South Bay', 'los gatos': 'South Bay', 'saratoga': 'South Bay',
  'milpitas': 'South Bay', 'morgan hill': 'South Bay', 'gilroy': 'South Bay',
  'cupertino': 'South Bay', 'mountain view': 'South Bay',
};

// Neighborhood/keyword fallbacks for when no city is found in address
const REGION_KEYWORDS = {
  'San Francisco': [
    ', sf,', ', sf ', '(sf)', ' sf, ca', 'sfpl', 'sfmoma',
    'soma', 'south of market',
    'mission district', 'mission dolores', 'dolores park', 'dolores st',
    'castro', 'noe valley', 'glen park, sf', 'glen park, san francisco', 'bernal',
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
    'faces sf', 'persia and mission', 'excelsior district',
    'elk glen', 'stow lake',
    ', ca 941',
  ],
  'North Bay':  [
    'marin ', 'marin,', 'marin county', 'north bay',
    'wine country', 'stinson beach', 'point reyes', 'olema',
    'williamson ranch',
  ],
  'East Bay':   [
    'east bay', 'e. bay',
    'lake merritt', 'rockridge', 'temescal', 'montclair',
    'lawrence hall', 'children\'s fairyland', 'tilden',
    'jean sweeney', 'macarthur blvd', 'college avenue',
    '510 families',
    ', ca 946', ', ca 945', ', ca 944',
  ],
  'Peninsula':  ['peninsula', 'filoli', 'baylands', 'eco center', 'half moon bay', 'palo alto', 'san carlos'],
  'South Bay':  ['south bay', 'silicon valley', 'oshman family jcc', 's. bay'],
};

const REGION_ORDER = ['San Francisco', 'North Bay', 'East Bay', 'Peninsula', 'South Bay'];

function extractCity(location) {
  if (!location) return null;
  // Match ", City, CA" or ", City, California"
  const m = location.match(/,\s*([^,]+),\s*(?:CA|California)\b/i);
  if (m) return m[1].trim().toLowerCase();
  return null;
}

function normalizeRegion(location, source) {
  const locLower = (location || '').toLowerCase();

  // 1. Zip code lookup (most precise — catches "Dublin, CA 94568" even without city text)
  const zip = extractZip(location);
  if (zip && ZIP_REGION_MAP[zip]) return ZIP_REGION_MAP[zip];

  // 2. Strict `, City, CA` pattern
  const city = extractCity(location);
  if (city && CITY_REGION_MAP[city]) return CITY_REGION_MAP[city];

  // 3. Loose city-name scan — catches bare "Dublin" without zip
  for (const [cityName, region] of Object.entries(CITY_REGION_MAP)) {
    const pat = new RegExp(`\\b${cityName}\\b`);
    if (pat.test(locLower)) return region;
  }

  // 4. Keyword fallback for neighborhoods and abbreviations
  const text = locLower + ' ' + (source || '').toLowerCase();
  for (const region of REGION_ORDER) {
    if (REGION_KEYWORDS[region].some(k => text.includes(k))) return region;
  }

  // 5. Source-based fallback
  if (source === 'Marin Mommies') return 'North Bay';
  if (source === '510 Families') return 'East Bay';
  if (source === 'SFPL Kids Events') return 'San Francisco';
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

const FAS_SOURCE = 'Family Adventure Squad/Mommy & Me Hiking';
const FAS_SHEET_ID = '1_57I0poigu0VenXWsJX6817RdQLDJ5YMjC1tj3IkcYY';
const FAS_GID = '1641998768';

async function scrapeFamilyAdventureSquad() {
  const events = [];
  try {
    const csvUrl = `https://docs.google.com/spreadsheets/d/${FAS_SHEET_ID}/export?format=csv&gid=${FAS_GID}`;
    const { data } = await axios.get(csvUrl, { headers: HEADERS, timeout: 15000, maxRedirects: 5 });

    const lines = data.split('\n');
    const today = new Date().toISOString().split('T')[0];
    const year = new Date().getFullYear();

    // Find the header row index (contains "DATE")
    let dataStart = 0;
    for (let i = 0; i < lines.length; i++) {
      if (parseCSVRow(lines[i])[0].trim().toUpperCase() === 'DATE') { dataStart = i + 1; break; }
    }

    for (let i = dataStart; i < lines.length; i++) {
      const row = parseCSVRow(lines[i]);
      const dateRaw = (row[0] || '').trim();
      const description = (row[1] || '').trim();
      const signupUrl = (row[2] || '').trim();

      if (!dateRaw || !description) continue;

      // Handle both same-month ranges (3/27-9) and cross-month ranges (09/05-09/07, 10/30-11/1)
      // Always take the start date
      const dateClean = dateRaw
        .replace(/[-–]\d{2}\/\d{1,2}$/, '')   // strip cross-month end: "10/30-11/1" → "10/30"
        .replace(/[-–]\d+$/, '')                // strip same-month end: "3/27-9" → "3/27"
        .trim();

      const m = dateClean.match(/^(\d{1,2})\/(\d{1,2})$/);
      if (!m) continue;

      const d = new Date(year, parseInt(m[1], 10) - 1, parseInt(m[2], 10));
      if (isNaN(d)) continue;
      const date = d.toISOString().split('T')[0];
      if (date < today) continue;

      const url = signupUrl && signupUrl.startsWith('http') ? signupUrl
        : 'https://www.familyadventuresquad.org';

      events.push({
        id: makeId(),
        source: FAS_SOURCE,
        title: description.slice(0, 120),
        url,
        description: description.length > 120 ? description : '',
        dateText: dateRaw,
        date,
        location: '',
        region: normalizeRegion(description, FAS_SOURCE),
        category: 'Kids & Family',
      });
    }
  } catch (e) { console.error('scrapeFamilyAdventureSquad:', e.message); }
  return events;
}

function parseCSVRow(line) {
  // Simple CSV parser that handles quoted fields
  const cols = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      cols.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

async function scrapeChabot() {
  const events = [];
  const seen = new Set();
  const today = new Date().toISOString().split('T')[0];
  const BASE = 'https://chabotspace.org';
  try {
    // Page 1 uses the programs listing URL; subsequent pages use the calendar list path
    const pageUrls = [
      `${BASE}/programs/events-listing/`,
      ...Array.from({ length: 5 }, (_, i) => `${BASE}/calendar/list/page/${i + 2}/?shortcode=ac635b34`),
    ];
    for (const pageUrl of pageUrls) {
      const { data } = await axios.get(pageUrl, { headers: HEADERS, timeout: 15000 });
      const $ = cheerio.load(data);
      // Events are embedded as JSON-LD Event objects
      let foundOnPage = 0;
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const raw = $(el).html();
          const obj = JSON.parse(raw);
          const items = Array.isArray(obj) ? obj : [obj];
          for (const item of items) {
            if (item['@type'] !== 'Event' || !item.startDate || !item.name) continue;
            const url = item.url || pageUrl;
            if (seen.has(url)) continue;
            seen.add(url);
            const date = item.startDate.slice(0, 10);
            if (date < today) continue;
            const title = item.name.replace(/&#\d+;/g, c => {
              const m = c.match(/&#(\d+);/); return m ? String.fromCharCode(parseInt(m[1])) : c;
            }).replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
            const desc = (item.description || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
            foundOnPage++;
            events.push({
              id: makeId(),
              source: 'Chabot Space & Science Center',
              title,
              url,
              description: desc,
              dateText: date,
              date,
              location: '10000 Skyline Blvd, Oakland, CA 94619',
              region: 'East Bay',
              category: 'Science & Education',
            });
          }
        } catch {}
      });
      if (foundOnPage === 0) break; // no more events
    }
  } catch (e) { console.error('scrapeChabot:', e.message); }
  return events;
}

async function scrapeLawrenceHall() {
  const events = [];
  const today = new Date().toISOString().split('T')[0];
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 365);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const BASE = 'https://lawrencehallofscience.org';
  try {
    // REST API `date` is publish date, not event date. Fetch recently-published events
    // then resolve each one's actual event date via JSON-LD on the individual page.
    const links = [];
    for (let page = 1; page <= 7; page++) {
      const { data } = await axios.get(
        `${BASE}/wp-json/wp/v2/event?per_page=100&page=${page}&order=desc&orderby=date&_fields=id,title,date,link,excerpt`,
        { headers: HEADERS, timeout: 15000 }
      );
      if (!data.length) break;
      for (const ev of data) {
        // Only look at events published recently — older ones are unlikely to be upcoming
        if ((ev.date || '').slice(0, 10) < cutoffStr) { break; }
        links.push(ev);
      }
      // If last item on this page is older than cutoff, no need to fetch more pages
      if (data.length && (data[data.length - 1].date || '').slice(0, 10) < cutoffStr) break;
    }

    // Resolve actual event dates in parallel (batches of 10)
    const BATCH = 10;
    for (let i = 0; i < links.length; i += BATCH) {
      const batch = links.slice(i, i + BATCH);
      const results = await Promise.allSettled(batch.map(async ev => {
        const { data: html } = await axios.get(ev.link, { headers: HEADERS, timeout: 15000 });
        const $ = cheerio.load(html);
        let eventDate = null;
        $('script[type="application/ld+json"]').each((_, el) => {
          try {
            const obj = JSON.parse($(el).html());
            const items = Array.isArray(obj) ? obj : [obj];
            for (const item of items) {
              if (item['@type'] === 'Event' && item.startDate) {
                eventDate = item.startDate.slice(0, 10);
                return false;
              }
            }
          } catch {}
        });
        return { ev, eventDate };
      }));

      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        const { ev, eventDate } = r.value;
        if (!eventDate || eventDate < today) continue;
        const title = ev.title?.rendered?.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#\d+;/g, c => {
          const m = c.match(/&#(\d+);/); return m ? String.fromCharCode(parseInt(m[1])) : c;
        }).trim() || '';
        if (!title) continue;
        const desc = ev.excerpt?.rendered?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200) || '';
        events.push({
          id: makeId(),
          source: 'Lawrence Hall of Science',
          title,
          url: ev.link,
          description: desc,
          dateText: eventDate,
          date: eventDate,
          location: '1 Centennial Dr, Berkeley, CA 94720',
          region: 'East Bay',
          category: 'Science & Education',
        });
      }
    }
  } catch (e) { console.error('scrapeLawrenceHall:', e.message); }
  return events;
}

// ── Scrape all sources ────────────────────────────────────────────────────────

let scrapeInProgress = false;

async function scrapeAll() {
  if (scrapeInProgress) { console.log('Scrape already in progress, skipping.'); return []; }
  scrapeInProgress = true;
  try {
  console.log('Scraping all sources…');
  const [r, m, f, e, s, d, x, fas, ch, lhs] = await Promise.allSettled([
    scrapeRonnie(), scrapeMarinMommies(), scrapeFuncheap(), scrape510Families(), scrapeSFPL(), scrapeDSE(), scrapeExploratorium(), scrapeFamilyAdventureSquad(), scrapeChabot(), scrapeLawrenceHall()
  ]);
  const all = [
    ...(r.status === 'fulfilled' ? r.value : []),
    ...(m.status === 'fulfilled' ? m.value : []),
    ...(f.status === 'fulfilled' ? f.value : []),
    ...(e.status === 'fulfilled' ? e.value : []),
    ...(s.status === 'fulfilled' ? s.value : []),
    ...(d.status === 'fulfilled' ? d.value : []),
    ...(x.status === 'fulfilled' ? x.value : []),
    ...(fas.status === 'fulfilled' ? fas.value : []),
    ...(ch.status === 'fulfilled' ? ch.value : []),
    ...(lhs.status === 'fulfilled' ? lhs.value : []),
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
  } finally {
    scrapeInProgress = false;
  }
}

// Run on startup + every 6 hours
scrapeAll().catch(err => console.error('Startup scrape failed:', err.message));
cron.schedule('0 */6 * * *', () => scrapeAll().catch(err => console.error('Scheduled scrape failed:', err.message)));

// ── Content moderation ────────────────────────────────────────────────────────

async function moderateEventContent(title, description) {
  if (!process.env.ANTHROPIC_API_KEY) return { safe: true };
  const content = `Title: ${title}\nDescription: ${description || ''}`.slice(0, 1000);
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 100,
    messages: [{
      role: 'user',
      content: `You are a content moderator for a family/kids events website. Determine if this event is appropriate for families with children.\n\n${content}\n\nReply with JSON only: {"safe": true} if appropriate, or {"safe": false, "reason": "<short reason>"} if inappropriate (adult content, violence, gambling, substance use, hate speech, or anything not suitable for children).`,
    }],
  });
  try {
    const text = msg.content[0].text.trim();
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    return json ? JSON.parse(json) : { safe: true };
  } catch {
    return { safe: true };
  }
}

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
    const addr = jsonld.location?.address;
    const addrStr = typeof addr === 'string' ? addr : null;
    const loc = jsonld.location?.name || addr?.streetAddress || addrStr || '';
    const fullAddr = addrStr
      ? [jsonld.location?.name, addrStr].filter(Boolean).join(', ')
      : [
          jsonld.location?.name,
          addr?.streetAddress,
          addr?.addressLocality,
          addr?.addressRegion,
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
    // When a specific date is selected, show all events for that date regardless of whether it's in the past
    const params = date ? [] : [today];
    const conditions = date ? [] : ['(date IS NULL OR date >= $1)'];

    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      const i = params.length;
      conditions.push(`(LOWER(title) LIKE $${i} OR LOWER(description) LIKE $${i} OR LOWER(location) LIKE $${i} OR LOWER(category) LIKE $${i} OR LOWER(source) LIKE $${i})`);
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
    res.json({ events: rows.filter(e => !/canceled/i.test(e.title)), lastScraped });
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

    const moderation = await moderateEventContent(fields.title, fields.description);
    if (!moderation.safe) {
      return res.status(422).json({ error: `This event was flagged as inappropriate for a family audience: ${moderation.reason || 'content not suitable for children'}.` });
    }

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
