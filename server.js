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
  if (!r.ok) throw new Error(`Shopify token fehlgeschlagen: ${r.status} ${await r.text()}`);
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
  if (!d.result || !d.data?.accessToken) throw new Error('CJ Auth fehlgeschlagen: ' + JSON.stringify(d));
  cjToken = d.data.accessToken;
  cjTokenExpiry = Date.now() + 1000 * 60 * 60 * 23;
  return cjToken;
}

app.get('/', (req, res) => {
  res.json({ status: 'ZoraSkin Backend v3.0', shopify: !!CONFIG.SHOPIFY_CLIENT_ID, cj: !!CONFIG.CJ_EMAIL, claude: !!CONFIG.CLAUDE_KEY });
});

app.get('/api/test', async (req, res) => {
  const results = {};
  try { await getShopifyToken(); results.shopify = 'verbunden'; } catch (e) { results.shopify = 'Fehler: ' + e.message; }
  try { await getCJToken(); results.cj = 'verbunden'; } catch (e) { results.cj = 'Fehler: ' + e.message; }
  results.claude = CONFIG.CLAUDE_KEY ? 'Key vorhanden' : 'Key fehlt';
  res.json(results);
});

// DEBUG: CJ Rohdaten anzeigen
app.get('/api/cj/debug', async (req, res) => {
  try {
    const token = await getCJToken();
    // Ohne Filter - einfach erste 5 Produkte holen
    const r = await fetch(
      'https://developers.cjdropshipping.com/api2.0/v1/product/list?pageNum=1&pageSize=5',
      { headers: { 'CJ-Access-Token': token } }
    );
    const d = await r.json();
    res.json({ 
      success: d.result, 
      total: d.data?.total,
      count: d.data?.list?.length,
      sample: d.data?.list?.slice(0,2),
      raw_result: d.result,
      message: d.message
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// CJ Kategorien abrufen
app.get('/api/cj/categories', async (req, res) => {
  try {
    const token = await getCJToken();
    const r = await fetch(
      'https://developers.cjdropshipping.com/api2.0/v1/product/getCategory',
      { headers: { 'CJ-Access-Token': token } }
    );
    const d = await r.json();
    res.json({ success: d.result, categories: d.data });
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

app.post('/api/shopify/product', async (req, res) => {
  try {
    const { product } = req.body;
    const token = await getShopifyToken();
    const body = {
      product: {
        title: product.name,
        body_html: `<p><em>${product.hook || ''}</em></p><p>${product.usp || ''}</p>`,
        vendor: 'ZoraSkin', product_type: 'Beauty',
        tags: (product.tags || []).join(','), status: 'active',
        variants: [{ price: product.vk.toString(), compare_at_price: (product.vk * 1.3).toFixed(2), requires_shipping: true, inventory_quantity: 999 }]
      }
    };
    if (product.image) body.product.images = [{ src: product.image }];
    const r = await fetch(`https://${CONFIG.SHOPIFY_DOMAIN}/admin/api/2025-01/products.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (!r.ok) throw new Error('Shopify Fehler: ' + JSON.stringify(d.errors));
    res.json({ success: true, shopifyId: d.product.id });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/agent/run', async (req, res) => {
  const { limit = 10, minRating = 0, minOrders = 0, priceMulti = 2.5 } = req.body;
  const log = [];
  const L = (msg, type = 'sys') => { log.push({ time: new Date().toISOString(), msg, type }); console.log('[' + type + '] ' + msg); };

  try {
    L('Agent gestartet', 'info');
    const shopToken = await getShopifyToken();
    L('Shopify verbunden', 'ok');
    const cjt = await getCJToken();
    L('CJDropshipping verbunden', 'ok');

    // Ohne Kategorie-Filter — alle Produkte abrufen
    const cjr = await fetch(
      `https://developers.cjdropshipping.com/api2.0/v1/product/list?pageNum=1&pageSize=${limit}`,
      { headers: { 'CJ-Access-Token': cjt } }
    );
    const cjd = await cjr.json();
    L('CJ API Antwort: result=' + cjd.result + ' total=' + cjd.data?.total + ' count=' + (cjd.data?.list?.length || 0), 'info');

    let rawProducts = cjd.data?.list || [];

    // Minimal filtern — nur Rating wenn vorhanden
    let products = rawProducts.filter(p => {
      const rating = parseFloat(p.productEval || p.salePrice || 0);
      return minRating === 0 || !p.productEval || rating >= minRating;
    });

    L(`${products.length} Produkte nach Filter (von ${rawProducts.length} total)`, 'ok');

    if (products.length === 0 && rawProducts.length === 0) {
      L('CJ gibt keine Produkte zurück. Prüfe ob dein CJ Account Produkte hat.', 'warn');
      L('CJ API Message: ' + (cjd.message || 'keine'), 'warn');
    }

    const enriched = [];
    for (const p of products.slice(0, limit)) {
      const ek = parseFloat(p.sellPrice || p.salePrice || p.productPrice || 10);
      const vk = Math.round(ek * priceMulti * 100) / 100;
      const name = p.productNameEn || p.productName || 'Beauty Product';
      let hook = name, usp = '';

      if (CONFIG.CLAUDE_KEY) {
        try {
          const ar = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 150, messages: [{ role: 'user', content: `Hook (10 words) and USP (15 words) for beauty product: "${name}". JSON only: {"hook":"...","usp":"..."}` }] })
          });
          const ad = await ar.json();
          const parsed = JSON.parse(ad.content[0].text.replace(/```json|```/g, '').trim());
          hook = parsed.hook; usp = parsed.usp;
        } catch (e) { L('AI Text Fehler: ' + e.message, 'warn'); }
      }

      enriched.push({
        name,
        ek: Math.round(ek * 100) / 100,
        vk,
        margin: Math.round((1 - ek / vk) * 100),
        rating: parseFloat(p.productEval) || 4.5,
        orders: parseInt(p.salesVolume) || 0,
        image: p.productImage || p.productImg || '',
        cjId: p.pid || p.productId,
        hook, usp,
        tags: ['Beauty', 'ZoraSkin']
      });
    }

    L(`${enriched.length} Produkte angereichert mit AI-Texten`, 'ok');

    let published = 0;
    for (const product of enriched) {
      try {
        const sr = await fetch(`https://${CONFIG.SHOPIFY_DOMAIN}/admin/api/2025-01/products.json`, {
          method: 'POST',
          headers: { 'X-Shopify-Access-Token': shopToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            product: {
              title: product.name,
              body_html: `<p><em>${product.hook}</em></p><p>${product.usp}</p>`,
              vendor: 'ZoraSkin', product_type: 'Beauty',
              tags: product.tags.join(','), status: 'active',
              variants: [{ price: product.vk.toString(), compare_at_price: (product.vk * 1.3).toFixed(2), requires_shipping: true, inventory_quantity: 999 }],
              images: product.image ? [{ src: product.image }] : []
            }
          })
        });
        if (sr.ok) { published++; L(`✓ Publiziert: ${product.name}`, 'ok'); }
        else { const err = await sr.json(); L(`Fehler bei ${product.name}: ${JSON.stringify(err.errors)}`, 'err'); }
      } catch (e) { L('Shopify Fehler: ' + e.message, 'err'); }
    }

    L(`Fertig: ${published}/${enriched.length} Produkte live in Shopify`, 'ok');
    res.json({ success: true, published, total: enriched.length, products: enriched, log });
  } catch (e) {
    L('Fehler: ' + e.message, 'err');
    res.status(500).json({ success: false, error: e.message, log });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ZoraSkin Backend v3.0 auf Port ${PORT}`));
