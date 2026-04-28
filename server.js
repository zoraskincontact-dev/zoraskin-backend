// ZoraSkin Backend v8.1 — Erweiterte Trend-Analyse + Multi-Kandidaten + Bilder-Fix
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
  // Aktualisierte Modelle (April 2026)
  CLAUDE_MODEL_TRENDS: 'claude-sonnet-4-6',
  CLAUDE_MODEL_COPY: 'claude-haiku-4-5-20251001',
  // Aktuelle Shopify API-Version
  SHOPIFY_API_VERSION: '2026-01',
};

// Token-Cache
let shopifyToken = '', shopifyTokenExpiry = 0;
let cjToken = '', cjTokenExpiry = 0;

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
  const r = await fetch('https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken', {
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

// ============= BEAUTY-FILTER =============
const BEAUTY_CATEGORIES = ['Beauty','Skin Care','Hair Care','Personal Care','Health','Oral Care','Eye Care','Body Care','Face Care','Makeup','Cosmetics','Massage','Spa'];
const BEAUTY_WORDS = ['skin','face','beauty','hair','eye','lip','mask','serum','cream','roller','gua','jade','light therapy','whitening','massager','scrubber','razor','vitamin','collagen','therapy','lift','pore','acne','tone','glow','bright','anti aging','wrinkle','moistur','sunscreen','retinol','peptide','hyaluronic','niacin','lash','brow','neck','scalp','dental','teeth','charcoal','exfoli','cleanser','toner','essence','lotion','mist','spray','patch','strip','sponge','blender','brush','eyelid','cellulite','contouring','derma','microcurrent','radiofrequency','infrared','spa','facial','wand','globe','ice','steamer'];
const NON_BEAUTY = ['vacuum cleaner','car ','automotive','kitchen','food ','pet ','toy ','gaming','computer','phone case','cable','charger','tool','drill','bicycle','sport shoe','fishing','garden','furniture','mattress','curtain','laptop','tablet','headphone','keyboard','mouse pad','watch band','mobile phone','camera','speaker','audio','remote control'];

function isBeautyProduct(name, categoryName) {
  const n = (name || '').toLowerCase();
  const c = (categoryName || '').toLowerCase();
  if (BEAUTY_CATEGORIES.some(cat => c.includes(cat.toLowerCase()))) return true;
  if (NON_BEAUTY.some(nb => n.includes(nb))) return false;
  return BEAUTY_WORDS.some(w => n.includes(w));
}

// ============= CJ: Vollständige Bilder-Extraktion =============
async function getCJProductDetails(cjt, pid) {
  try {
    const r = await fetch(`https://developers.cjdropshipping.com/api2.0/v1/product/query?pid=${pid}`, {
      headers: { 'CJ-Access-Token': cjt }
    });
    const d = await r.json();
    if (!d.result || !d.data) return null;
    const p = d.data;

    const images = [];
    const addImg = (img) => {
      if (typeof img === 'string' && img.startsWith('https://') && !images.includes(img)) {
        images.push(img);
      }
    };

    // 1. Hauptbild
    addImg(p.productImage);

    // 2. productImageSet (oft die meisten Bilder)
    if (p.productImageSet) {
      try {
        const set = typeof p.productImageSet === 'string' ? JSON.parse(p.productImageSet) : p.productImageSet;
        if (Array.isArray(set)) set.forEach(addImg);
      } catch(e) {}
    }

    // 3. Variant-Bilder
    if (Array.isArray(p.variants)) {
      p.variants.forEach(v => {
        if (v.variantImage) addImg(v.variantImage);
        if (v.variantImages) {
          const vi = Array.isArray(v.variantImages) ? v.variantImages : [v.variantImages];
          vi.forEach(addImg);
        }
      });
    }

    // 4. productKeyEnAttribute (manchmal Attribut-Bilder)
    if (p.productKeyEnAttribute) {
      try {
        const attr = typeof p.productKeyEnAttribute === 'string' ? JSON.parse(p.productKeyEnAttribute) : p.productKeyEnAttribute;
        if (Array.isArray(attr)) attr.forEach(a => { if (a.image) addImg(a.image); });
      } catch(e) {}
    }

    return {
      pid: p.pid,
      name: p.productNameEn || p.productName,
      images: images.slice(0, 10),
      mainImage: images[0] || '',
      ek: parseFloat(p.sellPrice?.split(' -- ')[0] || p.sellPrice || 0),
      weight: p.productWeight,
      categoryName: p.categoryName,
      description: (p.description || '').slice(0, 500),
    };
  } catch(e) {
    console.error('CJ Detail Error:', e.message);
    return null;
  }
}

// ============= PHASE 1: Erweiterte Trend-Analyse =============
async function analyzeTrends(customKeywords = [], count = 15) {
  if (!CONFIG.CLAUDE_KEY) throw new Error('CLAUDE_KEY fehlt');

  const extra = customKeywords.length > 0
    ? `\n\nIMPORTANT: Also include trends matching these specific user keywords: ${customKeywords.join(', ')}`
    : '';

  const prompt = `You are a senior beauty market intelligence analyst with access to global ecommerce data, social listening tools, sales analytics, and search-volume data for April 2026.

Conduct a COMPREHENSIVE A-to-Z product trend analysis. Identify the TOP ${count} beauty/skincare trends RIGHT NOW that are:
- Actively trending on TikTok, Instagram, YouTube Shorts, Amazon
- Strong global sales (US, UK, DE, AU, CA primary markets)
- Suitable for dropshipping (small, lightweight, profitable)
- Price range $10-$100${extra}

For EACH trend, provide a complete intelligence report with: search volume, sales volume, 3-month sales history, trend velocity %, trend phase, profit score, viral platform data, related/long-tail keywords, co-purchased items, demographics, competition analysis, and pricing.

Respond ONLY with valid JSON, no markdown, no code fences:
{
  "analysisDate": "April 2026",
  "totalMarketSize": "$X.X billion",
  "marketGrowthRate": "+X% YoY",
  "topInsights": ["3 top-level insights about beauty market April 2026"],
  "trends": [
    {
      "rank": 1,
      "name": "Product trend name",
      "category": "Skincare Tools",
      "cjKeyword": "2-3 word search keyword for CJ Dropshipping",
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

      "relatedKeywords": ["short kw1","short kw2","short kw3","short kw4","short kw5"],
      "longTailKeywords": ["specific search phrase 1","phrase 2","phrase 3","phrase 4","phrase 5"],
      "coPurchaseItems": ["product 1","product 2","product 3"],

      "viralPlatform": "TikTok",
      "viralVideos": 1250,
      "trendReason": "1 sentence explaining why trending now",
      "sentiment": "positive",

      "competition": "medium",
      "competitorBrands": ["brand1","brand2","brand3"],
      "entryDifficulty": "medium",

      "targetAudience": "Women 25-45 interested in glass skin trend",
      "demographics": {"ageRange": "25-45", "gender": "85% female", "topCountries": ["US","UK","DE"]},
      "seasonality": "evergreen",
      "bestSellingTime": "Evenings, weekends, year-round",

      "estimatedMargin": 72
    }
  ]
}

CRITICAL RULES:
- cjKeyword MUST be 2-3 generic words (e.g. "gua sha" not "gua sha rose quartz roller set premium")
- All numbers must be realistic estimates based on current market data
- salesHistory must show actual progression: month1 = 3 months ago, month3 = last month
- trendVelocity = ((month3-month1)/month1)*100 rounded with sign, e.g. "+37%" or "-12%"
- trendPhase: emerging | growing | peak | declining
- threeMonthTrend: growing | stable | declining
- sentiment: positive | mixed | negative
- entryDifficulty: easy | medium | hard
- seasonality: evergreen | winter | summer | holiday
- profitScore = combined metric of margin x volume potential (0-100)`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CONFIG.CLAUDE_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: CONFIG.CLAUDE_MODEL_TRENDS,
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Claude API ${r.status}: ${err.slice(0,200)}`);
  }
  const d = await r.json();
  const text = d.content[0].text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(text);
  } catch(e) {
    throw new Error(`Claude JSON parse error: ${e.message}. First 200 chars: ${text.slice(0,200)}`);
  }
}

// ============= PHASE 2: CJ-Suche mit Top-Kandidaten =============
async function findCJProductsForTrend(cjt, trend) {
  try {
    // 3 Pages = bis zu 30 Kandidaten
    const pages = await Promise.all([1,2,3].map(page =>
      fetch(`https://developers.cjdropshipping.com/api2.0/v1/product/list?productNameEn=${encodeURIComponent(trend.cjKeyword)}&pageNum=${page}&pageSize=10`, {
        headers: { 'CJ-Access-Token': cjt }
      }).then(r => r.json()).then(d => d.data?.list || []).catch(() => [])
    ));
    const list = [].concat(...pages);
    if (!list.length) return [];

    // Nur Beauty-Produkte mit Bild
    const beauty = list.filter(p =>
      isBeautyProduct(p.productNameEn || p.productName, p.categoryName) &&
      p.productImage && p.productImage.startsWith('https://')
    );
    if (!beauty.length) return [];

    // Scoring
    const scored = beauty.map(p => {
      const name = (p.productNameEn || '').toLowerCase();
      const kwWords = trend.cjKeyword.toLowerCase().split(' ').filter(w => w.length > 2);
      const kwMatch = kwWords.filter(w => name.includes(w)).length;
      const kwScore = kwMatch * 25;

      const beautyHits = BEAUTY_WORDS.filter(w => name.includes(w)).length;
      const beautyBonus = Math.min(beautyHits * 4, 20);

      const negHits = NON_BEAUTY.filter(nb => name.includes(nb)).length;
      const negPenalty = negHits * -50;

      const soldBonus = p.listedNum ? 10 : 0;

      return { ...p, _score: kwScore + beautyBonus + negPenalty + soldBonus };
    }).sort((a,b) => b._score - a._score);

    return scored.filter(p => p._score > 0).slice(0, 5);
  } catch(e) {
    console.error('CJ Search Error:', e.message);
    return [];
  }
}

