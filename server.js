// ZoraSkin Backend v8.3 — TikTok Apify-Integration + alles aus v8.2
// NEU: Apify TikTok Discovery (Phase 1) + Apify Hashtag-Lookup (Phase 2, parallel zu CJ)
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { URLSearchParams } = require('url');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const CONFIG = {
  CJ_EMAIL: process.env.CJ_EMAIL || '',
  CJ_KEY: process.env.CJ_KEY || '',
  SHOPIFY_DOMAIN: process.env.SHOPIFY_DOMAIN || '',
  SHOPIFY_CLIENT_ID: process.env.SHOPIFY_CLIENT_ID || '',
  SHOPIFY_CLIENT_SECRET: process.env.SHOPIFY_CLIENT_SECRET || '',
  CLAUDE_KEY: process.env.CLAUDE_KEY || '',
  APIFY_TOKEN: process.env.APIFY_TOKEN || '',
  CLAUDE_MODEL_TRENDS: 'claude-sonnet-4-6',
  CLAUDE_MODEL_COPY: 'claude-haiku-4-5-20251001',
  CLAUDE_MODEL_VISION: 'claude-haiku-4-5-20251001',
  SHOPIFY_API_VERSION: '2026-01',
  ENABLE_IMAGE_SANITY_CHECK: process.env.ENABLE_IMAGE_SANITY_CHECK === 'true',
  // Apify Actor-IDs (Format: username~actor-name)
  APIFY_DISCOVERY_ACTOR: 'data_xplorer~tiktok-trends',
  APIFY_LOOKUP_ACTOR: 'parseforge~tiktok-hashtag-analytics-scraper',
};

const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';
const APIFY_BASE = 'https://api.apify.com/v2';

let shopifyToken = '', shopifyTokenExpiry = 0;
let cjToken = '', cjTokenExpiry = 0;
let beautyCategoryIds = null;
let beautyCategoryNames = [];

// ============= AUTH =============
async function getShopifyToken() {
  if (shopifyToken && Date.now() < shopifyTokenExpiry - 60000) return shopifyToken;
  const r = await fetch(`https://${CONFIG.SHOPIFY_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CONFIG.SHOPIFY_CLIENT_ID,
      client_secret: CONFIG.SHOPIFY_CLIENT_SECRET
    })
  });
  if (!r.ok) throw new Error(`Shopify Token: ${r.status}`);
  const d = await r.json();
  shopifyToken = d.access_token;
  shopifyTokenExpiry = Date.now() + (d.expires_in || 86399) * 1000;
  return shopifyToken;
}

async function getCJToken() {
  if (cjToken && Date.now() < cjTokenExpiry - 60000) return cjToken;
  const r = await fetch(`${CJ_BASE}/authentication/getAccessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: CONFIG.CJ_EMAIL, password: CONFIG.CJ_KEY })
  });
  const d = await r.json();
  if (!d.result || !d.data?.accessToken) throw new Error('CJ Auth fehlgeschlagen');
  cjToken = d.data.accessToken;
  cjTokenExpiry = Date.now() + 1000 * 60 * 60 * 23;
  return cjToken;
}

