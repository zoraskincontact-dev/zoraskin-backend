const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { URLSearchParams } = require('url');
const app = express();

app.use(cors());
app.use(express.json());

const CONFIG = {
  CJ_EMAIL: process.env.CJ_EMAIL || '',
  CJ_KEY: process.env.CJ_KEY || '',
  SHOPIFY_DOMAIN: process.env.SHOPIFY_DOMAIN || '',
  SHOPIFY_CLIENT_ID: process.env.SHOPIFY_CLIENT_ID || '',
  SHOPIFY_CLIENT_SECRET: process.env.SHOPIFY_CLIENT_SECRET || '',
  CLAUDE_KEY: process.env.CLAUDE_KEY || '',
};

let shopifyToken = '';
let shopifyTokenExpiry = 0;
let cjToken = '';
let cjTokenExpiry = 0;

// ===================== AUTH =====================
async function getShopifyToken() {
  if (shopifyToken && Date.now() < shopifyTokenExpiry - 60000) return shopifyToken;
  const r = await fetch(`https://${CONFIG.SHOPIFY_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CONFIG.SHOPIFY_CLIENT_ID,
      client_secret: CONFIG.SHOPIFY_CLIENT_SECRET,
    }),
  });
  if (!r.ok) throw new Error(`Shopify token fehlgeschlagen: ${r.status}`);
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
    body: JSON.stringify({ email: CONFIG.CJ_EMAIL, password: CONFIG.CJ_KEY }),
  });
  const d = await r.json();
  if (!d.result || !d.data?.accessToken) throw new Error('CJ Auth fehlgeschlagen');
  cjToken = d.data.accessToken;
  cjTokenExpiry = Date.now() + 1000 * 60 * 60 * 23;
  return cjToken;
}

// ===================== STEP 1: TREND RESEARCH via Claude Web Search =====================
async function researchTrendingProducts(log) {
  const L = log;
  L('Recherchiere aktuelle Beauty-Trends weltweit...', 'info');

  const prompt = `You are a beauty market analyst. Research the TOP trending beauty and skincare products RIGHT NOW in 2026 that are:
1. Viral on TikTok, Instagram, YouTube
2. Selling extremely well globally (US, UK, DE, AU)
3. Have 4.5+ star ratings with 500+ reviews
4. Priced between $15-$100 (good dropshipping margin)
5. Small/lightweight (easy to ship)

Use your knowledge of 2026 beauty trends to identify 15 specific products.

For each product provide:
- Exact product search keyword (for finding on CJ Dropshipping)
- Why it's trending (viral reason)
- Estimated retail price range
- Target audience
- Minimum acceptable rating (4.5 or 4.8)
- Minimum sales volume threshold

Focus on: skincare tools, beauty devices, Korean beauty, anti-aging, wellness gadgets.

Respond ONLY with JSON:
{
  "trends": [
    {
      "rank": 1,
      "productName": "Exact product name in English",
      "searchKeyword": "keyword for CJ search",
      "trendReason": "Why viral/trending",
      "priceMin": 15,
      "priceMax": 45,
      "targetAudience": "Women 25-40",
      "minRating": 4.5,
      "minSales": 200,
      "category": "Skincare Tools",
      "viralPlatform": "TikTok",
      "estimatedMargin": 65
    }
  ]
}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CONFIG.CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const d = await r.json();

    // Finde JSON in der Antwort
    let jsonText = '';
    for (const block of d.content) {
      if (block.type === 'text') {
        jsonText = block.text;
        break;
      }
    }
    const cleaned = jsonText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    L(`${parsed.trends.length} Trending-Produkte identifiziert`, 'ok');
    return parsed.trends;
  } catch (e) {
    L('Web-Suche Fehler: ' + e.message + ' — nutze 2026 Trend-Datenbank', 'warn');
    // Fallback: Aktuelle Trends basierend auf Marktdaten
    return getFallbackTrends();
  }
}

