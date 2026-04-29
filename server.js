// ZoraSkin Backend v8.4 — Vollständig: TikTok Apify + EU-Lager + Multi-Lang + EU-Compliance + Frische + Collections
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
  APIFY_DISCOVERY_ACTOR: 'data_xplorer~tiktok-trends',
  APIFY_LOOKUP_ACTOR: 'parseforge~tiktok-hashtag-analytics-scraper',
};

const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';
const APIFY_BASE = 'https://api.apify.com/v2';

// EU-Lager Country Codes (CJ-Warehouses)
const EU_WAREHOUSE_CODES = ['DE', 'FR', 'CZ', 'IT', 'ES', 'GB', 'NL', 'PL'];
const US_WAREHOUSE_CODES = ['US', 'CA'];

// Sprachen mit Native-Namen für Marketing
const SUPPORTED_LANGUAGES = {
  EN: 'English', DE: 'German (Du-Form, freundlich)', FR: 'French', IT: 'Italian', ES: 'Spanish'
};

let shopifyToken = '', shopifyTokenExpiry = 0;
let cjToken = '', cjTokenExpiry = 0;
let beautyCategoryIds = null, beautyCategoryNames = [];
let collectionsCache = null, collectionsCacheExpiry = 0;

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
async function runApifyActor(actorId, input, options = {}) {
  if (!CONFIG.APIFY_TOKEN) throw new Error('APIFY_TOKEN fehlt');
  const timeoutSec = options.timeoutSec || 300;
  const url = `${APIFY_BASE}/acts/${actorId}/run-sync-get-dataset-items?token=${CONFIG.APIFY_TOKEN}&timeout=${timeoutSec}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input || {}),
    timeout: (timeoutSec + 30) * 1000,
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Apify ${actorId} ${r.status}: ${errText.slice(0,300)}`);
  }
  const data = await r.json();
  return Array.isArray(data) ? data : [];
}

// ============= APIFY: TIKTOK DISCOVERY =============
async function discoverTikTokTrends(options = {}, log = () => {}) {
  const { country = 'US', period = '30', maxResults = 50 } = options;
  if (!CONFIG.APIFY_TOKEN) {
    log('Apify-Token fehlt, TikTok-Discovery übersprungen', 'warn');
    return [];
  }
  log(`TikTok Discovery: Beauty-Hashtags ${country} letzte ${period} Tage`, 'info');

  const input = {
    scrapeHashtags: true, scrapeVideos: false, scrapeCreators: false, scrapeSongs: false,
    hashtagCountries: [country],
    hashtagIndustries: ['Beauty & Personal Care'],
    hashtagPeriod: period,
    hashtagMaxItems: Math.max(maxResults, 100),
    hashtagNewOnly: false,
  };

  try {
    const items = await runApifyActor(CONFIG.APIFY_DISCOVERY_ACTOR, input, { timeoutSec: 180 });
    log(`✓ TikTok Discovery raw: ${items.length} Items`, 'ok');

    // Echte Apify-Feldnamen: PascalCase mit Spaces
    const mapped = items.map(item => ({
      hashtag: (item.Hashtag || item.hashtag || '').replace(/^#/, '').trim(),
      rank: item.Rank || item.rank || null,
      industry: item.Industry || item.industry || '',
      country: item.Country || item.country || '',
      countryCode: item['Country Code'] || item.countryCode || '',
      videoCount: item.Posts || item.posts || 0,
      views: item['Video Views'] || item.videoViews || 0,
      rankChange: item['Rank Change'] || item.rankChange || 0,
      isNew: item['Is New'] || false,
      isPromoted: item['Is Promoted'] || false,
      tiktokUrl: item['TikTok URL'] || '',
      period: item.Period || period,
      trendDirection: item['Trend Direction'] || '',
      trendStats: item['Trend Stats'] || null,
      raw: item,
    })).filter(t => t.hashtag);

    log(`Nach Field-Mapping: ${mapped.length} Items`, 'info');

    // Beauty-Industry + Country-Filter (Apify ist nicht zuverlässig)
    const beautyKeywords = ['beauty', 'personal care', 'cosmetic', 'health'];
    const filtered = mapped.filter(t => {
      const ind = (t.industry || '').toLowerCase();
      const matchesIndustry = beautyKeywords.some(kw => ind.includes(kw));
      const matchesCountry = !country || t.countryCode === country || !t.countryCode;
      return matchesIndustry && matchesCountry;
    });
    log(`Nach Beauty+Country-Filter (${country}): ${filtered.length} Items`, filtered.length > 0 ? 'ok' : 'warn');

    // Fallback: Hashtag-Wort-Filter wenn Industry-Filter zu streng
    if (filtered.length < 3 && mapped.length > 0) {
      const beautyHashtagWords = ['skin','beauty','skincare','makeup','glow','hair','lash','lip','nail','serum','spa','facial','derm','cosmetic','blush','contour','mascara','foundation','retinol','vitamin','collagen','sunscreen','exfoliate','moisturize','clean','wash','toner','essence','peptide','hyaluronic','niacin','tinted','radiant','dewy'];
      const hashtagFiltered = mapped.filter(t => {
        const h = t.hashtag.toLowerCase();
        const matchesHashtag = beautyHashtagWords.some(kw => h.includes(kw));
        const matchesCountry = !country || t.countryCode === country || !t.countryCode;
        return matchesHashtag && matchesCountry;
      });
      log(`Fallback Hashtag-Keyword-Filter: ${hashtagFiltered.length} Items`, hashtagFiltered.length > 0 ? 'info' : 'warn');
      const merged = [...filtered];
      hashtagFiltered.forEach(t => {
        if (!merged.some(x => x.hashtag === t.hashtag)) merged.push(t);
      });
      // FRISCHE-PRIORISIERUNG: isNew + trendDirection: up zuerst
      merged.sort((a, b) => {
        const aFresh = (a.isNew ? 2 : 0) + (a.trendDirection === 'up' ? 1 : 0);
        const bFresh = (b.isNew ? 2 : 0) + (b.trendDirection === 'up' ? 1 : 0);
        return bFresh - aFresh;
      });
      return merged.slice(0, maxResults);
    }

    // Sortiere auch im normalen Pfad nach Frische
    filtered.sort((a, b) => {
      const aFresh = (a.isNew ? 2 : 0) + (a.trendDirection === 'up' ? 1 : 0);
      const bFresh = (b.isNew ? 2 : 0) + (b.trendDirection === 'up' ? 1 : 0);
      return bFresh - aFresh;
    });
    return filtered.slice(0, maxResults);
  } catch(e) {
    log(`TikTok Discovery Fehler: ${e.message}`, 'err');
    return [];
  }
}

// ============= APIFY: TIKTOK LOOKUP =============
async function lookupHashtagAnalytics(hashtags, options = {}, log = () => {}) {
  const { country = 'US' } = options;
  if (!CONFIG.APIFY_TOKEN || !hashtags?.length) return [];
  const cleanHashtags = hashtags.map(h => h.replace(/^#/, '').toLowerCase().replace(/\s+/g, ''));
  log(`TikTok Lookup: ${cleanHashtags.length} Hashtags Detail-Analyse`, 'info');

  const input = { hashtags: cleanHashtags, country, mode: 'lookup' };
  try {
    const items = await runApifyActor(CONFIG.APIFY_LOOKUP_ACTOR, input, { timeoutSec: 240 });
    log(`✓ TikTok Lookup raw: ${items.length} Items`, 'ok');
    if (items.length > 0) {
      log(`Lookup-Felder: ${Object.keys(items[0]).join(', ')}`, 'info');
    }
    return items.map(item => ({
      hashtag: (item.Hashtag || item.hashtag_name || item.hashtagName || item.name || item.hashtag || '').replace(/^#/, ''),
      views7d: item['7d Video Views'] || item.views7d || item.views_7d || 0,
      viewsTotal: item['Video Views'] || item.viewsTotal || item.views_total || item.views || 0,
      videoCount: item.Posts || item.publishCnt || item.videoCount || 0,
      audienceAges: item['Audience Ages'] || item.audienceAges || item.audience_ages || [],
      audienceInterests: item['Audience Interests'] || item.audienceInterests || item.audience_interests || [],
      topCountries: item['Top Countries'] || item.topCountries || item.top_countries || [],
      relatedHashtags: item['Related Hashtags'] || item.relatedHashtags || item.related_hashtags || [],
      topCreators: item['Top Creators'] || item.topCreators || item.top_creators || [],
      topVideos: item['Top Videos'] || item.topVideos || item.top_videos || [],
      trendChart: item['Trend Data'] || item.trendChart || item.trend_chart || [],
      raw: item,
    }));
  } catch(e) {
    log(`TikTok Lookup Fehler: ${e.message}`, 'err');
    return [];
  }
}

// ============= BEAUTY-KATEGORIEN AUTO-DISCOVERY =============
const BEAUTY_CATEGORY_KEYWORDS = ['beauty','skin','hair','cosmetic','makeup','personal care','face','eye','lip','nail','oral','dental','massage','spa','health','wellness','fragrance','perfume','body care'];

async function loadBeautyCategoryIds(cjt, log = () => {}) {
  if (beautyCategoryIds) return { ids: beautyCategoryIds, names: beautyCategoryNames };
  try {
    const r = await fetch(`${CJ_BASE}/product/getCategory`, { headers: { 'CJ-Access-Token': cjt } });
    const d = await r.json();
    if (!d.result || !d.data) {
      log('Beauty-Kategorien konnten nicht geladen werden', 'warn');
      beautyCategoryIds = [];
      return { ids: [], names: [] };
    }
    const ids = [], names = [];
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

function containsBeautyWord(name) { const n = (name || '').toLowerCase(); return BEAUTY_WORDS.some(w => n.includes(w)); }
function containsNonBeauty(name) { const n = (name || '').toLowerCase(); return NON_BEAUTY.some(nb => n.includes(nb)); }

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
        pid: p.id, productNameEn: p.nameEn, productImage: p.bigImage,
        sellPrice: parseFloat(p.sellPrice || p.nowPrice || 0),
        nowPrice: p.nowPrice ? parseFloat(p.nowPrice) : null,
        discountPriceRate: p.discountPriceRate, listedNum: p.listedNum || 0,
        categoryId: p.categoryId, threeCategoryName: p.threeCategoryName,
        twoCategoryName: p.twoCategoryName, oneCategoryName: p.oneCategoryName,
        categoryName: p.threeCategoryName || p.twoCategoryName || p.oneCategoryName,
        addMarkStatus: p.addMarkStatus, isVideo: p.isVideo, videoList: p.videoList || [],
        warehouseInventoryNum: p.warehouseInventoryNum || 0,
        totalVerifiedInventory: p.totalVerifiedInventory || 0,
        verifiedWarehouse: p.verifiedWarehouse, hasCECertification: p.hasCECertification,
        deliveryCycle: p.deliveryCycle, description: p.description, supplierName: p.supplierName,
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
    pid: p.pid, productNameEn: p.productNameEn, productImage: p.productImage,
    sellPrice: parseFloat(p.sellPrice || 0), listedNum: p.listedNum || 0,
    categoryName: p.categoryName, categoryId: p.categoryId,
  }));
}

async function findCJProductsForTrend(cjt, trend, log = () => {}) {
  const beautyCats = beautyCategoryIds || [];
  const keyword = trend.cjKeyword;
  let result = null;

  if (beautyCats.length > 0) {
    try {
      result = await searchProductsV2(cjt, {
        keyWord: keyword, page: 1, size: 30, lv3categoryList: beautyCats,
        verifiedWarehouse: 1, addMarkStatus: 1, productFlag: 0, orderBy: 1,
        sort: 'desc', startWarehouseInventory: 50, zonePlatform: 'shopify',
        features: ['enable_category', 'enable_video'],
      });
      if (result.products.length > 0) log(`  Strategie 1: ${result.products.length}`, 'info');
    } catch(e) { log(`  Strategie 1 Fehler: ${e.message}`, 'warn'); }
  }

  if (!result || result.products.length < 5) {
    try {
      const r2 = await searchProductsV2(cjt, {
        keyWord: keyword, page: 1, size: 30,
        lv3categoryList: beautyCats.length > 0 ? beautyCats : undefined,
        verifiedWarehouse: 1, orderBy: 1, sort: 'desc', features: ['enable_category'],
      });
      if (r2.products.length > 0) {
        log(`  Strategie 2: ${r2.products.length}`, 'info');
        result = result && result.products.length > 0
          ? { products: [...result.products, ...r2.products.filter(p => !result.products.some(x => x.pid === p.pid))] }
          : r2;
      }
    } catch(e) { log(`  Strategie 2 Fehler: ${e.message}`, 'warn'); }
  }

  if (!result || result.products.length < 3) {
    try {
      const r3 = await searchProductsV2(cjt, {
        keyWord: keyword, page: 1, size: 30, orderBy: 1, sort: 'desc', features: ['enable_category'],
      });
      if (r3.products.length > 0) {
        log(`  Strategie 3: ${r3.products.length}`, 'info');
        const filtered = r3.products.filter(p => !containsNonBeauty(p.productNameEn) && containsBeautyWord(p.productNameEn));
        result = result && result.products.length > 0
          ? { products: [...result.products, ...filtered.filter(p => !result.products.some(x => x.pid === p.pid))] }
          : { products: filtered };
      }
    } catch(e) { log(`  Strategie 3 Fehler: ${e.message}`, 'warn'); }
  }

  if (!result || result.products.length === 0) {
    try {
      log(`  V1-Fallback...`, 'warn');
      const v1 = await searchProductsV1Fallback(cjt, keyword, 1);
      const filtered = v1.filter(p => !containsNonBeauty(p.productNameEn) && containsBeautyWord(p.productNameEn));
      result = { products: filtered };
    } catch(e) { log(`  V1-Fallback Fehler: ${e.message}`, 'err'); return []; }
  }
  return result?.products || [];
}

// ============= SCORING (mit EU-Lager-Bonus) =============
function scoreProduct(p, trend, stockData = null) {
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

  // EU-LAGER-BONUS (NEU)
  if (stockData && Array.isArray(stockData)) {
    const euStocks = stockData.filter(s => EU_WAREHOUSE_CODES.includes(s.country) && s.total > 0);
    if (euStocks.length > 0) {
      const totalEuStock = euStocks.reduce((sum, s) => sum + s.total, 0);
      if (totalEuStock > 100) {
        score += 15;
        reasons.push(`EU-Lager(${euStocks.map(s => s.country).join(',')}):+15`);
      } else {
        score += 8;
        reasons.push(`EU-Lager:+8`);
      }
    }
  }

  // FRISCHE-TRENDS-BONUS aus TikTok-Live (NEU)
  if (trend.tiktokLive) {
    if (trend.tiktokLive.isNew) {
      score += 10;
      reasons.push('NewTrend:+10');
    }
    if (trend.tiktokLive.trendDirection === 'up' || (trend.tiktokLive.rankChange || 0) > 0) {
      score += 8;
      reasons.push('TrendUp:+8');
    }
  }

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
    addImg(p.bigImage); addImg(p.productImage);
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
      pid: p.pid, name: p.productNameEn || p.productName,
      images: images.slice(0, 10), mainImage: p.bigImage || images[0] || '',
      ek: parseFloat(p.sellPrice || 0), weight: p.productWeight,
      categoryName: p.categoryName, description: (p.description || '').slice(0, 600),
      supplierName: p.supplierName, videoList: p.productVideo || [],
      hasVideo: (p.productVideo || []).length > 0,
      variants: (p.variants || []).slice(0, 5).map(v => ({
        sku: v.variantSku, name: v.variantNameEn, price: v.variantSellPrice, weight: v.variantWeight,
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
      score: parseInt(r.score, 10), text: (r.comment || '').slice(0, 200),
      country: r.countryCode, user: r.commentUser,
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
      country: i.countryCode, countryName: i.countryNameEn,
      total: i.totalInventoryNum || 0, cjStock: i.cjInventoryNum || 0,
    }));
  } catch(e) { return []; }
}

// ============= VERSAND-SCHÄTZUNG =============
function estimateShipping(stock) {
  // stock = Array von { country, total }
  const hasEU = stock.some(s => EU_WAREHOUSE_CODES.includes(s.country) && s.total > 0);
  const hasUS = stock.some(s => US_WAREHOUSE_CODES.includes(s.country) && s.total > 0);
  const hasCN = stock.some(s => s.country === 'CN' && s.total > 0);

  if (hasEU) return { fastest: 'EU-Lager', businessDays: '3-7', emoji: '🇪🇺', message: '3-7 Werktage (EU-Lager verfügbar)' };
  if (hasUS) return { fastest: 'US-Lager', businessDays: '7-12', emoji: '🇺🇸', message: '7-12 Werktage (US-Lager)' };
  if (hasCN) return { fastest: 'China-Versand', businessDays: '12-18', emoji: '🇨🇳', message: '12-18 Werktage (Versand aus China)' };
  return { fastest: 'unbekannt', businessDays: '12-20', emoji: '📦', message: '12-20 Werktage' };
}

// ============= IMAGE-SANITY-CHECK =============
async function imageSanityCheck(imageUrl, productName, expectedCategory) {
  if (!CONFIG.ENABLE_IMAGE_SANITY_CHECK || !CONFIG.CLAUDE_KEY) return { ok: true, skipped: true };
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: CONFIG.CLAUDE_MODEL_VISION, max_tokens: 100,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: imageUrl } },
            { type: 'text', text: `Product name: "${productName}"\nExpected category: ${expectedCategory}\n\nDoes this image actually show the named beauty/skincare product? Reply ONLY with valid JSON: {"matches":true/false,"reason":"max 8 words"}` }
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
function calculatePricing(ek, trend, currency = 'USD') {
  const targetMargin = (trend.estimatedMargin || 70) / 100;
  const priceRange = trend.priceRange || { min: 15, max: 60 };
  let vk = ek / (1 - targetMargin);
  vk = Math.max(vk, priceRange.min);
  vk = Math.min(vk, priceRange.max);
  vk = Math.ceil(vk) - 0.01;
  const compareAt = Math.ceil(vk * 1.3) - 0.01;
  const margin = Math.round((1 - ek / vk) * 100);
  return { vk: parseFloat(vk.toFixed(2)), compareAt: parseFloat(compareAt.toFixed(2)), margin };
}