// ============= APIFY HELPER =============
// Synchron-Endpoint: POST run-sync-get-dataset-items
// Default Timeout 5 Min, kann via timeout query param erhöht werden
async function runApifyActor(actorId, input, options = {}) {
  if (!CONFIG.APIFY_TOKEN) throw new Error('APIFY_TOKEN fehlt');
  const timeoutSec = options.timeoutSec || 300;  // 5 Min default
  const url = `${APIFY_BASE}/acts/${actorId}/run-sync-get-dataset-items?token=${CONFIG.APIFY_TOKEN}&timeout=${timeoutSec}`;

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input || {}),
    timeout: (timeoutSec + 30) * 1000,  // node-fetch timeout etwas länger als Apify
  });

  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Apify ${actorId} ${r.status}: ${errText.slice(0,300)}`);
  }
  // run-sync-get-dataset-items liefert direkt das Array
  const data = await r.json();
  return Array.isArray(data) ? data : [];
}

// ============= APIFY: TIKTOK DISCOVERY =============
// Sucht aktuell trending Beauty-Hashtags auf TikTok Creative Center
async function discoverTikTokTrends(options = {}, log = () => {}) {
  const { country = 'US', period = '30', maxResults = 50 } = options;

  if (!CONFIG.APIFY_TOKEN) {
    log('Apify-Token fehlt, TikTok-Discovery übersprungen', 'warn');
    return [];
  }

  log(`TikTok Discovery: Beauty-Hashtags ${country} letzte ${period} Tage`, 'info');

  // data_xplorer/tiktok-trends Input-Schema
  const input = {
    scrapeHashtags: true,
    scrapeVideos: false,
    scrapeCreators: false,
    scrapeSongs: false,
    hashtagCountries: [country],
    hashtagIndustries: ['Beauty & Personal Care'],
    hashtagPeriod: period,
    hashtagMaxItems: maxResults,
    hashtagNewOnly: false,
  };

  try {
    const items = await runApifyActor(CONFIG.APIFY_DISCOVERY_ACTOR, input, { timeoutSec: 180 });
    log(`✓ TikTok Discovery: ${items.length} Hashtags erhalten`, 'ok');

    return items.map(item => ({
      hashtag: item.hashtag_name || item.hashtagName || item.name || item.hashtag,
      rank: item.rank,
      industry: item.industry,
      country: item.country || country,
      videoCount: item.publishCnt || item.videoCount || item.video_count || 0,
      views: item.videoViews || item.views || 0,
      rankChange: item.rankChange || item.rank_change || 0,
      trendType: item.trendType,
      raw: item,
    })).filter(t => t.hashtag);
  } catch(e) {
    log(`TikTok Discovery Fehler: ${e.message}`, 'err');
    return [];
  }
}

// ============= APIFY: TIKTOK HASHTAG-LOOKUP =============
// Holt detaillierte Analytics für ein spezifisches Hashtag
async function lookupHashtagAnalytics(hashtags, options = {}, log = () => {}) {
  const { country = 'US' } = options;
  if (!CONFIG.APIFY_TOKEN || !hashtags?.length) return [];

  // Hashtags säubern: ohne #, lowercase, ohne Spaces
  const cleanHashtags = hashtags.map(h => h.replace(/^#/, '').toLowerCase().replace(/\s+/g, ''));
  log(`TikTok Lookup: ${cleanHashtags.length} Hashtags Detail-Analyse`, 'info');

  const input = {
    hashtags: cleanHashtags,
    country: country,
    mode: 'lookup',
  };

  try {
    const items = await runApifyActor(CONFIG.APIFY_LOOKUP_ACTOR, input, { timeoutSec: 240 });
    log(`✓ TikTok Lookup: ${items.length} Detailberichte`, 'ok');

    return items.map(item => ({
      hashtag: item.hashtag_name || item.hashtagName || item.name,
      views7d: item.views7d || item.views_7d || 0,
      viewsTotal: item.viewsTotal || item.views_total || item.views || 0,
      videoCount: item.publishCnt || item.videoCount || 0,
      audienceAges: item.audienceAges || item.audience_ages || [],
      audienceInterests: item.audienceInterests || item.audience_interests || [],
      topCountries: item.topCountries || item.top_countries || [],
      relatedHashtags: item.relatedHashtags || item.related_hashtags || [],
      topCreators: item.topCreators || item.top_creators || [],
      topVideos: item.topVideos || item.top_videos || [],
      trendChart: item.trendChart || item.trend_chart || [],
      raw: item,
    }));
  } catch(e) {
    log(`TikTok Lookup Fehler: ${e.message}`, 'err');
    return [];
  }
}

// ============= BEAUTY-KATEGORIEN AUTO-DISCOVERY =============
const BEAUTY_CATEGORY_KEYWORDS = [
  'beauty', 'skin', 'hair', 'cosmetic', 'makeup', 'personal care',
  'face', 'eye', 'lip', 'nail', 'oral', 'dental', 'massage', 'spa',
  'health', 'wellness', 'fragrance', 'perfume', 'body care'
];

async function loadBeautyCategoryIds(cjt, log = () => {}) {
  if (beautyCategoryIds) return { ids: beautyCategoryIds, names: beautyCategoryNames };

  try {
    const r = await fetch(`${CJ_BASE}/product/getCategory`, {
      headers: { 'CJ-Access-Token': cjt }
    });
    const d = await r.json();
    if (!d.result || !d.data) {
      log('Beauty-Kategorien konnten nicht geladen werden', 'warn');
      beautyCategoryIds = [];
      return { ids: [], names: [] };
    }

    const ids = [];
    const names = [];
    for (const lv1 of (d.data || [])) {
      const lv1Name = (lv1.categoryFirstName || '').toLowerCase();
      const lv1Beauty = BEAUTY_CATEGORY_KEYWORDS.some(kw => lv1Name.includes(kw));
      for (const lv2 of (lv1.categoryFirstList || [])) {
        const lv2Name = (lv2.categorySecondName || '').toLowerCase();
        const lv2Beauty = BEAUTY_CATEGORY_KEYWORDS.some(kw => lv2Name.includes(kw));
        for (const lv3 of (lv2.categorySecondList || [])) {
          const lv3Name = (lv3.categoryName || '').toLowerCase();
          const lv3Beauty = BEAUTY_CATEGORY_KEYWORDS.some(kw => lv3Name.includes(kw));
          if (lv1Beauty || lv2Beauty || lv3Beauty) {
            ids.push(lv3.categoryId);
            names.push(`${lv1.categoryFirstName} > ${lv2.categorySecondName} > ${lv3.categoryName}`);
          }
        }
      }
    }
    beautyCategoryIds = ids;
    beautyCategoryNames = names;
    log(`✓ ${ids.length} Beauty-Kategorien aus CJ geladen`, 'ok');
    return { ids, names };
  } catch(e) {
    log(`Beauty-Kategorien Error: ${e.message}`, 'warn');
    beautyCategoryIds = [];
    return { ids: [], names: [] };
  }
}

// ============= BEAUTY-FILTER =============
const BEAUTY_WORDS = ['skin','face','beauty','hair','eye','lip','mask','serum','cream','roller','gua','jade','light therapy','whitening','massager','scrubber','razor','vitamin','collagen','therapy','lift','pore','acne','tone','glow','bright','anti aging','wrinkle','moistur','sunscreen','retinol','peptide','hyaluronic','niacin','lash','brow','neck','scalp','dental','teeth','charcoal','exfoli','cleanser','toner','essence','lotion','mist','spray','patch','strip','sponge','blender','brush','eyelid','cellulite','contouring','derma','microcurrent','radiofrequency','infrared','spa','facial','wand','globe','ice','steamer','nose','blackhead','red light','led light'];
const NON_BEAUTY = ['vacuum cleaner','car ','automotive','kitchen','food ','pet ','toy ','gaming','computer','phone case','cable','charger','tool','drill','bicycle','sport shoe','fishing','garden','furniture','mattress','curtain','laptop','tablet','headphone','keyboard','mouse pad','watch band','mobile phone','camera','speaker','audio','remote control'];

function containsBeautyWord(name) {
  const n = (name || '').toLowerCase();
  return BEAUTY_WORDS.some(w => n.includes(w));
}
function containsNonBeauty(name) {
  const n = (name || '').toLowerCase();
  return NON_BEAUTY.some(nb => n.includes(nb));
}

// ============= CJ V2 SEARCH =============
async function searchProductsV2(cjt, params) {
  const queryParams = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v === null || v === undefined || v === '') return;
    if (Array.isArray(v)) v.forEach(item => queryParams.append(k, item));
    else queryParams.append(k, String(v));
  });

  const url = `${CJ_BASE}/product/listV2?${queryParams.toString()}`;
  const r = await fetch(url, { headers: { 'CJ-Access-Token': cjt } });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`CJ V2 Search ${r.status}: ${errText.slice(0,200)}`);
  }
  const d = await r.json();
  if (!d.result) throw new Error(`CJ V2 Search Error: ${d.message || 'unknown'}`);

  const products = [];
  for (const block of (d.data?.content || [])) {
    for (const p of (block.productList || [])) {
      products.push({
        pid: p.id,
        productNameEn: p.nameEn,
        productImage: p.bigImage,
        sellPrice: parseFloat(p.sellPrice || p.nowPrice || 0),
        nowPrice: p.nowPrice ? parseFloat(p.nowPrice) : null,
        discountPriceRate: p.discountPriceRate,
        listedNum: p.listedNum || 0,
        categoryId: p.categoryId,
        threeCategoryName: p.threeCategoryName,
        twoCategoryName: p.twoCategoryName,
        oneCategoryName: p.oneCategoryName,
        categoryName: p.threeCategoryName || p.twoCategoryName || p.oneCategoryName,
        addMarkStatus: p.addMarkStatus,
        isVideo: p.isVideo,
        videoList: p.videoList || [],
        warehouseInventoryNum: p.warehouseInventoryNum || 0,
        totalVerifiedInventory: p.totalVerifiedInventory || 0,
        verifiedWarehouse: p.verifiedWarehouse,
        hasCECertification: p.hasCECertification,
        deliveryCycle: p.deliveryCycle,
        description: p.description,
        supplierName: p.supplierName,
      });
    }
  }
  return { products, total: d.data?.totalRecords || 0 };
}

async function searchProductsV1Fallback(cjt, keyword, page = 1) {
  const r = await fetch(`${CJ_BASE}/product/list?productNameEn=${encodeURIComponent(keyword)}&pageNum=${page}&pageSize=20`, {
    headers: { 'CJ-Access-Token': cjt }
  });
  const d = await r.json();
  return (d.data?.list || []).map(p => ({
    pid: p.pid,
    productNameEn: p.productNameEn,
    productImage: p.productImage,
    sellPrice: parseFloat(p.sellPrice || 0),
    listedNum: p.listedNum || 0,
    categoryName: p.categoryName,
    categoryId: p.categoryId,
  }));
}

async function findCJProductsForTrend(cjt, trend, log = () => {}) {
  const beautyCats = beautyCategoryIds || [];
  const keyword = trend.cjKeyword;
  let result = null;

  if (beautyCats.length > 0) {
    try {
      result = await searchProductsV2(cjt, {
        keyWord: keyword, page: 1, size: 30,
        lv3categoryList: beautyCats,
        verifiedWarehouse: 1, addMarkStatus: 1,
        productFlag: 0, orderBy: 1, sort: 'desc',
        startWarehouseInventory: 50, zonePlatform: 'shopify',
        features: ['enable_category', 'enable_video'],
      });
      if (result.products.length > 0) log(`  Strategie 1 (Trending+Verified+Beauty): ${result.products.length}`, 'info');
    } catch(e) { log(`  Strategie 1 fehlgeschlagen: ${e.message}`, 'warn'); }
  }

  if (!result || result.products.length < 5) {
    try {
      const r2 = await searchProductsV2(cjt, {
        keyWord: keyword, page: 1, size: 30,
        lv3categoryList: beautyCats.length > 0 ? beautyCats : undefined,
        verifiedWarehouse: 1, orderBy: 1, sort: 'desc',
        features: ['enable_category'],
      });
      if (r2.products.length > 0) {
        log(`  Strategie 2 (Verified+Beauty): ${r2.products.length}`, 'info');
        result = result && result.products.length > 0
          ? { products: [...result.products, ...r2.products.filter(p => !result.products.some(x => x.pid === p.pid))] }
          : r2;
      }
    } catch(e) { log(`  Strategie 2 fehlgeschlagen: ${e.message}`, 'warn'); }
  }

  if (!result || result.products.length < 3) {
    try {
      const r3 = await searchProductsV2(cjt, {
        keyWord: keyword, page: 1, size: 30,
        orderBy: 1, sort: 'desc', features: ['enable_category'],
      });
      if (r3.products.length > 0) {
        log(`  Strategie 3 (nur Keyword): ${r3.products.length}`, 'info');
        const filtered = r3.products.filter(p =>
          !containsNonBeauty(p.productNameEn) && containsBeautyWord(p.productNameEn)
        );
        result = result && result.products.length > 0
          ? { products: [...result.products, ...filtered.filter(p => !result.products.some(x => x.pid === p.pid))] }
          : { products: filtered };
      }
    } catch(e) { log(`  Strategie 3 fehlgeschlagen: ${e.message}`, 'warn'); }
  }

  if (!result || result.products.length === 0) {
    try {
      log(`  V1-Fallback wird versucht...`, 'warn');
      const v1 = await searchProductsV1Fallback(cjt, keyword, 1);
      const filtered = v1.filter(p => !containsNonBeauty(p.productNameEn) && containsBeautyWord(p.productNameEn));
      result = { products: filtered };
    } catch(e) { log(`  V1-Fallback fehlgeschlagen: ${e.message}`, 'err'); return []; }
  }
  return result?.products || [];
}

// ============= SCORING =============
function scoreProduct(p, trend) {
  let score = 0;
  const reasons = [];
  if (p.listedNum > 0) {
    const listScore = Math.min(30, Math.log10(p.listedNum + 1) * 10);
    score += listScore;
    reasons.push(`Listings:+${Math.round(listScore)}`);
  }
  if (p.productImage && p.productImage.startsWith('https://')) score += 10;
  if (beautyCategoryIds && beautyCategoryIds.includes(p.categoryId)) {
    score += 15; reasons.push('BeautyCat:+15');
  }
  const name = (p.productNameEn || '').toLowerCase();
  const kwWords = (trend.cjKeyword || '').toLowerCase().split(' ').filter(w => w.length > 2);
  const kwMatch = kwWords.filter(w => name.includes(w)).length;
  if (kwMatch > 0) { score += kwMatch * 8; reasons.push(`KwMatch:+${kwMatch * 8}`); }
  const beautyHits = BEAUTY_WORDS.filter(w => name.includes(w)).length;
  if (beautyHits > 0) { score += Math.min(15, beautyHits * 3); reasons.push(`BeautyKw:+${Math.min(15, beautyHits * 3)}`); }
  if (containsNonBeauty(name)) { score -= 50; reasons.push('NonBeauty:-50'); }
  if (p.verifiedWarehouse === 1) { score += 10; reasons.push('Verified:+10'); }
  if (p.warehouseInventoryNum > 100) { score += 5; reasons.push('Stock:+5'); }
  if (p.addMarkStatus === 1) { score += 5; reasons.push('FreeShip:+5'); }
  if (p.isVideo === 1 || (p.videoList && p.videoList.length > 0)) { score += 5; reasons.push('Video:+5'); }
  if (p.hasCECertification === 1) { score += 5; reasons.push('CE:+5'); }
  if (p.deliveryCycle && /^[1-5]/.test(p.deliveryCycle)) { score += 5; reasons.push('FastShip:+5'); }
  return { score: Math.round(score), reasons };
}

// ============= CJ DETAILS =============
async function getCJProductDetails(cjt, pid) {
  try {
    const r = await fetch(`${CJ_BASE}/product/query?pid=${pid}&features=enable_video,enable_inventory`, {
      headers: { 'CJ-Access-Token': cjt }
    });
    const d = await r.json();
    if (!d.result || !d.data) return null;
    const p = d.data;
    const images = [];
    const addImg = (img) => {
      if (typeof img === 'string' && img.startsWith('https://') && !images.includes(img)) images.push(img);
    };
    addImg(p.bigImage);
    addImg(p.productImage);
    if (p.productImageSet) {
      const set = typeof p.productImageSet === 'string' ? JSON.parse(p.productImageSet) : p.productImageSet;
      if (Array.isArray(set)) set.forEach(addImg);
    }
    if (Array.isArray(p.variants)) {
      p.variants.forEach(v => {
        addImg(v.variantImage);
        if (v.variantImages) {
          const vi = Array.isArray(v.variantImages) ? v.variantImages : [v.variantImages];
          vi.forEach(addImg);
        }
      });
    }
    return {
      pid: p.pid,
      name: p.productNameEn || p.productName,
      images: images.slice(0, 10),
      mainImage: p.bigImage || images[0] || '',
      ek: parseFloat(p.sellPrice || 0),
      weight: p.productWeight,
      categoryName: p.categoryName,
      description: (p.description || '').slice(0, 600),
      supplierName: p.supplierName,
      videoList: p.productVideo || [],
      hasVideo: (p.productVideo || []).length > 0,
      variants: (p.variants || []).slice(0, 5).map(v => ({
        sku: v.variantSku, name: v.variantNameEn,
        price: v.variantSellPrice, weight: v.variantWeight,
      })),
    };
  } catch(e) { return null; }
}

async function getCJProductReviews(cjt, pid) {
  try {
    const r = await fetch(`${CJ_BASE}/product/productComments?pid=${pid}&pageSize=10`, {
      headers: { 'CJ-Access-Token': cjt }
    });
    const d = await r.json();
    const list = d.data?.list || [];
    if (!list.length) return { count: 0, avgScore: null, topReviews: [] };
    const scores = list.map(r => parseInt(r.score, 10)).filter(s => !isNaN(s));
    const avg = scores.length ? (scores.reduce((a,b) => a+b, 0) / scores.length) : null;
    const top = list.slice(0, 3).map(r => ({
      score: parseInt(r.score, 10),
      text: (r.comment || '').slice(0, 200),
      country: r.countryCode,
      user: r.commentUser,
    }));
    return {
      count: parseInt(d.data?.total || list.length, 10),
      avgScore: avg ? Math.round(avg * 10) / 10 : null,
      topReviews: top,
    };
  } catch(e) { return { count: 0, avgScore: null, topReviews: [] }; }
}

async function getCJStockByPid(cjt, pid) {
  try {
    const r = await fetch(`${CJ_BASE}/product/stock/getInventoryByPid?pid=${pid}`, {
      headers: { 'CJ-Access-Token': cjt }
    });
    const d = await r.json();
    const inv = d.data?.inventories || [];
    return inv.map(i => ({
      country: i.countryCode,
      countryName: i.countryNameEn,
      total: i.totalInventoryNum || 0,
      cjStock: i.cjInventoryNum || 0,
    }));
  } catch(e) { return []; }
}

// ============= IMAGE-SANITY-CHECK =============
async function imageSanityCheck(imageUrl, productName, expectedCategory) {
  if (!CONFIG.ENABLE_IMAGE_SANITY_CHECK || !CONFIG.CLAUDE_KEY) return { ok: true, skipped: true };
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CONFIG.CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: CONFIG.CLAUDE_MODEL_VISION,
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: imageUrl } },
            { type: 'text',
              text: `Product name: "${productName}"\nExpected category: ${expectedCategory}\n\nDoes this image actually show the named beauty/skincare product? Reply ONLY with valid JSON: {"matches":true/false,"reason":"max 8 words"}` }
          ]
        }]
      })
    });
    const d = await r.json();
    const text = d.content?.[0]?.text?.replace(/```json|```/g, '').trim() || '{}';
    const parsed = JSON.parse(text);
    return { ok: parsed.matches !== false, reason: parsed.reason || '' };
  } catch(e) { return { ok: true, error: e.message }; }
}

// ============= PRICING + IMPORT-PREP =============
function calculatePricing(ek, trend) {
  const targetMargin = (trend.estimatedMargin || 70) / 100;
  const priceRange = trend.priceRange || { min: 15, max: 60 };
  let vk = ek / (1 - targetMargin);
  vk = Math.max(vk, priceRange.min);
  vk = Math.min(vk, priceRange.max);
  vk = Math.ceil(vk) - 0.01;
  const compareAt = Math.ceil(vk * 1.3) - 0.01;
  const margin = Math.round((1 - ek / vk) * 100);
  return {
    vk: parseFloat(vk.toFixed(2)),
    compareAt: parseFloat(compareAt.toFixed(2)),
    margin
  };
}

async function prepareProductForImport(cjt, cjProduct, trend, log = () => {}) {
  const [details, reviews, stock] = await Promise.all([
    getCJProductDetails(cjt, cjProduct.pid),
    getCJProductReviews(cjt, cjProduct.pid),
    getCJStockByPid(cjt, cjProduct.pid),
  ]);

  const ek = parseFloat(cjProduct.nowPrice || cjProduct.sellPrice || details?.ek || 0);
  const { vk, compareAt, margin } = calculatePricing(ek, trend);
  const allImages = details?.images || [cjProduct.productImage].filter(Boolean);

  let sanityCheck = { ok: true, skipped: true };
  if (CONFIG.ENABLE_IMAGE_SANITY_CHECK && allImages.length > 0) {
    sanityCheck = await imageSanityCheck(allImages[0], details?.name || cjProduct.productNameEn, trend.category);
    log(`  Image-Check "${(details?.name || '').slice(0,40)}": ${sanityCheck.ok ? '✓' : '✗ ' + (sanityCheck.reason || 'Mismatch')}`, sanityCheck.ok ? 'info' : 'warn');
  }

  const usStock = stock.find(s => s.country === 'US');
  const cnStock = stock.find(s => s.country === 'CN');

  return {
    name: details?.name || cjProduct.productNameEn || trend.name,
    cjId: cjProduct.pid,
    images: allImages,
    mainImage: details?.mainImage || cjProduct.productImage || '',
    imageCount: allImages.length,
    categoryName: details?.categoryName || cjProduct.categoryName,
    description: details?.description || '',
    ek: Math.round(ek * 100) / 100,
    vk, compareAt, margin,
    profit: parseFloat((vk - ek).toFixed(2)),
    listedNum: cjProduct.listedNum || 0,
    deliveryCycle: cjProduct.deliveryCycle,
    isFreeShipping: cjProduct.addMarkStatus === 1,
    hasCECertification: cjProduct.hasCECertification === 1,
    isVerifiedWarehouse: cjProduct.verifiedWarehouse === 1,
    warehouseInventory: cjProduct.warehouseInventoryNum || 0,
    hasVideo: details?.hasVideo || false,
    videoCount: (details?.videoList || []).length,
    supplierName: cjProduct.supplierName || details?.supplierName || '',
    discountPriceRate: cjProduct.discountPriceRate,
    stock: {
      us: usStock?.total || 0,
      cn: cnStock?.total || 0,
      total: stock.reduce((s, x) => s + x.total, 0),
      countries: stock.map(s => s.country),
    },
    reviews: {
      count: reviews.count,
      avgScore: reviews.avgScore,
      topReviews: reviews.topReviews,
    },
    imageSanity: sanityCheck,
    trend: {
      name: trend.name,
      cjKeyword: trend.cjKeyword,
      viralPlatform: trend.viralPlatform,
      trendReason: trend.trendReason,
      monthlySearches: trend.monthlySearches,
      monthlySales: trend.monthlySales,
      threeMonthTrend: trend.threeMonthTrend,
      trendScore: trend.trendScore,
      category: trend.category,
      targetAudience: trend.targetAudience,
      relatedKeywords: trend.relatedKeywords,
      longTailKeywords: trend.longTailKeywords,
      // TikTok-Live-Daten falls vorhanden
      tiktokLive: trend.tiktokLive,
    }
  };
}

async function getExistingTitles(shopToken) {
  const titles = new Set();
  try {
    const r = await fetch(`https://${CONFIG.SHOPIFY_DOMAIN}/admin/api/${CONFIG.SHOPIFY_API_VERSION}/products.json?limit=250&fields=title`, {
      headers: { 'X-Shopify-Access-Token': shopToken }
    });
    const d = await r.json();
    (d.products || []).forEach(p => titles.add(p.title.toLowerCase().trim()));
  } catch(e) {}
  return titles;
}

