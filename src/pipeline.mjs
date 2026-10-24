import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, today, readJSON, writeJSON, fetchText, sleep, esc, money, uniq } from './lib.mjs';
import { detectCategory, extractSpec, toSnapshotProduct, CATS, isAccessory } from './normalize.mjs';

const DATA = path.join(ROOT, 'data');
const OUT = path.join(ROOT, 'out');
const SNAP = path.join(DATA, 'snapshots');
const date = today();
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

const RECALL_KEYWORDS = [
  [/dehumidif/i, '除湿机'],
  [/humidif/i, '加湿器'],
  [/air\s*purif|air\s*cleaner/i, '空气净化器'],
  [/portable\s*air\s*conditioner|portable\s*a\/c|portable\s*ac\b/i, '移动空调'],
  [/window\s*air\s*conditioner|window\s*a\/c/i, '窗式空调'],
  [/space\s*heater|electric\s*heater|ceramic\s*heater|tower\s*heaters?|\bheaters?\b/i, '取暖器'],
  [/tower\s*fan|air\s*circulator|box\s*fan/i, '风扇'],
];

const RECALL_EXCLUDE = /water\s*heater|pool\s*heater|tankless|kerosene|sauna|patio|propane|gas\s*heater|fryer|grill|heat\s*pump|furnace|camping|side-by-side|utv|atv|vehicle|golf|boat|\brv\b|shower|cabinet/i;

async function storeCurrency(domain) {
  try {
    const html = await fetchText(`https://${domain}/`, { timeout: 30000 });
    const m = html.match(/Shopify\.currency\s*=\s*(\{[^}]+\})/);
    return m ? JSON.parse(m[1]).active : null;
  } catch {
    return null;
  }
}

const decodeEnt = (s = '') => String(s)
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

async function fetchWoo(store) {
  const items = [];
  for (let page = 1; page <= 4; page++) {
    const txt = await fetchText(`https://${store.domain}/wp-json/wc/store/products?per_page=100&page=${page}`, { timeout: 45000 });
    const list = JSON.parse(txt);
    if (!Array.isArray(list) || !list.length) break;
    for (const p of list) {
      const minor = Number(p.prices?.currency_minor_unit ?? 2);
      const div = 10 ** minor;
      const price = Number(p.prices?.price ?? 0) / div;
      const regular = Number(p.prices?.regular_price ?? 0) / div;
      const slugPart = String(p.permalink || '').split('/product/')[1] || String(p.id);
      items.push({
        handle: slugPart.replace(/\/$/, ''),
        title: decodeEnt(p.name || ''),
        body_html: `${p.short_description || ''} ${p.description || ''}`,
        product_type: p.categories?.[0]?.name || '',
        tags: [],
        vendor: store.brand,
        created_at: '', updated_at: '',
        permalink: p.permalink,
        variants: [{
          price: price > 0 ? String(price) : '',
          compare_at_price: regular > price ? String(regular) : '',
          available: !!p.is_in_stock,
          sku: p.sku || '',
          barcode: '',
        }],
      });
    }
    if (list.length < 100) break;
    await sleep(600);
  }
  return items;
}

