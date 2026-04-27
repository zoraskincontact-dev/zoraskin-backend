const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();

app.use(cors());
app.use(express.json());

// ===================== CONFIG =====================
const CONFIG = {
  CJ_EMAIL: process.env.CJ_EMAIL || '',
  CJ_KEY: process.env.CJ_KEY || '',
  SHOPIFY_DOMAIN: process.env.SHOPIFY_DOMAIN || '',
  SHOPIFY_TOKEN: process.env.SHOPIFY_TOKEN || '',
  CLAUDE_KEY: process.env.CLAUDE_KEY || '',
};

let cjAccessToken = '';
let cjTokenExpiry = 0;

// ===================== HEALTH CHECK =====================
app.get('/', (req, res) => {
  res.json({
    status: 'ZoraSkin Backend läuft ✓',
    version: '1.0.0',
    connections: {
      cj: !!CONFIG.CJ_EMAIL,
      shopify: !!CONFIG.SHOPIFY_TOKEN,
      claude: !!CONFIG.CLAUDE_KEY,
    }
  });
});

// ===================== CJ TOKEN =====================
async function getCJToken() {
  if (cjAccessToken && Date.now() < cjTokenExpiry) return cjAccessToken;
  const r = await fetch('https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: CONFIG.CJ_EMAIL, password: CONFIG.CJ_KEY })
  });
  const d = await r.json();
  if (d.result && d.data?.accessToken) {
    cjAccessToken = d.data.accessToken;
    cjTokenExpiry = Date.now() + 1000 * 60 * 60 * 23;
    return cjAccessToken;
  }
  throw new Error('CJ Auth fehlgeschlagen: ' + JSON.stringify(d));
}