// ============= TREND-ANALYSE MIT TIKTOK-INPUT =============
async function analyzeTrends(customKeywords = [], count = 15, tiktokTrends = []) {
  if (!CONFIG.CLAUDE_KEY) throw new Error('CLAUDE_KEY fehlt');

  const extra = customKeywords.length > 0
    ? `\n\nIMPORTANT: Also include trends matching these specific user keywords: ${customKeywords.join(', ')}`
    : '';

  // TikTok-Live-Daten als Input für Sonnet
  const tiktokContext = tiktokTrends.length > 0
    ? `\n\nLIVE TIKTOK DATA (April 2026, real Creative Center data):\nThe following Beauty hashtags are CURRENTLY trending on TikTok:\n${tiktokTrends.map((t, i) =>
        `${i+1}. #${t.hashtag} — Rank ${t.rank}, ${t.videoCount?.toLocaleString() || '?'} videos, ${t.views?.toLocaleString() || '?'} views, rank change: ${t.rankChange || 0}`
      ).join('\n')}\n\nIMPORTANT: Use these REAL hashtags as primary input. Match each hashtag to a product trend. Set the "tiktokHashtag" field to the matching hashtag name. Set "dataSource" to "tiktok_live" for trends backed by real TikTok data.`
    : '';

  const prompt = `You are a senior beauty market intelligence analyst with access to global ecommerce data, social listening tools, sales analytics, and search-volume data for April 2026.