function getFallbackTrends() {
  return [
    { rank: 1, productName: 'LED Red Light Therapy Wand', searchKeyword: 'red light therapy wand 660nm', trendReason: 'Anti-aging TikTok viral, 2.1B views', priceMin: 25, priceMax: 89, targetAudience: 'Women 30-50', minRating: 4.5, minSales: 500, category: 'Anti-Aging', viralPlatform: 'TikTok', estimatedMargin: 75 },
    { rank: 2, productName: 'Gua Sha Rose Quartz Set', searchKeyword: 'gua sha rose quartz roller set', trendReason: 'K-beauty trend, morning routine viral', priceMin: 15, priceMax: 35, targetAudience: 'Women 22-40', minRating: 4.5, minSales: 1000, category: 'Skincare Tools', viralPlatform: 'TikTok', estimatedMargin: 82 },
    { rank: 3, productName: 'Cryo Ice Globe Face Roller', searchKeyword: 'cryo ice globe facial roller', trendReason: 'De-puffing videos 500M+ views', priceMin: 18, priceMax: 42, targetAudience: 'Women 25-45', minRating: 4.5, minSales: 300, category: 'Skincare Tools', viralPlatform: 'Instagram', estimatedMargin: 80 },
    { rank: 4, productName: 'Microcurrent Face Lifting Device', searchKeyword: 'microcurrent face lifting device', trendReason: 'Non-surgical facelift trend', priceMin: 35, priceMax: 95, targetAudience: 'Women 35-55', minRating: 4.5, minSales: 200, category: 'Anti-Aging', viralPlatform: 'YouTube', estimatedMargin: 72 },
    { rank: 5, productName: 'Electric Scalp Massager Hair Growth', searchKeyword: 'electric scalp massager hair growth', trendReason: 'Hair loss awareness viral content', priceMin: 12, priceMax: 28, targetAudience: 'All genders 25-50', minRating: 4.5, minSales: 800, category: 'Hair Care', viralPlatform: 'TikTok', estimatedMargin: 78 },
    { rank: 6, productName: 'LED Teeth Whitening Kit', searchKeyword: 'LED teeth whitening kit professional', trendReason: 'Smile makeover trend, huge demand', priceMin: 20, priceMax: 49, targetAudience: 'All 18-45', minRating: 4.5, minSales: 600, category: 'Dental Beauty', viralPlatform: 'TikTok', estimatedMargin: 78 },
    { rank: 7, productName: 'Collagen Face Mask Sheet Set', searchKeyword: 'collagen face mask hyaluronic acid', trendReason: 'Skincare routine content evergreen', priceMin: 15, priceMax: 38, targetAudience: 'Women 20-45', minRating: 4.5, minSales: 1200, category: 'Skincare', viralPlatform: 'Instagram', estimatedMargin: 80 },
    { rank: 8, productName: 'Nano Facial Mist Steamer', searchKeyword: 'nano facial steamer ionic', trendReason: 'Spa-at-home trend post-COVID', priceMin: 22, priceMax: 55, targetAudience: 'Women 25-50', minRating: 4.5, minSales: 400, category: 'Skincare Tools', viralPlatform: 'YouTube', estimatedMargin: 75 },
    { rank: 9, productName: 'Blackhead Vacuum Pore Cleanser', searchKeyword: 'blackhead remover vacuum suction', trendReason: 'Satisfying extraction videos viral', priceMin: 18, priceMax: 45, targetAudience: 'Women 16-35', minRating: 4.5, minSales: 700, category: 'Skincare', viralPlatform: 'TikTok', estimatedMargin: 76 },
    { rank: 10, productName: 'Jade Roller Face Massager Set', searchKeyword: 'jade roller face massager set', trendReason: 'Natural beauty evergreen trend', priceMin: 12, priceMax: 32, targetAudience: 'Women 20-45', minRating: 4.5, minSales: 1500, category: 'Skincare Tools', viralPlatform: 'Instagram', estimatedMargin: 83 },
    { rank: 11, productName: 'Vitamin C Face Serum 30ml', searchKeyword: 'vitamin c serum face brightening', trendReason: 'Brightening skincare #1 search term', priceMin: 10, priceMax: 35, targetAudience: 'Women 20-50', minRating: 4.5, minSales: 2000, category: 'Skincare', viralPlatform: 'TikTok', estimatedMargin: 80 },
    { rank: 12, productName: 'Eye Massager Heated Bluetooth', searchKeyword: 'eye massager heated bluetooth music', trendReason: 'WFH eye strain awareness trend', priceMin: 28, priceMax: 65, targetAudience: 'All 25-55', minRating: 4.5, minSales: 300, category: 'Wellness', viralPlatform: 'Amazon', estimatedMargin: 72 },
    { rank: 13, productName: 'Dermaplaning Facial Razor Set', searchKeyword: 'dermaplaning facial razor women', trendReason: 'Smooth skin hack viral TikTok', priceMin: 8, priceMax: 22, targetAudience: 'Women 20-45', minRating: 4.5, minSales: 900, category: 'Skincare', viralPlatform: 'TikTok', estimatedMargin: 82 },
    { rank: 14, productName: 'Ultrasonic Skin Scrubber Spatula', searchKeyword: 'ultrasonic skin scrubber spatula face', trendReason: 'Professional skincare at home trend', priceMin: 22, priceMax: 58, targetAudience: 'Women 28-50', minRating: 4.5, minSales: 250, category: 'Skincare Tools', viralPlatform: 'YouTube', estimatedMargin: 74 },
    { rank: 15, productName: 'Face Lifting V-Shape Mask Bandage', searchKeyword: 'v shape face lifting mask slimming', trendReason: 'V-line face trend South Korea viral', priceMin: 8, priceMax: 25, targetAudience: 'Women 25-50', minRating: 4.5, minSales: 500, category: 'Anti-Aging', viralPlatform: 'TikTok', estimatedMargin: 80 },
  ];
}

