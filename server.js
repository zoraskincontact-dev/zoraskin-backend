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
  console.log('Shopify Token erneuert');
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

app.get('/', (req, res) => {
  res.json({ status: 'ZoraSkin Backend v2.0 läuft', shopify: !!CONFIG.SHOPIFY_CLIENT_ID, cj: !!CONFIG.CJ_EMAIL, claude: !!CONFIG.CLAUDE_KEY });
});

app.get('/api/test', async (req, res) => {
  const results = {};
  try { await getShopifyToken(); results.shopify = 'verbunden'; } catch (e) { results.shopify = 'Fehler: ' + e.message; }
  try { await getCJToken(); results.cj = 'verbunden'; } catch (e) { results.cj = 'Fehler: ' + e.message; }
  results.claude = CONFIG.CLAUDE_KEY ? 'Key vorhanden' : 'Key fehlt';
  res.json(results);
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
        body_html: `<p><em>${product.hook || ''}</em></p><p>${product.usp || ''}</p><p>Rating: ${product.rating}/5</p>`,
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
  const { category = 'Beauty', limit = 10, minRating = 4.5, minOrders = 100, priceMulti = 2.5 } = req.body;
  const log = [];
  const L = (msg, type = 'sys') => { log.push({ time: new Date().toISOString(), msg, type }); console.log(msg); };

  try {
    L('Agent gestartet', 'info');
    const shopToken = await getShopifyToken();
    L('Shopify verbunden', 'ok');
    const cjt = await getCJToken();
    L('CJDropshipping verbunden', 'ok');

    const cjr = await fetch(
      `https://developers.cjdropshipping.com/api2.0/v1/product/list?categoryName=${encodeURIComponent(category)}&pageNum=1&pageSize=${limit}`,
      { headers: { 'CJ-Access-Token': cjt } }
    );
    const cjd = await cjr.json();
    let products = (cjd.data?.list || [])
      .filter(p => parseFloat(p.productEval || 5) >= minRating)
      .filter(p => parseInt(p.salesVolume || 0) >= minOrders)
      .sort((a, b) => parseFloat(b.productEval) - parseFloat(a.productEval));
    L(`${products.length} Produkte gefunden`, 'ok');

    const enriched = [];
    for (const p of products) {
      const ek = parseFloat(p.sellPrice) || 10;
      const vk = Math.round(ek * priceMulti * 100) / 100;
      let hook = p.productNameEn || p.productName, usp = '';
      if (CONFIG.CLAUDE_KEY) {
        try {
          const ar = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 150, messages: [{ role: 'user', content: `Short hook (10 words) and USP (15 words) for: "${p.productNameEn || p.productName}". JSON only: {"hook":"...","usp":"..."}` }] })
          });
          const ad = await ar.json();
          const parsed = JSON.parse(ad.content[0].text.replace(/```json|```/g, '').trim());
          hook = parsed.hook; usp = parsed.usp;
        } catch (e) { }
      }
      enriched.push({ name: p.productNameEn || p.productName, ek, vk, rating: parseFloat(p.productEval) || 4.5, orders: parseInt(p.salesVolume) || 0, image: p.productImage, cjId: p.pid, hook, usp, tags: [category, 'Beauty'] });
    }
    L('Texte generiert', 'ok');

    let published = 0;
    for (const product of enriched) {
      try {
        const sr = await fetch(`https://${CONFIG.SHOPIFY_DOMAIN}/admin/api/2025-01/products.json`, {
          method: 'POST',
          headers: { 'X-Shopify-Access-Token': shopToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ product: { title: product.name, body_html: `<p><em>${product.hook}</em></p><p>${product.usp}</p>`, vendor: 'ZoraSkin', product_type: 'Beauty', tags: product.tags.join(','), status: 'active', variants: [{ price: product.vk.toString(), compare_at_price: (product.vk * 1.3).toFixed(2), requires_shipping: true, inventory_quantity: 999 }], images: product.image ? [{ src: product.image }] : [] } })
        });
        if (sr.ok) { published++; L(`Publiziert: ${product.name}`, 'ok'); }
        else { const err = await sr.json(); L(`Fehler: ${JSON.stringify(err)}`, 'err'); }
      } catch (e) { L('Fehler: ' + e.message, 'err'); }
    }

    L(`Fertig: ${published}/${enriched.length} in Shopify`, 'ok');
    res.json({ success: true, published, total: enriched.length, log });
  } catch (e) {
    L('Fehler: ' + e.message, 'err');
    res.status(500).json({ success: false, error: e.message, log });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ZoraSkin Backend v2.0 auf Port ${PORT}`));