Conduct a COMPREHENSIVE A-to-Z product trend analysis. Identify the TOP ${count} beauty/skincare trends RIGHT NOW that are:
- Actively trending on TikTok, Instagram, YouTube Shorts, Amazon
- Strong global sales (US, UK, DE, AU, CA primary markets)
- Suitable for dropshipping (small, lightweight, profitable)
- Price range $10-$100${extra}${tiktokContext}

For EACH trend, provide a complete intelligence report.

Respond ONLY with valid JSON, no markdown:
{
  "analysisDate": "April 2026",
  "totalMarketSize": "$X.X billion",
  "marketGrowthRate": "+X% YoY",
  "topInsights": ["3 top-level insights"],
  "trends": [
    {
      "rank": 1,
      "name": "Product trend name",
      "category": "Skincare Tools",
      "cjKeyword": "2-3 word keyword",
      "tiktokHashtag": "guasha",
      "dataSource": "tiktok_live",
      "avgPrice": 35,
      "priceRange": {"min": 25, "max": 55},
      "monthlySearches": 450000,
      "monthlySales": 85000,
      "salesHistory": {"month1": 62000, "month2": 71000, "month3": 85000},
      "trendVelocity": "+37%",
      "trendPhase": "peak",
      "threeMonthTrend": "growing",
      "trendScore": 94,
      "profitScore": 88,
      "relatedKeywords": ["kw1","kw2","kw3","kw4","kw5"],
      "longTailKeywords": ["phrase 1","phrase 2","phrase 3","phrase 4","phrase 5"],
      "coPurchaseItems": ["item 1","item 2","item 3"],
      "viralPlatform": "TikTok",
      "viralVideos": 1250,
      "trendReason": "1 sentence",
      "sentiment": "positive",
      "competition": "medium",
      "competitorBrands": ["brand1","brand2","brand3"],
      "entryDifficulty": "medium",
      "targetAudience": "Women 25-45",
      "demographics": {"ageRange": "25-45","gender": "85% female","topCountries": ["US","UK","DE"]},
      "seasonality": "evergreen",
      "bestSellingTime": "Year-round",
      "estimatedMargin": 72
    }
  ]
}