// ===================== STEP 2: CJ PRODUKT SUCHE MIT QUALITÄTSFILTER =====================
async function findBestCJProduct(cjt, trend, log) {
  const L = log;
  try {
    const r = await fetch(
      `https://developers.cjdropshipping.com/api2.0/v1/product/list?productNameEn=${encodeURIComponent(trend.searchKeyword)}&pageNum=1&pageSize=10`,
      { headers: { 'CJ-Access-Token': cjt } }
    );
    const d = await r.json();
    const products = d.data?.list || [];

    if (products.length === 0) {
      L(`Kein CJ-Produkt für: ${trend.productName}`, 'warn');
      return null;
    }

    // Scoring-System: Bewertung + Bestellzahl + Preis + Bild-Qualität
    const scored = products
      .filter(p => p.productImage && p.productImage.startsWith('http'))
      .map(p => {
        const rating = parseFloat(p.productEval) || 4.0;
        const sales = parseInt(p.salesVolume) || 0;
        const price = parseFloat(p.sellPrice?.split(' -- ')[0] || p.sellPrice || 99);
        const hasImage = p.productImage ? 20 : 0;
        const ratingScore = rating * 15;
        const salesScore = Math.min(sales / 50, 30);
        const priceOk = price >= trend.priceMin / 3 && price <= trend.priceMax / 2 ? 20 : 0;
        const nameMatch = (p.productNameEn || '').toLowerCase().includes(trend.searchKeyword.split(' ')[0].toLowerCase()) ? 15 : 0;
        const totalScore = ratingScore + salesScore + hasImage + priceOk + nameMatch;
        return { ...p, _score: totalScore, _rating: rating, _sales: sales, _price: price };
      })
      .sort((a, b) => b._score - a._score);

    if (scored.length === 0) {
      // Ohne Bildfilter nochmal versuchen
      const anyProduct = products[0];
      if (anyProduct) {
        return {
          name: anyProduct.productNameEn || trend.productName,
          image: anyProduct.productImage || '',
          ek: parseFloat(anyProduct.sellPrice?.split(' -- ')[0] || anyProduct.sellPrice || trend.priceMin / 2.5),
          rating: parseFloat(anyProduct.productEval) || 4.5,
          sales: parseInt(anyProduct.salesVolume) || 0,
          cjId: anyProduct.pid,
          score: 50
        };
      }
      return null;
    }

    const best = scored[0];
    L(`✓ Bestes CJ-Produkt: ${best.productNameEn?.substring(0, 40)} | ★${best._rating} | ${best._sales} Sales | Score: ${Math.round(best._score)}`, 'ok');

    return {
      name: best.productNameEn || trend.productName,
      image: best.productImage,
      ek: best._price,
      rating: best._rating,
      sales: best._sales,
      cjId: best.pid,
      score: Math.round(best._score)
    };
  } catch (e) {
    L(`CJ Suche Fehler für ${trend.productName}: ` + e.message, 'warn');
    return null;
  }
}

// ===================== STEP 3: PREISOPTIMIERUNG =====================
function optimizePrice(ek, trend) {
  // Dynamische Preisstrategie basierend auf Trend-Daten
  const targetMargin = (trend.estimatedMargin || 70) / 100;
  const marketMin = trend.priceMin || 15;
  const marketMax = trend.priceMax || 60;

  // Berechne optimalen VK
  let vk = ek / (1 - targetMargin);

  // Psychologische Preise ($X.99)
  vk = Math.round(vk) - 0.01;

  // Markt-Bounds einhalten
  vk = Math.max(vk, marketMin);
  vk = Math.min(vk, marketMax);

  // Compare price = fake "alter Preis" für Sale-Effekt (+25-35%)
  const compareAt = Math.round(vk * 1.3) - 0.01;

  const actualMargin = Math.round((1 - ek / vk) * 100);

  return { vk: parseFloat(vk.toFixed(2)), compareAt: parseFloat(compareAt.toFixed(2)), margin: actualMargin };
}