async function prepareProductForImport(cjt, cjProduct, trend, options = {}, log = () => {}) {
  const [details, reviews, stock] = await Promise.all([
    getCJProductDetails(cjt, cjProduct.pid),
    getCJProductReviews(cjt, cjProduct.pid),
    getCJStockByPid(cjt, cjProduct.pid),
  ]);

  const ek = parseFloat(cjProduct.nowPrice || cjProduct.sellPrice || details?.ek || 0);
  const { vk, compareAt, margin } = calculatePricing(ek, trend, options.currency);
  const allImages = details?.images || [cjProduct.productImage].filter(Boolean);

  let sanityCheck = { ok: true, skipped: true };
  if (CONFIG.ENABLE_IMAGE_SANITY_CHECK && allImages.length > 0) {
    sanityCheck = await imageSanityCheck(allImages[0], details?.name || cjProduct.productNameEn, trend.category);
    log(`  Image-Check "${(details?.name || '').slice(0,40)}": ${sanityCheck.ok ? '✓' : '✗ ' + (sanityCheck.reason || 'Mismatch')}`, sanityCheck.ok ? 'info' : 'warn');
  }

  // Stock-Aufschlüsselung pro Region
  const usStock = stock.find(s => s.country === 'US');
  const cnStock = stock.find(s => s.country === 'CN');
  const euStocks = stock.filter(s => EU_WAREHOUSE_CODES.includes(s.country) && s.total > 0);
  const totalEUStock = euStocks.reduce((sum, s) => sum + s.total, 0);
  const shippingEstimate = estimateShipping(stock);

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
      eu: totalEUStock,
      euCountries: euStocks.map(s => s.country),
      total: stock.reduce((s, x) => s + x.total, 0),
      countries: stock.map(s => s.country),
      raw: stock,
    },
    shipping: shippingEstimate,  // NEU
    hasEUStock: totalEUStock > 0,  // NEU
    reviews: {
      count: reviews.count, avgScore: reviews.avgScore, topReviews: reviews.topReviews,
    },
    imageSanity: sanityCheck,
    trend: {
      name: trend.name, cjKeyword: trend.cjKeyword,
      viralPlatform: trend.viralPlatform, trendReason: trend.trendReason,
      monthlySearches: trend.monthlySearches, monthlySales: trend.monthlySales,
      threeMonthTrend: trend.threeMonthTrend, trendScore: trend.trendScore,
      category: trend.category, targetAudience: trend.targetAudience,
      relatedKeywords: trend.relatedKeywords, longTailKeywords: trend.longTailKeywords,
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

// Detaillierte Duplikat-Suche: liefert komplette Produktdaten zurück
async function getExistingProducts(shopToken) {
  try {
    // body_html für Audit-Funktion (Beschreibungs-Vergleich)
    const r = await fetch(`https://${CONFIG.SHOPIFY_DOMAIN}/admin/api/${CONFIG.SHOPIFY_API_VERSION}/products.json?limit=250&fields=id,title,handle,body_html,vendor,product_type,tags,variants,image,images,status`, {
      headers: { 'X-Shopify-Access-Token': shopToken }
    });
    const d = await r.json();
    return (d.products || []).map(p => ({
      id: p.id,
      title: p.title,
      titleLower: p.title.toLowerCase().trim(),
      handle: p.handle,
      vendor: p.vendor,
      productType: p.product_type,
      tags: p.tags,
      bodyHtml: p.body_html || '',
      bodyText: stripHtml(p.body_html || ''),
      price: p.variants?.[0]?.price,
      compareAt: p.variants?.[0]?.compare_at_price,
      mainImage: p.image?.src || p.images?.[0]?.src || '',
      imageCount: p.images?.length || 0,
      status: p.status,
      adminUrl: `https://${CONFIG.SHOPIFY_DOMAIN}/admin/products/${p.id}`,
      publicUrl: p.handle ? `https://${CONFIG.SHOPIFY_DOMAIN.replace('.myshopify.com','.com')}/products/${p.handle}` : null,
    }));
  } catch(e) {
    console.error('getExistingProducts Error:', e.message);
    return [];
  }
}

// HTML-Tags entfernen + Whitespace normalisieren
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Vergleicht zwei Texte (für Beschreibungen — länger als Titel)
function calculateTextSimilarity(t1, t2) {
  if (!t1 || !t2) return 0;
  const a = t1.toLowerCase().replace(/[^a-z0-9äöüéèàç ]+/g, ' ').trim();
  const b = t2.toLowerCase().replace(/[^a-z0-9äöüéèàç ]+/g, ' ').trim();
  if (a === b) return 1.0;
  // Wörter > 3 Chars (Stopwords filtern automatisch)
  const aWords = new Set(a.split(/\s+/).filter(w => w.length > 3));
  const bWords = new Set(b.split(/\s+/).filter(w => w.length > 3));
  if (aWords.size === 0 || bWords.size === 0) return 0;
  const intersection = [...aWords].filter(w => bWords.has(w));
  const union = new Set([...aWords, ...bWords]);
  return union.size > 0 ? intersection.length / union.size : 0;
}

// Fuzzy-Match: wie ähnlich sind zwei Produktnamen
function calculateSimilarity(s1, s2) {
  if (!s1 || !s2) return 0;
  const a = s1.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const b = s2.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (a === b) return 1.0;
  // Wort-Überlappung
  const aWords = new Set(a.split(' ').filter(w => w.length > 2));
  const bWords = new Set(b.split(' ').filter(w => w.length > 2));
  const intersection = [...aWords].filter(w => bWords.has(w));
  const union = new Set([...aWords, ...bWords]);
  const jaccard = union.size > 0 ? intersection.length / union.size : 0;
  // Substring-Match
  const minLen = Math.min(a.length, b.length);
  const substringScore = (a.includes(b) || b.includes(a)) ? Math.min(a.length, b.length) / Math.max(a.length, b.length) : 0;
  return Math.max(jaccard, substringScore);
}

// Findet potenzielle Duplikate für einen neuen Kandidaten
function findDuplicates(candidate, existingProducts, threshold = 0.6) {
  const matches = existingProducts.map(p => ({
    ...p,
    similarity: calculateSimilarity(candidate.name || '', p.title)
  })).filter(m => m.similarity >= threshold);
  return matches.sort((a, b) => b.similarity - a.similarity).slice(0, 3);  // Top 3
}

// ============= TREND-ANALYSE MIT FRISCHE-PRIORISIERUNG =============
async function analyzeTrends(customKeywords = [], count = 15, tiktokTrends = []) {
  if (!CONFIG.CLAUDE_KEY) throw new Error('CLAUDE_KEY fehlt');
  const extra = customKeywords.length > 0
    ? `\n\nIMPORTANT: Also include trends matching these specific user keywords: ${customKeywords.join(', ')}`
    : '';

  // FRISCHE-PRIORISIERUNG: erst die isNew + trendDirection: up
  const sortedTrends = [...tiktokTrends].sort((a, b) => {
    const aFresh = (a.isNew ? 2 : 0) + (a.trendDirection === 'up' ? 1 : 0);
    const bFresh = (b.isNew ? 2 : 0) + (b.trendDirection === 'up' ? 1 : 0);
    return bFresh - aFresh;
  });

  const tiktokContext = sortedTrends.length > 0
    ? `\n\nLIVE TIKTOK DATA (April 2026, real Creative Center data):\nThe following Beauty hashtags are CURRENTLY trending on TikTok. ${sortedTrends.filter(t => t.isNew).length > 0 ? 'PRIORITIZE the ones marked NEW or TRENDING UP — these are the freshest opportunities (best for early-mover advantage):' : ''}\n${sortedTrends.map((t, i) =>
        `${i+1}. #${t.hashtag} — Rank ${t.rank}, ${t.videoCount?.toLocaleString() || '?'} videos, ${t.views?.toLocaleString() || '?'} views, change: ${t.rankChange || 0}${t.isNew ? ' [NEW]' : ''}${t.trendDirection === 'up' ? ' [UP]' : ''}${t.trendDirection === 'down' ? ' [DOWN]' : ''}`
      ).join('\n')}\n\nIMPORTANT: Use these REAL hashtags as primary input. Match each to a product trend. Set "tiktokHashtag" field to the matching hashtag name. Set "dataSource" to "tiktok_live" for trends with TikTok backing. PRIORITIZE [NEW] and [UP] hashtags in your top picks — these have early-mover advantage.`
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
      "rank": 1, "name": "Product trend name", "category": "Skincare Tools",
      "cjKeyword": "2-3 word keyword", "tiktokHashtag": "guasha",
      "dataSource": "tiktok_live", "freshness": "new",
      "avgPrice": 35, "priceRange": {"min": 25, "max": 55},
      "monthlySearches": 450000, "monthlySales": 85000,
      "salesHistory": {"month1": 62000, "month2": 71000, "month3": 85000},
      "trendVelocity": "+37%", "trendPhase": "peak", "threeMonthTrend": "growing",
      "trendScore": 94, "profitScore": 88,
      "relatedKeywords": ["kw1","kw2","kw3","kw4","kw5"],
      "longTailKeywords": ["phrase 1","phrase 2","phrase 3","phrase 4","phrase 5"],
      "coPurchaseItems": ["item 1","item 2","item 3"],
      "viralPlatform": "TikTok", "viralVideos": 1250,
      "trendReason": "1 sentence", "sentiment": "positive",
      "competition": "medium", "competitorBrands": ["brand1","brand2","brand3"],
      "entryDifficulty": "medium", "targetAudience": "Women 25-45",
      "demographics": {"ageRange": "25-45","gender": "85% female","topCountries": ["US","UK","DE"]},
      "seasonality": "evergreen", "bestSellingTime": "Year-round", "estimatedMargin": 72
    }
  ]
}

CRITICAL: cjKeyword 2-3 generic words. dataSource: tiktok_live or estimated. freshness: new (brand new trend) | rising (growing fast) | mature (peak/stable) | declining. trendPhase: emerging|growing|peak|declining. competition: low|medium|high. seasonality: evergreen|winter|summer|holiday. tiktokHashtag: only if matches a real hashtag (without #).`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: CONFIG.CLAUDE_MODEL_TRENDS, max_tokens: 16000,
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

