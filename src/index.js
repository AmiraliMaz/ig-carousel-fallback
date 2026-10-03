const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || '';
const IG_SESSIONID = process.env.IG_SESSIONID || '';
const IG_CSRFTOKEN = process.env.IG_CSRFTOKEN || '';
const IG_DS_USER_ID = process.env.IG_DS_USER_ID || '';
const DM_CHECK_MIN_MS = 10 * 60 * 1000;
const DM_CHECK_MAX_MS = 15 * 60 * 1000;
const processedMessageIds = new Set();
const MAX_PROCESSED = 500;
let browser = null;
async function getBrowser() {
  if (!browser || !browser.connected) {
    console.log('[fallback] launching browser...');
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--window-size=1280,800'] });
  }
  return browser;
}
async function setIgCookies(page) {
  if (!IG_SESSIONID) return false;
  await page.setCookie(
    { name: 'sessionid', value: IG_SESSIONID, domain: '.instagram.com' },
    { name: 'ds_user_id', value: IG_DS_USER_ID, domain: '.instagram.com' },
    { name: 'csrftoken', value: IG_CSRFTOKEN, domain: '.instagram.com' }
  );
  return true;
}
app.get('/', (req, res) => res.json({ status: 'ok', service: 'ig-carousel-fallback', dmMonitor: IG_SESSIONID ? 'enabled' : 'disabled', processedCount: processedMessageIds.size }));
app.post('/fetch', async (req, res) => {
  const { url, secret } = req.body || {};
  if (API_SECRET && secret !== API_SECRET) return res.status(403).json({ status: 'error', message: 'forbidden' });
  if (!url || !url.includes('instagram.com/')) return res.status(400).json({ status: 'error', message: 'invalid url' });
  try {
    const items = await fetchViaSaveclip(url);
    if (items.length === 0) return res.json({ status: 'error', message: 'no media found', items: [] });
    return res.json({ status: 'ok', items });
  } catch (err) {
    console.error('[fallback] error:', err.message);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});
async function fetchViaSaveclip(url) {
  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto('https://saveclip.app/', { waitUntil: 'networkidle2', timeout: 45000 });
    try { await page.waitForSelector('input[type="text"], input[name="url"], #url', { timeout: 10000 }); } catch (e) {}
    const hasInput = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      return !!inputs.find(i => i.type === 'text' || i.type === 'url' || (i.placeholder || '').toLowerCase().includes('instagram'));
    });
    if (!hasInput) throw new Error('url input not found');
    await page.evaluate((u) => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const inp = inputs.find(i => i.type === 'text' || i.type === 'url' || (i.placeholder || '').toLowerCase().includes('instagram'));
      if (inp) { inp.focus(); inp.value = u; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true })); }
    }, url);
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const dl = btns.find(b => /download/i.test(b.textContent || ''));
      if (dl) dl.click();
    });
    await page.waitForFunction(() => document.querySelectorAll('a[href*="dl.snapcdn.app"], a[href*=".mp4"], a[href*=".jpg"]').length > 0, { timeout: 60000 }).catch(() => {});
    const items = await page.evaluate(() => {
      const out = []; const seen = new Set();
      document.querySelectorAll('a[href*="dl.snapcdn.app"]').forEach(a => {
        if (seen.has(a.href)) return; seen.add(a.href);
        const txt = (a.textContent || '').toLowerCase();
        const type = txt.includes('video') ? 'video' : (txt.includes('image') || txt.includes('photo') ? 'photo' : 'unknown');
        out.push({ type, url: a.href, label: (a.textContent || '').trim().slice(0, 40) });
      });
      return out;
    });
    await page.close(); page = null;
    return items;
  } catch (err) { try { if (page) await page.close(); } catch (e) {} throw err; }
}
async function notifyN8n(url, msgId) {
  const webhookUrl = 'https://n8n-production-1542.up.railway.app/webhook/microservice-url';
  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, msgId }),
    });
    console.log(`[dm] notified n8n for ${url}: HTTP ${resp.status}`);
    return resp.ok;
  } catch (e) {
    console.log(`[dm] failed to notify n8n: ${e.message}`);
    return false;
  }
}
async function checkDMs() {
  if (!IG_SESSIONID) return;
  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15');
    await page.setViewport({ width: 390, height: 844, isMobile: true });
    await setIgCookies(page);
    await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 5000));
    const shares = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('a[href*="instagram.com/p/"], a[href*="instagram.com/reel/"]').forEach(a => {
        const m = a.href.match(/instagram\.com\/(p|reel)\/([A-Za-z0-9_-]+)/);
        if (m) out.push({ url: `https://www.instagram.com/${m[1]}/${m[2]}/`, msgId: a.href });
      });
      return out;
    });
    for (const share of shares) {
      if (processedMessageIds.has(share.msgId)) continue;
      processedMessageIds.add(share.msgId);
      console.log(`[dm] new share: ${share.url}`);
      await notifyN8n(share.url, share.msgId);
    }
    await page.close(); page = null;
  } catch (err) { try { if (page) await page.close(); } catch (e) {} }
}
function scheduleDMCheck() {
  if (!IG_SESSIONID) return;
  const delay = DM_CHECK_MIN_MS + Math.random() * (DM_CHECK_MAX_MS - DM_CHECK_MIN_MS);
  setTimeout(async () => { await checkDMs(); scheduleDMCheck(); }, delay);
}
app.listen(PORT, () => { console.log(`[fallback] listening on ${PORT}`); scheduleDMCheck(); });
process.on('SIGTERM', async () => { try { if (browser) await browser.close(); } catch (e) {} process.exit(0); });