CRITICAL: cjKeyword 2-3 generic words. dataSource: tiktok_live (if backed by TikTok hashtag) or estimated. trendPhase: emerging|growing|peak|declining. competition: low|medium|high. seasonality: evergreen|winter|summer|holiday. tiktokHashtag: only if matches a real hashtag from the live data above (without #).`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: CONFIG.CLAUDE_MODEL_TRENDS,
      max_tokens: 16000,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Claude API ${r.status}: ${err.slice(0,200)}`);
  }
  const d = await r.json();
  const truncated = d.stop_reason === 'max_tokens';
  const text = d.content[0].text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(text);
  } catch(e) {
    const repaired = repairTruncatedTrendJson(text);
    if (repaired) {
      console.warn(`[trends] JSON truncated=${truncated}, repariert auf ${repaired.trends?.length || 0}`);
      return repaired;
    }
    throw new Error(`Claude JSON parse error: ${e.message}. Truncated=${truncated}.`);
  }
}

function repairTruncatedTrendJson(text) {
  try {
    const arrayStart = text.indexOf('"trends"');
    if (arrayStart < 0) return null;
    const bracketStart = text.indexOf('[', arrayStart);
    if (bracketStart < 0) return null;
    let depth = 0, inString = false, escape = false, lastValidEnd = -1;
    for (let i = bracketStart + 1; i < text.length; i++) {
      const c = text[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) lastValidEnd = i; }
    }
    if (lastValidEnd < 0) return null;
    return JSON.parse(text.slice(0, lastValidEnd + 1) + '\n  ]\n}');
  } catch(e) { return null; }
}

// ============= MARKETING-CONTENT =============
async function generateContent(product) {
  if (!CONFIG.CLAUDE_KEY) {
    return { hook: product.trend.trendReason, usp: product.name, description: '', bullets: [] };
  }
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: CONFIG.CLAUDE_MODEL_COPY,
        max_tokens: 600,
        messages: [{
          role: 'user',
          content: `Write compelling beauty product copy in English.
Product: ${product.name}
Trending: ${product.trend.trendReason}
Platform: ${product.trend.viralPlatform}
Audience: ${product.trend.targetAudience}
Keywords: ${(product.trend.relatedKeywords || []).join(', ')}
${product.reviews?.avgScore ? `Avg rating: ${product.reviews.avgScore}/5 from ${product.reviews.count} reviews` : ''}

JSON only: {"hook":"emotional 10 word hook","usp":"unique benefit 15 words","description":"2-3 punchy benefit sentences","bullets":["benefit 1","benefit 2","benefit 3","benefit 4","benefit 5"]}`
        }]
      })
    });
    const d = await r.json();
    return JSON.parse(d.content[0].text.replace(/```json|```/g, '').trim());
  } catch(e) {
    return { hook: product.trend.trendReason, usp: product.name, description: '', bullets: [] };
  }
}

async function publishProduct(shopToken, product, content) {
  const bullets = (content.bullets || []).map(b => `<li>${b}</li>`).join('');
  const reviewsHtml = product.reviews?.avgScore
    ? `<p>⭐ <strong>${product.reviews.avgScore}/5</strong> · ${product.reviews.count} reviews</p>` : '';
  const ceHtml = product.hasCECertification ? '<p>🏷️ <strong>CE Certified</strong></p>' : '';
  const tiktokLiveHtml = product.trend.tiktokLive
    ? `<p>📈 <strong>TikTok-verifizierter Trend:</strong> ${product.trend.tiktokLive.viewsTotal?.toLocaleString() || ''} total views, ${product.trend.tiktokLive.videoCount?.toLocaleString() || ''} videos</p>`
    : '';

  const body = {
    product: {
      title: product.name,
      body_html: `<p><strong><em>${content.hook || ''}</em></strong></p>
<p>${content.description || content.usp || ''}</p>
${bullets ? `<ul>${bullets}</ul>` : ''}
${reviewsHtml}
${ceHtml}
${tiktokLiveHtml}
<p>⭐ <strong>Trending on ${product.trend.viralPlatform}:</strong> ${product.trend.trendReason}</p>
<p><em>🌍 Ships worldwide · ↩ 30-day returns · 🔒 Secure payment</em></p>`,
      vendor: 'ZoraSkin',
      product_type: product.trend.category || 'Beauty',
      tags: [
        product.trend.category, 'Trending 2026',
        product.trend.viralPlatform + ' Viral', 'ZoraSkin',
        product.hasCECertification ? 'CE Certified' : null,
        product.isVerifiedWarehouse ? 'Verified Stock' : null,
        product.trend.tiktokLive ? 'TikTok Live Trend' : null,
        ...(product.trend.relatedKeywords || []).slice(0, 3)
      ].filter(Boolean).join(','),
      status: 'active',
      variants: [{
        price: product.vk.toString(),
        compare_at_price: product.compareAt.toString(),
        requires_shipping: true,
        inventory_management: 'shopify',
        inventory_quantity: 999
      }],
      images: product.images.filter(i => i && i.startsWith('https://')).map((src, i) => ({ src, alt: i === 0 ? product.name : `${product.name} ${i + 1}` }))
    }
  };

  const r = await fetch(`https://${CONFIG.SHOPIFY_DOMAIN}/admin/api/${CONFIG.SHOPIFY_API_VERSION}/products.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': shopToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const e = await r.json();
    throw new Error(JSON.stringify(e.errors));
  }
  const d = await r.json();
  return d.product;
}

