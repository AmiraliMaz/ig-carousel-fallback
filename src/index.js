const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
// Secret to prevent abuse — set via env on Railway
const API_SECRET = process.env.API_SECRET || 'carousel-fallback-2026';

// Instagram session: full mobile bundle (instagrapi dump_settings) preferred.
// Primary: SESSION_JSON env var (JSON string). Fallback: ./session.json file.
// Legacy fallback: IG_SESSIONID / IG_DS_USER_ID / IG_CSRFTOKEN env vars.
let SESSION = null;
(function loadSessionBundle() {
  try {
    const raw = process.env.SESSION_JSON || '';
    if (raw) {
      SESSION = JSON.parse(raw);
      console.log('[session] bundle loaded from SESSION_JSON env');
      return;
    }
    const fs = require('fs');
    const path = require('path');
    const fp = path.join(__dirname, '..', 'session.json');
    if (fs.existsSync(fp)) {
      SESSION = JSON.parse(fs.readFileSync(fp, 'utf8'));
      console.log('[session] bundle loaded from session.json file');
    }
  } catch (e) {
    console.log('[session] bundle load failed:', e.message);
  }
})();

const IG_SESSIONID = (SESSION && SESSION.cookies && SESSION.cookies.sessionid) || process.env.IG_SESSIONID || '';
const IG_CSRFTOKEN = (SESSION && SESSION.cookies && SESSION.cookies.csrftoken) || process.env.IG_CSRFTOKEN || '';
const IG_DS_USER_ID = (SESSION && SESSION.cookies && SESSION.cookies.ds_user_id) || process.env.IG_DS_USER_ID || '';
const HAS_SESSION = !!(SESSION || process.env.IG_SESSIONID);

