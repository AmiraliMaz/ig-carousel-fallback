const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
// Secret to prevent abuse — set via env on Railway
const API_SECRET = process.env.API_SECRET || '';

// Instagram session for DM monitoring (set via Railway env vars)
const IG_SESSIONID = process.env.IG_SESSIONID || '';
const IG_CSRFTOKEN = process.env.IG_CSRFTOKEN || '';
const IG_DS_USER_ID = process.env.IG_DS_USER_ID || '';

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
  processedCount: processedMessageIds.size,
}));

/**
 * POST /fetch
 * Body: { url: "https://www.instagram.com/p/XXXX/", secret: "..." }
 * Returns: { status: "ok", items: [{ type: "photo"|"video", url: "https://..." }, ...] }
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
    // Try logged-in session first (better for age-gated / restricted posts)
    let items = [];
    if (IG_SESSIONID) {
      try {
        items = await fetchViaSession(url);
        console.log(`[fetch] session got ${items.length} items`);
      } catch (e) {
        console.log(`[fetch] session failed: ${e.message}, falling back to saveclip`);
      }
    }
    // Fallback to saveclip
    if (items.length === 0) {
      items = await fetchViaSaveclip(url);
    }
    if (items.length === 0) {
      return res.json({ status: 'error', message: 'no media found', items: [] });
    }
    return res.json({ status: 'ok', items });
  } catch (err) {
    console.error('[fallback] error:', err.message);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});


/**
 * Fetch media using logged-in Instagram session.
 * Uses direct HTTP (no browser) with session cookies - 5-10x faster than Puppeteer.
 */
async function fetchViaSession(url) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const cookieStr = `sessionid=${IG_SESSIONID}; ds_user_id=${IG_DS_USER_ID}; csrftoken=${IG_CSRFTOKEN}`;
    const options = {
      headers: {
        'Cookie': cookieStr,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 15000,
    };
    console.log('[session] fetching (direct HTTP)', url);
    https.get(url, options, (res) => {
      let html = '';
      res.on('data', chunk => html += chunk);
      res.on('end', () => {
        try {
          const out = [];
          const seen = new Set();
          const videoRe = /"video_url"\s*:\s*"([^"]+)"/g;
          let m;
          while ((m = videoRe.exec(html)) !== null) {
            let u = m[1].replace(/\u0026/g, '&').replace(/\\/g, '');
            if (!seen.has(u) && u.includes('cdn')) { seen.add(u); out.push({ type: 'video', url: u }); }
          }
          const imgRe = /"display_url"\s*:\s*"([^"]+)"/g;
          while ((m = imgRe.exec(html)) !== null) {
            let u = m[1].replace(/\u0026/g, '&').replace(/\\/g, '');
            if (!seen.has(u) && u.includes('cdn')) { seen.add(u); out.push({ type: 'photo', url: u }); }
          }
          console.log(`[session] extracted ${out.length} items (direct HTTP)`);
          resolve(out);
        } catch (e) { reject(e); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('HTTP timeout')));
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

async function sendToTelegram(items, sourceUrl) {
  if (!TG_BOT_TOKEN) {
    console.log('[dm] no TG_BOT_TOKEN, skipping send');
    return 0;
  }
  // Filter to actual slides (skip thumbnails)
  const slides = items.filter(it => it.label === 'Download Video' || it.label === 'Download Image');
  console.log(`[dm] sending ${slides.length} slides to Telegram`);
  let sent = 0;
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i];
    const isVideo = s.label === 'Download Video';
    const caption = `Slide ${i + 1} of ${slides.length}\n🔗 ${sourceUrl}`;
    try {
      const endpoint = isVideo ? 'sendVideo' : 'sendPhoto';
      const param = isVideo ? 'video' : 'photo';
      const resp = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TG_CHAT_ID,
          [param]: s.url,
          caption: caption,
          parse_mode: 'HTML',
        }),
      });
      const data = await resp.json();
      if (data.ok) {
        sent++;
        console.log(`[dm] sent slide ${i + 1}/${slides.length}`);
      } else {
        console.log(`[dm] failed slide ${i + 1}: ${data.description}`);
      }
    } catch (e) {
      console.log(`[dm] error sending slide ${i + 1}: ${e.message}`);
    }
    // Small delay between sends
    await new Promise(r => setTimeout(r, 2000));
  }
  return sent;
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
          await sendToTelegram(items, share.url);
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