// ============= MARKETING-CONTENT (MULTI-LANG + EU-COMPLIANCE) =============
async function generateContent(product, options = {}) {
  const language = (options.language || 'EN').toUpperCase();
  const euCompliant = options.euCompliant === true;
  const langName = SUPPORTED_LANGUAGES[language] || 'English';

  if (!CONFIG.CLAUDE_KEY) {
    return { hook: product.trend.trendReason, usp: product.name, description: '', bullets: [] };
  }

  const complianceRules = euCompliant ? `

EU-COMPLIANCE STRICT RULES (Cosmetics Regulation EC 1223/2009):
- DO NOT make medical or healing claims (e.g. "cures acne", "removes wrinkles", "treats")
- DO NOT make absolute time promises (e.g. "results in 7 days", "instant transformation")
- DO NOT use unqualified superlatives (e.g. "best", "perfect", "miracle")
- USE conditional/subjunctive language ("may help", "supports", "designed to")
- DO NOT compare against competitor products by name
- DO NOT promise guaranteed weight loss, lightening, or skin condition cures
- Marketing must be informational, not therapeutic
- Avoid phrases: "anti-aging" (use "for mature skin"), "whitens" (use "for radiance")` : '';

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: CONFIG.CLAUDE_MODEL_COPY, max_tokens: 700,
        messages: [{
          role: 'user',
          content: `Write compelling beauty product copy in ${langName}.

Product: ${product.name}
Trending context: ${product.trend.trendReason}
Platform: ${product.trend.viralPlatform}
Audience: ${product.trend.targetAudience}
Keywords: ${(product.trend.relatedKeywords || []).join(', ')}
${product.reviews?.avgScore ? `Customer rating: ${product.reviews.avgScore}/5 (${product.reviews.count} reviews)` : ''}
${product.shipping ? `Shipping: ${product.shipping.message}` : ''}
${complianceRules}

Generate JSON only (no markdown):
{
  "hook": "emotional 10-12 word hook in ${langName}",
  "usp": "unique benefit 15-20 words in ${langName}",
  "description": "2-3 punchy benefit sentences in ${langName}, ${euCompliant ? 'using conditional language' : 'compelling style'}",
  "bullets": ["benefit 1 in ${langName}","benefit 2","benefit 3","benefit 4","benefit 5"]
}`
        }]
      })
    });
    const d = await r.json();
    const parsed = JSON.parse(d.content[0].text.replace(/```json|```/g, '').trim());
    parsed._language = language;
    parsed._euCompliant = euCompliant;
    return parsed;
  } catch(e) {
    return { hook: product.trend.trendReason, usp: product.name, description: '', bullets: [], _error: e.message };
  }
}