function sessionCookieHeader() {
  if (SESSION && SESSION.cookies) {
    return Object.entries(SESSION.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  return `sessionid=${IG_SESSIONID}; ds_user_id=${IG_DS_USER_ID}; csrftoken=${IG_CSRFTOKEN}`;
}
function sessionUserAgent() {
  if (SESSION && SESSION.user_agent) return SESSION.user_agent;
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
}

// Telegram for direct sending (set via Railway env vars)
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '214454949';

// DM monitoring config
const DM_CHECK_MIN_MS = 10 * 60 * 1000;  // 10 min
const DM_CHECK_MAX_MS = 15 * 60 * 1000;  // 15 min
const processedMessageIds = new Set();
const MAX_PROCESSED = 500;

let browser = null;

// Anti-detection helpers
function randomDelay(minMs, maxMs) {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise(r => setTimeout(r, ms));
}

function randomViewport() {
  const viewports = [
    { width: 1280, height: 800 },
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1536, height: 864 },
    { width: 1920, height: 1080 },
  ];
  return viewports[Math.floor(Math.random() * viewports.length)];
}

function randomUserAgent() {
  const versions = ['120.0.0.0', '121.0.0.0', '122.0.0.0', '123.0.0.0'];
  const v = versions[Math.floor(Math.random() * versions.length)];
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`;
}

async function humanClick(page, selector) {
  // Move mouse to element with slight randomness, then click
  const el = await page.$(selector);
  if (!el) return false;
  const box = await el.boundingBox();
  if (!box) return false;
  const x = box.x + box.width / 2 + (Math.random() - 0.5) * 10;
  const y = box.y + box.height / 2 + (Math.random() - 0.5) * 10;
  await page.mouse.move(x, y, { steps: 5 });
  await page.mouse.click(x, y);
  return true;
}

async function getBrowser() {
  if (!browser || !browser.connected) {
    console.log('[fallback] launching browser...');
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,800',
      ],
    });
  }
  return browser;
}

async function setIgCookies(page) {
  if (!IG_SESSIONID) return false;
  const cookies = [
    { name: 'sessionid', value: IG_SESSIONID, domain: '.instagram.com' },
    { name: 'ds_user_id', value: IG_DS_USER_ID, domain: '.instagram.com' },
    { name: 'csrftoken', value: IG_CSRFTOKEN, domain: '.instagram.com' },
  ];
  await page.setCookie(...cookies);
  return true;
}

// Health check
app.get('/', (req, res) => res.json({
  status: 'ok',
  service: 'ig-carousel-fallback',
  dmMonitor: IG_SESSIONID ? 'enabled' : 'disabled',
  session: HAS_SESSION ? (SESSION ? 'bundle' : 'env') : 'disabled',
  processedCount: processedMessageIds.size,
}));

/**
 * POST /fetch
 * Body: { url: "https://www.instagram.com/p/XXXX/", secret: "..." }
 * Returns: { status: "ok", items: [{ type: "photo"|"video", url: "https://..." }, ...], source: "anonymous"|"session"|"saveclip" }
 */
app.post('/fetch', async (req, res) => {
  const { url, secret } = req.body || {};
  if (API_SECRET && secret !== API_SECRET) {
    return res.status(403).json({ status: 'error', message: 'forbidden' });
  }
  if (!url || !url.includes('instagram.com/')) {
    return res.status(400).json({ status: 'error', message: 'invalid url' });
  }

  try {
    // 1. Anonymous embed route first: fast, no login, no ban risk.
    //    Covers public reels / posts / carousels.
    let items = [];
    let source = 'none';
    try {
      items = await fetchViaAnonymous(url);
      source = 'anonymous';
      console.log(`[fetch] anonymous got ${items.length} items`);
    } catch (e) {
      console.log(`[fetch] anonymous failed: ${e.message}`);
    }
    // 2. Logged-in session (for age-gated / restricted / private posts).
    //    Fails fast when the session is logged out.
    if (items.length === 0 && HAS_SESSION) {
      try {
        items = await fetchViaSession(url);
        source = 'session';
        console.log(`[fetch] session got ${items.length} items`);
      } catch (e) {
        console.log(`[fetch] session failed: ${e.message}`);
      }
    }
    // 3. Saveclip last resort
    if (items.length === 0) {
      items = await fetchViaSaveclip(url);
      if (items.length > 0) source = 'saveclip';
    }
    if (items.length === 0) {
      return res.json({ status: 'error', message: 'no media found', items: [], source });
    }
    return res.json({ status: 'ok', items, source });
  } catch (err) {
    console.error('[fallback] error:', err.message);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});


/**
 * Fetch media anonymously via Instagram's public embed page
 * (https://www.instagram.com/p/{shortcode}/embed/). No login, no browser,
 * no session — just one HTTPS GET. The embed page is what Instagram serves
 * for website embeds, so it's built for public access. Returns ordered
 * items; carousels come back slide-by-slide with correct types.
 * Ported from the n8n "Extract Video" node logic (proven in production).
 */
async function fetchViaAnonymous(url) {
  const m = String(url || '').match(/instagram\.com\/(p|reel|tv)\/([A-Za-z0-9_-]+)/);
  if (!m) throw new Error('no shortcode in url');
  const embedUrl = `https://www.instagram.com/${m[1]}/${m[2]}/embed/`;
  console.log('[anonymous] fetching', embedUrl);
  const html = await httpsGetText(embedUrl, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  });
  // Unescape multi-escaped JSON (same approach as n8n "Extract Video")
  const decodeOnce = (s) => {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length) {
        const n = s[i + 1];
        if (n === 'u' && i + 5 < s.length) {
          const hex = s.slice(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 5; continue; }
        }
        if (n === 'n') { out += '\n'; i++; continue; }
        if (n === 't') { out += '\t'; i++; continue; }
        if (n === 'r') { out += '\r'; i++; continue; }
        out += n; i++; continue;
      }
      out += c;
    }
    return out;
  };
  let t = html;
  for (let r = 0; r < 4; r++) { const d = decodeOnce(t); if (d === t) break; t = d; }

  const out = [];
  const seen = new Set();
  const push = (type, u) => {
    if (u && !seen.has(u)) { seen.add(u); out.push({ type, url: u }); }
  };

  // Carousel: edge_sidecar_to_children with per-slide nodes
  const carouselIdx = t.indexOf('edge_sidecar_to_children');
  if (carouselIdx !== -1) {
    const section = t.slice(carouselIdx, carouselIdx + 200000);
    const nodePattern = /"node":\{"id":"(\d+)","shortcode":"([^"]+)","is_video":(true|false)/g;
    const slides = [];
    let nm;
    while ((nm = nodePattern.exec(section)) !== null) {
      slides.push({ shortcode: nm[2], isVideo: nm[3] === 'true' });
    }
    if (slides.length > 1) {
      const videoUrls = [];
      const vm = /"video_url":"(https?[^\"]*?\.mp4[^\"]*)"/g;
      let vmm;
      while ((vmm = vm.exec(section)) !== null) videoUrls.push(vmm[1]);
      const photoUrls = [];
      const pm = /"display_url":"(https?[^\"]+)"/g;
      let pmm;
      while ((pmm = pm.exec(section)) !== null) photoUrls.push(pmm[1]);
      let vIdx = 0, pIdx = 0;
      for (const s of slides) {
        if (s.isVideo) { if (vIdx < videoUrls.length) push('video', videoUrls[vIdx]); vIdx++; }
        else { if (pIdx < photoUrls.length) push('photo', photoUrls[pIdx]); pIdx++; }
      }
      console.log(`[anonymous] extracted ${out.length} carousel items`);
      if (!out.length) throw new Error('carousel found but no slide urls');
      return out;
    }
  }

  // Single video post / reel
  const svm = t.match(/"video_url"\s*:\s*"(https?[^\"]*?\.mp4[^\"]*)"/);
  if (svm) {
    push('video', svm[1]);
  } else {
    // Single photo post
    const spm = t.match(/"display_url"\s*:\s*"(https?[^\"]+)"/);
    if (spm) push('photo', spm[1]);
  }
  console.log(`[anonymous] extracted ${out.length} items`);
  if (!out.length) throw new Error('no media urls in embed page');
  return out;
}

