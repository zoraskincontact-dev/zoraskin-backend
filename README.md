# ZoraSkin Backend

Vollautomatischer Dropshipping-Agent für ZoraSkin.

## Railway Deployment (kostenlos)

1. Geh auf railway.app → Konto erstellen mit GitHub
2. "New Project" → "Deploy from GitHub repo"
3. Diesen Ordner als Repository hochladen
4. In Railway: Variables → alle Keys eintragen
5. Deploy → du bekommst eine URL wie: zoraskin-backend.railway.app

## API Endpoints

GET  /                      → Status Check
GET  /api/cj/products       → CJ Produkte suchen
POST /api/shopify/product   → Produkt in Shopify publizieren
GET  /api/shopify/shop      → Shop Status
POST /api/agent/run         → Vollautomatischer Agent Run