// ============= SHOPIFY: SMART COLLECTIONS =============
async function loadShopifyCollections(shopToken, log = () => {}) {
  if (collectionsCache && Date.now() < collectionsCacheExpiry) return collectionsCache;
  try {
    const r = await fetch(`https://${CONFIG.SHOPIFY_DOMAIN}/admin/api/${CONFIG.SHOPIFY_API_VERSION}/smart_collections.json?limit=250`, {
      headers: { 'X-Shopify-Access-Token': shopToken }
    });
    const d = await r.json();
    collectionsCache = d.smart_collections || [];
    collectionsCacheExpiry = Date.now() + 5 * 60 * 1000;
    log(`${collectionsCache.length} bestehende Smart Collections geladen`, 'info');
    return collectionsCache;
  } catch(e) {
    log(`Collections-Load Fehler: ${e.message}`, 'warn');
    return [];
  }
}

async function ensureSmartCollection(shopToken, categoryName, log = () => {}) {
  if (!categoryName || categoryName.length < 2) return null;
  const existing = await loadShopifyCollections(shopToken, log);
  const handle = categoryName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const found = existing.find(c =>
    c.handle === handle || c.title.toLowerCase() === categoryName.toLowerCase()
  );
  if (found) {
    log(`✓ Collection "${categoryName}" existiert (ID ${found.id})`, 'sys');
    return found;
  }
  // Erstellen
  try {
    const body = {
      smart_collection: {
        title: categoryName,
        rules: [{ column: 'tag', relation: 'equals', condition: categoryName }],
        disjunctive: false,
        sort_order: 'best-selling',
        published: true,
      }
    };
    const r = await fetch(`https://${CONFIG.SHOPIFY_DOMAIN}/admin/api/${CONFIG.SHOPIFY_API_VERSION}/smart_collections.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': shopToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const errText = await r.text();
      log(`Collection-Erstellung fehlgeschlagen: ${errText.slice(0,150)}`, 'warn');
      return null;
    }
    const d = await r.json();
    log(`★ Collection "${categoryName}" neu erstellt (ID ${d.smart_collection.id})`, 'ok');
    if (collectionsCache) collectionsCache.push(d.smart_collection);
    return d.smart_collection;
  } catch(e) {
    log(`Collection-Erstellung Fehler: ${e.message}`, 'warn');
    return null;
  }
}

// ============= SHOPIFY PUBLISH =============
async function publishProduct(shopToken, product, content) {
  const bullets = (content.bullets || []).map(b => `<li>${b}</li>`).join('');
  const reviewsHtml = product.reviews?.avgScore
    ? `<p>⭐ <strong>${product.reviews.avgScore}/5</strong> · ${product.reviews.count} reviews</p>` : '';
  const ceHtml = product.hasCECertification ? '<p>🏷️ <strong>CE Certified</strong></p>' : '';
  const shippingHtml = product.shipping
    ? `<p>${product.shipping.emoji} <strong>Versand:</strong> ${product.shipping.message}</p>` : '';
  const tiktokLiveHtml = product.trend.tiktokLive
    ? `<p>📈 <strong>TikTok-verifizierter Trend:</strong> ${product.trend.tiktokLive.viewsTotal?.toLocaleString() || ''} Views, ${product.trend.tiktokLive.videoCount?.toLocaleString() || ''} Videos</p>`
    : '';

  const body = {
    product: {
      title: product.name,
      body_html: `<p><strong><em>${content.hook || ''}</em></strong></p>
<p>${content.description || content.usp || ''}</p>
${bullets ? `<ul>${bullets}</ul>` : ''}
${reviewsHtml}
${ceHtml}
${shippingHtml}
${tiktokLiveHtml}
<p>⭐ <strong>Trending on ${product.trend.viralPlatform}:</strong> ${product.trend.trendReason}</p>
<p><em>↩ 30-day returns · 🔒 Secure payment</em></p>`,
      vendor: 'ZoraSkin',
      product_type: product.trend.category || 'Beauty',
      tags: [
        product.trend.category, 'Trending 2026',
        product.trend.viralPlatform + ' Viral', 'ZoraSkin',
        product.hasCECertification ? 'CE Certified' : null,
        product.isVerifiedWarehouse ? 'Verified Stock' : null,
        product.trend.tiktokLive ? 'TikTok Live Trend' : null,
        product.hasEUStock ? 'EU Stock' : null,
        product.shipping?.fastest === 'EU-Lager' ? 'Fast EU Shipping' : null,
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
  status: 'ZoraSkin Backend v8.4 — Vollausstattung',
  features: [
    'CJ V2-API mit Elasticsearch + Multi-Strategy',
    'TikTok Apify Integration (Discovery + Lookup)',
    'EU-Lager-Bonus (DE/FR/CZ/IT/ES/GB/NL/PL)',
    'Versand-Zeit-Schätzung pro Produkt',
    'Multi-Language Marketing (EN/DE/FR/IT/ES)',
    'EU-Compliance-Modus (Cosmetics Reg. EC 1223/2009)',
    'Frische-Trends-Priorisierung (isNew + trendUp)',
    'Smart Collections automatisch erstellen',
  ],
  endpoints: ['/api/test', '/api/categories', '/api/tiktok/test', '/api/trends/analyze', '/api/products/search', '/api/products/import', '/api/shopify/collections']
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
    euWarehouseCodes: EU_WAREHOUSE_CODES,
    supportedLanguages: Object.keys(SUPPORTED_LANGUAGES),
  };
  res.json(r);
});

app.get('/api/tiktok/test', async (req, res) => {
  const log = [];
  const L = (msg, type='sys') => { log.push({msg, type}); console.log('['+type+'] '+msg); };
  try {
    L('TikTok Discovery Test: Top 10 Beauty US 30 Tage', 'info');
    const input = {
      scrapeHashtags: true, scrapeVideos: false, scrapeCreators: false, scrapeSongs: false,
      hashtagCountries: ['US'], hashtagIndustries: ['Beauty & Personal Care'],
      hashtagPeriod: '30', hashtagMaxItems: 10, hashtagNewOnly: false,
    };
    L(`Apify Input: ${JSON.stringify(input)}`, 'info');
    const rawItems = await runApifyActor(CONFIG.APIFY_DISCOVERY_ACTOR, input, { timeoutSec: 120 });
    L(`✓ Apify Raw Response: ${rawItems.length} Items`, 'ok');
    let rawKeys = [], rawSample = null;
    if (rawItems.length > 0) {
      rawKeys = Object.keys(rawItems[0]);
      rawSample = rawItems[0];
      L(`Verfügbare Felder: ${rawKeys.join(', ')}`, 'info');
    }
    const mapped = await discoverTikTokTrends({ country: 'US', period: '30', maxResults: 10 }, L);
    L(`Mapping-Ergebnis: ${mapped.length} Hashtags nach Filter`, mapped.length > 0 ? 'ok' : 'warn');
    res.json({ success: true, rawCount: rawItems.length, rawKeys, rawSample, mappedCount: mapped.length, mappedSample: mapped.slice(0, 5), log });
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
      id: p.id, title: p.title, price: p.variants?.[0]?.price, images: p.images?.length, status: p.status
    })) });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/shopify/collections', async (req, res) => {
  try {
    const token = await getShopifyToken();
    const cols = await loadShopifyCollections(token);
    res.json({ success: true, count: cols.length, collections: cols.map(c => ({
      id: c.id, title: c.title, handle: c.handle, productsCount: c.products_count
    })) });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/trends/analyze', async (req, res) => {
  const {
    customKeywords = [],
    count = 15,
    useTikTok = true,
    tiktokCountry = 'US',
    tiktokCountries,  // Optional Array — überschreibt single country
    tiktokPeriod = '30'
  } = req.body;
  const serverLog = [];
  const L = (msg, type='sys') => { serverLog.push({msg, type}); console.log('['+type+'] '+msg); };

  // Country-Liste normalisieren
  const countryList = (Array.isArray(tiktokCountries) && tiktokCountries.length > 0)
    ? tiktokCountries
    : [tiktokCountry];

  try {
    L('━━━ Phase 1: Trend-Analyse ━━━', 'info');
    let tiktokTrends = [];
    if (useTikTok && CONFIG.APIFY_TOKEN) {
      L(`TikTok Discovery für ${countryList.length} Land/Länder: ${countryList.join(', ')} · ${tiktokPeriod}d`, 'info');

      // Discovery PARALLEL pro Land — schneller als sequenziell
      const results = await Promise.all(
        countryList.map(c => discoverTikTokTrends({
          country: c, period: tiktokPeriod, maxResults: 30
        }, L).catch(err => {
          L(`Country ${c} fehlgeschlagen: ${err.message}`, 'warn');
          return [];
        }))
      );

      // Merge mit Tracking welcher Hashtag in welchen Ländern auftaucht
      const hashtagMap = new Map();  // hashtag -> { ...data, countries: [...] }
      results.forEach((countryResults, idx) => {
        const country = countryList[idx];
        countryResults.forEach(t => {
          const key = t.hashtag.toLowerCase();
          if (hashtagMap.has(key)) {
            const existing = hashtagMap.get(key);
            existing.countries.push(country);
            existing.crossCountryRank = (existing.crossCountryRank || 0) + (Math.max(0, 100 - (t.rank || 50)));
            // Höchsten Wert behalten
            existing.videoCount = Math.max(existing.videoCount || 0, t.videoCount || 0);
            existing.views = Math.max(existing.views || 0, t.views || 0);
          } else {
            hashtagMap.set(key, { ...t, countries: [country], crossCountryRank: Math.max(0, 100 - (t.rank || 50)) });
          }
        });
      });

      tiktokTrends = Array.from(hashtagMap.values()).sort((a, b) => {
        // Cross-Country Trends zuerst, dann nach Reichweite
        if (a.countries.length !== b.countries.length) return b.countries.length - a.countries.length;
        return (b.views || 0) - (a.views || 0);
      });

      if (tiktokTrends.length > 0) {
        const newOnly = tiktokTrends.filter(t => t.isNew).length;
        const upOnly = tiktokTrends.filter(t => t.trendDirection === 'up').length;
        const crossCountry = tiktokTrends.filter(t => t.countries.length > 1).length;
        L(`✓ ${tiktokTrends.length} unique Hashtags · NEU: ${newOnly} · Aufsteigend: ${upOnly} · Cross-Country: ${crossCountry}`, 'ok');
        L(`Top 5: ${tiktokTrends.slice(0,5).map(t => `#${t.hashtag}(${t.countries.join('+')})`).join(', ')}`, 'info');
      }
    }
    L('Sonnet 4.6 strukturiert Trends...', 'info');
    const analysis = await analyzeTrends(customKeywords, count, tiktokTrends);
    L(`✓ ${(analysis.trends || []).length} Trend-Karten erstellt`, 'ok');

    if (tiktokTrends.length > 0 && analysis.trends) {
      let matchedCount = 0;
      analysis.trends.forEach(t => {
        if (t.tiktokHashtag) {
          const match = tiktokTrends.find(tk => tk.hashtag.toLowerCase() === t.tiktokHashtag.toLowerCase().replace(/^#/, ''));
          if (match) {
            t.tiktokLive = {
              hashtag: match.hashtag, rank: match.rank,
              videoCount: match.videoCount, views: match.views,
              rankChange: match.rankChange, country: match.country,
              isNew: match.isNew, trendDirection: match.trendDirection,
              countries: match.countries || [match.country],  // alle Länder wo der Trend lebt
              crossCountry: (match.countries || []).length > 1,
            };
            matchedCount++;
          }
        }
      });
      L(`${matchedCount} Trends mit TikTok-Live-Daten verknüpft`, 'ok');
    }
    res.json({
      success: true, ...analysis,
      tiktokTrendsCount: tiktokTrends.length,
      tiktokCountriesQueried: countryList,
      serverLog
    });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message, serverLog });
  }
});

app.post('/api/products/search', async (req, res) => {
  const { confirmedTrends = [], tiktokCountry = 'US', useTikTokLookup = true, preferEUStock = false } = req.body;
  if (!confirmedTrends.length) return res.status(400).json({ error: 'Keine Trends bestätigt' });
  const log = [];
  const L = (msg, type='sys') => { log.push({msg, type}); console.log('['+type+'] '+msg); };
  try {
    const cjt = await getCJToken();
    L('CJDropshipping verbunden', 'ok');
    await loadBeautyCategoryIds(cjt, L);
    const shopToken = await getShopifyToken();
    const existingProducts = await getExistingProducts(shopToken);
    L(`${existingProducts.length} bestehende Shopify-Produkte geladen für Duplikat-Check`, 'info');

    let tiktokDetails = {};
    if (useTikTokLookup && CONFIG.APIFY_TOKEN) {
      const hashtagsToLookup = confirmedTrends.filter(t => t.tiktokHashtag).map(t => t.tiktokHashtag);
      if (hashtagsToLookup.length > 0) {
        L(`TikTok-Lookup: ${hashtagsToLookup.length} Hashtags`, 'info');
        try {
          const details = await lookupHashtagAnalytics(hashtagsToLookup, { country: tiktokCountry }, L);
          details.forEach(d => { if (d.hashtag) tiktokDetails[d.hashtag.toLowerCase()] = d; });
          L(`✓ ${details.length} Detail-Berichte`, 'ok');
        } catch(e) { L(`TikTok-Lookup Fehler: ${e.message}`, 'warn'); }
      }
    }

    const trendResults = [];
    for (const trend of confirmedTrends) {
      L(`━━━ "${trend.name}" (Keyword: "${trend.cjKeyword}") ━━━`, 'info');
      if (trend.tiktokHashtag) {
        const lookup = tiktokDetails[trend.tiktokHashtag.toLowerCase()];
        if (lookup) {
          trend.tiktokLookup = lookup;
          L(`  TikTok-Detail: 7d ${lookup.views7d?.toLocaleString() || '?'} views`, 'info');
        }
      }

      const candidates = await findCJProductsForTrend(cjt, trend, L);
      if (!candidates.length) {
        L(`  ✗ Keine Beauty-Produkte`, 'warn');
        trendResults.push({ trend, candidates: [], message: 'Keine Treffer' });
        continue;
      }

      // Top 5 für Stock-Check (Top 3 für UI, +2 Reserve)
      const topRaw = candidates.slice(0, 5);

      // Stock parallel laden für Score-Berechnung mit EU-Bonus
      const stockData = await Promise.all(topRaw.map(c => getCJStockByPid(cjt, c.pid)));

      const scored = topRaw.map((p, i) => {
        const { score, reasons } = scoreProduct(p, trend, stockData[i]);
        return { ...p, _score: score, _scoreReasons: reasons, _stock: stockData[i] };
      }).sort((a, b) => b._score - a._score);

      // Optional: EU-Stock priorisieren
      if (preferEUStock) {
        scored.sort((a, b) => {
          const aEU = a._stock.some(s => EU_WAREHOUSE_CODES.includes(s.country) && s.total > 0) ? 1 : 0;
          const bEU = b._stock.some(s => EU_WAREHOUSE_CODES.includes(s.country) && s.total > 0) ? 1 : 0;
          if (aEU !== bEU) return bEU - aEU;
          return b._score - a._score;
        });
        L(`  ↻ EU-Stock priorisiert`, 'sys');
      }

      L(`  ✓ ${scored.length} Beauty-Produkte, Top-Score: ${scored[0]._score}`, 'ok');

      const top3 = scored.slice(0, 3);
      const detailedCandidates = await Promise.all(
        top3.map(c => prepareProductForImport(cjt, c, trend, {}, L))
      );

      const enriched = detailedCandidates.map((d, i) => {
        const dupes = findDuplicates(d, existingProducts, 0.6);
        const isDup = dupes.length > 0;
        if (isDup) L(`  ⚠ DUP: "${d.name}" ähnelt ${dupes.length} bestehenden Produkten (${Math.round(dupes[0].similarity * 100)}% ${dupes[0].title})`, 'warn');
        return {
          ...d,
          isDuplicate: isDup,
          duplicates: dupes,  // Liefert komplette Detail-Daten der gefundenen Duplikate
          score: top3[i]._score,
          scoreReasons: top3[i]._scoreReasons
        };
      });

      enriched.forEach((c, i) => {
        const reviewInfo = c.reviews.avgScore ? ` · ${c.reviews.avgScore}★` : '';
        const euInfo = c.hasEUStock ? ` · EU:${c.stock.eu}` : '';
        const usInfo = c.stock.us > 0 ? ` · US:${c.stock.us}` : '';
        L(`  ${i+1}. "${c.name}" | $${c.vk} | ${c.shipping?.businessDays}d${reviewInfo}${euInfo}${usInfo}`, 'info');
      });

      trendResults.push({ trend, candidates: enriched });
    }

    const totalCands = trendResults.reduce((s, r) => s + r.candidates.length, 0);
    L(`━━━ FERTIG: ${totalCands} Kandidaten ━━━`, 'ok');
    res.json({ success: true, trendResults, log });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message, log });
  }
});

app.post('/api/products/import', async (req, res) => {
  const {
    confirmedProducts = [],
    language = 'EN',
    euCompliant = false,
    autoCollections = true,
  } = req.body;
  if (!confirmedProducts.length) return res.status(400).json({ error: 'Keine Produkte bestätigt' });
  const log = [];
  const L = (msg, type='sys') => { log.push({msg, type}); console.log('['+type+'] '+msg); };
  try {
    const shopToken = await getShopifyToken();
    L(`Shopify verbunden · Sprache: ${language}${euCompliant ? ' · EU-Compliance: AKTIV' : ''}${autoCollections ? ' · Auto-Collections: ON' : ''}`, 'ok');
    let published = 0;
    let skipped = 0;
    let replaced = 0;
    const results = [];
    const collectionsCreated = new Set();

    for (const product of confirmedProducts) {
      // Duplikat-Action prüfen
      const dupAction = product._duplicateAction; // 'skip', 'replace', 'both' oder undefined
      const dupTargets = product._duplicateTargets || []; // Array von Shopify-IDs zum Ersetzen

      if (dupAction === 'skip') {
        L(`⏭ SKIP: ${product.name} (Duplikat, übersprungen)`, 'warn');
        skipped++;
        continue;
      }

      if (dupAction === 'replace' && dupTargets.length > 0) {
        L(`🔄 REPLACE: ${product.name} ersetzt ${dupTargets.length} bestehende Produkte`, 'info');
        for (const targetId of dupTargets) {
          try {
            const delR = await fetch(`https://${CONFIG.SHOPIFY_DOMAIN}/admin/api/${CONFIG.SHOPIFY_API_VERSION}/products/${targetId}.json`, {
              method: 'DELETE',
              headers: { 'X-Shopify-Access-Token': shopToken }
            });
            if (delR.ok) {
              L(`  ✓ Altes Produkt ${targetId} gelöscht`, 'ok');
              replaced++;
            } else {
              L(`  ⚠ Löschung ${targetId} fehlgeschlagen (${delR.status})`, 'warn');
            }
          } catch(e) {
            L(`  ⚠ Lösch-Fehler ${targetId}: ${e.message}`, 'warn');
          }
        }
      }

      L(`Generiere Marketing (${language}${euCompliant ? '/EU-Compliant' : ''}): ${product.name}`, 'info');
      const content = await generateContent(product, { language, euCompliant });
      L(`Importiere: ${product.name} | ${product.images.length} Bilder | $${product.vk}`, 'info');

      try {
        const shopifyProduct = await publishProduct(shopToken, product, content);
        published++;

        if (autoCollections && product.trend?.category) {
          const col = await ensureSmartCollection(shopToken, product.trend.category, L);
          if (col) collectionsCreated.add(product.trend.category);
        }

        results.push({
          name: product.name, shopifyId: shopifyProduct.id, shopifyHandle: shopifyProduct.handle,
          price: product.vk, compareAt: product.compareAt, margin: product.margin,
          profit: product.profit, images: product.images.length, status: 'live',
          language, euCompliant, category: product.trend?.category,
          duplicateAction: dupAction || 'none',
        });
        L(`✓ LIVE: ${product.name} | $${product.vk} | ${product.margin}% Marge`, 'ok');
      } catch(e) {
        L(`✗ Fehler: ${e.message}`, 'err');
      }
    }

    L(`=== FERTIG: ${published} live · ${skipped} skip · ${replaced} ersetzt · ${collectionsCreated.size} Collections ===`, 'ok');
    res.json({
      success: true, published, skipped, replaced,
      total: confirmedProducts.length,
      results, log,
      collectionsTouched: Array.from(collectionsCreated)
    });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message, log });
  }
});