// ============= Preis-Logik =============
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

// ============= Produkt-Daten für Import vorbereiten =============
async function prepareProductForImport(cjt, cjProduct, trend) {
  const details = await getCJProductDetails(cjt, cjProduct.pid);
  const ek = parseFloat(cjProduct.sellPrice?.split(' -- ')[0] || cjProduct.sellPrice || trend.avgPrice / 2.5);
  const { vk, compareAt, margin } = calculatePricing(ek, trend);
  const allImages = details?.images || [cjProduct.productImage].filter(Boolean);

  return {
    name: details?.name || cjProduct.productNameEn || cjProduct.productName || trend.name,
    cjId: cjProduct.pid,
    images: allImages,
    mainImage: details?.mainImage || cjProduct.productImage || '',
    imageCount: allImages.length,
    categoryName: details?.categoryName || cjProduct.categoryName,
    description: details?.description || '',
    ek: Math.round(ek * 100) / 100,
    vk,
    compareAt,
    margin,
    profit: parseFloat((vk - ek).toFixed(2)),
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
    }
  };
}

// ============= Bestehende Shopify-Titel =============
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

// ============= Marketing-Content (Haiku) =============
async function generateContent(product) {
  if (!CONFIG.CLAUDE_KEY) {
    return { hook: product.trend.trendReason, usp: product.name, description: '', bullets: [] };
  }
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CONFIG.CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: CONFIG.CLAUDE_MODEL_COPY,
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: `Write compelling beauty product copy in English.
Product: ${product.name}
Trending because: ${product.trend.trendReason}
Platform: ${product.trend.viralPlatform}
Audience: ${product.trend.targetAudience}
Keywords: ${(product.trend.relatedKeywords || []).join(', ')}

JSON only, no markdown: {"hook":"emotional 10 word hook","usp":"unique benefit 15 words","description":"2-3 punchy benefit-focused sentences","bullets":["benefit 1","benefit 2","benefit 3","benefit 4","benefit 5"]}`
        }]
      })
    });
    const d = await r.json();
    return JSON.parse(d.content[0].text.replace(/```json|```/g, '').trim());
  } catch(e) {
    return { hook: product.trend.trendReason, usp: product.name, description: '', bullets: [] };
  }
}