// ===================== STEP 4: PRODUKTTEXT GENERIERUNG =====================
async function generateProductContent(product, trend) {
  if (!CONFIG.CLAUDE_KEY) return { hook: trend.trendReason, usp: product.name, description: '' };

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: `Write compelling copy for this beauty product listing:
Product: ${product.name}
Trending because: ${trend.trendReason}
Target: ${trend.targetAudience}
Platform: ${trend.viralPlatform}
Rating: ${product.rating}/5 | Sales: ${product.sales}+

Generate:
1. Hook (emotional, max 10 words, creates desire)
2. USP (unique benefit, max 15 words)  
3. Description (3 short punchy sentences, benefits-focused, ends with CTA)
4. 5 bullet points (features/benefits mix)

JSON only:
{
  "hook": "...",
  "usp": "...",
  "description": "...",
  "bullets": ["...", "...", "...", "...", "..."]
}`
        }]
      })
    });
    const d = await r.json();
    const text = d.content[0].text.replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch (e) {
    return { hook: trend.trendReason, usp: product.name, description: product.name, bullets: [] };
  }
}

// ===================== SHOPIFY PUBLISH =====================
async function publishToShopify(shopToken, product, content, pricing, trend) {
  const bulletsHtml = (content.bullets || []).map(b => `<li>${b}</li>`).join('');
  const body = {
    product: {
      title: product.name,
      body_html: `
        <p class="hook"><em>${content.hook}</em></p>
        <p>${content.description}</p>
        ${bulletsHtml ? `<ul>${bulletsHtml}</ul>` : ''}
        <p><strong>Why customers love it:</strong> ${product.rating}★ rating | ${product.sales}+ sold | ${trend.viralPlatform} viral</p>
        <p><em>🚚 Fast worldwide shipping | ↩ 30-day returns | 🔒 Secure payment</em></p>
      `.trim(),
      vendor: 'ZoraSkin',
      product_type: trend.category || 'Beauty',
      tags: [
        ...product.tags || [],
        trend.category,
        trend.viralPlatform,
        'Trending 2026',
        product.rating >= 4.8 ? 'Top Rated' : 'Best Seller',
      ].filter(Boolean).join(','),
      status: 'active',
      variants: [{
        price: pricing.vk.toString(),
        compare_at_price: pricing.compareAt.toString(),
        requires_shipping: true,
        inventory_management: 'shopify',
        inventory_quantity: 999,
        weight: 0.3,
        weight_unit: 'kg'
      }],
      images: product.image && product.image.startsWith('http') ? [{ src: product.image, alt: product.name }] : [],
      metafields: [
        { namespace: 'zoraskin', key: 'trend_score', value: String(product.score || 0), type: 'number_integer' },
        { namespace: 'zoraskin', key: 'cj_id', value: String(product.cjId || ''), type: 'single_line_text_field' },
        { namespace: 'zoraskin', key: 'viral_platform', value: trend.viralPlatform || '', type: 'single_line_text_field' },
      ]
    }
  };

  const r = await fetch(`https://${CONFIG.SHOPIFY_DOMAIN}/admin/api/2025-01/products.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': shopToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    const err = await r.json();
    throw new Error(JSON.stringify(err.errors));
  }
  const sd = await r.json();
  return sd.product;
}

// ===================== ROUTES =====================
app.get('/', (req, res) => {
  res.json({ status: 'ZoraSkin Intelligence Agent v5.0', version: '5.0', shopify: !!CONFIG.SHOPIFY_CLIENT_ID, cj: !!CONFIG.CJ_EMAIL, claude: !!CONFIG.CLAUDE_KEY });
});

app.get('/api/test', async (req, res) => {
  const results = {};
  try { await getShopifyToken(); results.shopify = 'verbunden'; } catch (e) { results.shopify = 'Fehler: ' + e.message; }
  try { await getCJToken(); results.cj = 'verbunden'; } catch (e) { results.cj = 'Fehler: ' + e.message; }
  results.claude = CONFIG.CLAUDE_KEY ? 'Key vorhanden' : 'Key fehlt';
  res.json(results);
});

app.get('/api/shopify/products', async (req, res) => {
  try {
    const token = await getShopifyToken();
    const r = await fetch(`https://${CONFIG.SHOPIFY_DOMAIN}/admin/api/2025-01/products.json?limit=50`, { headers: { 'X-Shopify-Access-Token': token } });
    const d = await r.json();
    res.json({ success: true, count: d.products?.length, products: d.products?.map(p => ({ id: p.id, title: p.title, price: p.variants?.[0]?.price, images: p.images?.length, status: p.status, tags: p.tags })) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Trends abrufen ohne zu publizieren (Preview)
app.get('/api/trends', async (req, res) => {
  try {
    const log = [];
    const L = (msg, type) => log.push({ msg, type });
    const trends = await researchTrendingProducts(L);
    res.json({ success: true, trends, log });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Hauptagent
app.post('/api/agent/run', async (req, res) => {
  const { limit = 10, priceMulti = 2.5, minRating = 4.0, minSales = 0 } = req.body;
  const log = [];
  const L = (msg, type = 'sys') => { log.push({ time: new Date().toISOString(), msg, type }); console.log('[' + type + '] ' + msg); };

  try {
    L('=== ZoraSkin Intelligence Agent v5.0 gestartet ===', 'info');

    // Auth
    const shopToken = await getShopifyToken();
    L('Shopify verbunden ✓', 'ok');
    const cjt = await getCJToken();
    L('CJDropshipping verbunden ✓', 'ok');

    // Step 1: Trends recherchieren
    L('STEP 1: Recherchiere weltweite Beauty-Trends 2026...', 'info');
    const trends = await researchTrendingProducts(L);
    L(`${trends.length} Trending-Produkte identifiziert ✓`, 'ok');

    // Step 2: Für jeden Trend bestes CJ-Produkt finden
    L('STEP 2: Suche beste Produkte bei CJDropshipping...', 'info');
    const enrichedProducts = [];

    for (const trend of trends.slice(0, limit)) {
      L(`Analysiere Trend #${trend.rank}: ${trend.productName}`, 'info');
      const cjProduct = await findBestCJProduct(cjt, trend, L);

      if (!cjProduct) {
        L(`Überspringe: kein passendes CJ-Produkt`, 'warn');
        continue;
      }

      // Qualitätsfilter
      if (cjProduct.rating < minRating) {
        L(`Überspringe: Bewertung ${cjProduct.rating} < ${minRating} Minimum`, 'warn');
        continue;
      }

      enrichedProducts.push({ ...cjProduct, trend });
    }

    L(`${enrichedProducts.length} Produkte bestehen Qualitätsfilter ✓`, 'ok');

    // Step 3: Preisoptimierung + Content generieren
    L('STEP 3: Optimiere Preise und generiere Produkttexte...', 'info');
    const finalProducts = [];

    for (const product of enrichedProducts) {
      const pricing = optimizePrice(product.ek, product.trend);
      L(`Preis: $${product.ek} EK → $${pricing.vk} VK (${pricing.margin}% Marge, war $${pricing.compareAt})`, 'info');

      const content = await generateProductContent(product, product.trend);
      L(`Content generiert: "${content.hook}"`, 'ok');

      finalProducts.push({ ...product, pricing, content });
    }

    // Step 4: In Shopify publizieren
    L('STEP 4: Publiziere in Shopify...', 'info');
    let published = 0;
    const results = [];

    for (const product of finalProducts) {
      try {
        const shopifyProduct = await publishToShopify(shopToken, product, product.content, product.pricing, product.trend);
        published++;
        results.push({
          name: product.name,
          shopifyId: shopifyProduct.id,
          price: product.pricing.vk,
          compareAt: product.pricing.compareAt,
          margin: product.pricing.margin,
          rating: product.rating,
          sales: product.sales,
          score: product.score,
          image: product.image ? '✓' : '✗',
          trendReason: product.trend.trendReason,
          viralPlatform: product.trend.viralPlatform
        });
        L(`✓ LIVE: ${product.name} | $${product.pricing.vk} | ${product.pricing.margin}% Marge | ★${product.rating} | ${product.sales} Sales ${product.image ? '📸' : ''}`, 'ok');
      } catch (e) {
        L(`Fehler bei ${product.name}: ${e.message}`, 'err');
      }
    }

    L(`=== FERTIG: ${published}/${finalProducts.length} Produkte live in Shopify ===`, 'ok');
    res.json({ success: true, published, total: finalProducts.length, results, log });

  } catch (e) {
    L('Kritischer Fehler: ' + e.message, 'err');
    res.status(500).json({ success: false, error: e.message, log });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ZoraSkin Intelligence Agent v5.0 auf Port ${PORT}`));