function httpsGetText(url, headers) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 20000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('embed HTTP ' + res.statusCode + ' ' + body.slice(0, 80)));
        resolve(body);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('embed timeout')); });
  });
}

/**
 * Fetch media using the logged-in Instagram session via the private
 * media-info API (fast, no browser). Returns ordered items; carousels
 * come back slide-by-slide with correct types.
 */
async function fetchViaSession(url) {
  const shortcode = extractShortcode(url);
  if (!shortcode) throw new Error('no shortcode in url');
  const mediaId = shortcodeToMediaId(shortcode);
  const apiUrl = `https://i.instagram.com/api/v1/media/${mediaId}/info/`;
  console.log('[session] api fetching', apiUrl);
  const data = await httpsGetJson(apiUrl, {
    'Cookie': sessionCookieHeader(),
    'User-Agent': sessionUserAgent(),
    'X-IG-App-ID': '567310203415052',
    'Accept': 'application/json',
  });
  const items = (data && data.items) || [];
  if (!items.length) throw new Error('empty api response');
  const out = [];
  const seen = new Set();
  const pushMedia = (m) => {
    const isVideo = m.media_type === 2;
    const vv = m.video_versions || [];
    const iv = (m.image_versions2 && m.image_versions2.candidates) || [];
    const u = (isVideo && vv.length ? vv[0].url : null) || (iv.length ? iv[0].url : null) || '';
    if (u && !seen.has(u)) {
      seen.add(u);
      out.push({ type: isVideo ? 'video' : 'photo', url: u });
    }
  };
  const first = items[0];
  const carousel = first.carousel_media || [];
  if (carousel.length) carousel.forEach(pushMedia);
  else pushMedia(first);
  console.log(`[session] extracted ${out.length} items (api)`);
  if (!out.length) throw new Error('no media urls in api response');
  return out;
}

function extractShortcode(url) {
  const m = String(url || '').match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function shortcodeToMediaId(shortcode) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let id = 0n;
  for (const ch of shortcode) {
    const i = alphabet.indexOf(ch);
    if (i < 0) throw new Error('bad shortcode char');
    id = id * 64n + BigInt(i);
  }
  return id.toString();
}

function httpsGetJson(url, headers) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 15000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('API HTTP ' + res.statusCode + ' ' + body.slice(0, 120)));
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('bad json from api')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('API timeout')); });
  });
}