// Direkter Delete-Endpoint (falls separat gebraucht)
app.delete('/api/shopify/product/:id', async (req, res) => {
  try {
    const shopToken = await getShopifyToken();
    const r = await fetch(`https://${CONFIG.SHOPIFY_DOMAIN}/admin/api/${CONFIG.SHOPIFY_API_VERSION}/products/${req.params.id}.json`, {
      method: 'DELETE',
      headers: { 'X-Shopify-Access-Token': shopToken }
    });
    res.json({ success: r.ok, status: r.status });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============= SHOP AUDIT: DUPLIKAT-FINDER =============
// Vergleicht alle Shopify-Produkte gegeneinander, findet Duplikat-Paare
app.get('/api/audit/duplicates', async (req, res) => {
  const log = [];
  const L = (msg, type='sys') => { log.push({msg, type}); console.log('['+type+'] '+msg); };
  try {
    const threshold = parseFloat(req.query.threshold || '0.6');
    const shopToken = await getShopifyToken();
    L('Lade alle Shopify-Produkte...', 'info');
    const products = await getExistingProducts(shopToken);
    L(`✓ ${products.length} Produkte geladen`, 'ok');

    if (products.length < 2) {
      return res.json({
        success: true,
        productCount: products.length,
        duplicatePairs: [],
        message: 'Zu wenige Produkte für Duplikat-Audit (mindestens 2 nötig)',
        log
      });
    }

    L(`Analyse: ${products.length}×${products.length-1}/2 = ${Math.round(products.length * (products.length-1) / 2)} Vergleiche`, 'info');
    L(`Threshold: ${Math.round(threshold * 100)}% Ähnlichkeit (Name 50% + Beschreibung 50%)`, 'info');

    const pairs = [];
    for (let i = 0; i < products.length; i++) {
      for (let j = i + 1; j < products.length; j++) {
        const a = products[i];
        const b = products[j];

        // Name-Similarity (verwendet bestehende Funktion)
        const nameSim = calculateSimilarity(a.title, b.title);
        // Beschreibungs-Similarity
        const descSim = calculateTextSimilarity(a.bodyText || '', b.bodyText || '');

        // Gewichtetes Total: 50% Name + 50% Beschreibung
        // Falls eine Beschreibung leer: voller Name-Score
        const hasDesc = (a.bodyText || '').length > 20 && (b.bodyText || '').length > 20;
        const total = hasDesc
          ? (nameSim * 0.5 + descSim * 0.5)
          : nameSim;

        if (total >= threshold) {
          pairs.push({
            similarity: total,
            nameSimilarity: nameSim,
            descSimilarity: descSim,
            hasDescription: hasDesc,
            productA: {
              id: a.id, title: a.title, mainImage: a.mainImage,
              price: a.price, status: a.status, imageCount: a.imageCount,
              adminUrl: a.adminUrl, publicUrl: a.publicUrl,
              productType: a.productType, vendor: a.vendor,
              descPreview: (a.bodyText || '').slice(0, 150)
            },
            productB: {
              id: b.id, title: b.title, mainImage: b.mainImage,
              price: b.price, status: b.status, imageCount: b.imageCount,
              adminUrl: b.adminUrl, publicUrl: b.publicUrl,
              productType: b.productType, vendor: b.vendor,
              descPreview: (b.bodyText || '').slice(0, 150)
            }
          });
        }
      }
    }

    pairs.sort((x, y) => y.similarity - x.similarity);
    L(`✓ ${pairs.length} Duplikat-Paare gefunden über Threshold ${Math.round(threshold * 100)}%`, pairs.length > 0 ? 'warn' : 'ok');

    res.json({
      success: true,
      productCount: products.length,
      duplicatePairs: pairs,
      threshold,
      log
    });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message, log });
  }
});

// ╔══════════════════════════════════════════════════════════════════╗
// ║  ZORASKIN SHOP SETUP — v1.0                                      ║
// ║  Browser-basiertes Komplett-Setup: Pages, Menus, Theme-Config    ║
// ║  Aufruf:  GET  /setup            → Browser-Seite mit Knopf       ║
// ║           POST /api/shop/setup   → führt Setup durch             ║
// ║  Nutzt bestehende Helper aus v8.4 (getShopifyToken, CONFIG)      ║
// ╚══════════════════════════════════════════════════════════════════╝

const SETUP_COLLECTIONS = [
  { title: 'Bestsellers', handle: 'bestsellers',
    body_html: '<p>The pieces our community can\'t stop talking about.</p>',
    rules: [{ column: 'tag', relation: 'equals', condition: 'Trending 2026' }],
    disjunctive: true, sort_order: 'best-selling' },
  { title: 'Skincare Tools', handle: 'skincare-tools',
    body_html: '<p>Premium tools for sculpting, depuffing, and lifting.</p>',
    rules: [
      { column: 'title', relation: 'contains', condition: 'gua sha' },
      { column: 'title', relation: 'contains', condition: 'roller' },
      { column: 'title', relation: 'contains', condition: 'massager' },
      { column: 'title', relation: 'contains', condition: 'globe' },
      { column: 'tag', relation: 'equals', condition: 'Skincare Tools' }
    ], disjunctive: true, sort_order: 'best-selling' },
  { title: 'LED Therapy', handle: 'led-therapy',
    body_html: '<p>Red light, blue light, infrared. Clinical-grade devices for at-home treatment.</p>',
    rules: [
      { column: 'title', relation: 'contains', condition: 'led' },
      { column: 'title', relation: 'contains', condition: 'light therapy' },
      { column: 'title', relation: 'contains', condition: 'red light' },
      { column: 'tag', relation: 'equals', condition: 'LED Therapy' }
    ], disjunctive: true, sort_order: 'best-selling' },
  { title: 'Daily Rituals', handle: 'daily-rituals',
    body_html: '<p>Cleansers, serums, masks, and creams. The everyday essentials.</p>',
    rules: [
      { column: 'title', relation: 'contains', condition: 'cream' },
      { column: 'title', relation: 'contains', condition: 'serum' },
      { column: 'title', relation: 'contains', condition: 'mask' },
      { column: 'title', relation: 'contains', condition: 'cleanser' },
      { column: 'title', relation: 'contains', condition: 'steamer' }
    ], disjunctive: true, sort_order: 'best-selling' },
  { title: 'New Arrivals', handle: 'new-arrivals',
    body_html: '<p>Just landed. Be the first to try our latest drops.</p>',
    rules: [{ column: 'vendor', relation: 'equals', condition: 'ZoraSkin' }],
    disjunctive: false, sort_order: 'created-desc' },
  { title: 'EU Fast Shipping', handle: 'eu-fast-shipping',
    body_html: '<p>Ships from European warehouses — receive in 3–7 business days.</p>',
    rules: [{ column: 'tag', relation: 'equals', condition: 'EU Stock' }],
    disjunctive: false, sort_order: 'best-selling' }
];

const SETUP_PAGES = [
  { handle: 'about', title: 'About ZoraSkin',
    body_html: '<p><em>ZoraSkin started with a simple frustration: too many beauty products promise everything and deliver nothing.</em></p><p>We\'re a small team of skincare obsessives who believe that real results come from two things — well-engineered tools and clean, no-nonsense formulations. Nothing else.</p><h3>What we believe</h3><ul><li><strong>Craft over hype.</strong> We test every product for months before launch.</li><li><strong>Honest formulations.</strong> Cruelty-free, dermatologist-tested.</li><li><strong>Built to last.</strong> Premium materials.</li></ul><h3>Where we ship</h3><p>Worldwide. Many of our products ship from European warehouses for 3–7 day delivery in EU/UK; orders to other regions arrive within 7–14 business days.</p><h3>Get in touch</h3><p>Questions? Email <a href="mailto:zoraskin.contact@gmail.com">zoraskin.contact@gmail.com</a>.</p>' },
  { handle: 'contact', title: 'Contact Us',
    body_html: '<p>We\'d love to hear from you. Most messages get a reply within 24 hours.</p><h3>General inquiries</h3><p><strong>Email:</strong> <a href="mailto:zoraskin.contact@gmail.com">zoraskin.contact@gmail.com</a></p><h3>Order support</h3><p>Already have an order? Include your order number for the fastest response.</p><h3>Response time</h3><p>Monday–Friday: within 24 hours<br>Weekends: within 48 hours</p>' },
  { handle: 'shipping', title: 'Shipping Information',
    body_html: '<h3>Shipping rates</h3><ul><li><strong>Free worldwide shipping</strong> on orders over $50</li><li>Standard shipping (under $50): $4.99 flat rate</li></ul><h3>Delivery times</h3><ul><li><strong>EU / UK (from EU warehouse):</strong> 3–7 business days 🇪🇺</li><li><strong>USA, Canada (from US warehouse):</strong> 7–12 business days 🇺🇸</li><li><strong>Rest of world:</strong> 12–18 business days</li></ul><p><em>Each product page shows the expected shipping time based on warehouse availability.</em></p><h3>Tracking</h3><p>You\'ll receive a tracking link by email as soon as your order ships.</p><h3>Customs &amp; duties</h3><p>For international orders outside the warehouse region, any import duties or taxes are the responsibility of the recipient.</p>' },
  { handle: 'returns', title: 'Returns &amp; Exchanges',
    body_html: '<h3>30-day money-back guarantee</h3><p>Not in love with your purchase? Send it back within 30 days for a full refund. No questions asked.</p><h3>How to return</h3><ol><li>Email <a href="mailto:zoraskin.contact@gmail.com">zoraskin.contact@gmail.com</a> with your order number</li><li>We\'ll send you a return label and instructions</li><li>Drop off the package at your local post office</li><li>Refund processed within 5 business days of receipt</li></ol><h3>Conditions</h3><ul><li>Items in original condition (skincare tools cleaned)</li><li>Opened cosmetic products excluded for hygiene reasons</li></ul><h3>EU customers — Right of withdrawal</h3><p>Per EU consumer law, you have a 14-day right of withdrawal from receipt of goods, no reason required. Our 30-day policy extends this further at our discretion.</p><h3>Damaged items</h3><p>Email us a photo — we\'ll send a replacement at no cost.</p>' },
  { handle: 'faq', title: 'Frequently Asked Questions',
    body_html: '<h3>Are your products cruelty-free?</h3><p>Yes. Every ZoraSkin product is cruelty-free.</p><h3>Are the materials safe?</h3><p>All our gua sha tools, rollers, and globes are made from genuine semi-precious stones. LED devices are CE-certified where applicable.</p><h3>How do I clean my gua sha or roller?</h3><p>Wash with warm water and gentle soap after each use. Pat dry.</p><h3>Will I see results?</h3><p>Most customers notice visible changes within 2–3 weeks of consistent use (3–5 times per week).</p><h3>Where do you ship from?</h3><p>From multiple fulfillment centers — typically the closest to you. EU customers usually receive items from our European warehouses for fastest delivery.</p><h3>Can I cancel my order?</h3><p>If your order hasn\'t shipped yet, yes — email us within 12 hours of ordering.</p>' },
  { handle: 'imprint', title: 'Imprint',
    body_html: '<p><em>Information per Swiss e-commerce regulations and the EU Digital Services Act.</em></p><h3>Operator</h3><p>[Your full name]<br>[Your street + number]<br>[ZIP] Bern<br>Switzerland</p><h3>Contact</h3><p>Email: <a href="mailto:zoraskin.contact@gmail.com">zoraskin.contact@gmail.com</a><br>Phone: [+41 XX XXX XX XX]</p><h3>UID / VAT</h3><p>[CH-UID-Number — only if registered as a business]</p><h3>Online dispute resolution (EU customers)</h3><p>European Commission platform: <a href="https://ec.europa.eu/consumers/odr" target="_blank" rel="noopener">https://ec.europa.eu/consumers/odr</a></p><h3>Disclaimer</h3><p>Despite careful content control, we assume no liability for the content of external links.</p>' }
];

// GraphQL Helper (nutzt bestehende getShopifyToken + CONFIG)
async function setupShopifyGraphQL(query, variables = {}) {
  const token = await getShopifyToken();
  const r = await fetch(`https://${CONFIG.SHOPIFY_DOMAIN}/admin/api/${CONFIG.SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const data = await r.json();
  if (data.errors) throw new Error('GraphQL: ' + JSON.stringify(data.errors));
  return data.data;
}

// REST Helper (nutzt bestehende getShopifyToken + CONFIG)
async function setupShopifyREST(path, options = {}) {
  const token = await getShopifyToken();
  const r = await fetch(`https://${CONFIG.SHOPIFY_DOMAIN}/admin/api/${CONFIG.SHOPIFY_API_VERSION}${path}`, {
    ...options,
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`${options.method || 'GET'} ${path} → ${r.status}: ${txt.slice(0, 300)}`);
  }
  return r.json();
}

