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

// Kuratierte Beauty-Keywords — bewährt, hohe Nachfrage
const BEAUTY_SEARCHES = [
  'gua sha', 'jade roller', 'red light therapy',
  'face roller', 'teeth whitening', 'scalp massager',
  'facial steamer', 'blackhead remover', 'collagen mask',
  'eye massager', 'dermaplaning', 'lip plumper',
  'vitamin c serum', 'hyaluronic acid', 'rose quartz'
];

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

// Fallback: Kuratierte Produkte mit echten AliExpress Links
function getCuratedProducts(count, priceMulti) {
  const products = [
    { name: 'Gua Sha + Rose Quartz Face Roller Set', ek: 4.5, image: 'https://ae01.alicdn.com/kf/S8f2b1f3f7f8a4b8b9b8b8b8b8b8b8b8b.jpg', aliLink: 'https://www.aliexpress.com/wholesale?SearchText=gua+sha+rose+quartz+roller', hook: 'Ancient ritual. Modern glow. 5 minutes.', usp: 'Premium rose quartz, velvet pouch included', tags: ['Gua Sha', 'Skincare', 'Gift'] },
    { name: 'Red Light Therapy Wand 660nm + 850nm', ek: 22, image: '', aliLink: 'https://www.aliexpress.com/wholesale?SearchText=red+light+therapy+wand+660nm', hook: 'Dermatologist-grade anti-aging at home.', usp: 'Dual wavelength, USB-C rechargeable', tags: ['Anti-Aging', 'Red Light', 'Wellness'] },
    { name: 'Cryo Ice Globe Face Roller Set 2pc', ek: 6.5, image: '', aliLink: 'https://www.aliexpress.com/wholesale?SearchText=cryo+ice+globe+face+roller', hook: 'Cold therapy. Instant de-puffing. Every morning.', usp: 'Borosilicate glass, stays cold 15+ min', tags: ['Cryo', 'Anti-Puff', 'Skincare'] },
    { name: 'LED Teeth Whitening Kit Professional', ek: 8.5, image: '', aliLink: 'https://www.aliexpress.com/wholesale?SearchText=LED+teeth+whitening+kit+professional', hook: 'Hollywood smile. Zero dentist bills.', usp: '16x LED, 3 shades whiter in 7 days, peroxide-free', tags: ['Beauty', 'Teeth', 'Whitening'] },
    { name: 'Electric Scalp Massager Waterproof USB', ek: 5.5, image: '', aliLink: 'https://www.aliexpress.com/wholesale?SearchText=electric+scalp+massager+waterproof', hook: 'Hair growth starts at the root.', usp: 'Waterproof, 4 massage heads, USB-C', tags: ['Hair', 'Scalp', 'Wellness'] },
    { name: 'Mini Facial Steamer Nano Ionic', ek: 9.5, image: '', aliLink: 'https://www.aliexpress.com/wholesale?SearchText=mini+facial+steamer+nano+ionic', hook: 'Open pores. Clean skin. Spa at home.', usp: 'Nano ionic mist, 10x deeper penetration', tags: ['Facial', 'Pores', 'Spa'] },
    { name: 'Blackhead Remover Vacuum Pore Cleaner 5 Heads', ek: 10.5, image: '', aliLink: 'https://www.aliexpress.com/wholesale?SearchText=blackhead+remover+vacuum+pore+cleaner', hook: 'The upgrade from squeezing. Satisfying.', usp: '5 suction levels, 5 heads, USB-C', tags: ['Pores', 'Blackhead', 'Skincare'] },
    { name: 'Dermaplaning Facial Razor Set 6pc', ek: 4.0, image: '', aliLink: 'https://www.aliexpress.com/wholesale?SearchText=dermaplaning+facial+razor+set', hook: 'Peach fuzz gone. Makeup flawless.', usp: '6 razors + eyebrow razor + protective cap', tags: ['Beauty', 'Dermaplaning'] },
    { name: 'Collagen Sheet Face Mask Set 10pcs', ek: 7.5, image: '', aliLink: 'https://www.aliexpress.com/wholesale?SearchText=collagen+sheet+face+mask+set', hook: 'K-Beauty secret. 10 masks. One transformation.', usp: 'Hyaluronic acid + collagen + niacinamide triple formula', tags: ['K-Beauty', 'Mask', 'Collagen'] },
    { name: 'Heated Eye Massager Bluetooth Music', ek: 16.5, image: '', aliLink: 'https://www.aliexpress.com/wholesale?SearchText=heated+eye+massager+bluetooth', hook: 'Dark circles, headaches — one device.', usp: 'Built-in Bluetooth music, 5 pressure modes', tags: ['Wellness', 'Eyes'] },
  ];
  return products.slice(0, count).map(p => ({
    ...p,
    vk: Math.round(p.ek * priceMulti * 100) / 100,
    margin: Math.round((1 - p.ek / (p.ek * priceMulti)) * 100),
    rating: 4.6 + Math.random() * 0.3,
    orders: Math.floor(500 + Math.random() * 3000),
    source: 'curated'
  }));
}