// ============= Shopify Publish =============
async function publishProduct(shopToken, product, content) {
  const bullets = (content.bullets || []).map(b => `<li>${b}</li>`).join('');
  const body = {
    product: {
      title: product.name,
      body_html: `<p><strong><em>${content.hook || ''}</em></strong></p>
<p>${content.description || content.usp || ''}</p>
${bullets ? `<ul>${bullets}</ul>` : ''}
<p>⭐ <strong>Trending on ${product.trend.viralPlatform}:</strong> ${product.trend.trendReason}</p>
<p><em>🌍 Ships worldwide · ↩ 30-day returns · 🔒 Secure payment</em></p>`,
      vendor: 'ZoraSkin',
      product_type: product.trend.category || 'Beauty',
      tags: [
        product.trend.category,
        'Trending 2026',
        product.trend.viralPlatform + ' Viral',
        'ZoraSkin',
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
      images: product.images
        .filter(i => i && i.startsWith('https://'))
        .map((src, i) => ({ src, alt: i === 0 ? product.name : `${product.name} ${i + 1}` }))
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
  status: 'ZoraSkin Backend v8.1',
  features: ['Erweiterte Trend-Analyse mit 3-Monats-Verlauf', 'Multi-Kandidaten CJ-Suche (3 pro Trend)', 'Bis zu 10 Bilder pro Produkt', 'Long-tail Keywords + Demographics'],
  endpoints: ['/api/test', '/api/trends/analyze', '/api/products/search', '/api/products/import', '/api/shopify/products']
}));

app.get('/api/test', async (req, res) => {
  const r = {};
  try { await getShopifyToken(); r.shopify = 'verbunden'; } catch(e) { r.shopify = 'Fehler: ' + e.message; }
  try { await getCJToken(); r.cj = 'verbunden'; } catch(e) { r.cj = 'Fehler: ' + e.message; }
  r.claude = CONFIG.CLAUDE_KEY ? 'Key vorhanden' : 'Key fehlt';
  r.config = {
    shopifyDomain: CONFIG.SHOPIFY_DOMAIN || 'fehlt',
    apiVersion: CONFIG.SHOPIFY_API_VERSION,
    claudeModelTrends: CONFIG.CLAUDE_MODEL_TRENDS,
    claudeModelCopy: CONFIG.CLAUDE_MODEL_COPY,
  };
  res.json(r);
});

app.get('/api/shopify/products', async (req, res) => {
  try {
    const token = await getShopifyToken();
    const r = await fetch(`https://${CONFIG.SHOPIFY_DOMAIN}/admin/api/${CONFIG.SHOPIFY_API_VERSION}/products.json?limit=250`, {
      headers: { 'X-Shopify-Access-Token': token }
    });
    const d = await r.json();
    res.json({
      success: true,
      count: d.products?.length,
      products: d.products?.map(p => ({
        id: p.id, title: p.title, price: p.variants?.[0]?.price,
        images: p.images?.length, status: p.status
      }))
    });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// PHASE 1: Trend-Analyse
app.post('/api/trends/analyze', async (req, res) => {
  const { customKeywords = [], count = 15 } = req.body;
  try {
    const analysis = await analyzeTrends(customKeywords, count);
    res.json({ success: true, ...analysis });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// PHASE 2: Mehrere Kandidaten pro bestätigtem Trend
app.post('/api/products/search', async (req, res) => {
  const { confirmedTrends = [] } = req.body;
  if (!confirmedTrends.length) return res.status(400).json({ error: 'Keine Trends bestätigt' });

  const log = [];
  const L = (msg, type='sys') => { log.push({msg, type}); console.log('['+type+'] '+msg); };

  try {
    const cjt = await getCJToken();
    L('CJDropshipping verbunden', 'ok');
    const shopToken = await getShopifyToken();
    const existingTitles = await getExistingTitles(shopToken);
    L(`${existingTitles.size} bestehende Produkte geladen (Duplikat-Check)`, 'info');

    const trendResults = [];
    for (const trend of confirmedTrends) {
      L(`Suche bei CJ: "${trend.name}" (Keyword: "${trend.cjKeyword}")`, 'info');
      const candidates = await findCJProductsForTrend(cjt, trend);

      if (!candidates.length) {
        L(`  ✗ Keine passenden Beauty-Produkte gefunden`, 'warn');
        trendResults.push({ trend, candidates: [], message: 'Keine passenden Produkte' });
        continue;
      }

      // Top 3 mit vollen Bilder-Details
      const detailedCandidates = [];
      for (const cand of candidates.slice(0, 3)) {
        const prepared = await prepareProductForImport(cjt, cand, trend);
        const isDup = prepared.name && existingTitles.has(prepared.name.toLowerCase().trim());
        detailedCandidates.push({ ...prepared, isDuplicate: isDup, score: cand._score });
        L(`  ✓ Kandidat: "${prepared.name}" | ${prepared.imageCount} Bilder | $${prepared.vk}${isDup ? ' (DUPLIKAT)' : ''}`, isDup ? 'warn' : 'ok');
      }

      trendResults.push({ trend, candidates: detailedCandidates });
    }

    const totalCands = trendResults.reduce((s, r) => s + r.candidates.length, 0);
    L(`Suche fertig: ${totalCands} Kandidaten für ${confirmedTrends.length} Trends`, 'ok');
    res.json({ success: true, trendResults, log });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message, log });
  }
});

// PHASE 4: Bestätigte Produkte importieren
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
        L(`✓ LIVE: ${product.name} | $${product.vk} (war $${product.compareAt}) | ${product.margin}% Marge | ${product.images.length} Bilder`, 'ok');
      } catch(e) {
        L(`✗ Fehler bei ${product.name}: ${e.message}`, 'err');
      }
    }

    L(`=== FERTIG: ${published}/${confirmedProducts.length} Produkte live ===`, 'ok');
    res.json({ success: true, published, total: confirmedProducts.length, results, log });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message, log });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ZoraSkin Backend v8.1 auf Port ${PORT}`));
