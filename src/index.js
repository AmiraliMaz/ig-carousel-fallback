const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || '';
let browser = null;
async function getBrowser() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--window-size=1280,800'] });
  }
  return browser;
}
app.get('/', (req, res) => res.json({ status: 'ok', service: 'ig-carousel-fallback' }));
app.post('/fetch', async (req, res) => {
  const { url, secret } = req.body || {};
  if (API_SECRET && secret !== API_SECRET) return res.status(403).json({ status: 'error', message: 'forbidden' });
  if (!url || !url.includes('instagram.com/')) return res.status(400).json({ status: 'error', message: 'invalid url' });
  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto('https://saveclip.app/', { waitUntil: 'networkidle2', timeout: 45000 });
    try { await page.waitForSelector('input[type="text"], input[name="url"], #url', { timeout: 10000 }); } catch (e) {}
    const hasInput = await page.evaluate(() => { const inputs = Array.from(document.querySelectorAll('input')); return !!inputs.find(i => i.type === 'text' || i.type === 'url' || (i.placeholder || '').toLowerCase().includes('instagram')); });
    if (!hasInput) throw new Error('url input not found');
    await page.evaluate((u) => { const inputs = Array.from(document.querySelectorAll('input')); const inp = inputs.find(i => i.type === 'text' || i.type === 'url' || (i.placeholder || '').toLowerCase().includes('instagram')); if (inp) { inp.focus(); inp.value = u; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true })); } }, url);
    await page.evaluate(() => { const btns = Array.from(document.querySelectorAll('button')); const dl = btns.find(b => /download/i.test(b.textContent || '')); if (dl) dl.click(); });
    await page.waitForFunction(() => document.querySelectorAll('a[href*="dl.snapcdn.app"], a[href*=".mp4"], a[href*=".jpg"]').length > 0, { timeout: 60000 }).catch(() => {});
    const items = await page.evaluate(() => { const out = []; const seen = new Set(); document.querySelectorAll('a[href*="dl.snapcdn.app"]').forEach(a => { const href = a.href; if (seen.has(href)) return; seen.add(href); const txt = (a.textContent || '').toLowerCase(); const type = txt.includes('video') ? 'video' : (txt.includes('image') || txt.includes('photo') ? 'photo' : 'unknown'); out.push({ type, url: href, label: (a.textContent || '').trim().slice(0, 40) }); }); return out; });
    await page.close(); page = null;
    if (items.length === 0) return res.json({ status: 'error', message: 'no media found', items: [] });
    return res.json({ status: 'ok', items });
  } catch (err) {
    try { if (page) await page.close(); } catch (e) {}
    return res.status(500).json({ status: 'error', message: err.message });
  }
});
app.listen(PORT, () => console.log('listening on ' + PORT));
process.on('SIGTERM', async () => { try { if (browser) await browser.close(); } catch (e) {} process.exit(0); });