// ============= ROUTES =============
app.get('/', (req, res) => res.json({
  status: 'ZoraSkin Backend v8.3 — TikTok Apify Integration',
  features: [
    'CJ V2-API mit Elasticsearch + Multi-Strategy',
    'TikTok Discovery via Apify (echte Hashtags US/UK/DE)',
    'TikTok Hashtag-Lookup für Demographics + Top-Videos',
    'Sonnet 4.6 nutzt TikTok-Live-Daten als Input',
    'Echte CJ-Bewertungen + Lager pro Land',
    'Image-Sanity-Check via Vision-API'
  ],
  endpoints: ['/api/test', '/api/categories', '/api/tiktok/test', '/api/trends/analyze', '/api/products/search', '/api/products/import']
}));

app.get('/api/test', async (req, res) => {
  const r = {};
  try { await getShopifyToken(); r.shopify = 'verbunden'; } catch(e) { r.shopify = 'Fehler: ' + e.message; }
  try {
    await getCJToken();
    r.cj = 'verbunden';
    if (!beautyCategoryIds) await loadBeautyCategoryIds(cjToken);
    r.beautyCategories = beautyCategoryIds?.length || 0;
  } catch(e) { r.cj = 'Fehler: ' + e.message; }
  r.claude = CONFIG.CLAUDE_KEY ? 'Key vorhanden' : 'Key fehlt';
  r.apify = CONFIG.APIFY_TOKEN ? 'Token vorhanden' : 'Token fehlt';
  r.config = {
    shopifyDomain: CONFIG.SHOPIFY_DOMAIN || 'fehlt',
    apiVersion: CONFIG.SHOPIFY_API_VERSION,
    claudeModelTrends: CONFIG.CLAUDE_MODEL_TRENDS,
    claudeModelCopy: CONFIG.CLAUDE_MODEL_COPY,
    imageSanityCheck: CONFIG.ENABLE_IMAGE_SANITY_CHECK,
    apifyDiscovery: CONFIG.APIFY_DISCOVERY_ACTOR,
    apifyLookup: CONFIG.APIFY_LOOKUP_ACTOR,
  };
  res.json(r);
});