// SETUP-API Endpoint
app.post('/api/shop/setup', async (req, res) => {
  const log = [];
  const L = (msg, type = 'info') => { log.push({ msg, type, time: new Date().toISOString() }); console.log(`[setup:${type}] ${msg}`); };

  try {
    L('Setup gestartet', 'sys');
    await getShopifyToken();
    L('Shopify-Auth OK', 'ok');

    // STEP 1: Theme finden
    const themesData = await setupShopifyREST('/themes.json');
    const theme = themesData.themes.find(t => t.name === 'ZoraSkin')
      || themesData.themes.find(t => t.role === 'unpublished' && t.name.toLowerCase().includes('zora'))
      || themesData.themes.find(t => t.role === 'main');
    if (!theme) throw new Error('Theme "ZoraSkin" nicht gefunden. Lade es zuerst hoch (Online Store → Themes → Add theme → Upload zip).');
    L(`Theme gefunden: "${theme.name}" (Role: ${theme.role})`, 'ok');

    // STEP 2: Produkte zählen
    const products = (await setupShopifyREST('/products.json?limit=250&fields=id,title,tags,vendor')).products;
    L(`${products.length} Produkte im Shop`, 'info');

    // STEP 3: Smart Collections
    const existingCols = (await setupShopifyREST('/smart_collections.json?limit=250')).smart_collections;
    const collections = [];
    for (const def of SETUP_COLLECTIONS) {
      const found = existingCols.find(c => c.handle === def.handle);
      if (found) {
        collections.push({ ...def, id: found.id, gid: `gid://shopify/Collection/${found.id}` });
        L(`Collection "${def.title}" existiert bereits — übersprungen`, 'info');
      } else {
        const r = await setupShopifyREST('/smart_collections.json', {
          method: 'POST', body: JSON.stringify({ smart_collection: def })
        });
        collections.push({ ...def, id: r.smart_collection.id, gid: `gid://shopify/Collection/${r.smart_collection.id}` });
        L(`Collection "${def.title}" angelegt (ID ${r.smart_collection.id})`, 'ok');
      }
      await new Promise(r => setTimeout(r, 400));
    }

    // STEP 4: Pages
    const existingPages = (await setupShopifyREST('/pages.json?limit=250')).pages;
    const pages = [];
    for (const def of SETUP_PAGES) {
      const found = existingPages.find(p => p.handle === def.handle);
      if (found) {
        await setupShopifyREST(`/pages/${found.id}.json`, {
          method: 'PUT',
          body: JSON.stringify({ page: { id: found.id, body_html: def.body_html, title: def.title } })
        });
        pages.push({ ...def, id: found.id, gid: `gid://shopify/Page/${found.id}` });
        L(`Page "${def.title}" aktualisiert`, 'ok');
      } else {
        const r = await setupShopifyREST('/pages.json', {
          method: 'POST',
          body: JSON.stringify({ page: { ...def, published: true } })
        });
        pages.push({ ...def, id: r.page.id, gid: `gid://shopify/Page/${r.page.id}` });
        L(`Page "${def.title}" angelegt`, 'ok');
      }
      await new Promise(r => setTimeout(r, 400));
    }

    // STEP 5: Menus
    const colByHandle = Object.fromEntries(collections.map(c => [c.handle, c]));
    const pageByHandle = Object.fromEntries(pages.map(p => [p.handle, p]));

    const MENUS = [
      { title: 'Main menu', handle: 'main-menu', items: [
        { title: 'Shop', type: 'COLLECTION', resourceId: colByHandle['bestsellers']?.gid, url: '/collections/bestsellers' },
        { title: 'Bestsellers', type: 'COLLECTION', resourceId: colByHandle['bestsellers']?.gid, url: '/collections/bestsellers' },
        { title: 'Skincare Tools', type: 'COLLECTION', resourceId: colByHandle['skincare-tools']?.gid, url: '/collections/skincare-tools' },
        { title: 'LED Therapy', type: 'COLLECTION', resourceId: colByHandle['led-therapy']?.gid, url: '/collections/led-therapy' },
        { title: 'Fast EU Shipping', type: 'COLLECTION', resourceId: colByHandle['eu-fast-shipping']?.gid, url: '/collections/eu-fast-shipping' },
        { title: 'About', type: 'PAGE', resourceId: pageByHandle['about']?.gid, url: '/pages/about' }
      ]},
      { title: 'Footer Shop', handle: 'footer', items: [
        { title: 'Bestsellers', type: 'COLLECTION', resourceId: colByHandle['bestsellers']?.gid, url: '/collections/bestsellers' },
        { title: 'New Arrivals', type: 'COLLECTION', resourceId: colByHandle['new-arrivals']?.gid, url: '/collections/new-arrivals' },
        { title: 'Skincare Tools', type: 'COLLECTION', resourceId: colByHandle['skincare-tools']?.gid, url: '/collections/skincare-tools' },
        { title: 'LED Therapy', type: 'COLLECTION', resourceId: colByHandle['led-therapy']?.gid, url: '/collections/led-therapy' },
        { title: 'Daily Rituals', type: 'COLLECTION', resourceId: colByHandle['daily-rituals']?.gid, url: '/collections/daily-rituals' },
        { title: 'EU Fast Shipping', type: 'COLLECTION', resourceId: colByHandle['eu-fast-shipping']?.gid, url: '/collections/eu-fast-shipping' }
      ]},
      { title: 'Footer Support', handle: 'footer-support', items: [
        { title: 'Contact us', type: 'PAGE', resourceId: pageByHandle['contact']?.gid, url: '/pages/contact' },
        { title: 'Shipping', type: 'PAGE', resourceId: pageByHandle['shipping']?.gid, url: '/pages/shipping' },
        { title: 'Returns', type: 'PAGE', resourceId: pageByHandle['returns']?.gid, url: '/pages/returns' },
        { title: 'FAQ', type: 'PAGE', resourceId: pageByHandle['faq']?.gid, url: '/pages/faq' }
      ]},
      { title: 'Footer Company', handle: 'footer-company', items: [
        { title: 'About', type: 'PAGE', resourceId: pageByHandle['about']?.gid, url: '/pages/about' },
        { title: 'Imprint', type: 'PAGE', resourceId: pageByHandle['imprint']?.gid, url: '/pages/imprint' },
        { title: 'Privacy Policy', type: 'HTTP', url: '/policies/privacy-policy' },
        { title: 'Terms of Service', type: 'HTTP', url: '/policies/terms-of-service' },
        { title: 'Refund Policy', type: 'HTTP', url: '/policies/refund-policy' }
      ]}
    ];

    const existingMenus = (await setupShopifyGraphQL(`query{menus(first:50){nodes{id handle title}}}`)).menus.nodes;
    const existingMenuMap = Object.fromEntries(existingMenus.map(m => [m.handle, m]));

    for (const menu of MENUS) {
      const items = menu.items
        .filter(i => i.type === 'HTTP' || i.resourceId)
        .map(i => i.type === 'HTTP'
          ? { title: i.title, type: 'HTTP', url: i.url }
          : { title: i.title, type: i.type, resourceId: i.resourceId });

      if (existingMenuMap[menu.handle]) {
        const r = await setupShopifyGraphQL(
          `mutation menuUpdate($id:ID!,$title:String!,$handle:String!,$items:[MenuItemUpdateInput!]!){menuUpdate(id:$id,title:$title,handle:$handle,items:$items){menu{id} userErrors{field message}}}`,
          { id: existingMenuMap[menu.handle].id, title: menu.title, handle: menu.handle, items }
        );
        if (r.menuUpdate.userErrors.length) {
          L(`Menu "${menu.title}" Fehler: ${JSON.stringify(r.menuUpdate.userErrors)}`, 'err');
        } else {
          L(`Menu "${menu.title}" aktualisiert (${items.length} Links)`, 'ok');
        }
      } else {
        const r = await setupShopifyGraphQL(
          `mutation menuCreate($title:String!,$handle:String!,$items:[MenuItemCreateInput!]!){menuCreate(title:$title,handle:$handle,items:$items){menu{id} userErrors{field message}}}`,
          { title: menu.title, handle: menu.handle, items }
        );
        if (r.menuCreate.userErrors.length) {
          L(`Menu "${menu.title}" Fehler: ${JSON.stringify(r.menuCreate.userErrors)}`, 'err');
        } else {
          L(`Menu "${menu.title}" angelegt (${items.length} Links)`, 'ok');
        }
      }
      await new Promise(r => setTimeout(r, 500));
    }

    // STEP 6: Theme Settings
    const settingsData = {
      current: {
        color_background: '#faf6f0', color_surface: '#ffffff', color_surface_alt: '#f5f0e8',
        color_text: '#1a1410', color_muted: '#8a7d72', color_accent: '#c9956a',
        color_sage: '#3d7a5c', page_width: 1280, cart_type: 'page'
      },
      presets: { 'ZoraSkin Default': { color_background: '#faf6f0', color_accent: '#c9956a', page_width: 1280 } }
    };
    await setupShopifyREST(`/themes/${theme.id}/assets.json`, {
      method: 'PUT',
      body: JSON.stringify({ asset: { key: 'config/settings_data.json', value: JSON.stringify(settingsData, null, 2) } })
    });
    L('Theme-Settings (Farben, Layout) gesetzt', 'ok');

    L('=== SETUP ABGESCHLOSSEN ===', 'ok');
    res.json({
      success: true,
      collections: collections.length,
      pages: pages.length,
      menus: MENUS.length,
      themeName: theme.name,
      themePublished: theme.role === 'main',
      log
    });
  } catch (e) {
    L(`FEHLER: ${e.message}`, 'err');
    res.status(500).json({ success: false, error: e.message, log });
  }
});