function scheduleDMCheck() {
  if (!IG_SESSIONID) {
    console.log('[dm] monitor disabled (no IG_SESSIONID)');
    return;
  }
  const delay = DM_CHECK_MIN_MS + Math.random() * (DM_CHECK_MAX_MS - DM_CHECK_MIN_MS);
  console.log(`[dm] next check in ${Math.round(delay / 60000)} min`);
  setTimeout(async () => {
    await checkDMs();
    scheduleDMCheck();
  }, delay);
}

app.listen(PORT, () => {
  console.log(`[fallback] listening on ${PORT}`);
  // WebSocket DM monitor DISABLED - n8n via Zernio is the primary DM→Telegram path
  // startWebSocketMonitor();
  // Legacy polling monitor (disabled by default, enable if needed)
  // scheduleDMCheck();
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  try { if (browser) await browser.close(); } catch (e) {}
  process.exit(0);
});

// ===== WebSocket Real-time DM Monitor =====
// Uses Chrome DevTools Protocol to passively observe Instagram's WebSocket
// No extra API calls - just watches what the browser already receives

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8n-production-1542.up.railway.app/webhook/microservice-url';
const wsProcessedIds = new Set();

async function startWebSocketMonitor() {
  if (!IG_SESSIONID) {
    console.log('[ws] no IG session, WebSocket monitor disabled');
    return;
  }

  console.log('[ws] starting WebSocket DM monitor...');
  let page = null;

  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setUserAgent(randomUserAgent());
    await page.setViewport(randomViewport());
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    await setIgCookies(page);

    // Create CDP session for network monitoring
    const cdp = await page.target().createCDPSession();
    await cdp.send('Network.enable');

    // Listen for WebSocket frames (Instagram real-time sync)
    cdp.on('Network.webSocketFrameReceived', async (params) => {
      try {
        const payload = params.response?.payloadData || '';
        if (!payload) return;

        // Look for DM thread updates with shared posts
        // Instagram WebSocket messages contain JSON with thread items
        if (payload.includes('instagram.com/p/') || payload.includes('instagram.com/reel/')) {
          const urls = payload.match(/https?:\/\/(www\.)?instagram\.com\/(p|reel)\/[A-Za-z0-9_-]+\/?/g);
          if (urls) {
            for (const url of urls) {
              const cleanUrl = url.replace(/\/$/, '') + '/';
              if (!wsProcessedIds.has(cleanUrl)) {
                wsProcessedIds.add(cleanUrl);
                if (wsProcessedIds.size > MAX_PROCESSED) {
                  const first = wsProcessedIds.values().next().value;
                  wsProcessedIds.delete(first);
                }
                console.log(`[ws] new share detected: ${cleanUrl}`);
                await notifyN8n(cleanUrl);
              }
            }
          }
        }
      } catch (e) {
        // Ignore parse errors
      }
    });

    // Also listen for GraphQL responses (thread sync)
    cdp.on('Network.responseReceived', async (params) => {
      try {
        const url = params.response?.url || '';
        // Instagram thread sync endpoints
        if (url.includes('/direct/') || url.includes('graphql')) {
          // The response body would need to be fetched via CDP
          // For now, rely on WebSocket frames which are more reliable
        }
      } catch (e) {}
    });

    console.log('[ws] navigating to Instagram DMs...');
    await page.goto('https://www.instagram.com/direct/inbox/', {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });

    console.log('[ws] WebSocket monitor active - watching for new shares');
    console.log('[ws] (browser tab stays open, passively observing)');

    // Keep the page alive - monitor runs indefinitely
    // Reconnect if page crashes
    page.on('close', () => {
      console.log('[ws] page closed, restarting monitor in 30s...');
      setTimeout(startWebSocketMonitor, 30000);
    });

  } catch (err) {
    console.error('[ws] monitor error:', err.message);
    try { if (page) await page.close(); } catch (e) {}
    // Retry in 60s
    setTimeout(startWebSocketMonitor, 60000);
  }
}

async function notifyN8n(shareUrl) {
  try {
    const resp = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: shareUrl,
        source: 'websocket-monitor',
        timestamp: new Date().toISOString(),
      }),
    });
    console.log(`[ws] notified n8n: ${resp.status}`);
  } catch (e) {
    console.log(`[ws] n8n notify failed: ${e.message}`);
  }
}
