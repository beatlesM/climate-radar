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
:root{--bg:#0d1117;--panel:#151b23;--line:#2a3441;--text:#e9eef5;--muted:#9aa7b6;--accent:#5eead4;--warn:#fbbf24;--danger:#f87171;--good:#34d399;}
html[data-theme="light"]{--bg:#f6f7f9;--panel:#ffffff;--line:#dde3ea;--text:#111827;--muted:#5b6675;--accent:#0f766e;--warn:#b45309;--danger:#b91c1c;--good:#047857;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:18px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:980px;margin:0 auto;padding:28px 20px 80px}
header{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:28px}
.brand{font-weight:700;letter-spacing:.5px;font-size:20px}
.brand span{color:var(--accent)}
button.toggle{background:var(--panel);border:1px solid var(--line);color:var(--text);padding:8px 14px;border-radius:999px;font-size:15px;cursor:pointer}
h1{font-size:34px;line-height:1.3;margin:0 0 10px}
h2{font-size:23px;margin:44px 0 14px;padding-bottom:8px;border-bottom:1px solid var(--line)}
h3{font-size:19px;margin:22px 0 8px}
p{color:var(--text)}
.sub{color:var(--muted);font-size:16px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:22px 0}
@media(max-width:760px){.grid{grid-template-columns:repeat(2,1fr)}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px}
.kpi{font-size:32px;font-weight:700;color:var(--accent);line-height:1.2}
.kpi-label{color:var(--muted);font-size:15px}
table{width:100%;border-collapse:collapse;margin:12px 0;font-size:16px}
th,td{text-align:left;padding:10px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:14px;letter-spacing:.3px}
td.num{white-space:nowrap;font-variant-numeric:tabular-nums}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.tag{display:inline-block;font-size:13px;padding:2px 9px;border-radius:999px;border:1px solid var(--line);color:var(--muted);margin:2px 4px 2px 0}
.tag.warn{color:var(--warn);border-color:var(--warn)}
.tag.danger{color:var(--danger);border-color:var(--danger)}
.tag.good{color:var(--good);border-color:var(--good)}
.note{background:var(--panel);border-left:4px solid var(--accent);padding:14px 16px;border-radius:8px;color:var(--muted);font-size:16px}
.cta{display:inline-block;background:var(--accent);color:#062a26;font-weight:700;padding:12px 22px;border-radius:10px;margin-top:8px}
html[data-theme="light"] .cta{color:#fff}
footer{margin-top:60px;color:var(--muted);font-size:14px;border-top:1px solid var(--line);padding-top:18px}
nav.crumbs{color:var(--muted);font-size:15px;margin:-10px 0 14px}
.spark{display:block;margin:6px 0 2px}
.facts{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:16px 0}
@media(max-width:760px){.facts{grid-template-columns:1fr 1fr}}
.facts div{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.facts b{display:block;font-size:22px;color:var(--accent);line-height:1.3}
.facts span{color:var(--muted);font-size:14px}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:14px 0}
@media(max-width:760px){.cards{grid-template-columns:1fr}}
.cards .card{font-size:16px}
.cards .card a{font-weight:600;display:block;margin-bottom:4px}
@media(max-width:600px){h1{font-size:27px}h2{font-size:20px}body{font-size:17px}th,td{padding:8px 6px}}
`;

let SITE = { name: 'Climate Radar', baseUrl: '', paddleCheckoutUrl: '', priceMonthly: 29, priceYearly: 299, earlyNote: '早鸟价，限前 20 名' };

function brandMark() {
  const [a, b] = String(SITE.name || 'Climate Radar').toUpperCase().split(' ');
  return `${esc(a || 'CLIMATE')}<span>${esc(b || 'RADAR')}</span>`;
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
${op ? `<div style="margin-top:10px">运营者：${esc(op)}${SITE.contactEmail ? `｜<a href="mailto:${esc(SITE.contactEmail)}">${esc(SITE.contactEmail)}</a>` : ''}</div>` : ''}
<div style="margin-top:10px"><a href="${esc(base)}terms.html">服务条款</a> · <a href="${esc(base)}privacy.html">隐私政策</a> · <a href="${esc(base)}refund.html">退款政策</a> · <a href="${esc(base)}about.html">About (EN)</a></div></footer></div>
<script>try{const t=localStorage.getItem('theme');if(t)document.documentElement.dataset.theme=t}catch(e){}</script></body></html>`;
}

function catLabel(id) { return CATS.find((c) => c.id === id)?.label ?? id; }

const realPrice = (p) => Boolean(p.price) && !p.spec?.preorder && !p.spec?.discontinued;

function renderReport(ctx) {
  const { catalog, diff, recalls, stats, prevDate } = ctx;
  const recentRecalls = recalls.filter((r) => r.date >= '2023-01-01').slice(0, 12);
  const hit = recalls.filter((r) => r.matchedBrands.length || r.matchedSku).slice(0, 8);
  const incomparable = catalog.filter((p) => (p.spec.flags ?? []).some((f) => f.code.endsWith('unstated') || f.code === 'sacc-gap' || f.code === 'eu-liters'));
  const promos = catalog.filter((p) => realPrice(p) && p.spec.discount && p.spec.discount >= 0.08).sort((a, b) => b.spec.discount - a.spec.discount).slice(0, 12);
  const fresh = catalog.filter((p) => p.created && p.created >= new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10)).sort((a, b) => (a.created < b.created ? 1 : -1)).slice(0, 12);
  const cheapest = Object.entries(stats.byCat)
    .map(([id]) => ({ id, med: median(catalog.filter((p) => p.cat === id && realPrice(p)).map((p) => p.price)) }))
    .filter((x) => x.med && ['dehumidifier','portable-ac','air-purifier','humidifier'].includes(x.id))
    .sort((a, b) => a.med - b.med)[0];
  const pairs = catalog.filter((p) => p.cat === 'portable-ac' && p.spec.btuAshrae && p.spec.btuSacc);
  const ratios = pairs.map((p) => p.spec.btuSacc / p.spec.btuAshrae).sort((a, b) => a - b);
  const ratioMed = ratios.length ? ratios[Math.floor(ratios.length / 2)] : null;
  const pairRows = pairs.slice(0, 8).map((p) => `<tr><td><a href="../model/${esc(modelId(p))}.html">${esc(p.title)}</a><div class="sub">${esc(p.vendor)}</div></td><td class="num">${p.spec.btuAshrae.toLocaleString()}</td><td class="num">${p.spec.btuSacc.toLocaleString()}</td><td class="num">${Math.round((p.spec.btuSacc / p.spec.btuAshrae) * 100)}%</td></tr>`).join('');

  const bandRows = Object.keys(stats.byCat).map((id) => {
    const rows = catalog.filter((p) => p.cat === id && realPrice(p));
    const prices = rows.map((p) => p.price);
    if (!prices.length) return '';
    return `<tr><td>${esc(catLabel(id))}</td><td class="num">${rows.length}</td><td class="num">${money(Math.min(...prices))}</td><td class="num">${money(median(prices))}</td><td class="num">${money(Math.max(...prices))}</td></tr>`;
  }).join('');

  const recallRows = recentRecalls.map((r) => {
    const m = r.matchedBrands.length ? `<span class="tag danger">命中：${esc(r.matchedBrands.slice(0, 3).join('、'))}</span>` : '';
    return `<tr><td class="num">${esc(r.date)}</td><td><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a><div class="sub">${esc(r.cat)}｜${esc(r.units)}</div>${m}</td></tr>`;
  }).join('');

  const incomparablePick = [];
  const perVendor = new Map();
  for (const p of incomparable) {
    const n = perVendor.get(p.vendor) ?? 0;
    if (n >= 2) continue;
    perVendor.set(p.vendor, n + 1);
    incomparablePick.push(p);
    if (incomparablePick.length >= 16) break;
  }
  const incomparableRows = incomparablePick.map((p) => {
    const s = p.spec;
    const shown = p.cat === 'portable-ac'
      ? (s.btuSacc && s.btuAshrae ? `SACC ${s.btuSacc.toLocaleString()} / ASHRAE ${s.btuAshrae.toLocaleString()}`
        : s.btuSacc ? `SACC ${s.btuSacc.toLocaleString()}`
        : s.btuAshrae ? `ASHRAE ${s.btuAshrae.toLocaleString()}` : '—')
      : (s.pints ? `${s.pints} pint` : s.liters ? `${s.liters} L/天 ≈ ${s.pintsEq} pint` : '—');
    const flag = (s.flags ?? []).find((f) => f.code !== 'ok-sacc' && f.code !== 'ok-doe');
    return `<tr><td><a href="../model/${esc(modelId(p))}.html">${esc(p.title)}</a><div class="sub">${esc(p.vendor)} ｜ <a href="${esc(p.url)}" target="_blank" rel="noopener">官网</a></div></td><td class="num">${esc(shown)}</td><td class="num">${money(p.price)}</td><td><span class="tag warn">${esc(flag?.text ?? '不可比')}</span></td></tr>`;
  }).join('');

  const promoRows = promos.map((p) => `<tr><td><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a><div class="sub">${esc(p.vendor)}</div></td><td class="num">${money(p.price)}</td><td class="num">${money(p.compare)}</td><td class="num">-${Math.round(p.spec.discount * 100)}%</td></tr>`).join('');

  const freshRows = fresh.map((p) => `<tr><td class="num">${esc(p.created)}</td><td><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a><div class="sub">${esc(p.vendor)}｜${esc(catLabel(p.cat))}</div></td><td class="num">${money(p.price)}</td></tr>`).join('');

  const moveRows = [...diff.priceDrop.slice(0, 10), ...diff.priceUp.slice(0, 5)].map((p) => {
    const pct = Math.round(p.delta * 100);
    return `<tr><td><a href="https://${esc(p.domain)}/products/${esc(p.handle)}" target="_blank" rel="noopener">${esc(p.title)}</a><div class="sub">${esc(p.domain)}</div></td><td class="num">${money(p.oldPrice)} → ${money(p.price)}</td><td class="num"><span class="tag ${pct < 0 ? 'good' : 'danger'}">${pct > 0 ? '+' : ''}${pct}%</span></td></tr>`;
  }).join('');

  return `${pageHead(`选品与合规周报 · ${date}`, `第 ${ctx.issue} 期：${stats.stores} 家美国独立站、${stats.products} 个在售型号的价格、规格口径与 CPSC 召回情报。`)}
<h1>除湿机 / 移动空调 · 选品与合规周报</h1>
<p class="sub">第 ${ctx.issue} 期｜${date}｜覆盖 ${stats.stores} 家独立站、${stats.products} 个在售型号${prevDate ? `｜对比基准 ${prevDate}` : '｜本期建立基线'}</p>
<nav class="crumbs"><a href="${SITE.baseUrl ? esc(SITE.baseUrl) : '../index.html'}">首页</a> › 本期 ｜ <a href="../model/index.html">型号库</a> ｜ <a href="index.html">往期</a></nav>

<div class="grid">
  <div class="card"><div class="kpi">${stats.byCat.dehumidifier ?? 0}</div><div class="kpi-label">除湿机</div></div>
  <div class="card"><div class="kpi">${stats.byCat['portable-ac'] ?? 0}</div><div class="kpi-label">移动空调</div></div>
  <div class="card"><div class="kpi">${stats.incomparable}</div><div class="kpi-label">规格不可直接比</div></div>
  <div class="card"><div class="kpi">${stats.totalRecalls}</div><div class="kpi-label">相关召回（含历史）</div></div>
</div>

<div class="note"><strong>本周三句话</strong><br>
1）共 ${stats.totalRecalls} 条相关召回（含历史），${stats.hitRecalls} 条命中你监控的品牌——先查同款工厂。<br>
2）${stats.incomparable} 个在售型号的 BTU/除湿量没写标准，这些数字不能直接拿来比价。<br>
3）${promos.length} 个型号在打 8% 以上折扣；中位价最低的是${esc(catLabel(cheapest?.id ?? ''))}（${money(cheapest?.med)}）。</div>

<h2>一、召回雷达（官方数据，全自动）</h2>
<table><thead><tr><th style="width:110px">日期</th><th>召回事件</th></tr></thead><tbody>${recallRows || '<tr><td colspan="2" class="sub">本期无新增。</td></tr>'}</tbody></table>

${hit.length ? `<h3>命中你监控品牌的召回</h3><table><thead><tr><th>日期</th><th>品牌</th><th>事件</th></tr></thead><tbody>${hit.map((r) => `<tr><td class="num">${esc(r.date)}</td><td>${esc(r.matchedBrands.join('、') || '型号精确命中')}</td><td><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a></td></tr>`).join('')}</tbody></table>` : ''}

<h2>二、不可比清单（本报告的核心价值）</h2>
<p class="sub">除湿机 2019 年换过测试标准，移动空调 2017 年从 ASHRAE 改成 SACC。下面这些型号只写了数字、没写尺子，和别家直接比就是错的。</p>
${pairs.length ? `<h3>实测换算：ASHRAE 到 SACC 到底打几折</h3>
<p class="sub">官网同时标注两个标准的 ${pairs.length} 台机型里，SACC 中位数是 ASHRAE 的 <strong>${Math.round((ratioMed ?? 0) * 100)}%</strong>（区间 ${Math.round(ratios[0] * 100)}%–${Math.round(ratios[ratios.length - 1] * 100)}%）。每家不一样，不能用一个固定系数去折算。</p>
<table><thead><tr><th>机型</th><th style="width:110px">ASHRAE</th><th style="width:100px">SACC</th><th style="width:80px">比例</th></tr></thead><tbody>${pairRows}</tbody></table>` : ''}
<table><thead><tr><th>型号</th><th style="width:150px">标称</th><th style="width:90px">价格</th><th style="width:230px">问题</th></tr></thead><tbody>${incomparableRows || '<tr><td colspan="4" class="sub">本期全部标注了标准。</td></tr>'}</tbody></table>

<h2>三、谁在动价</h2>
<table><thead><tr><th>型号</th><th style="width:170px">价格</th><th style="width:80px">幅度</th></tr></thead><tbody>${moveRows || '<tr><td colspan="3" class="sub">本期建立基线，下周开始出现真实涨跌。</td></tr>'}</tbody></table>

<h2>四、促销与新上架</h2>
${promoRows ? `<table><thead><tr><th>促销型号</th><th style="width:90px">现价</th><th style="width:90px">原价</th><th style="width:70px">折扣</th></tr></thead><tbody>${promoRows}</tbody></table>` : '<p class="sub">本期无 8% 以上折扣。</p>'}
${freshRows ? `<h3>近 90 天新上架</h3><table><thead><tr><th style="width:110px">上架</th><th>型号</th><th style="width:90px">价格</th></tr></thead><tbody>${freshRows}</tbody></table>` : ''}

<h2>五、价格带</h2>
<table><thead><tr><th>品类</th><th>在售</th><th>最低</th><th>中位</th><th>最高</th></tr></thead><tbody>${bandRows}</tbody></table>

<h2>六、覆盖说明</h2>
<p class="sub">本期覆盖 ${stats.stores} 家公开可访问的独立站（${ctx.storeNames}）。召回部分来自 CPSC 官方接口，覆盖全美公开召回，不依赖店铺。价格只反映独立站标价，不含亚马逊、沃尔玛、Home Depot 等平台，也不含优惠券后的真实成交价。另有 ${stats.priceHidden} 个型号官网只给占位价（$1 之类）、${stats.priceMissing} 个给不出价格，这两类已从价格统计中剔除。</p>
<p style="margin-top:22px">${ctaHtml('订阅，每周一自动收到', '../model/index.html', '按型号查本期全部机型')}</p>
${pageFoot('../')}`;
}

function renderIndex(ctx) {
  const { stats } = ctx;
  return `${pageHead('Climate Radar · 美国除湿机与移动空调选品情报')}
<h1>别人抄得走你的网页，抄不走你三年前存下的价格和型号表。</h1>
<p class="sub">给做美国市场的中小卖家：每周一份除湿机 / 移动空调 / 空气处理的竞品与召回情报。所有规格换成同一把尺子，所有召回对上具体型号。</p>
<div class="grid">
  <div class="card"><div class="kpi">${stats.products}</div><div class="kpi-label">本期追踪型号</div></div>
  <div class="card"><div class="kpi">${stats.stores}</div><div class="kpi-label">独立站</div></div>
  <div class="card"><div class="kpi">${stats.recentRecalls}</div><div class="kpi-label">近三年相关召回</div></div>
</div>
<h2>你每周拿到什么</h2>
<table><tbody>
<tr><td><strong>召回雷达</strong></td><td>CPSC 一发布就进报告，标注受影响品牌、型号、销量，以及是否命中你正在卖的同款工厂。</td></tr>
<tr><td><strong>同一把尺子</strong></td><td>除湿量按 DOE-2019、制冷量按 SACC 统一；没写标准的型号单独列出来，告诉你哪些数字不能比。</td></tr>
<tr><td><strong>谁在动</strong></td><td>谁降价、谁断货、谁上新；价格历史从第一期开始累积，越用越值钱。</td></tr>
<tr><td><strong>三句话结论</strong></td><td>本周跟不跟、跟谁、别碰什么。表格是原料，结论才是产品。</td></tr>
</tbody></table>
<h2>价格</h2>
<div class="card"><div class="kpi">$${SITE.priceMonthly}<span style="font-size:18px;color:var(--muted)">/月</span></div>
<p class="sub">${esc(SITE.earlyNote || '早鸟价')}。年付 $${SITE.priceYearly}。</p>
<p class="sub">付款由 Paddle 处理（名义卖家模式），自动代扣美国销售税与欧洲 VAT，中国大陆个人可直接收款。</p>
${SITE.paddleYearlyUrl ? `<p><a class="cta" href="${esc(SITE.paddleYearlyUrl)}" rel="noopener" style="background:transparent;border:1px solid var(--accent);color:var(--accent)">改年付 $${SITE.priceYearly}（省 $${SITE.priceMonthly * 12 - SITE.priceYearly}）</a></p>` : ''}</div>
<p style="margin-top:20px">${SITE.paddleCheckoutUrl ? `<a class="cta" href="${esc(SITE.paddleCheckoutUrl)}" rel="noopener">订阅，收每周情报</a> <a class="cta" style="background:transparent;border:1px solid var(--line);color:var(--text);margin-left:8px" href="report/latest.html">先看本期样板报告</a>` : `<a class="cta" href="report/latest.html">先看本期样板报告</a>`} <a class="cta" style="background:transparent;border:1px solid var(--line);color:var(--text);margin-left:8px" href="model/index.html">按型号查</a></p>
${SITE.contactEmail && !SITE.paddleCheckoutUrl ? `<p class="sub">想先订：<a href="mailto:${esc(SITE.contactEmail)}?subject=${encodeURIComponent('Climate Radar 早鸟订阅')}">发邮件到 ${esc(SITE.contactEmail)}</a>，写明你的品类和店铺链接，我给你开通。</p>` : ''}
<h2>怎么运作</h2>
<p>每周一自动抓取公开商品页与官方召回库，生成报告并发布到这里。人工只做一件事：确认那三句话。</p>
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
  if (!comps.length) { comps = byPrice(pool).slice(0, 6); compTitle = '同品类在售（按价格接近）'; }
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
${compRows ? `<table><thead><tr><th>型号</th><th style="width:120px">能力</th><th style="width:90px">价格</th><th style="width:110px">单位价</th></tr></thead><tbody>${compRows}</tbody></table>` : '<p class="sub">本期没有能力接近的其他品牌在售型号。</p>'}

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
  return `${pageHead('型号库 · 全部在售机型', '按品牌与能力整理的除湿机、移动空调、空气净化器等型号库，含价格、规格口径与召回记录。')}
<nav class="crumbs"><a href="${SITE.baseUrl ? esc(SITE.baseUrl) : '../index.html'}">首页</a> › 型号库</nav>
<h1>型号库</h1>
<p class="sub">本期 ${ctx.catalog.length} 个在售型号，数据日期 ${esc(ctx.date)}。点开任意型号，看它的口径校验、同类竞品单位价与品牌召回记录。</p>
${sections}
${pageFoot('../')}`;
}

function renderEmail(ctx) {
  const { stats, diff, recalls, date: d, issue } = ctx;
  const hits = recalls.filter((r) => (r.matchedBrands.length || r.matchedSku) && r.date >= '2025-01-01').slice(0, 4);
  const drops = diff.priceDrop.slice(0, 4);
  const dropRows = drops.map((p) => `<tr><td style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:15px">${esc(p.title)}<div style="color:#6b7280;font-size:13px">${esc(p.domain)}</div></td><td style="padding:8px 0;border-bottom:1px solid #e5e7eb;text-align:right;font-size:15px;white-space:nowrap"><s style="color:#9ca3af">$${p.oldPrice}</s> <b>$${p.price}</b> <span style="color:#047857">${Math.round(p.delta * 100)}%</span></td></tr>`).join('');
  const hitRows = hits.map((r) => `<tr><td style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:15px"><a href="${esc(r.url)}" style="color:#0f766e">${esc(r.title)}</a><div style="color:#6b7280;font-size:13px">${esc(r.date)}｜命中 ${esc(r.matchedBrands.join('、') || '型号')}</div></td></tr>`).join('');
  const link = SITE.baseUrl ? `${SITE.baseUrl}report/latest.html` : 'report/latest.html';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>第 ${issue} 期｜${esc(d)}</title></head>
<body style="margin:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#111827">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
<div style="font-size:13px;letter-spacing:1px;color:#0f766e;font-weight:700">${esc(SITE.name.toUpperCase())}</div>
<h1 style="font-size:22px;margin:8px 0 4px">第 ${issue} 期：本周除湿机/移动空调情报</h1>
<div style="color:#6b7280;font-size:14px;margin-bottom:18px">${esc(d)}｜${stats.stores} 家独立站｜${stats.products} 个型号</div>
<div style="background:#fff;border-radius:12px;padding:18px 20px;margin-bottom:16px">
<p style="margin:0 0 10px;font-size:16px;line-height:1.7"><b>三句话：</b>共 ${stats.totalRecalls} 条相关召回（含历史），${stats.hitRecalls} 条命中你监控的品牌；${stats.incomparable} 个型号 BTU/除湿量未写标准，不能直接比价；本期 ${diff.priceDrop.length} 个型号降价 5% 以上${diff.fresh.length ? `，${diff.fresh.length} 个新上架` : ''}。</p>
</div>
${hitRows ? `<div style="background:#fff;border-radius:12px;padding:18px 20px;margin-bottom:16px"><h2 style="font-size:16px;margin:0 0 8px">召回命中</h2><table style="width:100%;border-collapse:collapse">${hitRows}</table></div>` : ''}
${dropRows ? `<div style="background:#fff;border-radius:12px;padding:18px 20px;margin-bottom:16px"><h2 style="font-size:16px;margin:0 0 8px">谁在降价</h2><table style="width:100%;border-collapse:collapse">${dropRows}</table></div>` : ''}
<div style="text-align:center;margin:22px 0"><a href="${esc(link)}" style="display:inline-block;background:#0f766e;color:#fff;font-weight:700;padding:12px 26px;border-radius:10px;text-decoration:none">看完整本期报告</a></div>
<div style="color:#6b7280;font-size:12px;line-height:1.6">数据来自品牌官网公开商品页与美国消费品安全委员会（CPSC）公开数据库；仅覆盖公开独立站，不含亚马逊等平台内部数据。本邮件不构成法律或合规意见。</div>
<div style="color:#9ca3af;font-size:12px;margin-top:10px">你收到这封邮件是因为订阅了 ${esc(SITE.name)}。回复本邮件可退订。</div>
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
    recentRecalls: recalls.filter((r) => r.date >= threeYearsAgo).length,
    hitRecalls: recalls.filter((r) => r.matchedBrands.length || r.matchedSku).length,
    totalRecalls: recalls.length,
    priceHidden: catalog.filter((p) => p.spec.priceHidden).length,
    priceMissing: catalog.filter((p) => !p.price).length,
    skipped,
    carriedForward,
  };
  await fs.mkdir(path.join(OUT, 'report'), { recursive: true });
  const priorReports = (await fs.readdir(path.join(OUT, 'report')).catch(() => []))
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
  await fs.writeFile(path.join(OUT, 'report', `${runDate}.html`), renderReport(ctx));
  await fs.writeFile(path.join(OUT, 'report', 'latest.html'), renderReport(ctx));
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
  const emailSubject = `[${SITE.name} 第 ${issue} 期] ${stats.hitRecalls} 条品牌召回命中｜${diff.priceDrop.length} 个降价`;
  await fs.writeFile(path.join(OUT, 'email', 'subject.txt'), emailSubject);

  const issues = (await fs.readdir(path.join(OUT, 'report')))
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
