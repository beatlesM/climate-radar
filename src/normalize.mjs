import { stripHtml, uniq, parsePrice, round2 } from './lib.mjs';

export const CATS = [
  { id: 'portable-ac', label: '移动空调', re: /portable\s*(?:air\s*conditioner|ac|a\/c)|portable ac\b|spot cooler|floor\s*air\s*conditioner/i },
  { id: 'window-ac', label: '窗式空调', re: /window\s*(?:air\s*conditioner|ac|a\/c)|window ac\b/i },
  { id: 'dehumidifier', label: '除湿机', re: /dehumidif/i },
  { id: 'air-purifier', label: '空气净化器', re: /air\s*purif/i },
  { id: 'humidifier', label: '加湿器', re: /humidif(?!ier\s*filter)/i },
  { id: 'heater', label: '取暖器', re: /space\s*heater|ceramic\s*heater|electric\s*heater|\bheaters?\b/i },
  { id: 'fan', label: '风扇', re: /tower\s*fan|air\s*circulator|\bfan\b/i },
];

export const ACCESSORY = /(replacement|filter|filters|hose|window\s*kit|seal\s*kit|remote|cover|bracket|adapter|wick|brush|cleaner|desiccant|refill|pad\b|accessor|part\b|strap|mount|bucket|drain\s*pan|protection\s*plan|warranty|extended\s*coverage|refurbish|renewed|open\s*box|gift\s*card|bundle|sample|spare\b)/i;

const STRONG = /purifier|dehumidifier|humidifier|heater|\bfan\b|air\s*conditioner|circulator/i;
const HARD_ACCESSORY = /open\s*box|refurbish|renewed|^(remote|replacement|filter|filters|hose|drain\s*hose|kit|cover|bracket|adapter)\b|\bremote\s+(control\s+)?for\b|replacement|filters?\s+for|compatible\s+with|cleaning\s+kit|removal\s+tool|\brefill\b|hanging\s*kit|price\s*difference|purchase\s+the\b|\bsensor\b|drain\s*tube|starter\s*kit|prefilter|filters?\s+\d+\s*pack|\b(intake\/exhaust|venting)\s+hose\b|booster\s+pad|\blifter\b|remote\s+control(ler)?\s*$|\badapter\s+for\b|drain\s+bucket|pump\s+parts|hose\s+kit|aroma\s+pad|pads?\s+\d+-pack|universal\s+fit/i;

export function isAccessory(title = '') {
  const t = String(title);
  if (HARD_ACCESSORY.test(t)) return true;
  return ACCESSORY.test(t) && !STRONG.test(t);
}

const DISQUALIFY = /mini[-\s]*split|mini\s*split|ductless|split\s*system|multi[-\s]*zone|central\s*air|evaporative\s*cooler|swamp\s*cooler/i;

export function detectCategory(product) {
  const hay = `${product.title} ${product.product_type ?? ''} ${(product.tags ?? []).join(' ')}`;
  if (DISQUALIFY.test(hay)) return null;
  for (const cat of CATS) if (cat.re.test(hay)) return cat;
  return null;
}

const num = (s) => Number(String(s).replace(/,/g, ''));