async function fetchStore(store) {
  if (store.platform === 'woo') return fetchWoo(store);
  const items = [];
  for (let page = 1; page <= 4; page++) {
    const txt = await fetchText(`https://${store.domain}/products.json?limit=250&page=${page}`);
    const products = JSON.parse(txt).products ?? [];
    items.push(...products);
    if (products.length < 250) break;
    await sleep(1500);
  }
  return items;
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function flatCatalog(snapshots) {
  const rows = [];
  for (const [domain, products] of Object.entries(snapshots)) {
    for (const p of products) {
      if (isAccessory(p.title || '')) continue;
      rows.push({ domain, ...p });
    }
  }
  return rows;
}

function diffCatalog(prev, cur) {
  const out = { priceDrop: [], priceUp: [], oos: [], back: [], fresh: [], dropped: [] };
  if (!prev) return out;
  for (const [domain, products] of Object.entries(cur)) {
    const before = prev[domain] ?? [];
    const map = new Map(before.map((p) => [p.handle, p]));
    for (const p of products) {
      const b = map.get(p.handle);
      if (!b) { out.fresh.push({ domain, ...p }); continue; }
      map.delete(p.handle);
      if (b.price && p.price) {
        const delta = (p.price - b.price) / b.price;
        if (delta <= -0.05) out.priceDrop.push({ domain, ...p, oldPrice: b.price, delta });
        if (delta >= 0.05) out.priceUp.push({ domain, ...p, oldPrice: b.price, delta });
      }
      if (b.available && !p.available) out.oos.push({ domain, ...p });
      if (!b.available && p.available) out.back.push({ domain, ...p });
    }
    for (const b of map.values()) out.dropped.push({ domain, ...b });
  }
  out.priceDrop.sort((a, b) => a.delta - b.delta);
  out.priceUp.sort((a, b) => b.delta - a.delta);
  return out;
}

async function loadRecalls(stores = []) {
  const bulk = JSON.parse(await fetchText('https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart=2022-01-01', { timeout: 90000 }));
  const list = [...bulk];
  for (const brand of uniq(stores.map((s) => s.brand))) {
    try {
      const txt = await fetchText(`https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallTitle=${encodeURIComponent(brand)}`, { timeout: 30000 });
      list.push(...JSON.parse(txt));
      await sleep(900);
    } catch (err) {
      log(`recall brand ${brand} failed: ${err.message}`);
    }
  }
  const all = new Map();
  for (const r of list) {
    const products = r.Products ?? [];
    const hay = `${r.Title || ''} ${products.map((p) => p.Name).join(' ')}`;
    const cat = RECALL_KEYWORDS.find(([re]) => re.test(hay))?.[1];
    if (!cat || RECALL_EXCLUDE.test(hay) || all.has(r.RecallNumber)) continue;
    all.set(r.RecallNumber, {
      number: r.RecallNumber,
      cat,
      date: (r.RecallDate || '').slice(0, 10),
      title: r.Title || '',
      url: r.URL || '',
      units: products[0]?.NumberOfUnits || '',
      hazard: (r.Hazards ?? []).map((h) => h.Name).join(' ') || '',
      model: uniq(products.map((p) => p.Model)).slice(0, 12),
      names: uniq(products.map((p) => p.Name)).slice(0, 6),
      upcs: uniq((r.ProductUPCs ?? []).map((u) => u.UPC)).slice(0, 30),
      brands: uniq([
        ...(r.Manufacturers ?? []).map((m) => m.Name),
        ...(r.Importers ?? []).map((m) => m.Name),
      ]),
      desc: (r.Description || '').slice(0, 500),
    });
  }
  log(`recalls ${all.size} (from ${list.length} since 2022-01-01)`);
  return [...all.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
}

function matchRecalls(recalls, catalog, stores) {
  const brandKeys = new Map();
  for (const s of stores) brandKeys.set(s.brand.toLowerCase().replace(/[^a-z0-9]/g, ''), s.brand);
  for (const p of catalog) {
    const v = String(p.vendor || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (v.length > 4) brandKeys.set(v, p.vendor);
  }
  const exactSkus = new Map();
  for (const p of catalog) {
    for (const code of [p.sku, p.barcode]) {
      if (code && String(code).trim().length >= 8) exactSkus.set(String(code).trim().toUpperCase(), p);
    }
  }
  for (const r of recalls) {
    const hay = `${r.title} ${r.brands.join(' ')} ${r.names.join(' ')}`.toLowerCase().replace(/[^a-z0-9]/g, '');
    r.matchedBrands = [];
    for (const [key, label] of brandKeys) {
      if (key.length >= 5 && hay.includes(key)) r.matchedBrands.push(label);
    }
    r.matchedBrands = uniq(r.matchedBrands).filter((b, _, arr) => !arr.some((o) => o !== b && o.toLowerCase().includes(b.toLowerCase())));
    r.matchedSku = null;
    for (const upc of r.upcs) {
      const hit = exactSkus.get(String(upc).trim().toUpperCase());
      if (hit) { r.matchedSku = { title: hit.title, domain: hit.domain }; break; }
    }
  }
  return recalls;
}

/* ---------------- HTML ---------------- */

const CSS = `
:root{--bg:#0b0e13;--panel:#121821;--line:#2a3442;--rule:#3c4757;--text:#f1f4f8;--muted:#a2adbb;--accent:#e7b25c;--accent-ink:#1a1206;--danger:#f0756c;--warn:#e7b25c;--good:#5ed3a2;}
html[data-theme="light"]{--bg:#f5f2eb;--panel:#fffdf8;--line:#d8d1c3;--rule:#b4ac9c;--text:#17191e;--muted:#5f6673;--accent:#96590a;--accent-ink:#fffdf8;--danger:#a62a20;--warn:#8a540a;--good:#0b6b4e;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:18px/1.68 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1040px;margin:0 auto;padding:28px 22px 80px}
header{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:30px}
.brand{font-weight:700;letter-spacing:.09em;font-size:16px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.brand span{color:var(--accent)}
button.toggle{background:transparent;border:1px solid var(--line);color:var(--muted);padding:7px 13px;border-radius:2px;font-size:13px;cursor:pointer;letter-spacing:.05em}
button.toggle:hover{color:var(--text);border-color:var(--text)}
h1,h2,h3{font-family:"Iowan Old Style","Songti SC","Noto Serif SC",Georgia,serif;font-weight:600}
h1{font-size:40px;line-height:1.22;margin:0 0 12px;letter-spacing:-.01em}
h2{font-size:24px;margin:46px 0 14px;padding-bottom:10px;border-bottom:1px solid var(--line)}
h3{font-size:20px;margin:24px 0 8px}
p{margin:0 0 14px}
.sub{color:var(--muted);font-size:16px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:22px 0}
@media(max-width:760px){.grid{grid-template-columns:repeat(2,1fr)}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:2px;padding:16px}
.kpi{font:600 34px/1.1 "Iowan Old Style","Songti SC",Georgia,serif;color:var(--text);font-variant-numeric:tabular-nums}
.kpi-label{color:var(--muted);font-size:14px;margin-top:6px}
table{width:100%;border-collapse:collapse;margin:16px 0;font-size:15.5px}
th,td{text-align:left;padding:11px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:11.5px;letter-spacing:.12em;text-transform:uppercase;border-bottom:1px solid var(--rule);white-space:nowrap}
td.num{white-space:nowrap;font-variant-numeric:tabular-nums;font-feature-settings:"tnum"}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.tag{display:inline-block;font-size:12px;padding:2px 8px;border-radius:2px;border:1px solid var(--line);color:var(--muted);margin:2px 4px 2px 0;white-space:nowrap;letter-spacing:.02em}
.tag.warn{color:var(--warn);border-color:var(--warn)}
.tag.danger{color:var(--danger);border-color:var(--danger)}
.tag.good{color:var(--good);border-color:var(--good)}
.note{background:var(--panel);border-left:3px solid var(--accent);padding:15px 18px;border-radius:0;color:var(--text);font-size:16px;margin:18px 0}
.note strong{color:var(--accent)}
.cta{display:inline-block;background:var(--accent);color:var(--accent-ink);font-weight:700;padding:12px 22px;border-radius:2px;margin-top:8px;letter-spacing:.02em}
.cta.ghost{background:transparent;border:1px solid var(--line);color:var(--text);margin-left:8px}
footer{margin-top:64px;color:var(--muted);font-size:13.5px;border-top:1px solid var(--line);padding-top:18px;line-height:1.7}
nav.crumbs{color:var(--muted);font-size:14px;margin:-8px 0 18px}
.spark{display:block;margin:6px 0 2px}
.facts{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:16px 0}
@media(max-width:760px){.facts{grid-template-columns:1fr 1fr}}
.facts div{background:var(--panel);border:1px solid var(--line);border-radius:2px;padding:12px 14px}
.facts b{display:block;font-size:24px;color:var(--text);line-height:1.3}
.facts span{color:var(--muted);font-size:14px}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:14px 0}
@media(max-width:760px){.cards{grid-template-columns:1fr}}
.cards .card{font-size:16px}
.cards .card a{font-weight:600;display:block;margin-bottom:4px}

/* weekly brief */
.brief-cover{border-top:2px solid var(--text);padding-top:20px}
.cover-top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;font:600 11.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.cover-top .sample{border:1px solid var(--accent);color:var(--accent);padding:3px 9px;letter-spacing:.16em}
.brief-kicker{margin:36px 0 14px;font:600 12.5px/1.5 ui-monospace,Menlo,monospace;letter-spacing:.16em;text-transform:uppercase;color:var(--accent)}
.brief-cover h1{font-size:clamp(34px,5.1vw,58px);line-height:1.14;margin:0 0 20px;max-width:17em;letter-spacing:-.015em}
.brief-deck{font-size:20px;line-height:1.75;color:var(--muted);max-width:42em;margin:0}
.brief-deck strong{color:var(--text);font-weight:600}
.brief-byline{display:flex;gap:10px 26px;flex-wrap:wrap;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:13px 0;margin:30px 0 0;font-size:13px;color:var(--muted);letter-spacing:.02em}
.kpi-strip{display:grid;grid-template-columns:repeat(4,1fr);border-bottom:2px solid var(--text);margin:0 0 52px}
.kpi-strip>div{padding:20px 16px 18px;border-left:1px solid var(--line)}
.kpi-strip>div:first-child{border-left:0;padding-left:0}
.kpi-strip b{display:block;font:600 40px/1 "Iowan Old Style","Songti SC",Georgia,serif;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.kpi-strip b em{font-style:normal;font-size:17px;color:var(--accent);margin-left:3px;letter-spacing:0}
.kpi-strip span{display:block;margin-top:9px;font-size:13px;line-height:1.5;color:var(--muted)}
.section-head{display:grid;grid-template-columns:58px 1fr;gap:18px;align-items:start;margin:58px 0 18px;padding-top:16px;border-top:2px solid var(--text)}
.section-head .no{font:600 12px/1 ui-monospace,Menlo,monospace;letter-spacing:.14em;color:var(--accent);padding-top:8px}
.section-head h2{font-size:30px;line-height:1.25;margin:0;padding:0;border:0}
.section-head p{margin:9px 0 0;color:var(--muted);font-size:16px;max-width:46em}
.conclusions{border-top:1px solid var(--line);margin-top:8px}
.conclusion{display:grid;grid-template-columns:52px 1fr;gap:16px;padding:24px 0;border-bottom:1px solid var(--line)}
.conclusion .no{font:600 14px/1.5 ui-monospace,Menlo,monospace;color:var(--accent)}
.conclusion h3{font-size:22px;line-height:1.42;margin:0 0 9px}
.conclusion p{margin:0 0 10px;font-size:17px}
.conclusion .act{font-size:15px;line-height:1.65;color:var(--muted);border-left:2px solid var(--accent);padding-left:11px}
.conclusion .act b{color:var(--accent);font-weight:600;letter-spacing:.06em;font-size:12px;margin-right:6px}
.chart{background:var(--panel);border:1px solid var(--line);padding:18px 18px 14px;margin:20px 0}
.chart-head{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px}
.chart-title{font-size:14px;font-weight:600;letter-spacing:.02em}
.chart-sub{font-size:12.5px;color:var(--muted)}
.chart-scroll{overflow-x:auto}
.chart-legend{display:flex;gap:18px;flex-wrap:wrap;margin:6px 0 12px;font-size:12.5px;color:var(--muted)}
.chart-legend i{display:inline-block;width:10px;height:10px;margin-right:6px;vertical-align:1px}
.bars{margin:2px 0}
.bar-row{display:grid;grid-template-columns:122px 1fr 78px;gap:12px;align-items:center;padding:7px 0;border-top:1px solid var(--line)}
.bar-row:first-child{border-top:0}
.bar-label{font-size:13px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar-track{display:flex;height:19px;background:var(--line);overflow:hidden}
.bar-track i{display:block;height:100%;background:var(--accent)}
.bar-track i.bad{background:var(--danger)}
.bar-track i.good{background:var(--rule);opacity:.55}
.bar-val{font:600 12.5px/1.4 ui-monospace,Menlo,monospace;text-align:right;color:var(--text);white-space:nowrap}
.ratio{margin:2px 0}
.ratio-axis,.ratio-row{display:grid;grid-template-columns:248px 1fr 48px;gap:12px;align-items:center}
.ratio-axis{color:var(--muted);font:11px ui-monospace,Menlo,monospace;padding-bottom:5px}
.ratio-axis .ticks{position:relative;display:block;height:14px}
.ratio-axis .ticks span{position:absolute;transform:translateX(-50%)}
.ratio-row{padding:7px 0;border-top:1px solid var(--line)}
.ratio-label{font-size:12.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ratio-track{position:relative;height:18px}
.ratio-track::before{content:"";position:absolute;left:0;right:0;top:50%;height:1px;background:var(--line)}
.ratio-dot{position:absolute;top:50%;width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:50%;background:var(--accent)}
.ratio-med{position:absolute;top:0;bottom:0;border-left:1px dashed var(--accent);opacity:.65}
.ratio-val{font:600 12.5px ui-monospace,Menlo,monospace;text-align:right;color:var(--text)}
.table-wrap{overflow-x:auto}
.table-wrap table{min-width:620px}
details{margin:14px 0}
details summary{cursor:pointer;color:var(--accent);font-size:14px;padding:8px 0;letter-spacing:.02em}
details summary:hover{text-decoration:underline}
.mobile-cards{display:none}
.brief-end{border-top:2px solid var(--text);margin-top:56px;padding-top:22px}
.brief-end h2{border:0;margin:0 0 8px;padding:0;font-size:26px}
.brief-end .sub{margin-bottom:18px}
.method{display:grid;grid-template-columns:1fr 1fr;gap:0 34px;margin:18px 0}
.method div{padding:12px 0;border-top:1px solid var(--line);font-size:15px;color:var(--muted)}
.method b{display:block;color:var(--text);font-size:13px;letter-spacing:.05em;margin-bottom:3px;font-weight:600}
.sample-note{border:1px solid var(--accent);padding:13px 16px;font-size:14px;color:var(--text);margin:24px 0 0;line-height:1.65}
.sample-note b{color:var(--accent);letter-spacing:.06em;margin-right:6px}
@media(max-width:760px){
  .kpi-strip{grid-template-columns:1fr 1fr}
  .kpi-strip>div:nth-child(3){border-left:0;padding-left:0;border-top:1px solid var(--line)}
  .kpi-strip>div:nth-child(4){border-top:1px solid var(--line)}
  .section-head{grid-template-columns:1fr;gap:4px}
  .section-head .no{padding-top:0}
  .conclusion{grid-template-columns:1fr;gap:4px}
  .method{grid-template-columns:1fr}
  .brief-cover h1{font-size:34px}
  .brief-deck{font-size:18px}
}
@media(max-width:600px){
  body{font-size:17px}
  .wrap{padding:20px 16px 60px}
  h1{font-size:29px}
  h2{font-size:22px}
  table{font-size:14px}
  th,td{padding:8px 6px}
  .kpi-strip b{font-size:32px}
  .brief-cover h1{font-size:31px}
  .brief-kicker{margin-top:26px}
  .section-head h2{font-size:25px}
  .conclusion h3{font-size:20px}
}
@media(max-width:680px){
  .hit-table{display:none}
  .mobile-cards{display:block}
  .rcard{padding:14px 0;border-bottom:1px solid var(--line)}
  .rcard .rc-top{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;font-size:12px;color:var(--muted)}
  .rcard .rc-title{display:block;margin:7px 0 4px;font-size:16px;line-height:1.5;color:var(--text)}
  .bar-row{grid-template-columns:1fr auto;gap:3px 10px;padding:9px 0}
  .bar-track{grid-column:1/-1;order:3;height:16px}
  .ratio-axis{display:none}
  .ratio-row{grid-template-columns:1fr auto;gap:4px 10px;padding:9px 0}
  .ratio-track{grid-column:1/-1;order:3;height:16px}
  .ratio-label{white-space:normal}
}
@media print{
  html[data-theme],html[data-theme="dark"],html[data-theme="light"]{--bg:#fff;--panel:#fff;--text:#111827;--muted:#4b5563;--line:#d1d5db;--rule:#9ca3af;--accent:#8a4b00;--accent-ink:#fff;--danger:#a3261c;--warn:#8a540b;--good:#065f46}
  body{background:#fff;color:#111827;font-size:10.5pt}
  .wrap{max-width:none;padding:0}
  header,nav.crumbs,button.toggle{display:none}
  .brief-cover h1{font-size:30pt}
  .brief-deck{font-size:11pt}
  .kpi-strip b{font-size:22pt}
  .section-head h2{font-size:18pt}
  .chart{break-inside:avoid;border-color:#d1d5db}
  .chart svg{min-width:0}
  tr,.conclusion,.sample-note{break-inside:avoid}
  details>summary{display:none}
  a{color:inherit;text-decoration:none}
  footer{margin-top:24px}
  @page{size:A4;margin:14mm}
}
`;

let SITE = { name: 'Climate Radar', baseUrl: '', paddleCheckoutUrl: '', priceMonthly: 29, priceYearly: 299, earlyNote: '早鸟价，限前 20 名' };

function brandMark() {
  const [a, b] = String(SITE.name || 'Climate Radar').toUpperCase().split(' ');
  return `${esc(a || 'CLIMATE')} <span>${esc(b || 'RADAR')}</span>`;
}

function pageHead(title, desc = '') {
  const meta = SITE.baseUrl ? `<meta name="description" content="${esc(desc || title)}"><link rel="canonical" href="${esc(SITE.baseUrl)}">` : '';
  return `<!doctype html><html lang="zh-CN" data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${meta}<style>${CSS}</style></head><body><div class="wrap">
<header><a class="brand" href="${SITE.baseUrl ? esc(SITE.baseUrl) : '/'}" style="color:inherit;text-decoration:none">${brandMark()}</a><button class="toggle" onclick="(function(){const h=document.documentElement;const n=h.dataset.theme==='dark'?'light':'dark';h.dataset.theme=n;localStorage.setItem('theme',n)})()">切换明暗</button></header>`;
}

function pageFoot(pre = '') {
  const base = SITE.baseUrl || pre;
  const op = [SITE.legalName, SITE.address].filter(Boolean).join('｜');
  return `<footer>数据来源：各品牌官网公开商品页、美国消费品安全委员会（CPSC）公开召回数据库。仅覆盖公开可访问的独立站商品，不含亚马逊等平台内部数据。本报告不构成法律或合规意见。
${SITE.paddleCheckoutUrl ? '' : '<div style="margin-top:8px"><strong>样刊阶段：</strong>报告免费公开，尚未开放收款订阅。</div>'}
${op ? `<div style="margin-top:10px">运营者：${esc(op)}${SITE.contactEmail ? `｜<a href="mailto:${esc(SITE.contactEmail)}">${esc(SITE.contactEmail)}</a>` : ''}</div>` : ''}
<div style="margin-top:10px"><a href="${esc(base)}terms.html">服务条款</a> · <a href="${esc(base)}privacy.html">隐私政策</a> · <a href="${esc(base)}refund.html">退款政策</a> · <a href="${esc(base)}about.html">About (EN)</a></div></footer></div>
<script>try{const t=localStorage.getItem('theme');if(t)document.documentElement.dataset.theme=t}catch(e){}
addEventListener('beforeprint',function(){document.querySelectorAll('details').forEach(function(d){d.open=true})});</script></body></html>`;
}

function catLabel(id) { return CATS.find((c) => c.id === id)?.label ?? id; }

const realPrice = (p) => Boolean(p.price) && !p.spec?.preorder && !p.spec?.discontinued;

const isUnstated = (p) => (p.spec.flags ?? []).some((f) => f.code.endsWith('unstated') || f.code === 'sacc-gap' || f.code === 'eu-liters');

function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  let cut = t.slice(0, n - 1);
  const space = cut.lastIndexOf(' ');
  if (space > n * 0.6) cut = cut.slice(0, space);
  return `${cut.trim()}…`;
}

function recallTitle(text = '') {
  return String(text)
    .replace(/;\s*Sold\b[\s\S]*$/i, '')
    .replace(/[;\s]+$/, '')
    .trim();
}

function modelCode(title = '') {
  const m = String(title).match(/\b([A-Z]{2,4}-\d{2,4}[A-Z0-9-]*)\b/);
  return m ? m[1] : null;
}

function flagShort(flag) {
  if (!flag) return '不可比';
  if (flag.code.includes('unstated')) return '未注明标准';
  if (flag.code === 'eu-liters') return '按升标，未折 DOE';
  if (flag.code === 'sacc-gap') return '缺少 SACC';
  return flag.text;
}

function fmtUnits(raw) {
  const m = String(raw || '').match(/([\d,.]+)\s*(million|billion|thousand)?/i);
  if (!m) return '—';
  let n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n) || !n) return '—';
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'million') n *= 1e6;
  if (unit === 'billion') n *= 1e9;
  if (unit === 'thousand') n *= 1e3;
  if (n >= 1e8) return `约 ${(n / 1e8).toFixed(1).replace(/\.0$/, '')} 亿`;
  if (n >= 1e4) return `约 ${(n / 1e4).toFixed(1).replace(/\.0$/, '')} 万`;
  return `约 ${n.toLocaleString('en-US')}`;
}