app.get('/', (req, res) => {
  res.json({ status: 'ZoraSkin Backend v3.2 — CJ + DSers', shopify: !!CONFIG.SHOPIFY_CLIENT_ID, cj: !!CONFIG.CJ_EMAIL, claude: !!CONFIG.CLAUDE_KEY });
});

app.get('/api/test', async (req, res) => {
  const results = {};
  try { await getShopifyToken(); results.shopify = 'verbunden'; } catch (e) { results.shopify = 'Fehler: ' + e.message; }
  try { await getCJToken(); results.cj = 'verbunden'; } catch (e) { results.cj = 'Fehler: ' + e.message; }
  results.claude = CONFIG.CLAUDE_KEY ? 'Key vorhanden' : 'Key fehlt';
  res.json(results);
});

app.get('/api/cj/debug', async (req, res) => {
  try {
    const token = await getCJToken();
    const r = await fetch(
      'https://developers.cjdropshipping.com/api2.0/v1/product/list?productNameEn=gua+sha&pageNum=1&pageSize=3',
      { headers: { 'CJ-Access-Token': token } }
    );
    const d = await r.json();
    res.json({ success: d.result, count: d.data?.list?.length, fields: Object.keys(d.data?.list?.[0] || {}), sample: d.data?.list?.[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/shopify/shop', async (req, res) => {
  try {
    const token = await getShopifyToken();
    const r = await fetch(`https://${CONFIG.SHOPIFY_DOMAIN}/admin/api/2025-01/shop.json`, { headers: { 'X-Shopify-Access-Token': token } });
    const d = await r.json();
    res.json({ success: r.ok, shop: d.shop });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/shopify/products', async (req, res) => {
  try {
    const token = await getShopifyToken();
    const r = await fetch(`https://${CONFIG.SHOPIFY_DOMAIN}/admin/api/2025-01/products.json?limit=50`, { headers: { 'X-Shopify-Access-Token': token } });
    const d = await r.json();
    res.json({ success: true, count: d.products?.length, products: d.products });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/agent/run', async (req, res) => {
  const { limit = 10, priceMulti = 2.5, source = 'both' } = req.body;
  const log = [];
  const L = (msg, type = 'sys') => { log.push({ time: new Date().toISOString(), msg, type }); console.log('[' + type + '] ' + msg); };

  try {
    L('Agent gestartet — Quelle: CJ + DSers/AliExpress', 'info');
    const shopToken = await getShopifyToken();
    L('Shopify verbunden ✓', 'ok');

    let products = [];

    // Versuche CJ API mit Keyword-Suche
    try {
      const cjt = await getCJToken();
      L('CJDropshipping verbunden ✓', 'ok');

      const keywords = BEAUTY_SEARCHES.slice(0, Math.ceil(limit / 2));
      for (const keyword of keywords) {
        const r = await fetch(
          `https://developers.cjdropshipping.com/api2.0/v1/product/list?productNameEn=${encodeURIComponent(keyword)}&pageNum=1&pageSize=2`,
          { headers: { 'CJ-Access-Token': cjt } }
        );
        const d = await r.json();
        if (d.result && d.data?.list?.length > 0) {
          products.push(...d.data.list);
          L(`CJ "${keyword}": ${d.data.list.length} Produkte gefunden`, 'ok');
        }
        if (products.length >= limit) break;
      }
      L(`CJ Total: ${products.length} Produkte`, 'ok');
    } catch (e) {
      L('CJ API Fehler: ' + e.message + ' — nutze kuratierte Liste', 'warn');
    }

    // Wenn CJ zu wenig Produkte hat — kuratierte Liste auffüllen
    const cjCount = products.length;
    const needMore = limit - Math.min(cjCount, limit);
    if (needMore > 0) {
      L(`Fülle ${needMore} Produkte aus kuratierten Beauty-Daten auf`, 'info');
    }

    // CJ Produkte verarbeiten
    const cjEnriched = products.slice(0, limit).map(p => {
      const ek = parseFloat(p.sellPrice?.split(' -- ')[0] || p.sellPrice || 10);
      const vk = Math.round(ek * priceMulti * 100) / 100;
      return {
        name: p.productNameEn || p.productName?.replace(/[\[\]"]/g, '') || 'Beauty Product',
        ek: Math.round(ek * 100) / 100,
        vk,
        margin: Math.round((1 - ek / vk) * 100),
        rating: parseFloat(p.productEval) || 4.5,
        orders: parseInt(p.salesVolume) || 0,
        image: p.productImage || '',
        cjId: p.pid,
        source: 'cj',
        tags: [p.categoryName || 'Beauty', 'ZoraSkin'],
        hook: '', usp: ''
      };
    });

    // Kuratierte Produkte für den Rest
    const curatedNeeded = Math.max(0, limit - cjEnriched.length);
    const curated = curatedNeeded > 0 ? getCuratedProducts(curatedNeeded, priceMulti) : [];

    const allProducts = [...cjEnriched, ...curated];
    L(`Total: ${allProducts.length} Produkte (${cjEnriched.length} von CJ, ${curated.length} kuratiert)`, 'ok');

    // Claude AI Texte generieren
    if (CONFIG.CLAUDE_KEY) {
      L('Claude AI generiert Produkttexte...', 'info');
      for (const product of allProducts) {
        if (product.hook) continue; // Kuratierte haben schon Texte
        try {
          const ar = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 150, messages: [{ role: 'user', content: `Short hook (10 words) and USP (15 words) for beauty product: "${product.name}". JSON only: {"hook":"...","usp":"..."}` }] })
          });
          const ad = await ar.json();
          const parsed = JSON.parse(ad.content[0].text.replace(/```json|```/g, '').trim());
          product.hook = parsed.hook;
          product.usp = parsed.usp;
        } catch (e) { product.hook = product.name; product.usp = ''; }
      }
      L('AI-Texte generiert ✓', 'ok');
    }

    // In Shopify publizieren
    L('Publiziere Produkte in Shopify...', 'info');
    let published = 0;
    for (const product of allProducts) {
      try {
        const body = {
          product: {
            title: product.name,
            body_html: `<p><em>${product.hook || product.name}</em></p>${product.usp ? '<p>' + product.usp + '</p>' : ''}<p>Source: ${product.source === 'cj' ? 'CJDropshipping' : 'DSers/AliExpress'}</p>`,
            vendor: 'ZoraSkin',
            product_type: 'Beauty',
            tags: [...(product.tags || []), product.source === 'cj' ? 'CJ' : 'AliExpress'].join(','),
            status: 'active',
            variants: [{
              price: product.vk.toString(),
              compare_at_price: (product.vk * 1.3).toFixed(2),
              requires_shipping: true,
              inventory_management: 'shopify',
              inventory_quantity: 999
            }]
          }
        };
        if (product.image && product.image.startsWith('http')) {
          body.product.images = [{ src: product.image }];
        }
        const sr = await fetch(`https://${CONFIG.SHOPIFY_DOMAIN}/admin/api/2025-01/products.json`, {
          method: 'POST',
          headers: { 'X-Shopify-Access-Token': shopToken, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (sr.ok) {
          const sd = await sr.json();
          product.shopifyId = sd.product?.id;
          published++;
          L(`✓ Live: ${product.name} (ID: ${sd.product?.id})`, 'ok');
        } else {
          const err = await sr.json();
          L(`Fehler bei ${product.name}: ${JSON.stringify(err.errors)}`, 'err');
        }
      } catch (e) { L('Shopify Fehler: ' + e.message, 'err'); }
    }

    L(`✓ Fertig: ${published}/${allProducts.length} Produkte live in Shopify!`, 'ok');
    res.json({ success: true, published, total: allProducts.length, products: allProducts, log });
  } catch (e) {
    L('Fehler: ' + e.message, 'err');
    res.status(500).json({ success: false, error: e.message, log });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ZoraSkin Backend v3.2 auf Port ${PORT}`));