async function fetchViaSaveclip(url) {
  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    // Anti-detection: random UA and viewport
    await page.setUserAgent(randomUserAgent());
    await page.setViewport(randomViewport());

    // Hide webdriver flag
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    console.log('[fallback] opening saveclip.app');
    await page.goto('https://saveclip.app/', { waitUntil: 'networkidle2', timeout: 45000 });

    // (delays removed per user request)

    try {
      await page.waitForSelector('input[type="text"], input[name="url"], #url', { timeout: 10000 });
    } catch (e) {
      console.log('[fallback] input not found quickly, continuing');
    }

    const inputSel = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const urlInput = inputs.find(i =>
        i.type === 'text' || i.type === 'url' || (i.placeholder || '').toLowerCase().includes('instagram')
      );
      return urlInput ? true : false;
    });
    if (!inputSel) throw new Error('url input not found');

    await page.evaluate((u) => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const inp = inputs.find(i =>
        i.type === 'text' || i.type === 'url' || (i.placeholder || '').toLowerCase().includes('instagram')
      );
      if (inp) {
        inp.focus();
        inp.value = u;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, url);

    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const dl = btns.find(b => /download/i.test(b.textContent || ''));
      if (dl) dl.click();
    });

    console.log('[fallback] submitted, waiting for results...');
    await page.waitForFunction(
      () => document.querySelectorAll('a[href*="dl.snapcdn.app"], a[href*=".mp4"], a[href*=".jpg"]').length > 0,
      { timeout: 60000 }
    ).catch(() => console.log('[fallback] wait timed out, extracting anyway'));

    const items = await page.evaluate(() => {
      const out = [];
      const seen = new Set();
      document.querySelectorAll('a[href*="dl.snapcdn.app"]').forEach(a => {
        const href = a.href;
        if (seen.has(href)) return;
        seen.add(href);
        const txt = (a.textContent || '').toLowerCase();
        const type = txt.includes('video') ? 'video' : (txt.includes('image') || txt.includes('photo') ? 'photo' : 'unknown');
        out.push({ type, url: href, label: (a.textContent || '').trim().slice(0, 40) });
      });
      if (out.length === 0) {
        document.querySelectorAll('a[href$=".mp4"]').forEach(a => {
          if (!seen.has(a.href)) { seen.add(a.href); out.push({ type: 'video', url: a.href, label: '' }); }
        });
        document.querySelectorAll('a[href$=".jpg"], a[href$=".jpeg"], a[href$=".png"], a[href$=".webp"]').forEach(a => {
          if (!seen.has(a.href)) { seen.add(a.href); out.push({ type: 'photo', url: a.href, label: '' }); }
        });
      }
      return out;
    });

    console.log(`[fallback] extracted ${items.length} items`);
    await page.close(); page = null;
    return items;
  } catch (err) {
    try { if (page) await page.close(); } catch (e) {}
    throw err;
  }
}

async function checkDMs() {
  if (!IG_SESSIONID) {
    console.log('[dm] no IG session configured, skipping');
    return;
  }
  let page = null;
  try {
    console.log('[dm] checking DMs...');
    const b = await getBrowser();
    page = await b.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    );
    await page.setViewport({ width: 390, height: 844, isMobile: true });
    await setIgCookies(page);

    await page.goto('https://www.instagram.com/direct/inbox/', {
      waitUntil: 'networkidle2',
      timeout: 45000,
    });

    // Wait for DM list to load
    await new Promise(r => setTimeout(r, 5000));

    // Extract recent threads and look for shared posts
    // This is a simplified version - looks for links in the page
    const shares = await page.evaluate(() => {
      const out = [];
      // Look for Instagram post/reel links in the DM view
      const links = document.querySelectorAll('a[href*="instagram.com/p/"], a[href*="instagram.com/reel/"]');
      links.forEach(a => {
        const href = a.href;
        const m = href.match(/instagram\.com\/(p|reel)\/([A-Za-z0-9_-]+)/);
        if (m) {
          // Try to find a message ID from parent elements
          let el = a;
          let msgId = null;
          for (let i = 0; i < 5 && el; i++) {
            const idAttr = el.getAttribute('data-message-id') || el.id;
            if (idAttr) { msgId = idAttr; break; }
            el = el.parentElement;
          }
          out.push({ url: `https://www.instagram.com/${m[1]}/${m[2]}/`, msgId: msgId || href });
        }
      });
      return out;
    });

    console.log(`[dm] found ${shares.length} shared posts`);

    for (const share of shares) {
      if (processedMessageIds.has(share.msgId)) {
        continue;
      }
      processedMessageIds.add(share.msgId);
      if (processedMessageIds.size > MAX_PROCESSED) {
        const first = processedMessageIds.values().next().value;
        processedMessageIds.delete(first);
      }

      console.log(`[dm] new share: ${share.url}`);
      try {
        const items = await fetchViaSaveclip(share.url);
        if (items.length > 0) {
          console.log(`[dm] got ${items.length} items (not sending: monitor disabled)`);
        }
      } catch (e) {
        console.log(`[dm] error processing ${share.url}: ${e.message}`);
      }
    }

    await page.close(); page = null;
  } catch (err) {
    console.error('[dm] check error:', err.message);
    try { if (page) await page.close(); } catch (e) {}
  }
}

app.listen(PORT, () => {
  console.log(`[fallback] listening on ${PORT}`);
  // WebSocket DM monitor DISABLED - n8n via Zernio is the primary DM→Telegram path
  // startWebSocketMonitor();
});

process.on('SIGTERM', async () => {
  try { if (browser) await browser.close(); } catch (e) {}
  process.exit(0);
});