// HTML-Setup-Seite
app.get('/setup', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZoraSkin Shop Setup</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500&family=DM+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',sans-serif;background:#faf6f0;color:#1a1410;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem}
.wrap{max-width:680px;width:100%}
.card{background:#fff;border-radius:14px;padding:3rem 2.5rem;box-shadow:0 8px 30px rgba(26,20,16,.08)}
.logo{font-family:'Cormorant Garamond',serif;font-size:32px;letter-spacing:.3em;text-align:center;margin-bottom:.5rem}
.subtitle{text-align:center;color:#8a7d72;font-size:13px;letter-spacing:.1em;text-transform:uppercase;margin-bottom:2.5rem}
h2{font-family:'Cormorant Garamond',serif;font-weight:400;font-size:1.65rem;margin-bottom:.75rem}
p{color:#5a4f47;line-height:1.65;margin-bottom:1rem}
.task-list{margin:1.5rem 0;padding:0;list-style:none}
.task-list li{padding:.65rem 0 .65rem 1.85rem;position:relative;color:#5a4f47;font-size:14px}
.task-list li::before{content:'✓';position:absolute;left:0;color:#3d7a5c;font-weight:700}
.btn{display:block;width:100%;padding:1.1rem 2rem;background:#1a1410;color:#fff;border:0;border-radius:6px;font-size:14px;font-weight:500;letter-spacing:.16em;text-transform:uppercase;cursor:pointer;font-family:inherit;transition:all .2s;margin-top:1rem;text-decoration:none;text-align:center}
.btn:hover:not(:disabled){background:#8b5e3c}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn-secondary{background:#c9956a}
.btn-secondary:hover:not(:disabled){background:#8b5e3c}
.progress{margin-top:2rem;display:none}
.progress.active{display:block}
.log{background:#1a1410;color:#e8d9c4;padding:1.25rem;border-radius:8px;font-family:'SF Mono',Monaco,monospace;font-size:12px;line-height:1.6;max-height:400px;overflow-y:auto;white-space:pre-wrap}
.log .ok{color:#5fb88c}.log .err{color:#ed7c70}.log .info{color:#7eb6ed}.log .sys{color:rgba(255,255,255,.5)}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:spin 1s linear infinite;margin-right:.5rem;vertical-align:middle}
@keyframes spin{to{transform:rotate(360deg)}}
.success{display:none;background:rgba(61,122,92,.08);border:1px solid rgba(61,122,92,.3);padding:1.5rem;border-radius:8px;margin-top:1.5rem}
.success.active{display:block}
.success h3{color:#3d7a5c;margin-bottom:.75rem}
.error{display:none;background:rgba(192,57,43,.08);border:1px solid rgba(192,57,43,.3);padding:1.25rem;border-radius:8px;margin-top:1.5rem;color:#c0392b}
.error.active{display:block}
.next-steps{margin-top:1rem;padding:1.25rem;background:#f5f0e8;border-radius:8px}
.next-steps h4{font-family:'Cormorant Garamond',serif;font-weight:500;margin-bottom:.5rem;color:#1a1410}
.next-steps p,.next-steps ol{color:#5a4f47;font-size:14px;line-height:1.7}
.next-steps a{color:#8b5e3c;border-bottom:1px solid currentColor;text-decoration:none}
</style></head><body>
<div class="wrap"><div class="card">
  <div class="logo">ZORASKIN</div>
  <div class="subtitle">Shop Setup · Vollautomatisch</div>
  <h2>Bereit, deinen Shop fertigzustellen?</h2>
  <p>Dieser Knopf erledigt in einem Schritt:</p>
  <ul class="task-list">
    <li>6 Smart Collections (Bestsellers, Skincare Tools, LED Therapy, Daily Rituals, New Arrivals, EU Fast Shipping)</li>
    <li>6 Pflichtseiten (About, Contact, Shipping, Returns, FAQ, Imprint) mit fertigem Text</li>
    <li>4 Navigation Menus (Header + 3 Footer-Spalten)</li>
    <li>Theme-Farben und Layout setzen</li>
  </ul>
  <p style="font-size:13px;color:#8a7d72">Dauer: ca. 30 Sekunden. Mehrfach klicken erlaubt — bestehende Inhalte werden aktualisiert, nicht doppelt angelegt.</p>
  <button class="btn" id="run-btn" onclick="runSetup()">▸ Setup jetzt starten</button>
  <div class="progress" id="progress">
    <p style="font-size:13px;color:#8a7d72;margin-bottom:.75rem"><span class="spinner" id="spinner"></span><span id="status">Setup läuft …</span></p>
    <div class="log" id="log"></div>
  </div>
  <div class="success" id="success">
    <h3>✓ Setup abgeschlossen</h3>
    <p style="color:#5a4f47;font-size:14px">Dein Shop ist befüllt. Damit alles live geht, machst du jetzt noch <strong>3 letzte Klicks</strong> im Shopify Admin:</p>
    <div class="next-steps">
      <h4>Klick 1 — Theme aktivieren</h4>
      <p><a href="https://${CONFIG.SHOPIFY_DOMAIN}/admin/themes" target="_blank">Online Store → Themes</a> → bei <strong>ZoraSkin</strong> → Actions → <strong>Publish</strong></p>
    </div>
    <div class="next-steps" style="margin-top:.75rem">
      <h4>Klick 2 — Hero-Bild hochladen</h4>
      <p>Themes → ZoraSkin → <strong>Customize</strong> → Hero Section → Background image (2400×1200 JPG)</p>
    </div>
    <div class="next-steps" style="margin-top:.75rem">
      <h4>Klick 3 — Impressum-Daten ergänzen</h4>
      <p><a href="https://${CONFIG.SHOPIFY_DOMAIN}/admin/pages" target="_blank">Pages</a> → <strong>Imprint</strong> → echte Adresse/Telefon/UID statt Platzhalter eintragen</p>
    </div>
    <a href="https://${CONFIG.SHOPIFY_DOMAIN}/admin" target="_blank"><div class="btn btn-secondary">Zum Shopify Admin</div></a>
  </div>
  <div class="error" id="error"></div>
</div></div>
<script>
async function runSetup(){
  const btn=document.getElementById('run-btn');
  const prog=document.getElementById('progress');
  const logEl=document.getElementById('log');
  const status=document.getElementById('status');
  const spinner=document.getElementById('spinner');
  const success=document.getElementById('success');
  const error=document.getElementById('error');
  btn.disabled=true;btn.textContent='Setup läuft…';
  prog.classList.add('active');
  success.classList.remove('active');
  error.classList.remove('active');
  logEl.innerHTML='';
  try{
    const r=await fetch('/api/shop/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    const data=await r.json();
    (data.log||[]).forEach(entry=>{
      const time=new Date(entry.time).toLocaleTimeString();
      const line=document.createElement('div');
      line.innerHTML='<span style="color:rgba(255,255,255,.4)">'+time+'</span>  <span class="'+entry.type+'">'+entry.msg+'</span>';
      logEl.appendChild(line);
    });
    logEl.scrollTop=logEl.scrollHeight;
    if(data.success){
      spinner.style.display='none';
      status.textContent='✓ Fertig — '+data.collections+' Collections · '+data.pages+' Pages · '+data.menus+' Menus';
      success.classList.add('active');
      btn.textContent='✓ Setup erledigt — nochmal ausführen';
      btn.disabled=false;
    }else{
      spinner.style.display='none';
      status.textContent='✗ Fehler beim Setup';
      error.classList.add('active');
      error.innerHTML='<strong>Fehler:</strong> '+(data.error||'Unbekannter Fehler')+'<br><br>Bitte den Log oben prüfen.';
      btn.textContent='Erneut versuchen';
      btn.disabled=false;
    }
  }catch(e){
    spinner.style.display='none';
    status.textContent='✗ Netzwerk-Fehler';
    error.classList.add('active');
    error.innerHTML='<strong>Fehler:</strong> '+e.message;
    btn.textContent='Erneut versuchen';
    btn.disabled=false;
  }
}
</script></body></html>`);
});

// ╚══════════════════════════════════════════════════════════════════╝
// ║  ENDE Setup-Block — Original v8.4 PORT/listen folgt unverändert  ║
// ╚══════════════════════════════════════════════════════════════════╝

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ZoraSkin Backend v8.4 auf Port ${PORT}`));
