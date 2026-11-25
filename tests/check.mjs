// Browser check for the portfolio page. Runs in GitHub Actions (see .github/workflows/check.yml).
// Serves the repo root, loads index.html in headless Chromium and fails on any broken promise.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = process.cwd();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = await readFile(join(root, path === '/' ? 'index.html' : path));
    res.writeHead(200, { 'content-type': types[extname(path)] || 'text/html' }); res.end(body);
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const url = `http://127.0.0.1:${server.address().port}/`;
await mkdir('shots', { recursive: true });

const MODELS = ['atom', 'neuron', 'cad', 'chess'];
const GL = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failed++; };

// Share of pixels in a PNG that differ from its corner pixel (0..1).
async function inked(page, png) {
  return page.evaluate(async b64 => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    // Background = the most common colour, so a model touching a corner cannot skew it.
    const hist = new Map(); for (let i = 0; i < d.length; i += 4) { const k = d[i] >> 3 << 10 | d[i + 1] >> 3 << 5 | d[i + 2] >> 3; hist.set(k, (hist.get(k) || 0) + 1); }
    const top = [...hist].sort((x, y) => y[1] - x[1])[0][0], r = (top >> 10 & 31) << 3, gg = (top >> 5 & 31) << 3, b = (top & 31) << 3;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - r) + Math.abs(d[i + 1] - gg) + Math.abs(d[i + 2] - b) > 40) n++;
    return n / (d.length / 4);
  }, png.toString('base64'));
}

function watch(page) {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });
  return errors;
}

// 1. Desktop: links, lazy creation, every model renders, drag does not open the link.
{
  const browser = await chromium.launch({ args: GL });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = watch(page);
  await page.goto(url, { waitUntil: 'networkidle' });

  const hrefs = await page.$$eval('a[href]', as => as.map(a => a.href));
  ok(!hrefs.some(h => /github\.com\/Fs1lyric\/(calendio|flowday|tradedesk)/i.test(h)), 'no links to private repos (calendio, flowday, tradedesk)');
  ok(hrefs.some(h => /github\.com\/Fs1lyric\/tokenmeter/.test(h)), 'tokenmeter is still linked');

  for (const m of MODELS) ok(await page.$(`canvas.pgl[data-model="${m}"]`), `${m}: canvas present`);
  const early = await page.$$eval('canvas.pgl[data-gl]', cs => cs.map(c => c.dataset.model));
  ok(early.length === 0, `project models are not built at load (built: ${early.join(',') || 'none'})`);

  for (const m of MODELS) {
    const el = page.locator(`canvas.pgl[data-model="${m}"]`);
    await el.scrollIntoViewIfNeeded();
    const built = await page.waitForFunction(m => document.querySelector(`canvas.pgl[data-model="${m}"]`)?.dataset.gl === 'on', m, { timeout: 15000 }).then(() => true, () => false);
    ok(built, `${m}: WebGL stage built once scrolled into view`);
    await page.waitForTimeout(2500);
    const png = await el.screenshot({ path: `shots/${m}.png` });
    const share = await inked(page, png);
    ok(share > 0.03, `${m}: renders a model (${(share * 100).toFixed(1)}% inked)`);
  }
  await page.locator('#work').screenshot({ path: 'shots/work-desktop.png' });

  const atom = page.locator('canvas.pgl[data-model="atom"]');
  await atom.scrollIntoViewIfNeeded();
  const box = await atom.boundingBox();
  let popped = false; ctx.on('page', () => popped = true);
  await page.mouse.move(box.x + box.width * .3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .7, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  ok(!popped && page.url() === url, 'dragging a model does not follow the row link');

  ok(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
}

// 2. Reduced motion: models still render, as a still frame.
{
  const browser = await chromium.launch({ args: GL });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const errors = watch(page);
  await page.goto(url, { waitUntil: 'networkidle' });
  for (const m of MODELS) {
    const el = page.locator(`canvas.pgl[data-model="${m}"]`);
    await el.scrollIntoViewIfNeeded();
    await page.waitForTimeout(2500);
    const a = await el.screenshot();
    await page.waitForTimeout(1200);
    const b = await el.screenshot({ path: `shots/${m}-still.png` });
    ok(await inked(page, b) > 0.03, `${m}: renders under reduced motion`);
    ok(a.equals(b), `${m}: holds still under reduced motion`);
  }
  ok(errors.length === 0, `reduced motion: no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
}

// 3. Phone: no sideways scroll, models sit under the text.
{
  const browser = await chromium.launch({ args: GL });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = watch(page);
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.locator('canvas.pgl[data-model="atom"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(2500);
  await page.locator('#work').screenshot({ path: 'shots/work-phone.png' });
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  ok(wide <= 0, `phone: no horizontal overflow (${wide}px)`);
  ok(errors.length === 0, `phone: no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
}

// 4. No WebGL: canvases drop out cleanly, page still works.
{
  const browser = await chromium.launch({ args: ['--disable-webgl', '--disable-3d-apis'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = watch(page);
  await page.goto(url, { waitUntil: 'networkidle' });
  for (const m of MODELS) { await page.locator(`canvas.pgl[data-model="${m}"]`).scrollIntoViewIfNeeded().catch(() => {}); await page.waitForTimeout(700); }
  await page.waitForTimeout(800);
  ok(await page.$$eval('canvas.pgl', cs => cs.length) === 0, 'no WebGL: project canvases removed');
  await page.locator('#work').screenshot({ path: 'shots/work-nogl.png' });
  // three.js itself logs why it could not create a context; that is expected here, anything else is not.
  const real = errors.filter(e => !/THREE\.WebGLRenderer: .*WebGL context/.test(e));
  ok(real.length === 0, `no WebGL: no page errors${real.length ? ': ' + real.join(' | ') : ''}`);
  await browser.close();
}

server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