function hazardLabel(text = '') {
  const s = String(text).toLowerCase();
  const out = [];
  if (/fire|overheat|ignit|melt/.test(s)) out.push('火灾');
  if (/burn/.test(s)) out.push('烧伤');
  if (/shock|electric/.test(s)) out.push('触电');
  if (/mold/.test(s)) out.push('霉菌');
  if (/death|serious injury|injur|entrap|suffocat|strang|chok/.test(s)) out.push('伤害');
  if (/laceration|cut/.test(s)) out.push('割伤');
  if (/tip|fall/.test(s)) out.push('倾倒');
  if (/leak|water/.test(s)) out.push('漏水');
  return out.length ? out.slice(0, 2).join(' · ') : '其他';
}

function recallRank(r) {
  const year = Number(String(r.date).slice(0, 4)) || 0;
  const hit = (r.matchedBrands?.length || r.matchedSku) ? 100 : 0;
  return hit + (year >= 2025 ? 20 : year >= 2023 ? 10 : 0) + (r.cat === '取暖器' ? 2 : 0);
}

function simpleBars(rows) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return `<div class="bars" role="img" aria-label="按数量排序的条形图">${rows.map((r) => `<div class="bar-row">
<span class="bar-label">${esc(r.label)}</span>
<div class="bar-track"><i style="width:${(r.value / max) * 100}%;opacity:${r.opacity ?? 1}"></i></div>
<span class="bar-val">${esc(r.text ?? r.value)}</span>
</div>`).join('')}</div>`;
}

function splitBars(rows) {
  return `<div class="bars" role="img" aria-label="未注明标准的型号占比">${rows.map((r) => {
    const pct = Math.round((r.bad / Math.max(1, r.total)) * 100);
    return `<div class="bar-row">
<span class="bar-label">${esc(r.label)}</span>
<div class="bar-track"><i class="good" style="width:${100 - pct}%"></i><i class="bad" style="width:${pct}%"></i></div>
<span class="bar-val">${r.bad} / ${r.total} · ${pct}%</span>
</div>`;
  }).join('')}</div>`;
}

function ratioBars(pairs, medianPct) {
  const rows = [...pairs].sort((a, b) => (a.spec.btuSacc / a.spec.btuAshrae) - (b.spec.btuSacc / b.spec.btuAshrae));
  const med = medianPct == null ? 75 : medianPct;
  const x = (v) => ((Math.min(100, Math.max(50, v)) - 50) / 50) * 100;
  const medLeft = x(med);
  const ticks = [50, 60, 70, 80, 90, 100];
  return `<div class="ratio" role="img" aria-label="SACC 相对 ASHRAE 的比例">
<div class="ratio-axis"><span></span><span class="ticks">${ticks.map((t) => `<span style="left:${x(t)}%">${t}%</span>`).join('')}</span><span></span></div>
${rows.map((p) => {
    const pct = Math.round((p.spec.btuSacc / p.spec.btuAshrae) * 100);
    const code = modelCode(p.title);
    const label = code
      ? `${clip(code, 16)} · ${p.spec.btuAshrae.toLocaleString()}→${p.spec.btuSacc.toLocaleString()}`
      : `${clip(p.vendor, 16)} · ${p.spec.btuAshrae.toLocaleString()}→${p.spec.btuSacc.toLocaleString()}`;
    return `<div class="ratio-row">
<span class="ratio-label">${esc(label)}</span>
<div class="ratio-track"><i class="ratio-med" style="left:${medLeft}%"></i><i class="ratio-dot" style="left:${x(pct)}%"></i></div>
<span class="ratio-val">${pct}%</span>
</div>`;
  }).join('')}
<div class="chart-sub" style="margin-top:8px">虚线为中位 ${med}%；横轴 50%–100%，圆点为各机型 SACC/ASHRAE。</div>
</div>`;
}