export function extractSpec(product) {
  const body = String(product.body_html ?? '');
  const meta = `${product.title} ${product.product_type ?? ''} ${(product.tags ?? []).join(' ')}`;
  const text = stripHtml(`${meta} || ${body}`);

  const btuPairs = [];
  for (const m of text.matchAll(/(\d{1,2},?\d{3})\s*(?:btu|btus)\s*\(?\s*(ashrae|sacc|doe)?/gi)) {
    const v = num(m[1]);
    const std = (m[2] || '').toUpperCase();
    if (v >= 3000 && v <= 30000) btuPairs.push({ v, std });
  }
  const btuAshrae = btuPairs.find((p) => p.std === 'ASHRAE')?.v ?? null;
  const btuSacc = btuPairs.find((p) => p.std === 'SACC')?.v ?? null;
  const btus = uniq(btuPairs.map((p) => p.v)).sort((a, b) => b - a);

  const readPints = (s) => uniq([...s.matchAll(/(\d{2,3})\s*(?:pint|pints|pt\.?)\b/gi)]
    .map((m) => Number(m[1]))
    .filter((v) => v >= 20 && v <= 400)).sort((a, b) => b - a);
  const titlePints = readPints(meta);
  const pints = titlePints.length ? titlePints : readPints(text);

  const sqft = uniq([...text.matchAll(/(\d{2,4}(?:,\d{3})?)\s*(?:sq\.?\s*ft|sqft|square\s*feet)/gi)]
    .map((m) => num(m[1]))
    .filter((v) => v >= 50 && v <= 5000)).sort((a, b) => b - a);

  const tank = text.match(/(\d+(?:\.\d+)?)\s*(?:gal|gallon)/i);
  const liters = uniq([...text.matchAll(/(\d+(?:\.\d+)?)\s*(?:l\b|litre|liter)/gi)]
    .map((m) => Number(m[1]))
    .filter((v) => v >= 5 && v <= 80)).sort((a, b) => b - a);
  const refrig = text.match(/\bR[-\s]?(32|410A|290|134A|454B)\b/i);
  const certs = ['ENERGY STAR', 'ETL', 'UL', 'AHAM', 'CARB'].filter((c) =>
    new RegExp(c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text));

  const flags = [];
  const usesSacc = /\bsacc\b|seasonal\s*adjusted/i.test(text);
  const usesAshrae = /\bashrae\b/i.test(text);
  const usesDoe = /2019\s*doe|doe\s*2019|department\s*of\s*energy|65\s*°?\s*f/i.test(text);

  const variants = product.variants ?? [];
  const first = variants[0] ?? {};
  let price = parsePrice(first.price);
  let compare = parsePrice(first.compare_at_price);
  let priceHidden = false;
  if (price != null && price <= 1) { price = null; compare = null; priceHidden = true; }
  const available = variants.some((v) => v.available);

  return {
    price,
    compare,
    priceHidden,
    available,
    sku: first.sku || '',
    barcode: first.barcode || '',
    spec: {
      btu: btuSacc ?? btuAshrae ?? (btus[0] ?? null),
      btuAshrae,
      btuSacc,
      btuAll: btus.slice(0, 4),
      pints: pints[0] ?? null,
      liters: liters[0] ?? null,
      pintsEq: liters[0] ? Math.round(liters[0] * 2.113) : null,
      sqft: sqft[0] ?? null,
      tankGal: tank ? Number(tank[1]) : null,
      refrigerant: refrig ? `R${refrig[1].toUpperCase()}` : null,
      certs,
      standard: btuSacc ? 'SACC' : btuAshrae ? 'ASHRAE' : usesSacc ? 'SACC' : usesDoe ? 'DOE-2019' : usesAshrae ? 'ASHRAE' : null,
      flags,
      excerpt: text.slice(0, 700),
      unitCount: variants.length,
      discount: compare && price && compare > price ? round2((compare - price) / compare) : null,
    },
  };
}

export function buildFlags(catId, spec) {
  const flags = [];
  if (catId === 'portable-ac' && (spec.btuAshrae || spec.btuSacc || spec.btu)) {
    if (spec.btuSacc && spec.btuAshrae) flags.push({ code: 'ok-both', text: `双标：ASHRAE ${spec.btuAshrae.toLocaleString()} / SACC ${spec.btuSacc.toLocaleString()}，可直接比` });
    else if (spec.btuSacc) flags.push({ code: 'ok-sacc', text: '只标 SACC，口径正确' });
    else if (spec.btuAshrae) flags.push({ code: 'sacc-gap', text: `只标 ASHRAE ${spec.btuAshrae.toLocaleString()}，不是可比制冷量` });
    else flags.push({ code: 'btu-unstated', text: 'BTU 未注明标准，不可直接比' });
  }
  if (catId === 'dehumidifier' && spec.pints) {
    if (spec.standard === 'DOE-2019') flags.push({ code: 'ok-doe', text: '标注 DOE-2019，可直接比' });
    else flags.push({ code: 'pint-unstated', text: '除湿量未注明标准，新旧数据不可比' });
  }
  if (catId === 'dehumidifier' && !spec.pints && spec.liters) {
    flags.push({ code: 'eu-liters', text: `按升标（${spec.liters}L ≈ ${spec.pintsEq} pint），未按 DOE 折算` });
  }
  return flags;
}

export function toSnapshotProduct(store, product, cat, extracted) {
  const spec = { ...extracted.spec };
  spec.flags = buildFlags(cat.id, spec);
  const discontinued = /discontinued|no longer available/i.test(product.title || '');
  if (discontinued) {
    spec.discontinued = true;
    spec.flags.push({ code: 'discontinued', text: '已停产' });
  }
  if (extracted.priceHidden) {
    spec.priceHidden = true;
    spec.flags.push({ code: 'price-hidden', text: '官网未显示有效价格（占位价）' });
  }
  if (/pre-?sale|pre-?order|early\s*bird\s*deposit|\bdeposit\b/i.test(product.title || '')) {
    spec.preorder = true;
    spec.flags.push({ code: 'preorder', text: '预售/定金价，不是成交价' });
  }
  return {
    handle: product.handle,
    title: product.title,
    type: product.product_type || '',
    vendor: product.vendor || store.brand,
    cat: cat.id,
    url: product.permalink || `https://${store.domain}/products/${product.handle}`,
    price: extracted.price,
    compare: extracted.compare,
    available: discontinued ? false : extracted.available,
    created: (product.created_at || '').slice(0, 10),
    updated: (product.updated_at || '').slice(0, 10),
    sku: extracted.sku,
    barcode: extracted.barcode,
    spec,
  };
}