// ===================== CJ PRODUKTE SUCHEN =====================
app.get('/api/cj/products', async (req, res) => {
  try {
    const { category = 'Beauty', limit = 10, minRating = 4.5, minOrders = 100 } = req.query;
    const token = await getCJToken();
    const r = await fetch(
      `https://developers.cjdropshipping.com/api2.0/v1/product/list?categoryName=${encodeURIComponent(category)}&pageNum=1&pageSize=${limit}`,
      { headers: { 'CJ-Access-Token': token } }
    );
    const d = await r.json();
    if (!d.result) throw new Error('CJ API Fehler: ' + JSON.stringify(d));

    const products = (d.data?.list || [])
      .filter(p => parseFloat(p.productEval || 5) >= parseFloat(minRating))
      .filter(p => parseInt(p.salesVolume || 0) >= parseInt(minOrders))
      .map(p => ({
        id: p.pid,
        name: p.productNameEn || p.productName,
        ek: parseFloat(p.sellPrice) || 0,
        rating: parseFloat(p.productEval) || 4.5,
        orders: parseInt(p.salesVolume) || 0,
        image: p.productImage || '',
        cjId: p.pid,
        supplier: 'CJDropshipping',
        ship: '5–8 days EU',
        tags: [category, 'Beauty'],
      }));

    res.json({ success: true, products, total: products.length });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ===================== CJ PRODUKTDETAILS =====================
app.get('/api/cj/product/:pid', async (req, res) => {
  try {
    const token = await getCJToken();
    const r = await fetch(
      `https://developers.cjdropshipping.com/api2.0/v1/product/query?pid=${req.params.pid}`,
      { headers: { 'CJ-Access-Token': token } }
    );
    const d = await r.json();
    res.json({ success: d.result, product: d.data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ===================== CLAUDE AI TEXT =====================
app.post('/api/ai/text', async (req, res) => {
  try {
    const { productName } = req.body;
    if (!CONFIG.CLAUDE_KEY) throw new Error('Claude Key nicht konfiguriert');
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CONFIG.CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `Write a SHORT emotional product hook (max 10 words) and USP (max 15 words) for this beauty product: "${productName}". Reply ONLY with JSON: {"hook":"...","usp":"..."}`
        }]
      })
    });
    const d = await r.json();
    const text = d.content[0].text.replace(/```json|```/g, '').trim();
    res.json({ success: true, ...JSON.parse(text) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ===================== SHOPIFY PRODUKT ERSTELLEN =====================
app.post('/api/shopify/product', async (req, res) => {
  try {
    const { product } = req.body;
    if (!CONFIG.SHOPIFY_TOKEN || !CONFIG.SHOPIFY_DOMAIN) throw new Error('Shopify nicht konfiguriert');

    const body = {
      product: {
        title: product.name,
        body_html: `<p><em>${product.hook || ''}</em></p><p>${product.usp || ''}</p><p>⭐ ${product.rating}/5 — ${product.orders}+ orders</p>`,
        vendor: 'ZoraSkin',
        product_type: 'Beauty',
        tags: (product.tags || []).join(','),
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

    if (product.image) {
      body.product.images = [{ src: product.image }];
    }

    const r = await fetch(
      `https://${CONFIG.SHOPIFY_DOMAIN}/admin/api/2024-01/products.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': CONFIG.SHOPIFY_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    );

    const d = await r.json();
    if (!r.ok) throw new Error('Shopify Fehler: ' + JSON.stringify(d.errors));
    res.json({ success: true, shopifyId: d.product.id, product: d.product });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ===================== SHOPIFY SHOP INFO =====================
app.get('/api/shopify/shop', async (req, res) => {
  try {
    if (!CONFIG.SHOPIFY_TOKEN || !CONFIG.SHOPIFY_DOMAIN) throw new Error('Shopify nicht konfiguriert');
    const r = await fetch(
      `https://${CONFIG.SHOPIFY_DOMAIN}/admin/api/2024-01/shop.json`,
      { headers: { 'X-Shopify-Access-Token': CONFIG.SHOPIFY_TOKEN } }
    );
    const d = await r.json();
    res.json({ success: r.ok, shop: d.shop });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ===================== SHOPIFY PRODUKTE ABRUFEN =====================
app.get('/api/shopify/products', async (req, res) => {
  try {
    if (!CONFIG.SHOPIFY_TOKEN || !CONFIG.SHOPIFY_DOMAIN) throw new Error('Shopify nicht konfiguriert');
    const r = await fetch(
      `https://${CONFIG.SHOPIFY_DOMAIN}/admin/api/2024-01/products.json?limit=50`,
      { headers: { 'X-Shopify-Access-Token': CONFIG.SHOPIFY_TOKEN } }
    );
    const d = await r.json();
    res.json({ success: true, products: d.products, count: d.products?.length });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ===================== VOLLAUTOMATISCHER AGENT RUN =====================
app.post('/api/agent/run', async (req, res) => {
  const { category = 'Beauty', limit = 10, minRating = 4.5, minOrders = 100, priceMulti = 2.5 } = req.body;
  const log = [];
  const addLog = (msg, type = 'sys') => { log.push({ time: new Date().toISOString(), msg, type }); };

  try {
    addLog('Agent gestartet', 'info');

    // CJ Token
    const token = await getCJToken();
    addLog('CJDropshipping verbunden ✓', 'ok');

    // Produkte suchen
    const r = await fetch(
      `https://developers.cjdropshipping.com/api2.0/v1/product/list?categoryName=${encodeURIComponent(category)}&pageNum=1&pageSize=${limit}`,
      { headers: { 'CJ-Access-Token': token } }
    );
    const d = await r.json();
    let products = (d.data?.list || [])
      .filter(p => parseFloat(p.productEval || 5) >= minRating)
      .filter(p => parseInt(p.salesVolume || 0) >= minOrders);

    addLog(`${products.length} Produkte bei CJ gefunden`, 'ok');

    // Preise berechnen + AI Texte
    const enriched = [];
    for (const p of products) {
      const ek = parseFloat(p.sellPrice) || 10;
      const vk = Math.round(ek * priceMulti * 100) / 100;
      let hook = '', usp = '';
      if (CONFIG.CLAUDE_KEY) {
        try {
          const ar = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 200, messages: [{ role: 'user', content: `Write hook (max 10 words) and usp (max 15 words) for: "${p.productNameEn || p.productName}". JSON only: {"hook":"...","usp":"..."}` }] })
          });
          const ad = await ar.json();
          const parsed = JSON.parse(ad.content[0].text.replace(/```json|```/g, '').trim());
          hook = parsed.hook; usp = parsed.usp;
        } catch (e) { }
      }
      enriched.push({ id: p.pid, name: p.productNameEn || p.productName, ek, vk, margin: Math.round((1 - ek / vk) * 100), rating: parseFloat(p.productEval) || 4.5, orders: parseInt(p.salesVolume) || 0, image: p.productImage, cjId: p.pid, hook, usp, tags: [category, 'Beauty'] });
    }
    addLog('AI-Texte generiert', 'ok');

    // In Shopify publizieren
    let published = 0;
    for (const product of enriched) {
      try {
        const sr = await fetch(`https://${CONFIG.SHOPIFY_DOMAIN}/admin/api/2024-01/products.json`, {
          method: 'POST',
          headers: { 'X-Shopify-Access-Token': CONFIG.SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ product: { title: product.name, body_html: `<p><em>${product.hook}</em></p><p>${product.usp}</p>`, vendor: 'ZoraSkin', product_type: 'Beauty', tags: product.tags.join(','), status: 'active', variants: [{ price: product.vk.toString(), compare_at_price: (product.vk * 1.3).toFixed(2), requires_shipping: true, inventory_quantity: 999 }], images: product.image ? [{ src: product.image }] : [] } })
        });
        if (sr.ok) { published++; addLog(`✓ Publiziert: ${product.name}`, 'ok'); }
        else { addLog(`Fehler bei: ${product.name}`, 'err'); }
      } catch (e) { addLog(`Fehler: ${e.message}`, 'err'); }
    }

    addLog(`Agent abgeschlossen: ${published}/${enriched.length} publiziert`, 'ok');
    res.json({ success: true, published, total: enriched.length, products: enriched, log });
  } catch (e) {
    addLog('Agent Fehler: ' + e.message, 'err');
    res.status(500).json({ success: false, error: e.message, log });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ZoraSkin Backend läuft auf Port ${PORT}`));