// Test-Endpoint speziell für TikTok — schnell prüfen ob Apify-Token + Actors funktionieren
app.get('/api/tiktok/test', async (req, res) => {
  const log = [];
  const L = (msg, type='sys') => { log.push({msg, type}); console.log('['+type+'] '+msg); };
  try {
    L('TikTok Discovery Test: Top 10 Beauty US 30 Tage', 'info');

    // Direkter Apify-Call ohne Mapping → zeigt Raw-Felder
    const input = {
      scrapeHashtags: true,
      scrapeVideos: false,
      scrapeCreators: false,
      scrapeSongs: false,
      hashtagCountries: ['US'],
      hashtagIndustries: ['Beauty & Personal Care'],
      hashtagPeriod: '30',
      hashtagMaxItems: 10,
      hashtagNewOnly: false,
    };
    L(`Apify Input: ${JSON.stringify(input)}`, 'info');

    const rawItems = await runApifyActor(CONFIG.APIFY_DISCOVERY_ACTOR, input, { timeoutSec: 120 });
    L(`✓ Apify Raw Response: ${rawItems.length} Items erhalten`, 'ok');

    let rawKeys = [];
    let rawSample = null;
    if (rawItems.length > 0) {
      rawKeys = Object.keys(rawItems[0]);
      rawSample = rawItems[0];
      L(`Verfügbare Felder im 1. Item: ${rawKeys.join(', ')}`, 'info');
    }

    // Auch normales Mapping testen
    const mapped = await discoverTikTokTrends({ country: 'US', period: '30', maxResults: 10 }, L);
    L(`Mapping-Ergebnis: ${mapped.length} Hashtags nach Filter`, mapped.length > 0 ? 'ok' : 'warn');

    res.json({
      success: true,
      rawCount: rawItems.length,
      rawKeys,
      rawSample,
      mappedCount: mapped.length,
      mappedSample: mapped.slice(0, 3),
      log
    });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message, log });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const cjt = await getCJToken();
    const { ids, names } = await loadBeautyCategoryIds(cjt);
    res.json({ count: ids.length, categories: names });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/shopify/products', async (req, res) => {
  try {
    const token = await getShopifyToken();
    const r = await fetch(`https://${CONFIG.SHOPIFY_DOMAIN}/admin/api/${CONFIG.SHOPIFY_API_VERSION}/products.json?limit=250`, {
      headers: { 'X-Shopify-Access-Token': token }
    });
    const d = await r.json();
    res.json({ success: true, count: d.products?.length, products: d.products?.map(p => ({
      id: p.id, title: p.title, price: p.variants?.[0]?.price,
      images: p.images?.length, status: p.status
    })) });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// PHASE 1: Trend-Analyse mit TikTok-Discovery
app.post('/api/trends/analyze', async (req, res) => {
  const { customKeywords = [], count = 15, useTikTok = true, tiktokCountry = 'US', tiktokPeriod = '30' } = req.body;
  const serverLog = [];
  const L = (msg, type='sys') => { serverLog.push({msg, type}); console.log('['+type+'] '+msg); };

  try {
    L('━━━ Phase 1: Trend-Analyse ━━━', 'info');

    // Schritt 1: TikTok Discovery
    let tiktokTrends = [];
    if (useTikTok && CONFIG.APIFY_TOKEN) {
      L(`TikTok Discovery: Beauty-Hashtags ${tiktokCountry} letzte ${tiktokPeriod}d`, 'info');
      tiktokTrends = await discoverTikTokTrends({
        country: tiktokCountry,
        period: tiktokPeriod,
        maxResults: 30
      }, L);
      if (tiktokTrends.length > 0) {
        L(`✓ ${tiktokTrends.length} echte TikTok-Hashtags geladen`, 'ok');
        L(`Top 5: ${tiktokTrends.slice(0,5).map(t => '#' + t.hashtag).join(', ')}`, 'info');
      } else {
        L('Keine TikTok-Daten (Sonnet arbeitet ohne Live-Daten)', 'warn');
      }
    } else if (useTikTok) {
      L('Apify-Token fehlt, TikTok-Discovery übersprungen', 'warn');
    }

    // Schritt 2: Sonnet strukturiert (mit oder ohne TikTok-Daten)
    L('Sonnet 4.6 strukturiert Trends...', 'info');
    const analysis = await analyzeTrends(customKeywords, count, tiktokTrends);
    L(`✓ ${(analysis.trends || []).length} Trend-Karten erstellt`, 'ok');

    // Schritt 3: TikTok-Live-Stats den passenden Trends zuordnen
    if (tiktokTrends.length > 0 && analysis.trends) {
      let matchedCount = 0;
      analysis.trends.forEach(t => {
        if (t.tiktokHashtag) {
          const match = tiktokTrends.find(tk =>
            tk.hashtag.toLowerCase() === t.tiktokHashtag.toLowerCase().replace(/^#/, '')
          );
          if (match) {
            t.tiktokLive = {
              hashtag: match.hashtag,
              rank: match.rank,
              videoCount: match.videoCount,
              views: match.views,
              rankChange: match.rankChange,
              country: match.country,
            };
            matchedCount++;
          }
        }
      });
      L(`${matchedCount} Trends mit TikTok-Live-Daten verknüpft`, 'ok');
    }

    res.json({ success: true, ...analysis, tiktokTrendsCount: tiktokTrends.length, serverLog });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message, serverLog });
  }
});

// PHASE 2: CJ-Suche + TikTok-Lookup parallel pro Trend
app.post('/api/products/search', async (req, res) => {
  const { confirmedTrends = [], tiktokCountry = 'US', useTikTokLookup = true } = req.body;
  if (!confirmedTrends.length) return res.status(400).json({ error: 'Keine Trends bestätigt' });

  const log = [];
  const L = (msg, type='sys') => { log.push({msg, type}); console.log('['+type+'] '+msg); };

  try {
    const cjt = await getCJToken();
    L('CJDropshipping verbunden', 'ok');
    await loadBeautyCategoryIds(cjt, L);

    const shopToken = await getShopifyToken();
    const existingTitles = await getExistingTitles(shopToken);
    L(`${existingTitles.size} bestehende Produkte für Duplikat-Check geladen`, 'info');

    // OPTIONAL: TikTok-Lookup für alle bestätigten Trends parallel
    let tiktokDetails = {};
    if (useTikTokLookup && CONFIG.APIFY_TOKEN) {
      const hashtagsToLookup = confirmedTrends
        .filter(t => t.tiktokHashtag)
        .map(t => t.tiktokHashtag);

      if (hashtagsToLookup.length > 0) {
        L(`TikTok-Lookup: Demographics für ${hashtagsToLookup.length} Hashtags`, 'info');
        try {
          const details = await lookupHashtagAnalytics(hashtagsToLookup, { country: tiktokCountry }, L);
          details.forEach(d => {
            if (d.hashtag) tiktokDetails[d.hashtag.toLowerCase()] = d;
          });
          L(`✓ ${details.length} Detail-Berichte erhalten`, 'ok');
        } catch(e) {
          L(`TikTok-Lookup Fehler (CJ-Suche läuft trotzdem): ${e.message}`, 'warn');
        }
      }
    }

    // CJ-Suche pro Trend
    const trendResults = [];
    for (const trend of confirmedTrends) {
      L(`━━━ "${trend.name}" (Keyword: "${trend.cjKeyword}") ━━━`, 'info');

      // TikTok-Lookup-Daten dem Trend zuordnen
      if (trend.tiktokHashtag) {
        const lookup = tiktokDetails[trend.tiktokHashtag.toLowerCase()];
        if (lookup) {
          trend.tiktokLookup = lookup;
          L(`  TikTok-Detail: 7d ${lookup.views7d?.toLocaleString() || '?'} views, ${lookup.videoCount?.toLocaleString() || '?'} Videos`, 'info');
        }
      }

      const candidates = await findCJProductsForTrend(cjt, trend, L);
      if (!candidates.length) {
        L(`  ✗ Keine Beauty-Produkte gefunden`, 'warn');
        trendResults.push({ trend, candidates: [], message: 'Keine Treffer' });
        continue;
      }

      const scored = candidates.map(p => {
        const { score, reasons } = scoreProduct(p, trend);
        return { ...p, _score: score, _scoreReasons: reasons };
      }).sort((a, b) => b._score - a._score);

      L(`  ✓ ${scored.length} Beauty-Produkte gefunden, Top-Score: ${scored[0]._score}`, 'ok');

      const top3 = scored.slice(0, 3);
      const detailedCandidates = await Promise.all(
        top3.map(c => prepareProductForImport(cjt, c, trend, L))
      );

      const enriched = detailedCandidates.map((d, i) => {
        const isDup = d.name && existingTitles.has(d.name.toLowerCase().trim());
        if (isDup) L(`  ⚠ DUPLIKAT: "${d.name}"`, 'warn');
        return { ...d, isDuplicate: isDup, score: top3[i]._score, scoreReasons: top3[i]._scoreReasons };
      });

      enriched.forEach((c, i) => {
        const reviewInfo = c.reviews.avgScore ? ` · ${c.reviews.avgScore}★ (${c.reviews.count})` : '';
        const stockInfo = c.stock.us > 0 ? ` · US:${c.stock.us}` : '';
        L(`  ${i+1}. "${c.name}" | $${c.vk} | ${c.imageCount} Bilder | ${c.listedNum} Listings${reviewInfo}${stockInfo}`, 'info');
      });

      trendResults.push({ trend, candidates: enriched });
    }

    const totalCands = trendResults.reduce((s, r) => s + r.candidates.length, 0);
    L(`━━━ FERTIG: ${totalCands} Kandidaten für ${confirmedTrends.length} Trends ━━━`, 'ok');
    res.json({ success: true, trendResults, log });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message, log });
  }
});