function renderReport(ctx) {
  const { catalog, recalls, stats, prevDate } = ctx;
  const sample = !SITE.paddleCheckoutUrl;
  const deh = catalog.filter((p) => p.cat === 'dehumidifier');
  const dehBad = deh.filter(isUnstated);
  const pac = catalog.filter((p) => p.cat === 'portable-ac');
  const pacBad = pac.filter(isUnstated);
  const humBad = catalog.filter((p) => p.cat === 'humidifier' && isUnstated(p));
  const unstated = catalog.filter(isUnstated);
  const pairs = pac.filter((p) => p.spec.btuAshrae && p.spec.btuSacc);
  const ratioPct = pairs.map((p) => Math.round((p.spec.btuSacc / p.spec.btuAshrae) * 100));
  const ratioMed = ratioPct.length ? median(ratioPct) : null;
  const ratioMin = ratioPct.length ? Math.min(...ratioPct) : null;
  const ratioMax = ratioPct.length ? Math.max(...ratioPct) : null;
  const pairVendors = uniq(pairs.map((p) => p.vendor));
  const pairScope = pairVendors.length === 1 ? `${pairVendors[0]} ${pairs.length} 款` : `${pairVendors.length} 个品牌共 ${pairs.length} 款`;
  const pairNote = pairVendors.length === 1
    ? `本期可比的 ${pairs.length} 款双标机型全部来自 ${pairVendors[0]}。`
    : `本期 ${pairs.length} 款双标机型来自 ${pairVendors.join('、')}。`;

  const hit = recalls.filter((r) => r.matchedBrands.length || r.matchedSku);
  const brandHits = {};
  for (const r of hit) for (const b of r.matchedBrands) brandHits[b] = (brandHits[b] ?? 0) + 1;
  const brandTop = Object.entries(brandHits).sort((a, b) => b[1] - a[1]).slice(0, 2)
    .map(([b, n]) => `${b.replace(/\s*Air$/, '')} ${n}`).join(' · ') || '无';
  const hitSorted = [...hit].sort((a, b) => (a.date < b.date ? 1 : -1));
  const allByDate = [...recalls].sort((a, b) => (a.date < b.date ? 1 : -1));

  const catOrder = ['取暖器', '窗式空调', '空气净化器', '除湿机', '加湿器', '风扇'];
  const catCounts = catOrder
    .map((label) => ({ label, value: recalls.filter((r) => r.cat === label).length }))
    .filter((r) => r.value)
    .sort((a, b) => b.value - a.value);
  const recallBars = catCounts.map((r, i) => ({ ...r, text: `${r.value} 条`, opacity: i === 0 ? 1 : 0.55 }));

  const splitRows = [
    { label: '除湿机', total: deh.length, bad: dehBad.length },
    { label: '移动空调', total: pac.length, bad: pacBad.length },
    { label: '加湿器', total: catalog.filter((p) => p.cat === 'humidifier').length, bad: humBad.length },
  ].filter((r) => r.total && r.bad > 0);

  const specShown = (p) => {
    const s = p.spec;
    if (p.cat === 'portable-ac') {
      return s.btuSacc && s.btuAshrae ? `SACC ${s.btuSacc.toLocaleString()} / ASHRAE ${s.btuAshrae.toLocaleString()}`
        : s.btuSacc ? `SACC ${s.btuSacc.toLocaleString()}`
        : s.btuAshrae ? `ASHRAE ${s.btuAshrae.toLocaleString()}`
        : s.btu ? `${s.btu.toLocaleString()} BTU` : '—';
    }
    if (s.pints) return `${s.pints} pint/天`;
    if (s.liters) return `${s.liters} L/天`;
    if (s.sqft) return `${s.sqft.toLocaleString()} sq ft`;
    return '—';
  };

  const incomparableRow = (p) => {
    const s = p.spec;
    const flag = (s.flags ?? []).find((f) => f.code !== 'ok-sacc' && f.code !== 'ok-doe' && f.code !== 'ok-both');
    return `<tr><td><a href="../model/${esc(modelId(p))}.html">${esc(clip(p.title, 62))}</a><div class="sub">${esc(p.vendor)} ｜ <a href="${esc(p.url)}" target="_blank" rel="noopener">官网</a></div></td><td class="num">${esc(specShown(p))}</td><td class="num">${money(p.price)}</td><td><span class="tag warn" title="${esc(flag?.text ?? '')}">${esc(flagShort(flag))}</span></td></tr>`;
  };

  const pacBadRows = [...pacBad].sort((a, b) => (a.vendor < b.vendor ? -1 : a.vendor > b.vendor ? 1 : b.price - a.price)).map(incomparableRow).join('');
  const dehPick = [];
  const seenVendor = new Set();
  for (const p of [...dehBad].sort((a, b) => (a.vendor < b.vendor ? -1 : 1))) {
    if (seenVendor.has(p.vendor)) continue;
    seenVendor.add(p.vendor);
    dehPick.push(p);
    if (dehPick.length >= 8) break;
  }
  const dehBadRows = dehPick.map(incomparableRow).join('');

  const bandRows = ['dehumidifier', 'portable-ac', 'air-purifier', 'humidifier', 'heater', 'fan'].map((id) => {
    const rows = catalog.filter((p) => p.cat === id && realPrice(p));
    const prices = rows.map((p) => p.price);
    if (!prices.length) return '';
    return `<tr><td>${esc(catLabel(id))}</td><td class="num">${rows.length}</td><td class="num">${money(Math.min(...prices))}</td><td class="num">${money(median(prices))}</td><td class="num">${money(Math.max(...prices))}</td></tr>`;
  }).join('');

  const claims = catalog.filter((p) => realPrice(p) && p.spec.discount >= 0.08);
  const claimRows = [...claims].sort((a, b) => b.spec.discount - a.spec.discount).slice(0, 6).map((p) => {
    const diffPct = Math.round(p.spec.discount * 100);
    return `<tr><td><a href="../model/${esc(modelId(p))}.html">${esc(clip(p.title, 64))}</a><div class="sub">${esc(p.vendor)}</div></td><td class="num">${money(p.price)}</td><td class="num">${money(p.compare)}</td><td class="num"><span class="tag warn">-${diffPct}%</span></td></tr>`;
  }).join('');

  const hitRows = hitSorted.map((r) => `<tr>
<td class="num">${esc(r.date)}</td>
<td>${esc(r.cat)}</td>
<td><span class="tag danger">${esc(r.matchedBrands.join('、') || '型号精确命中')}</span></td>
<td><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(clip(recallTitle(r.title), 120))}</a><div class="sub">CPSC ${esc(r.number)}</div></td>
<td class="num">${esc(fmtUnits(r.units))}</td>
<td><span class="tag">${esc(hazardLabel(r.hazard))}</span></td>
</tr>`).join('');

  const hitCards = hitSorted.map((r) => `<div class="rcard">
<div class="rc-top"><span>${esc(r.date)}</span><span>${esc(r.cat)}</span><span class="tag danger">${esc(r.matchedBrands.join('、') || '型号精确命中')}</span><span class="tag">${esc(hazardLabel(r.hazard))}</span></div>
<a class="rc-title" href="${esc(r.url)}" target="_blank" rel="noopener">${esc(clip(recallTitle(r.title), 120))}</a>
<div class="sub">${esc(fmtUnits(r.units))} · CPSC ${esc(r.number)}</div>
</div>`).join('');

  const allRows = allByDate.map((r) => `<tr>
<td class="num">${esc(r.date)}</td>
<td>${esc(r.cat)}</td>
<td><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(clip(recallTitle(r.title), 120))}</a></td>
<td>${esc(r.matchedBrands.join('、') || r.brands.slice(0, 2).join('、') || '—')}</td>
<td class="num">${esc(fmtUnits(r.units))}</td>
</tr>`).join('');

  const dehPct = deh.length ? Math.round((dehBad.length / deh.length) * 100) : 0;
  const ratioLine = ratioMed == null ? '' : `${pairScope}双标移动空调的 SACC 制冷量中位数仅为 ASHRAE 的 <strong>${ratioMed}%</strong>。`;
  const headline = dehBad.length
    ? `${deh.length} 款除湿机<br>${dehBad.length} 款没有写明测试标准`
    : `${stats.products} 个收录型号的规格、价格与召回基线`;

  const sectionHead = (no, title, stand) => `<div class="section-head"><div class="no">${no}</div><div><h2>${title}</h2><p>${stand}</p></div></div>`;

  return `${pageHead(`美国家居气候电器卖家情报 · 第 ${ctx.issue} 期`, `第 ${ctx.issue} 期：${stats.stores} 家美国独立站、${stats.products} 个收录型号的价格、规格口径与 CPSC 召回情报。`)}
<nav class="crumbs"><a href="${SITE.baseUrl ? esc(SITE.baseUrl) : '../index.html'}">首页</a> › 本期 ｜ <a href="../model/index.html">型号库</a> ｜ <a href="index.html">往期</a></nav>

<div class="brief-cover">
  <div class="cover-top">
    <div>CLIMATE RADAR · WEEKLY MARKET BRIEF</div>
    <div>NO. ${String(ctx.issue).padStart(3, '0')} · ${ctx.date}${sample ? ' · <span class="sample">样刊</span>' : ''}</div>
  </div>
  <div class="brief-kicker">美国家居气候电器 · 独立站竞品情报</div>
  <h1>${headline}</h1>
  <p class="brief-deck">未注明 DOE-2019 口径的除湿量无法跨品牌比较；${ratioLine}本期按同一把尺子重排 ${stats.products} 个型号，并列出 ${hit.length} 条命中监控品牌的 CPSC 召回。</p>
  <div class="brief-byline">
    <span>数据日期 ${ctx.date}</span>
    <span>${stats.stores} 家品牌独立站</span>
    <span>${stats.products} 个收录型号</span>
    <span>${prevDate ? `对比基准 ${prevDate}` : '首期基线'}</span>
  </div>
</div>

<div class="kpi-strip">
  <div><b>${stats.products}</b><span>收录型号<br>覆盖 ${stats.stores} 家独立站</span></div>
  <div><b>${unstated.length}</b><span>规格不可直接比<br>除湿机 ${stats.dehUnstated}/${stats.dehTotal} 款</span></div>
  <div><b>${hit.length}</b><span>召回命中监控品牌<br>${esc(brandTop)}</span></div>
  <div><b>${ratioMed ?? '—'}<em>%</em></b><span>SACC / ASHRAE 中位比<br>${pairs.length} 款双标机型${pairVendors.length === 1 ? ` · ${esc(pairVendors[0])}` : ` · ${pairVendors.length} 个品牌`}</span></div>
</div>

<div class="section-head"><div class="no">结论</div><div><h2>本期三个判断</h2><p>结论只使用可核对的数据；每条附一条可执行动作。</p></div></div>
<div class="conclusions">
  <div class="conclusion">
    <div class="no">01</div>
    <div>
      <h3>召回集中在取暖器，品牌命中集中在 Vornado 与 Lasko</h3>
      <p>${recalls.length} 条相关召回中，取暖器 ${catCounts.find((c) => c.label === '取暖器')?.value ?? 0} 条。${hit.length} 条命中监控品牌：${Object.entries(brandHits).sort((a, b) => b[1] - a[1]).map(([b, n]) => `${esc(b.replace(/\s*Air$/, ''))} ${n} 条`).join('、')}；其中取暖器 ${hit.filter((r) => r.cat === '取暖器').length} 条、风扇 ${hit.filter((r) => r.cat === '风扇').length} 条。最近一条为 ${esc(hitSorted[0]?.date ?? '—')} 的${esc(hitSorted[0]?.cat ?? '')}召回，涉及${esc(fmtUnits(hitSorted[0]?.units))}。</p>
      <div class="act"><b>动作</b>上架或采购同款、同厂取暖器与风扇前，按 CPSC 公告的型号、UPC 与销售时间核对；品牌名相同不等于型号被召回。</div>
    </div>
  </div>
  <div class="conclusion">
    <div class="no">02</div>
    <div>
      <h3>${pairVendors.length === 1 ? `${esc(pairVendors[0])} 双标机型：SACC 仅为 ASHRAE 的 ${ratioMed}%` : `双标机型：SACC 中位为 ASHRAE 的 ${ratioMed}%`}</h3>
      <p>${pairNote}按 SACC/ASHRAE 计算，中位数 ${ratioMed}%，最低 ${ratioMin}%，最高 ${ratioMax}%。标称 12,000 BTU 的机型，SACC 口径约为 ${Math.round(12000 * ratioMin / 100).toLocaleString()}–${Math.round(12000 * ratioMax / 100).toLocaleString()} BTU。</p>
      <div class="act"><b>动作</b>比价、定价与详情页统一使用 SACC；向工厂索取 SACC 测试值。只有 ASHRAE 数字的型号，不进入同口径排序。</div>
    </div>
  </div>
  <div class="conclusion">
    <div class="no">03</div>
    <div>
      <h3>除湿机的规格透明度最低</h3>
      <p>${deh.length} 款除湿机中 ${dehBad.length} 款未注明 DOE-2019 口径或未按 DOE 折算，占 ${dehPct}%；可验证口径的仅 ${deh.length - dehBad.length} 款。另有 ${pacBad.length} 款移动空调只写 BTU、不写标准。</p>
      <div class="act"><b>动作</b>只把标注 DOE-2019 的型号放进单位价排序；其余先向供应商要测试报告，再决定是否跟价。</div>
    </div>
  </div>
</div>

${sectionHead('01', '召回雷达', '美国消费品安全委员会（CPSC）公开数据：2022 年以来气候电器品类召回，并补充品牌历史召回（最早 2004 年）。先列命中监控品牌的记录，再列全部相关召回。')}
<div class="chart">
  <div class="chart-head"><div class="chart-title">相关召回按品类分布</div><div class="chart-sub">共 ${recalls.length} 条 · 按事件数</div></div>
  ${simpleBars(recallBars)}
</div>
<h3>命中监控品牌（${hit.length} 条）</h3>
<div class="table-wrap hit-table"><table><thead><tr><th style="width:96px">日期</th><th style="width:88px">品类</th><th style="width:140px">品牌</th><th>召回事件</th><th style="width:96px">规模</th><th style="width:104px">危害</th></tr></thead><tbody>${hitRows || '<tr><td colspan="6" class="sub">本期无品牌命中。</td></tr>'}</tbody></table></div>
<div class="mobile-cards">${hitCards || '<p class="sub">本期无品牌命中。</p>'}</div>
<details>
  <summary>展开全部 ${recalls.length} 条相关召回</summary>
  <div class="table-wrap"><table><thead><tr><th style="width:96px">日期</th><th style="width:88px">品类</th><th>召回事件</th><th style="width:150px">品牌 / 厂商</th><th style="width:96px">规模</th></tr></thead><tbody>${allRows}</tbody></table></div>
</details>
<div class="note">品牌匹配基于召回标题、产品名与厂商名，属于线索而非结论。采购前须以 CPSC 公告中的型号、UPC 与销售时间核对。</div>

${sectionHead('02', '规格口径', '除湿量统一为 DOE-2019 pints/天，制冷量统一为 SACC。未注明标准的数字保留原值，但不参与跨品牌比较。')}
<div class="chart">
  <div class="chart-head"><div class="chart-title">未注明标准或未按 DOE 折算的型号占比</div><div class="chart-sub">按品类 · 红色为不可直接比</div></div>
  <div class="chart-legend"><span><i style="background:var(--danger)"></i>不可比</span><span><i style="background:var(--rule);opacity:.6"></i>口径可验证</span></div>
  ${splitBars(splitRows)}
</div>
${pairs.length ? `<div class="chart">
  <div class="chart-head"><div class="chart-title">SACC / ASHRAE 实测比例</div><div class="chart-sub">${pairs.length} 款双标机型${pairVendors.length === 1 ? ` · 全部来自 ${esc(pairVendors[0])}` : ''}</div></div>
  ${ratioBars(pairs, ratioMed)}
</div>` : ''}
<h3>移动空调：未注明标准的全部 ${pacBad.length} 款</h3>
<div class="table-wrap"><table><thead><tr><th>型号</th><th style="width:210px">标称</th><th style="width:90px">价格</th><th style="width:230px">问题</th></tr></thead><tbody>${pacBadRows || '<tr><td colspan="4" class="sub">本期全部标注了标准。</td></tr>'}</tbody></table></div>
<h3>除湿机：按品牌各取 1 款示例</h3>
<div class="table-wrap"><table><thead><tr><th>型号</th><th style="width:130px">标称</th><th style="width:90px">价格</th><th style="width:230px">问题</th></tr></thead><tbody>${dehBadRows || '<tr><td colspan="4" class="sub">本期全部标注了标准。</td></tr>'}</tbody></table></div>
<div class="note">可验证口径的除湿机 ${deh.length - dehBad.length} 款，占 ${100 - dehPct}%；移动空调 ${pac.length - pacBad.length} 款。完整标记见<a href="../model/index.html">型号库</a>逐页的“规格与合规字段”。</div>

${sectionHead('03', '价格与供给', prevDate ? `与 ${prevDate} 快照对比。价格均为官网标价，不含优惠券、会员价与运费。` : '首期只有价格基线，不计算环比。价格均为官网标价，不含优惠券、会员价与运费。')}
<h3>价格带（${ctx.date}）</h3>
<div class="table-wrap"><table><thead><tr><th>品类</th><th>有标价型号</th><th>最低</th><th>中位</th><th>最高</th></tr></thead><tbody>${bandRows}</tbody></table></div>
<h3>${claims.length ? `官方划线价差最大（前 ${Math.min(6, claims.length)} 款，共 ${claims.length} 款 ≥8%）` : '官方划线价差'}</h3>
<div class="table-wrap"><table><thead><tr><th>型号</th><th style="width:90px">现价</th><th style="width:90px">划线价</th><th style="width:76px">价差</th></tr></thead><tbody>${claimRows || '<tr><td colspan="4" class="sub">本期无 ≥8% 的划线价差。</td></tr>'}</tbody></table></div>
<div class="note">划线价为商家自填，可能长期高于实际成交价，本报告不将其计为降价。另有 ${stats.priceHidden} 个型号官网只显示占位价、${stats.priceMissing} 个取不到价格，已从全部价格统计中剔除。</div>

${sectionHead('04', '方法与边界', '可复现的采集与计算规则；不确定的地方直接标注，不用估算补齐。')}
<div class="method">
  <div><b>覆盖范围</b>${stats.stores} 家公开可访问的美国品牌独立站；不含亚马逊、沃尔玛、Home Depot 等平台内部数据。</div>
  <div><b>品类</b>除湿机、移动空调、空气净化器、加湿器、风扇、取暖器；剔除配件、耗材、翻新、开箱与占位价商品。</div>
  <div><b>除湿量</b>DOE-2019 pints/天。只写升、未按 DOE 折算的型号标记为不可比。</div>
  <div><b>制冷量</b>SACC BTU；同时标注 ASHRAE 的机型给出两者比例，不采用固定换算系数。</div>
  <div><b>召回</b>CPSC 公开接口；2022 年以来气候电器品类召回，并补充更早的品牌历史召回。先做型号/UPC 精确匹配，再做品牌匹配。</div>
  <div><b>价格</b>官网公开标价；不含优惠券、会员价、运费与平台补贴，不代表最终成交价。</div>
</div>

<div class="brief-end">
  <h2>${sample ? '样刊说明' : '订阅'}</h2>
  <p class="sub">${sample
    ? `本期为样刊，免费公开，暂不收款。开放订阅后每周一邮件交付完整报告与型号库访问；月付 $${SITE.priceMonthly}，年付 $${SITE.priceYearly}，税费由 Paddle 在结账时计算。`
    : `每周一邮件交付完整报告与型号库访问；月付 $${SITE.priceMonthly}，年付 $${SITE.priceYearly}，税费由 Paddle 在结账时计算。`}</p>
  ${SITE.paddleCheckoutUrl
    ? `<a class="cta" href="${esc(SITE.paddleCheckoutUrl)}" rel="noopener">订阅，每周一收到完整报告</a>`
    : `<a class="cta" href="../model/index.html">查看 ${stats.products} 个型号</a> <a class="cta ghost" href="index.html">往期报告</a>`}
  <div class="sample-note"><b>状态</b>${sample ? '样刊 · 免费公开 · 未开放收款' : '正式订阅'}。数据来源为品牌官网公开商品页与 CPSC 公开召回库；本报告不构成法律或合规意见。</div>
</div>
${pageFoot('../')}`;
}