app.post('/api/products/import', async (req, res) => {
  const { confirmedProducts = [] } = req.body;
  if (!confirmedProducts.length) return res.status(400).json({ error: 'Keine Produkte bestätigt' });

  const log = [];
  const L = (msg, type='sys') => { log.push({msg, type}); console.log('['+type+'] '+msg); };

  try {
    const shopToken = await getShopifyToken();
    L('Shopify verbunden', 'ok');
    let published = 0;
    const results = [];

    for (const product of confirmedProducts) {
      L(`Generiere Marketing-Content: ${product.name}`, 'info');
      const content = await generateContent(product);
      L(`Importiere: ${product.name} | ${product.images.length} Bilder | $${product.vk}`, 'info');

      try {
        const shopifyProduct = await publishProduct(shopToken, product, content);
        published++;
        results.push({
          name: product.name,
          shopifyId: shopifyProduct.id,
          shopifyHandle: shopifyProduct.handle,
          price: product.vk,
          compareAt: product.compareAt,
          margin: product.margin,
          profit: product.profit,
          images: product.images.length,
          status: 'live'
        });
        L(`✓ LIVE: ${product.name} | $${product.vk} | ${product.margin}% Marge`, 'ok');
      } catch(e) {
        L(`✗ Fehler bei ${product.name}: ${e.message}`, 'err');
      }
    }

    L(`=== FERTIG: ${published}/${confirmedProducts.length} live ===`, 'ok');
    res.json({ success: true, published, total: confirmedProducts.length, results, log });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message, log });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ZoraSkin Backend v8.3 auf Port ${PORT} (TikTok Apify aktiv)`));