function renderIndex(ctx) {
  const { stats, recalls } = ctx;
  const sample = !SITE.paddleCheckoutUrl;
  const unstated = stats.incomparable;
  const pairs = ctx.catalog.filter((p) => p.cat === 'portable-ac' && p.spec.btuAshrae && p.spec.btuSacc);
  const ratioMed = pairs.length ? median(pairs.map((p) => Math.round((p.spec.btuSacc / p.spec.btuAshrae) * 100))) : null;
  const pairVendors = uniq(pairs.map((p) => p.vendor));
  const brandHits = {};
  for (const r of recalls.filter((x) => x.matchedBrands.length)) for (const b of r.matchedBrands) brandHits[b] = (brandHits[b] ?? 0) + 1;
  const brandText = Object.entries(brandHits).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([b, n]) => `${b.replace(/\s*Air$/, '')} ${n}`).join(' · ');
  const title = `${SITE.name} · 美国家居气候电器卖家情报`;

  return `${pageHead(title, `每周一份美国除湿机、移动空调、空气净化器、加湿器、风扇与取暖器的竞品、规格与 CPSC 召回情报。覆盖 ${stats.stores} 家品牌独立站、${stats.products} 个收录型号。`)}
<div class="brief-cover">
  <div class="cover-top">
    <div>CLIMATE RADAR · WEEKLY MARKET BRIEF</div>
    <div>NO. ${String(ctx.issue).padStart(3, '0')} · ${ctx.date}${sample ? ' · <span class="sample">样刊</span>' : ''}</div>
  </div>
  <div class="brief-kicker">美国家居气候电器 · 独立站竞品情报</div>
  <h1>美国家居气候电器，<br>每周一份可核对的情报。</h1>
  <p class="brief-deck">覆盖 ${stats.stores} 家品牌独立站、${stats.products} 个收录型号。规格统一到 DOE-2019 与 SACC，召回匹配到品牌与型号，价格按周记录。每条判断都能回到原始商品页或 CPSC 公告。</p>
  <div class="brief-byline">
    <span>第 ${ctx.issue} 期 · ${ctx.date}</span>
    <span>每周一更新</span>
    <span>${sample ? '样刊免费公开' : '订阅制'}</span>
  </div>
</div>

<div class="kpi-strip">
  <div><b>${stats.products}</b><span>收录型号<br>覆盖 ${stats.stores} 家独立站</span></div>
  <div><b>${unstated}</b><span>规格不可直接比<br>除湿机 ${stats.dehUnstated}/${stats.dehTotal} 款</span></div>
  <div><b>${stats.hitRecalls}</b><span>召回命中监控品牌<br>${esc(brandText)}</span></div>
  <div><b>${ratioMed ?? '—'}<em>%</em></b><span>SACC / ASHRAE 中位比<br>${pairs.length} 款双标机型${pairVendors.length === 1 ? ` · ${esc(pairVendors[0])}` : ''}</span></div>
</div>

<div class="section-head"><div class="no">内容</div><div><h2>一份报告，四类可核对的信息</h2><p>不做泛行业综述，只覆盖能落到型号、价格与公告上的事实。</p></div></div>
<div class="conclusions">
  <div class="conclusion">
    <div class="no">01</div>
    <div><h3>召回雷达</h3><p>${recalls.length} 条 CPSC 相关召回，${stats.hitRecalls} 条命中监控品牌。逐条给出日期、品类、型号线索、销量、危害与官方公告链接。</p></div>
  </div>
  <div class="conclusion">
    <div class="no">02</div>
    <div><h3>规格口径</h3><p>${unstated} 个型号的标称值不可直接比。${pairs.length} 款双标移动空调${pairVendors.length === 1 ? `（全部来自 ${esc(pairVendors[0])}）` : ''}给出 SACC/ASHRAE 实测比例，中位 ${ratioMed}%，不用固定系数折算。</p></div>
  </div>
  <div class="conclusion">
    <div class="no">03</div>
    <div><h3>价格与供给</h3><p>六个品类的价格带与收录数量。首期建立基线，此后按周记录价格变化；官网划线价单独标注，不当作真实降价。</p></div>
  </div>
  <div class="conclusion">
    <div class="no">04</div>
    <div><h3>型号库</h3><p>${stats.products} 个型号逐页记录规格字段、单位能力价、同类竞品与品牌召回记录，可长期对照。</p></div>
  </div>
</div>

<div class="section-head"><div class="no">定价</div><div><h2>订阅与当前状态</h2><p>${sample ? '当前为样刊阶段：报告免费公开，尚未开放收款。' : '付款与税务由 Paddle 作为名义卖家处理。'}</p></div></div>
<div class="grid" style="grid-template-columns:repeat(2,1fr);margin-top:0">
  <div class="card"><div class="kpi">$${SITE.priceMonthly}<span style="font-size:16px;color:var(--muted)">/月</span></div><div class="kpi-label">月付，自动续费，可随时取消</div></div>
  <div class="card"><div class="kpi">$${SITE.priceYearly}<span style="font-size:16px;color:var(--muted)">/年</span></div><div class="kpi-label">年付，相当于 $${Math.round(SITE.priceYearly / 12)}/月</div></div>
</div>
<p class="sub">${sample ? '正式开放订阅前不会收款。届时通过 Paddle 结账，自动计算美国销售税与欧洲 VAT。' : '通过 Paddle 结账，自动计算美国销售税与欧洲 VAT；发票由 Paddle 开具。'}</p>
<p style="margin-top:18px"><a class="cta" href="report/latest.html">阅读本期报告</a> <a class="cta ghost" href="model/index.html">查 ${stats.products} 个型号</a>${SITE.paddleCheckoutUrl ? ` <a class="cta ghost" href="${esc(SITE.paddleCheckoutUrl)}" rel="noopener">订阅</a>` : ''}</p>

<div class="section-head"><div class="no">交付</div><div><h2>怎么运作</h2><p>每周日 13:00 UTC 自动抓取、比对、生成并发布；数据快照、报告与型号页一并存档。</p></div></div>
<div class="method">
  <div><b>采集</b>品牌官网公开商品页；只取公开可访问的价格、规格、库存与上架时间。</div>
  <div><b>校验</b>规格按 DOE-2019 与 SACC 归一；未注明标准的型号单独标记，不参与排序。</div>
  <div><b>召回</b>CPSC 公开接口；先做型号/UPC 精确匹配，再做品牌匹配，人工复核后再写入结论。</div>
  <div><b>交付</b>静态网页 + 每周邮件；历史快照保存在版本库中，不依赖第三方数据库。</div>
</div>
${pageFoot('')}`;
}

/* ---------------- model pages, email, sitemap ---------------- */

const brandKey = (s = '') => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const slug = (s = '') => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90);
const CAT_CORE = ['dehumidifier', 'portable-ac', 'air-purifier', 'humidifier', 'heater', 'fan'];

function hash8(s) {
  let h = 5381;
  for (const ch of String(s)) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

function modelId(p) {
  const d = slug(p.domain);
  const h = slug(p.handle);
  return h.length >= 80 ? `${d}--${h.slice(0, 80)}-${hash8(p.handle)}` : `${d}--${h}`;
}

function capacityOf(p) {
  const s = p.spec ?? {};
  if (p.cat === 'dehumidifier') return s.pints ?? s.pintsEq ?? null;
  if (p.cat === 'portable-ac') return s.btuSacc ?? s.btuAshrae ?? s.btu ?? null;
  if (p.cat === 'air-purifier' || p.cat === 'humidifier') return s.sqft ?? null;
  return null;
}

function capacityLabel(p) {
  const c = capacityOf(p);
  if (c == null) return '—';
  if (p.cat === 'dehumidifier') return `${c} pint/天`;
  if (p.cat === 'portable-ac') return `${c.toLocaleString()} BTU`;
  return `${c.toLocaleString()} sq ft`;
}

function unitPrice(p) {
  const c = capacityOf(p);
  if (!realPrice(p) || !c) return null;
  if (p.cat === 'dehumidifier') return { v: p.price / c, unit: '$/pint' };
  if (p.cat === 'portable-ac') return { v: (p.price / c) * 1000, unit: '$/千 BTU' };
  return { v: (p.price / c) * 100, unit: '$/100 sq ft' };
}

function ctaHtml(label, fallbackHref = null, fallbackLabel = '先看本期样板报告') {
  if (SITE.paddleCheckoutUrl) return `<a class="cta" href="${esc(SITE.paddleCheckoutUrl)}" rel="noopener">${esc(label)}</a>`;
  const href = fallbackHref ?? `${SITE.baseUrl ? SITE.baseUrl : '../'}report/latest.html`;
  return `<a class="cta" href="${esc(href)}">${esc(fallbackLabel)}</a>`;
}

function sparkline(points) {
  const vals = points.map((x) => x.price).filter((v) => v != null);
  if (vals.length < 2) return '';
  const w = 300; const h = 56; const pad = 4;
  const min = Math.min(...vals); const max = Math.max(...vals);
  const span = max - min || 1;
  const step = (w - pad * 2) / (points.length - 1);
  const xy = points.map((pt, i) => {
    const y = h - pad - ((pt.price - min) / span) * (h - pad * 2);
    return `${(pad + i * step).toFixed(1)},${y.toFixed(1)}`;
  });
  const last = vals[vals.length - 1]; const first = vals[0];
  const color = last < first ? 'var(--good)' : last > first ? 'var(--danger)' : 'var(--accent)';
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="价格历史">
<polyline fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" points="${xy.join(' ')}"/>
</svg><div class="sub">最低 ${money(min)}｜最高 ${money(max)}｜最新 ${money(last)}</div>`;
}

async function updatePriceHistory(snapshots) {
  const file = path.join(DATA, 'prices.json');
  const db = await readJSON(file, {});
  let added = 0;
  for (const [domain, products] of Object.entries(snapshots)) {
    for (const p of products) {
      if (!p.price) continue;
      const key = `${domain}|${p.handle}`;
      const arr = db[key] ?? (db[key] = []);
      const last = arr[arr.length - 1];
      if (!last || last[0] !== date) { arr.push([date, p.price]); added++; }
      else last[1] = p.price;
      if (arr.length > 260) arr.splice(0, arr.length - 260);
    }
  }
  await writeJSON(file, db);
  log(`price history: ${Object.keys(db).length} series, +${added} points`);
  return new Map(Object.entries(db).map(([k, v]) => [k, v.map(([d, pr]) => ({ date: d, price: pr }))]));
}

function recallsFor(p, recalls) {
  const key = brandKey(p.vendor);
  return recalls.filter((r) => {
    if (r.matchedSku && r.matchedSku.domain === p.domain && brandKey(r.matchedSku.title) === brandKey(p.title)) return true;
    return r.matchedBrands.some((b) => brandKey(b) === key || (key.length >= 5 && brandKey(b).includes(key)));
  }).slice(0, 8);
}

function renderModel(p, ctx) {
  const { recalls, catalog, history } = ctx;
  const s = p.spec ?? {};
  const hist = history.get(`${p.domain}|${p.handle}`) ?? [];
  const up = unitPrice(p);
  const cap = capacityOf(p);
  const pool = catalog.filter((x) => x.cat === p.cat && x.domain !== p.domain && realPrice(x));
  const byCapacity = (arr) => arr
    .filter((x) => capacityOf(x) != null)
    .sort((a, b) => Math.abs(capacityOf(a) - cap) - Math.abs(capacityOf(b) - cap));
  const byPrice = (arr) => arr
    .filter((x) => p.price)
    .sort((a, b) => Math.abs(a.price - p.price) - Math.abs(b.price - p.price));
  let comps = [];
  let compTitle = '同类竞品';
  if (cap) {
    comps = byCapacity(pool.filter((x) => capacityOf(x) != null && Math.abs(capacityOf(x) - cap) / cap <= 0.4)).slice(0, 6);
    compTitle = '同类竞品（按能力接近程度）';
    if (comps.length < 3) {
      const loose = byCapacity(pool).slice(0, 6);
      if (loose.length > comps.length) { comps = loose; compTitle = '同品类竞品（放宽能力范围）'; }
    }
  }
  if (!comps.length) { comps = byPrice(pool).slice(0, 6); compTitle = '同品类同价位'; }
  const seen = new Set();
  comps = comps.filter((x) => {
    const k = `${x.vendor}|${capacityOf(x) ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 6);
  const compRows = comps.map((x) => {
    const u = unitPrice(x);
    return `<tr><td><a href="${esc(modelId(x))}.html">${esc(x.title)}</a><div class="sub">${esc(x.vendor)}</div></td><td class="num">${esc(capacityLabel(x))}</td><td class="num">${money(x.price)}</td><td class="num">${u ? money(u.v) + '<div class="sub">' + esc(u.unit) + '</div>' : '—'}</td></tr>`;
  }).join('');
  const flagHtml = (s.flags ?? []).map((f) => `<span class="tag ${f.code.startsWith('ok') ? 'good' : 'warn'}">${esc(f.text)}</span>`).join('') || '<span class="tag">规格无异常标记</span>';
  const rrows = recallsFor(p, recalls).map((r) => `<tr><td class="num">${esc(r.date)}</td><td><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a><div class="sub">${esc(r.hazard).slice(0, 120)}</div></td></tr>`).join('');
  const histRows = hist.slice(-8).reverse().map((h) => `<tr><td class="num">${esc(h.date)}</td><td class="num">${money(h.price)}</td></tr>`).join('');
  const jsonld = {
    '@context': 'https://schema.org', '@type': 'Product', name: p.title, brand: { '@type': 'Brand', name: p.vendor },
    sku: p.sku || undefined, category: catLabel(p.cat), url: p.url,
    offers: p.price ? { '@type': 'Offer', price: p.price, priceCurrency: 'USD', availability: p.available ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock' } : undefined,
  };
  const title = `${p.title}｜${p.vendor} 规格、价格与召回记录`;
  return `${pageHead(title, `${p.vendor} ${p.title}：${capacityLabel(p)}，${p.price ? money(p.price) : '价格未公开'}。口径校验、同类竞品单位价与 CPSC 召回记录。`)}
<nav class="crumbs"><a href="${SITE.baseUrl ? esc(SITE.baseUrl) : '../index.html'}">首页</a> › <a href="${SITE.baseUrl ? esc(SITE.baseUrl) : '../'}report/latest.html">本期周报</a> › ${esc(catLabel(p.cat))}</nav>
<h1>${esc(p.title)}</h1>
<p class="sub">${esc(p.vendor)}｜${esc(catLabel(p.cat))}｜数据日期 ${esc(ctx.date)}${p.available ? '' : '｜<span class="tag warn">当前缺货/下架</span>'}</p>
<div class="facts">
  <div><b>${money(p.price)}</b><span>${s.preorder ? '预售/定金价' : '官网现价'}${p.compare && p.compare > p.price ? `（原价 ${money(p.compare)}）` : ''}</span></div>
  <div><b>${esc(capacityLabel(p))}</b><span>标称能力</span></div>
  <div><b>${up ? money(up.v) : '—'}</b><span>${up ? esc(up.unit) : '单位价不可算'}</span></div>
</div>
<div>${flagHtml}</div>

${hist.length > 1 ? `<h2>价格历史</h2>${sparkline(hist)}<table><thead><tr><th>日期</th><th>标价</th></tr></thead><tbody>${histRows}</tbody></table>` : `<h2>价格历史</h2><p class="sub">从 ${esc(ctx.date)} 起开始记录，下一期出现对比。</p>`}

<h2>规格与合规字段</h2>
<table><tbody>
<tr><td>制冷量（ASHRAE）</td><td>${s.btuAshrae ? s.btuAshrae.toLocaleString() + ' BTU' : '—'}</td></tr>
<tr><td>制冷量（SACC / DOE）</td><td>${s.btuSacc ? s.btuSacc.toLocaleString() + ' BTU' : '—'}</td></tr>
<tr><td>除湿量</td><td>${s.pints ? s.pints + ' pint/天' : s.pintsEq ? `${s.liters} L/天（≈ ${s.pintsEq} pint）` : '—'}</td></tr>
<tr><td>适用面积</td><td>${s.sqft ? s.sqft.toLocaleString() + ' sq ft' : '—'}</td></tr>
<tr><td>水箱</td><td>${s.tankGal ? s.tankGal + ' gal' : '—'}</td></tr>
<tr><td>冷媒</td><td>${esc(s.refrigerant ?? '—')}</td></tr>
<tr><td>认证</td><td>${esc(s.certs?.join('、') || '—')}</td></tr>
<tr><td>货号 / 条码</td><td>${esc(p.sku || '—')} / ${esc(p.barcode || '—')}</td></tr>
<tr><td>官网上架</td><td>${esc(p.created || '—')}</td></tr>
<tr><td>原始页面</td><td><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.domain)}</a></td></tr>
</tbody></table>

<h2>${compTitle}</h2>
${compRows ? `<table><thead><tr><th>型号</th><th style="width:120px">能力</th><th style="width:90px">价格</th><th style="width:110px">单位价</th></tr></thead><tbody>${compRows}</tbody></table>` : '<p class="sub">本期没有能力接近的其他品牌型号。</p>'}

<h2>品牌召回记录（CPSC）</h2>
${rrows ? `<table><thead><tr><th style="width:110px">日期</th><th>事件</th></tr></thead><tbody>${rrows}</tbody></table><p class="sub">品牌层面的历史召回，不代表此型号已被召回；下单前请对照召回公告里的型号与 UPC。</p>` : '<p class="sub">该品牌自 2022 年以来没有进入本报告过滤范围的相关召回。</p>'}

<p style="margin-top:26px">${ctaHtml('订阅，收每周型号与召回更新')}</p>
${pageFoot('../')}
<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>`;
}

function renderModelIndex(ctx) {
  const { catalog, history } = ctx;
  const groups = CAT_CORE.map((id) => ({ id, rows: catalog.filter((p) => p.cat === id).sort((a, b) => (a.vendor < b.vendor ? -1 : a.vendor > b.vendor ? 1 : 0)) })).filter((g) => g.rows.length);
  const sections = groups.map((g) => `<h2>${esc(catLabel(g.id))}（${g.rows.length}）</h2><div class="cards">${g.rows.map((p) => {
    const h = history.get(`${p.domain}|${p.handle}`) ?? [];
    const last = h[h.length - 1];
    const prev = h[h.length - 2];
    const delta = last && prev ? Math.round(((last.price - prev.price) / prev.price) * 100) : null;
    return `<div class="card"><a href="${esc(modelId(p))}.html">${esc(p.title)}</a><div class="sub">${esc(p.vendor)}｜${esc(capacityLabel(p))}</div><div class="num">${money(p.price)}${delta != null && delta !== 0 ? ` <span class="tag ${delta < 0 ? 'good' : 'danger'}">${delta > 0 ? '+' : ''}${delta}%</span>` : ''}</div></div>`;
  }).join('')}</div>`).join('');
  return `${pageHead('型号库 · 全部收录机型', '按品牌与能力整理的除湿机、移动空调、空气净化器等型号库，含价格、规格口径与召回记录。')}
<nav class="crumbs"><a href="${SITE.baseUrl ? esc(SITE.baseUrl) : '../index.html'}">首页</a> › 型号库</nav>
<h1>型号库</h1>
<p class="sub">本期 ${ctx.catalog.length} 个收录型号，数据日期 ${esc(ctx.date)}。点开任意型号，看它的口径校验、同类竞品单位价与品牌召回记录。</p>
${sections}
${pageFoot('../')}`;
}

function renderEmail(ctx) {
  const { stats, diff, recalls, date: d, issue, catalog } = ctx;
  const sample = !SITE.paddleCheckoutUrl;
  const hits = recalls.filter((r) => (r.matchedBrands.length || r.matchedSku)).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 3);
  const drops = diff.priceDrop.slice(0, 3);
  const dropRows = drops.map((p) => `<tr><td style="padding:9px 0;border-bottom:1px solid #e5e7eb;font-size:15px">${esc(p.title)}<div style="color:#6b7280;font-size:13px">${esc(p.domain)}</div></td><td style="padding:9px 0;border-bottom:1px solid #e5e7eb;text-align:right;font-size:15px;white-space:nowrap"><s style="color:#9ca3af">$${p.oldPrice}</s> <b>$${p.price}</b> <span style="color:#047857">${Math.round(p.delta * 100)}%</span></td></tr>`).join('');
  const hitRows = hits.map((r) => `<tr><td style="padding:9px 0;border-bottom:1px solid #e5e7eb;font-size:15px"><a href="${esc(r.url)}" style="color:#8a4b00;text-decoration:none">${esc(clip(recallTitle(r.title), 110))}</a><div style="color:#6b7280;font-size:13px;margin-top:3px">${esc(r.date)}｜${esc(r.cat)}｜${esc(r.matchedBrands.join('、') || '型号命中')}｜${esc(fmtUnits(r.units))}</div></td></tr>`).join('');
  const link = SITE.baseUrl ? `${SITE.baseUrl}report/latest.html` : 'report/latest.html';
  const deh = catalog.filter((p) => p.cat === 'dehumidifier');
  const dehBad = deh.filter(isUnstated);
  const pacPairs = catalog.filter((p) => p.cat === 'portable-ac' && p.spec.btuAshrae && p.spec.btuSacc);
  const pacMed = pacPairs.length ? median(pacPairs.map((p) => Math.round((p.spec.btuSacc / p.spec.btuAshrae) * 100))) : null;
  const pacVendors = uniq(pacPairs.map((p) => p.vendor));
  const pacNote = pacMed == null
    ? `${pacPairs.length} 款移动空调同时给出 ASHRAE 与 SACC，可直接换算。`
    : `${pacVendors.join('、')} ${pacPairs.length} 款双标移动空调的 SACC 中位数为 ASHRAE 的 ${pacMed}%，最低 ${Math.min(...pacPairs.map((p) => Math.round((p.spec.btuSacc / p.spec.btuAshrae) * 100)))}%。`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>第 ${issue} 期｜${esc(d)}</title></head>
<body style="margin:0;background:#f5f2eb;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#17191e">
<div style="max-width:600px;margin:0 auto;padding:26px 18px">
<div style="border-top:2px solid #17191e;padding-top:14px;font-size:11px;letter-spacing:1.5px;color:#5f6673">CLIMATE RADAR · WEEKLY MARKET BRIEF</div>
<div style="font-size:12px;color:#5f6673;margin-top:6px">第 ${issue} 期｜${esc(d)}｜${stats.stores} 家独立站｜${stats.products} 个型号${sample ? '｜样刊' : ''}</div>
<h1 style="font-family:Georgia,'Songti SC',serif;font-size:26px;line-height:1.35;margin:20px 0 12px">${deh.length} 款除湿机，${dehBad.length} 款没有写明测试标准</h1>
<p style="font-size:15px;line-height:1.8;color:#4b5563;margin:0 0 18px">未注明 DOE-2019 口径的除湿量无法跨品牌比较；本期 ${stats.hitRecalls} 条 CPSC 召回命中监控品牌。</p>
<div style="background:#fffdf8;border:1px solid #d8d1c3;padding:18px 20px;margin-bottom:16px">
<div style="font-size:11px;letter-spacing:1.5px;color:#8a4b00;margin-bottom:10px">本期要点</div>
<p style="margin:0 0 10px;font-size:15px;line-height:1.7"><b>01</b>　未注明 DOE-2019 的 ${dehBad.length} 款，页面上的 pint 数不能直接与竞品横比；本期逐款标出口径，只把 ${deh.length - dehBad.length} 款放进同一张对比表。</p>
<p style="margin:0 0 10px;font-size:15px;line-height:1.7"><b>02</b>　${pacNote}</p>
<p style="margin:0;font-size:15px;line-height:1.7"><b>03</b>　${recalls.length} 条相关召回中，${stats.hitRecalls} 条命中 Vornado 与 Lasko；取暖器占 ${recalls.filter((r) => r.cat === '取暖器').length} 条。</p>
</div>
${hitRows ? `<div style="background:#fffdf8;border:1px solid #d8d1c3;padding:18px 20px;margin-bottom:16px"><div style="font-size:11px;letter-spacing:1.5px;color:#8a4b00;margin-bottom:6px">召回命中</div><table style="width:100%;border-collapse:collapse">${hitRows}</table></div>` : ''}
${dropRows ? `<div style="background:#fffdf8;border:1px solid #d8d1c3;padding:18px 20px;margin-bottom:16px"><div style="font-size:11px;letter-spacing:1.5px;color:#8a4b00;margin-bottom:6px">价格变动</div><table style="width:100%;border-collapse:collapse">${dropRows}</table></div>` : ''}
<div style="text-align:center;margin:24px 0"><a href="${esc(link)}" style="display:inline-block;background:#17191e;color:#fff;font-weight:700;padding:13px 28px;border-radius:2px;text-decoration:none">阅读完整报告</a></div>
<div style="color:#6b7280;font-size:12px;line-height:1.7;border-top:1px solid #d8d1c3;padding-top:12px">数据来自品牌官网公开商品页与美国消费品安全委员会（CPSC）公开数据库；仅覆盖公开独立站，不含亚马逊等平台内部数据。本邮件不构成法律或合规意见。${sample ? '当前为样刊阶段，报告免费公开，尚未开放收款。' : ''}</div>
<div style="color:#9ca3af;font-size:12px;margin-top:8px">${sample ? `这是 ${esc(SITE.name)} 的样刊，发送给你用于评估。回复本邮件可退订或直接反馈。` : `你收到这封邮件是因为订阅了 ${esc(SITE.name)}。回复本邮件可退订。`}</div>
</div></body></html>`;
}

function renderArchive(pages) {
  const rows = pages.map((p) => `<tr><td class="num">${esc(p.date)}</td><td><a href="${esc(p.file)}">第 ${p.issue} 期</a></td></tr>`).join('');
  return `${pageHead('往期报告', '每周竞品与召回情报的往期存档。')}
<nav class="crumbs"><a href="${SITE.baseUrl ? esc(SITE.baseUrl) : '../index.html'}">首页</a> › 往期</nav>
<h1>往期报告</h1>
<p class="sub">每期独立存档，历史不会因为新一期而消失。</p>
<table><thead><tr><th style="width:130px">日期</th><th>期号</th></tr></thead><tbody>${rows}</tbody></table>
${pageFoot('../')}`;
}

function renderSitemap(URLs, lastmod = date) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${URLs.map((u) => `<url><loc>${esc(u.loc)}</loc><lastmod>${lastmod}</lastmod><priority>${u.priority}</priority></url>`).join('\n')}
</urlset>`;
}

/* ---------------- legal pages ---------------- */

function renderLegal(kind) {
  const op = SITE.legalName || SITE.name;
  const contact = SITE.contactEmail
    ? `<a href="mailto:${esc(SITE.contactEmail)}">${esc(SITE.contactEmail)}</a>`
    : '（上线前填写联系邮箱）';
  const updated = SITE.legalUpdated || date;
  const plans = `月付 $${SITE.priceMonthly}、年付 $${SITE.priceYearly}`;
  const page = {
    terms: {
      title: '服务条款',
      body: [
        ['1. 服务内容', `<p>${esc(op)}（下称“我们”）提供 ${esc(SITE.name)} 订阅服务：基于品牌官网公开商品页与美国消费品安全委员会（CPSC）公开召回数据库，按周生成竞品价格、规格口径与召回匹配报告，并通过网页与邮件交付。</p>`],
        ['2. 订阅与付款', `<p>当前价格为${plans}（以结账页面显示为准）。付款由 Paddle.com 作为名义卖家（Merchant of Record）处理，Paddle 负责代收款项、开具发票并代扣代缴适用税费。订阅默认自动续费，可在 Paddle 发送的账单邮件中随时取消。</p>`],
        ['3. 取消与退款', `<p>可随时取消，取消后当期服务持续到该计费周期结束，不再自动扣费。退款按<a href="refund.html">退款政策</a>执行。</p>`],
        ['4. 使用许可与限制', `<p>订阅仅供订阅人及其所在团队内部使用。未经书面许可，不得转售、公开转载、批量再分发报告内容，不得将报告数据用于对外提供同类数据服务。违反本条的，我们可停止服务且不予退款。</p>`],
        ['5. 数据与免责', `<p>报告数据来自公开渠道，我们尽力校验但不保证完整、及时或无误；召回信息以 CPSC 官方公告为准，型号匹配为辅助线索而非结论。报告不构成法律、合规、投资或采购建议。因使用报告作出的任何决定由使用者自行承担。</p>`],
        ['6. 责任限制', `<p>在法律允许的范围内，我们对任何间接损失不承担责任；就本服务产生的全部责任，以你在过去 12 个月内实际支付的费用总额为上限。</p>`],
        ['7. 服务变更与终止', `<p>我们可能调整覆盖范围、交付频率或价格。价格调整不追溯已付周期，并会提前至少 14 天通过邮件通知。</p>`],
        ['8. 适用法律与联系', `<p>本条款适用中华人民共和国法律（不含冲突规范）。争议先友好协商。联系：${contact}。</p>`],
      ],
    },
    privacy: {
      title: '隐私政策',
      body: [
        ['1. 我们收集什么', `<p>订阅邮箱、可选的姓名/公司名、你主动发来的邮件内容；支付信息（卡号、账单地址）由 Paddle 直接收集和处理，我们不接触也不存储完整支付信息。网页端仅在浏览器本地保存明暗主题偏好，不使用广告或行为追踪 Cookie。</p>`],
        ['2. 用途', `<p>发送每周报告与账单通知、处理退款与客服请求、防止滥用。我们不会出售你的个人数据，也不会用于与订阅无关的营销。</p>`],
        ['3. 第三方', `<p>Paddle（支付与税务，作为名义卖家）、Resend（邮件发送）、GitHub Pages（网站托管，会按常规记录访问日志）。这些服务商按其各自隐私政策处理数据，可能涉及跨境传输。</p>`],
        ['4. 保留与删除', `<p>订阅关系存续期间及结束后 24 个月内保留必要记录（税务与纠纷需要）。你可以随时来信要求查询、更正或删除个人数据；删除后我们将停止发送报告。法律要求保留的账务记录除外。</p>`],
        ['5. 儿童', `<p>本服务面向经营者，不面向 16 岁以下人士。</p>`],
        ['6. 联系', `<p>隐私相关请求请联系：${contact}。</p>`],
      ],
    },
    refund: {
      title: '退款政策',
      body: [
        ['1. 首次订阅 7 天保障', `<p>首次订阅后 7 天内，如报告不符合预期，可来信申请全额退款，无需说明理由。已按同一订单获得退款的，不再重复适用。</p>`],
        ['2. 续费与取消', `<p>续费周期内已交付的报告不支持按比例退款；你可以随时取消，取消后不再产生下一次扣费。</p>`],
        ['3. 重复扣款与故障', `<p>如发生重复扣款、扣款金额错误，或连续两周未能交付报告，我们将全额退还相应款项。</p>`],
        ['4. 如何申请', `<p>发送邮件至 ${contact}，附上 Paddle 订单号或账单邮箱，标题注明“退款”。我们将在 3 个工作日内确认，退款由 Paddle 原路退回，通常 5–10 个工作日到账。</p>`],
      ],
    },
  }[kind];

  return `${pageHead(`${page.title} · ${SITE.name}`, `${SITE.name} ${page.title}`)}
<nav class="crumbs"><a href="${SITE.baseUrl ? esc(SITE.baseUrl) : 'index.html'}">首页</a> › ${esc(page.title)}</nav>
<h1>${esc(page.title)}</h1>
<p class="sub">运营者：${esc(op)}${SITE.address ? `｜${esc(SITE.address)}` : ''}｜更新日期 ${esc(updated)}</p>
${page.body.map(([h, html]) => `<h2>${esc(h)}</h2>${html}`).join('\n')}
${pageFoot('')}`;
}

function renderAbout() {
  const op = SITE.legalName || SITE.name;
  const contact = SITE.contactEmail || 'contact@example.com';
  return `${pageHead(`About · ${SITE.name}`)}
<nav class="crumbs"><a href="${SITE.baseUrl ? esc(SITE.baseUrl) : 'index.html'}">Home</a> › About</nav>
<h1>About ${esc(SITE.name)}</h1>
<p class="sub">A marketplace-intelligence subscription for small sellers of home climate appliances in the United States.</p>
<h2>What the product is</h2>
<p>Every week we collect publicly listed product pages from US brand storefronts across six categories — dehumidifiers, portable air conditioners, air purifiers, humidifiers, space heaters and fans — and publish a report that (1) normalizes capacity claims to the standards shoppers actually compare (SACC for cooling, DOE-2019 pints for dehumidification), (2) tracks list-price changes, stock status and new launches, and (3) matches brands and models against the public CPSC recall database. Each tracked model has a permanent page with its specification history, comparable competitors and recall record.</p>
<h2>Who it is for</h2>
<p>Independent sellers and small brands sourcing or listing these categories on Amazon, Shopify or retail channels, who need a defensible read on competitor specifications and safety history without subscribing to enterprise retail-data platforms.</p>
<h2>Delivery</h2>
<p>Reports are published on this website every Monday and delivered by email to subscribers. Access is granted for the duration of the subscription.</p>
<h2>Pricing and billing</h2>
<p>$${SITE.priceMonthly} per month or $${SITE.priceYearly} per year, auto-renewing, cancel anytime. Payments, invoices and applicable sales tax or VAT are handled by Paddle.com as Merchant of Record. See <a href="refund.html">Refund policy</a>, <a href="terms.html">Terms</a> and <a href="privacy.html">Privacy policy</a>.</p>
<h2>Data and limitations</h2>
<p>All source data is publicly accessible: brand storefront product feeds and the U.S. Consumer Product Safety Commission's public recall API. We do not access Amazon or other marketplace-internal data, and we do not resell full catalogs. Reports are informational and are not legal, compliance or investment advice; recall matching is an aid, and the official CPSC notice always governs.</p>
<h2>Operator</h2>
<p>${esc(op)}${SITE.address ? `, ${esc(SITE.address)}` : ''}. Contact: <a href="mailto:${esc(contact)}">${esc(contact)}</a>.</p>
${pageFoot('')}`;
}

/* ---------------- main ---------------- */

async function main() {
  SITE = { ...SITE, ...(await readJSON(path.join(DATA, 'site.json'), {})) };
  if (!SITE.baseUrl && process.env.SITE_URL) SITE.baseUrl = process.env.SITE_URL;
  if (SITE.baseUrl && !SITE.baseUrl.endsWith('/')) SITE.baseUrl += '/';
  const stores = (await readJSON(path.join(DATA, 'stores.json'), [])).filter((s) => s.active !== false);
  log(`stores: ${stores.length}`);

  const renderOnly = process.env.RENDER_ONLY === '1';
  const prevDirs = (await fs.readdir(SNAP).catch(() => [])).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const runDate = renderOnly ? (prevDirs[prevDirs.length - 1] ?? date) : date;
  const prevDate = prevDirs.filter((d) => d < runDate).pop() ?? null;
  let prev = null;
  if (prevDate) {
    prev = {};
    for (const s of stores) prev[s.domain] = (await readJSON(path.join(SNAP, prevDate, `${s.domain}.json`), []));
  }
  log(`prev snapshot: ${prevDate ?? 'none'}`);

  const snapshots = {};
  const failures = [];
  const skipped = [];
  const carriedForward = [];
  if (renderOnly) {
    for (const s of stores) {
      const v = await readJSON(path.join(SNAP, runDate, `${s.domain}.json`), null);
      if (Array.isArray(v)) snapshots[s.domain] = v;
    }
    log(`render-only: ${Object.keys(snapshots).length} stores from ${runDate}`);
  }
  for (const store of renderOnly ? [] : stores) {
    try {
      const currency = store.currency ?? await storeCurrency(store.domain);
      if (currency && currency !== 'USD') {
        skipped.push(`${store.domain} (${currency})`);
        log(`SKIP ${store.domain}: ${currency}`);
        continue;
      }
      const raw = await fetchStore(store);
      const picked = [];
      for (const p of raw) {
        const cat = detectCategory(p);
        if (!cat) continue;
        if (isAccessory(p.title || '')) continue;
        const ext = extractSpec(p);
        if (!ext.price && !ext.priceHidden && store.platform !== 'woo') continue;
        picked.push(toSnapshotProduct(store, p, cat, ext));
      }
      snapshots[store.domain] = picked;
      log(`${store.domain}: ${raw.length} -> ${picked.length}`);
      await sleep(2600 + Math.random() * 1600);
    } catch (err) {
      failures.push(`${store.domain}: ${err.message}`);
      log(`FAIL ${store.domain}: ${err.message}`);
      const carried = prevDate ? await readJSON(path.join(SNAP, prevDate, `${store.domain}.json`), null) : null;
      if (carried) {
        snapshots[store.domain] = carried;
        carriedForward.push(store.domain);
      }
    }
  }

  if (!Object.keys(snapshots).length) throw new Error('all stores failed; aborting to avoid wiping history');
  if (!renderOnly) {
    for (const [domain, products] of Object.entries(snapshots)) {
      await writeJSON(path.join(SNAP, runDate, `${domain}.json`), products);
    }
  }

  const catalog = flatCatalog(snapshots);
  const diff = diffCatalog(prev, snapshots);
  const recalls = renderOnly
    ? (await readJSON(path.join(DATA, 'recalls.json'), []))
    : matchRecalls(await loadRecalls(stores), catalog, stores);
  if (!renderOnly) await writeJSON(path.join(DATA, 'recalls.json'), recalls);
  await writeJSON(path.join(DATA, 'catalog.json'), catalog);

  const threeYearsAgo = new Date(Date.now() - 3 * 365 * 864e5).toISOString().slice(0, 10);
  const byCat = {};
  for (const p of catalog) byCat[p.cat] = (byCat[p.cat] ?? 0) + 1;
  const stats = {
    stores: Object.keys(snapshots).length,
    products: catalog.length,
    byCat,
    incomparable: catalog.filter((p) => (p.spec.flags ?? []).some((f) => f.code.endsWith('unstated') || f.code === 'sacc-gap' || f.code === 'eu-liters')).length,
    dehTotal: catalog.filter((p) => p.cat === 'dehumidifier').length,
    dehUnstated: catalog.filter((p) => p.cat === 'dehumidifier' && isUnstated(p)).length,
    recentRecalls: recalls.filter((r) => r.date >= threeYearsAgo).length,
    hitRecalls: recalls.filter((r) => r.matchedBrands.length || r.matchedSku).length,
    totalRecalls: recalls.length,
    priceHidden: catalog.filter((p) => p.spec.priceHidden).length,
    priceMissing: catalog.filter((p) => !p.price).length,
    skipped,
    carriedForward,
  };
  const ARCHIVE = path.join(DATA, 'reports');
  await fs.mkdir(ARCHIVE, { recursive: true });
  await fs.mkdir(path.join(OUT, 'report'), { recursive: true });
  const priorReports = (await fs.readdir(ARCHIVE).catch(() => []))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.html$/.test(f) && f.slice(0, 10) < runDate);
  const issue = priorReports.length + 1;
  const history = renderOnly
    ? new Map(Object.entries(await readJSON(path.join(DATA, 'prices.json'), {})).map(([k, v]) => [k, v.map(([d, pr]) => ({ date: d, price: pr }))]))
    : await updatePriceHistory(snapshots);
  const ctx = {
    catalog, diff, recalls, stats, prevDate, issue, history, date: runDate,
    storeNames: stores.filter((s) => snapshots[s.domain]).map((s) => s.brand).join('、'),
  };

  await fs.rm(path.join(OUT, 'model'), { recursive: true, force: true });
  await fs.mkdir(path.join(OUT, 'model'), { recursive: true });
  await fs.mkdir(path.join(OUT, 'email'), { recursive: true });
  await fs.writeFile(path.join(OUT, '.nojekyll'), '');
  const reportHtml = renderReport(ctx);
  await fs.writeFile(path.join(OUT, 'report', `${runDate}.html`), reportHtml);
  await fs.writeFile(path.join(ARCHIVE, `${runDate}.html`), reportHtml);
  await fs.writeFile(path.join(OUT, 'report', 'latest.html'), reportHtml);
  for (const f of [...priorReports, `${runDate}.html`]) {
    await fs.copyFile(path.join(ARCHIVE, f), path.join(OUT, 'report', f));
  }
  await fs.writeFile(path.join(OUT, 'index.html'), renderIndex(ctx));
  for (const k of ['terms', 'privacy', 'refund']) {
    await fs.writeFile(path.join(OUT, `${k}.html`), renderLegal(k));
  }
  await fs.writeFile(path.join(OUT, 'about.html'), renderAbout());

  for (const p of catalog) {
    await fs.writeFile(path.join(OUT, 'model', `${modelId(p)}.html`), renderModel(p, ctx));
  }
  await fs.writeFile(path.join(OUT, 'model', 'index.html'), renderModelIndex(ctx));
  log(`model pages: ${catalog.length}`);

  await fs.writeFile(path.join(OUT, 'email', 'latest.html'), renderEmail(ctx));
  const emailSubject = `[${SITE.name} 第 ${issue} 期] ${stats.dehUnstated} 款除湿机未注明测试标准｜${stats.hitRecalls} 条品牌召回命中`;
  await fs.writeFile(path.join(OUT, 'email', 'subject.txt'), emailSubject);

  const issues = (await fs.readdir(ARCHIVE))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.html$/.test(f))
    .sort()
    .reverse()
    .map((f, i, arr) => ({ date: f.slice(0, 10), file: f, issue: arr.length - i }));
  await fs.writeFile(path.join(OUT, 'report', 'index.html'), renderArchive(issues));

  if (SITE.baseUrl) {
    const base = SITE.baseUrl;
    const urls = [
      { loc: base, priority: '1.0' },
      { loc: `${base}report/latest.html`, priority: '0.9' },
      { loc: `${base}model/index.html`, priority: '0.9' },
      { loc: `${base}report/index.html`, priority: '0.6' },
      { loc: `${base}terms.html`, priority: '0.3' },
      { loc: `${base}privacy.html`, priority: '0.3' },
      { loc: `${base}refund.html`, priority: '0.3' },
      { loc: `${base}about.html`, priority: '0.4' },
      ...issues.map((i) => ({ loc: `${base}report/${i.file}`, priority: '0.7' })),
      ...catalog.map((p) => ({ loc: `${base}model/${modelId(p)}.html`, priority: '0.6' })),
    ];
    await fs.writeFile(path.join(OUT, 'sitemap.xml'), renderSitemap(urls, runDate));
    await fs.writeFile(path.join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${base}sitemap.xml\n`);
    log(`sitemap: ${urls.length} urls`);
  }

  await writeJSON(path.join(OUT, 'stats.json'), { date: runDate, issue, stats, failures, carriedForward, skipped });

  log(`done: ${catalog.length} products, ${recalls.length} recalls, ${failures.length} store failures`);
  if (failures.length) log(failures.join(' | '));
}

main().catch((err) => { console.error(err); process.exit(1); });
