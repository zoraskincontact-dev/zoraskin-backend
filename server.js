const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { URLSearchParams } = require('url');
const app = express();
app.use(cors());
app.use(express.json());

const CONFIG = {
  CJ_EMAIL: process.env.CJ_EMAIL||'',
  CJ_KEY: process.env.CJ_KEY||'',
  SHOPIFY_DOMAIN: process.env.SHOPIFY_DOMAIN||'',
  SHOPIFY_CLIENT_ID: process.env.SHOPIFY_CLIENT_ID||'',
  SHOPIFY_CLIENT_SECRET: process.env.SHOPIFY_CLIENT_SECRET||'',
  CLAUDE_KEY: process.env.CLAUDE_KEY||'',
};

let shopifyToken='',shopifyTokenExpiry=0,cjToken='',cjTokenExpiry=0;

async function getShopifyToken(){
  if(shopifyToken&&Date.now()<shopifyTokenExpiry-60000)return shopifyToken;
  const r=await fetch(`https://${CONFIG.SHOPIFY_DOMAIN}/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:CONFIG.SHOPIFY_CLIENT_ID,client_secret:CONFIG.SHOPIFY_CLIENT_SECRET})});
  if(!r.ok)throw new Error(`Shopify token: ${r.status}`);
  const d=await r.json();
  shopifyToken=d.access_token;
  shopifyTokenExpiry=Date.now()+(d.expires_in||86399)*1000;
  return shopifyToken;
}

async function getCJToken(){
  if(cjToken&&Date.now()<cjTokenExpiry-60000)return cjToken;
  const r=await fetch('https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:CONFIG.CJ_EMAIL,password:CONFIG.CJ_KEY})});
  const d=await r.json();
  if(!d.result||!d.data?.accessToken)throw new Error('CJ Auth fehlgeschlagen');
  cjToken=d.data.accessToken;
  cjTokenExpiry=Date.now()+1000*60*60*23;
  return cjToken;
}

// 50 kuratierte Beauty-Produkte mit kurzen CJ-Keywords
const PRODUCTS=[
  {name:'Red Light Therapy Wand',cjKeyword:'red light therapy',ek:22,priceMin:49,priceMax:89,margin:68,hook:'Dermatologist-grade anti-aging at home.',usp:'Dual 660nm+850nm wavelength, USB-C rechargeable',tags:['Anti-Aging','Red Light'],platform:'TikTok',trendReason:'2.1B TikTok views, #1 anti-aging tool 2026'},
  {name:'Gua Sha Rose Quartz Set',cjKeyword:'gua sha',ek:4.5,priceMin:24,priceMax:35,margin:80,hook:'Ancient ritual. Modern glow.',usp:'Premium rose quartz, velvet pouch included',tags:['Gua Sha','K-Beauty'],platform:'Instagram',trendReason:'K-beauty morning routine viral'},
  {name:'Cryo Ice Globe Face Roller',cjKeyword:'ice roller face',ek:6.5,priceMin:28,priceMax:42,margin:75,hook:'Cold therapy. Instant de-puffing.',usp:'Borosilicate glass, stays cold 15+ minutes',tags:['Cryo','Anti-Puff'],platform:'TikTok',trendReason:'Morning de-puffing 500M+ views'},
  {name:'LED Teeth Whitening Kit',cjKeyword:'teeth whitening LED',ek:8.5,priceMin:32,priceMax:49,margin:74,hook:'Hollywood smile. Zero dentist bills.',usp:'16x LED, 3 shades whiter in 7 days',tags:['Whitening','Smile'],platform:'TikTok',trendReason:'Smile transformation before/after viral'},
  {name:'Electric Scalp Massager',cjKeyword:'scalp massager',ek:5.5,priceMin:22,priceMax:32,margin:72,hook:'Hair growth starts at the root.',usp:'Waterproof, 4 massage heads, USB-C',tags:['Hair Growth','Wellness'],platform:'TikTok',trendReason:'Hair loss awareness viral movement'},
  {name:'Nano Ionic Facial Steamer',cjKeyword:'facial steamer',ek:9.5,priceMin:35,priceMax:52,margin:72,hook:'Open pores. Spa at home.',usp:'Nano ionic mist, 10x deeper penetration',tags:['Pores','Spa'],platform:'YouTube',trendReason:'At-home spa trend 200M+ views'},
  {name:'Blackhead Remover Vacuum',cjKeyword:'blackhead vacuum',ek:10.5,priceMin:35,priceMax:49,margin:70,hook:'The satisfying upgrade from squeezing.',usp:'5 suction levels, 5 heads, USB-C',tags:['Pores','Blackhead'],platform:'TikTok',trendReason:'Satisfying extraction content viral'},
  {name:'Collagen Hydrogel Face Mask 10pcs',cjKeyword:'collagen face mask',ek:7.5,priceMin:28,priceMax:38,margin:72,hook:'K-Beauty secret. 10 masks.',usp:'Hyaluronic acid + Collagen + Niacinamide',tags:['K-Beauty','Collagen'],platform:'Instagram',trendReason:'Korean skincare ritual evergreen'},
  {name:'Microcurrent Face Lifting Device',cjKeyword:'microcurrent face',ek:18,priceMin:55,priceMax:85,margin:70,hook:'Non-surgical facelift. Real results.',usp:'5 microcurrent modes, rechargeable',tags:['Anti-Aging','Face Lift'],platform:'YouTube',trendReason:'Non-invasive facelift exploding trend'},
  {name:'Dermaplaning Facial Razor Set',cjKeyword:'dermaplaning razor',ek:4,priceMin:18,priceMax:26,margin:77,hook:'Peach fuzz gone. Makeup flawless.',usp:'6 razors + eyebrow razor included',tags:['Dermaplaning','Smooth Skin'],platform:'TikTok',trendReason:'Smooth skin hack viral'},
  {name:'Vitamin C Brightening Serum',cjKeyword:'vitamin c serum',ek:5,priceMin:22,priceMax:35,margin:76,hook:'Brighter skin in 7 days.',usp:'20% Vitamin C + Hyaluronic Acid',tags:['Vitamin C','Brightening'],platform:'Google',trendReason:'#1 skincare ingredient globally'},
  {name:'Heated Eye Massager Bluetooth',cjKeyword:'eye massager',ek:16.5,priceMin:49,priceMax:69,margin:68,hook:'Dark circles eliminated. Daily.',usp:'Bluetooth music, 5 pressure modes',tags:['Eye Care','Wellness'],platform:'Amazon',trendReason:'WFH eye strain awareness'},
  {name:'Ultrasonic Skin Scrubber',cjKeyword:'skin scrubber',ek:12,priceMin:38,priceMax:55,margin:70,hook:'Deep clean. No needles needed.',usp:'Ultrasonic vibration, 4 modes, USB-C',tags:['Deep Clean','Skincare'],platform:'YouTube',trendReason:'Pro skincare at home trend'},
  {name:'Jade Roller Face Massager',cjKeyword:'jade roller',ek:3.5,priceMin:18,priceMax:28,margin:78,hook:'Cool. Calm. Glowing. Every morning.',usp:'Real jade stone, double-ended',tags:['Jade','Natural Beauty'],platform:'Instagram',trendReason:'Natural beauty evergreen seller'},
  {name:'V-Shape Face Lifting Mask',cjKeyword:'face lifting mask',ek:4,priceMin:18,priceMax:28,margin:77,hook:'V-line face. No surgery.',usp:'Collagen infused, 20-min treatment',tags:['Face Lift','K-Beauty'],platform:'TikTok',trendReason:'Korean V-line face trend viral'},
  {name:'Lip Plumper Device Electric',cjKeyword:'lip plumper',ek:6,priceMin:22,priceMax:35,margin:74,hook:'Fuller lips. No injections.',usp:'USB rechargeable, 3 intensity levels',tags:['Lips','Beauty'],platform:'TikTok',trendReason:'Fuller lips trend non-invasive'},
  {name:'Face Roller Massage Tool',cjKeyword:'face roller',ek:5,priceMin:20,priceMax:32,margin:75,hook:'Sculpt your face daily.',usp:'Stainless steel, anti-aging ergonomic design',tags:['Face Sculpt','Roller'],platform:'Instagram',trendReason:'Face sculpting routine viral'},
  {name:'Exfoliating Silicone Face Scrubber',cjKeyword:'silicone face scrubber',ek:4,priceMin:18,priceMax:28,margin:77,hook:'Cleaner pores. Softer skin. Daily.',usp:'Medical grade silicone, 6000 bristles',tags:['Exfoliate','Clean'],platform:'TikTok',trendReason:'Double cleanse method viral'},
  {name:'Eye Cream Anti Aging Peptide',cjKeyword:'eye cream peptide',ek:6,priceMin:22,priceMax:38,margin:75,hook:'Bye dark circles. Hello bright eyes.',usp:'Peptide complex + Caffeine + Hyaluronic acid',tags:['Eye Cream','Anti-Aging'],platform:'Instagram',trendReason:'Under-eye skincare trending 2026'},
  {name:'Retinol Anti Wrinkle Face Cream',cjKeyword:'retinol face cream',ek:7,priceMin:25,priceMax:42,margin:74,hook:'Turn back time. Start tonight.',usp:'0.5% Retinol + Vitamin E + Ceramides',tags:['Retinol','Anti-Aging'],platform:'YouTube',trendReason:'Retinol skincare routine exploding'},
  {name:'Hyaluronic Acid Face Serum',cjKeyword:'hyaluronic acid serum',ek:5.5,priceMin:22,priceMax:35,margin:75,hook:'Plump skin. All day hydration.',usp:'5-layer hyaluronic acid penetration system',tags:['Hydration','Serum'],platform:'TikTok',trendReason:'Dewy skin trend #glasskin'},
  {name:'Niacinamide Brightening Serum',cjKeyword:'niacinamide serum',ek:5,priceMin:20,priceMax:32,margin:76,hook:'Even skin tone. Minimized pores.',usp:'10% Niacinamide + 1% Zinc formula',tags:['Niacinamide','Brightening'],platform:'Instagram',trendReason:'Niacinamide skin barrier trend'},
  {name:'Eyelash Curler Professional',cjKeyword:'eyelash curler',ek:3,priceMin:14,priceMax:22,margin:78,hook:'Bigger eyes. 30 seconds.',usp:'Heated ceramic plates, all eye shapes',tags:['Lashes','Eyes'],platform:'TikTok',trendReason:'Fox eye lash trend viral'},
  {name:'Sunscreen SPF50 Face Moisturizer',cjKeyword:'sunscreen SPF50 face',ek:6,priceMin:22,priceMax:35,margin:74,hook:'Sun-proof. Glow intact. Daily.',usp:'SPF50 PA+++ lightweight non-greasy formula',tags:['Sunscreen','SPF','Skincare'],platform:'TikTok',trendReason:'SPF education movement 2026'},
  {name:'Face Mist Hydrating Spray',cjKeyword:'face mist spray',ek:4,priceMin:16,priceMax:28,margin:78,hook:'Instant refresh. Anytime. Anywhere.',usp:'Rose water + Aloe vera + Glycerin formula',tags:['Face Mist','Hydration'],platform:'Instagram',trendReason:'On-the-go skincare trend'},
  {name:'Pore Strips Nose Blackhead',cjKeyword:'pore strips nose',ek:3,priceMin:12,priceMax:22,margin:80,hook:'Satisfying. Effective. Instant results.',usp:'Charcoal-infused, 10 strips per pack',tags:['Pores','Nose','Blackhead'],platform:'TikTok',trendReason:'Satisfying skincare content viral'},
  {name:'Charcoal Face Mask Peel Off',cjKeyword:'charcoal peel mask',ek:4,priceMin:16,priceMax:26,margin:77,hook:'Pull out impurities. Reveal glow.',usp:'Activated charcoal + Tea tree oil',tags:['Charcoal','Peel Off'],platform:'TikTok',trendReason:'Satisfying peel-off content viral'},
  {name:'Facial Massage Gua Sha Stone',cjKeyword:'gua sha stone',ek:5,priceMin:20,priceMax:32,margin:75,hook:'Sculpt. Depuff. Glow.',usp:'Natural bian stone, traditional TCM technique',tags:['Gua Sha','TCM'],platform:'Instagram',trendReason:'TCM beauty ritual trending'},
  {name:'Under Eye Patches Collagen',cjKeyword:'eye patches collagen',ek:5,priceMin:18,priceMax:28,margin:76,hook:'24-hour eye bags — gone.',usp:'Gold collagen + Hyaluronic acid patches',tags:['Eye Patches','Anti-Aging'],platform:'TikTok',trendReason:'Undereye patches morning routine'},
  {name:'Face Wash Foaming Cleanser',cjKeyword:'foaming face wash',ek:5,priceMin:18,priceMax:30,margin:76,hook:'Clean skin. Fresh start. Every day.',usp:'pH-balanced, suitable for all skin types',tags:['Cleanser','Skincare'],platform:'YouTube',trendReason:'Double cleanse Korean routine'},
  {name:'Beauty Blender Sponge Set',cjKeyword:'beauty blender sponge',ek:3,priceMin:12,priceMax:20,margin:80,hook:'Flawless base. Zero streaks.',usp:'Latex-free, washable, 3-pack set',tags:['Makeup','Blender'],platform:'Instagram',trendReason:'Airbrushed skin makeup trend'},
  {name:'Eyebrow Lamination Kit',cjKeyword:'eyebrow lamination kit',ek:7,priceMin:25,priceMax:38,margin:74,hook:'Soap brows at home. Perfect.',usp:'Professional-grade, lasts 6-8 weeks',tags:['Eyebrows','Lamination'],platform:'TikTok',trendReason:'Fluffy brow trend exploding'},
  {name:'Lash Serum Growth Formula',cjKeyword:'lash growth serum',ek:6,priceMin:22,priceMax:35,margin:74,hook:'Longer lashes. No extensions.',usp:'Biotin + Peptide + Castor oil formula',tags:['Lashes','Serum'],platform:'Instagram',trendReason:'Natural lash growth trend'},
  {name:'Lip Mask Overnight Treatment',cjKeyword:'lip mask overnight',ek:4,priceMin:16,priceMax:26,margin:77,hook:'Wake up with perfect lips.',usp:'Honey + Shea butter + Vitamin E',tags:['Lips','Mask'],platform:'TikTok',trendReason:'Overnight beauty routine trend'},
  {name:'Facial Oil Rosehip Vitamin C',cjKeyword:'rosehip facial oil',ek:7,priceMin:25,priceMax:42,margin:74,hook:'Natural glow. Real results.',usp:'100% pure rosehip + Vitamin C blend',tags:['Facial Oil','Natural'],platform:'Instagram',trendReason:'Natural skincare ingredient trend'},
  {name:'Toner Pad Exfoliating AHA BHA',cjKeyword:'toner pad AHA',ek:6,priceMin:22,priceMax:35,margin:74,hook:'Chemical exfoliation made easy.',usp:'AHA 10% + BHA 2% pre-soaked pads',tags:['Toner','Exfoliant'],platform:'TikTok',trendReason:'Chemical exfoliation education trend'},
  {name:'Neck Firming Cream Anti Aging',cjKeyword:'neck firming cream',ek:7,priceMin:25,priceMax:42,margin:74,hook:'Tech neck? Not anymore.',usp:'Collagen boosting peptide complex',tags:['Neck','Anti-Aging'],platform:'YouTube',trendReason:'Neck aging awareness content'},
  {name:'Hair Growth Serum Biotin',cjKeyword:'hair growth serum',ek:6,priceMin:22,priceMax:35,margin:74,hook:'Thicker hair. Visibly in 30 days.',usp:'5% Minoxidil-free biotin + caffeine blend',tags:['Hair Growth','Biotin'],platform:'TikTok',trendReason:'Hair loss recovery trend viral'},
  {name:'Eyelid Tape Double Crease',cjKeyword:'eyelid tape',ek:2,priceMin:10,priceMax:18,margin:82,hook:'Instant double eyelid. No makeup.',usp:'Invisible, waterproof, 120 strips',tags:['Eyes','Eyelid'],platform:'TikTok',trendReason:'K-pop beauty trend viral'},
  {name:'Face Lifting Tape V Line',cjKeyword:'face lifting tape',ek:3,priceMin:12,priceMax:22,margin:80,hook:'Instant lift. Invisible magic.',usp:'Medical grade adhesive, skin-colored',tags:['Face Lift','Tape'],platform:'TikTok',trendReason:'Instant face lift hack viral'},
  {name:'Skin Tightening RF Device',cjKeyword:'RF skin tightening',ek:25,priceMin:69,priceMax:99,margin:68,hook:'Salon results. Home device.',usp:'Radiofrequency + EMS + LED combination',tags:['RF','Tightening','Device'],platform:'YouTube',trendReason:'At-home RF treatment trending'},
  {name:'Nose Shaper Lifting Bridge',cjKeyword:'nose shaper',ek:3,priceMin:12,priceMax:22,margin:80,hook:'Contoured nose. No surgery.',usp:'Silicone, comfortable 15-min daily use',tags:['Nose','Contouring'],platform:'TikTok',trendReason:'Non-surgical beauty hack trend'},
  {name:'Acne Spot Treatment Patches',cjKeyword:'acne patches',ek:3,priceMin:12,priceMax:22,margin:80,hook:'Overnight spot gone. Guaranteed.',usp:'Hydrocolloid technology, 72 patches',tags:['Acne','Spot','Patches'],platform:'TikTok',trendReason:'Skincare minimalism acne patches'},
  {name:'Face Lift Massager Roller',cjKeyword:'face lift massager',ek:8,priceMin:28,priceMax:45,margin:74,hook:'5 minutes. Lifted face. Daily.',usp:'T-bar design, stainless steel cooling',tags:['Massage','Lifting'],platform:'Instagram',trendReason:'Face yoga alternative trend'},
  {name:'Shower Filter Hard Water',cjKeyword:'shower filter',ek:12,priceMin:35,priceMax:55,margin:72,hook:'Soft water. Better skin. Better hair.',usp:'15-stage filtration, 6-month cartridge',tags:['Shower','Hair','Skin'],platform:'TikTok',trendReason:'Hard water hair damage awareness'},
  {name:'Teeth Whitening Powder Charcoal',cjKeyword:'whitening powder charcoal',ek:4,priceMin:16,priceMax:28,margin:78,hook:'Whiter teeth. Natural method.',usp:'Activated charcoal + coconut, no peroxide',tags:['Teeth','Charcoal','Natural'],platform:'TikTok',trendReason:'Natural teeth whitening trend'},
  {name:'Body Scrub Coffee Exfoliator',cjKeyword:'coffee body scrub',ek:6,priceMin:22,priceMax:35,margin:74,hook:'Smooth skin. Energizing ritual.',usp:'Arabica coffee + coconut oil formula',tags:['Body','Scrub','Natural'],platform:'Instagram',trendReason:'Body care ritual trend 2026'},
  {name:'Eyebrow Microblading Pen',cjKeyword:'eyebrow microblading pen',ek:4,priceMin:16,priceMax:28,margin:78,hook:'Microbladed brows. Zero appointment.',usp:'Hair-stroke tip, waterproof, 4 shades',tags:['Eyebrows','Microblading'],platform:'TikTok',trendReason:'Defined brow trend viral'},
  {name:'Neck Massager Electric Pulse',cjKeyword:'neck massager electric',ek:14,priceMin:42,priceMax:65,margin:72,hook:'Tense neck? Gone in 15 minutes.',usp:'EMS pulse + heat, wireless, USB-C',tags:['Neck','Massager','Wellness'],platform:'Amazon',trendReason:'WFH neck pain solution trend'},
  {name:'Body Contouring Massager Anti Cellulite',cjKeyword:'anti cellulite massager',ek:12,priceMin:38,priceMax:58,margin:72,hook:'Smoother skin. Real results.',usp:'Vacuum suction + vibration technology',tags:['Body','Cellulite','Contouring'],platform:'Instagram',trendReason:'Body care investment trend 2026'},
];

const BEAUTY_WORDS=['skin','face','beauty','hair','eye','lip','mask','serum','cream','roller','gua','jade','light','whitening','massager','scrubber','razor','vitamin','collagen','therapy','lift','pore','acne','tone','glow','bright','anti','aging','wrinkle','moistur','sunscreen','retinol','peptide','hyaluronic','niacin','lash','brow','neck','scalp','dental','teeth','charcoal','exfoli'];

async function getCJProduct(cjt,keyword,log){
  const L=log;
  try{
    // 2 Seiten abrufen = bis zu 20 Produkte fuer mehr Auswahl
    const [r1,r2]=await Promise.all([1,2].map(page=>
      fetch(`https://developers.cjdropshipping.com/api2.0/v1/product/list?productNameEn=${encodeURIComponent(keyword)}&pageNum=${page}&pageSize=10`,{headers:{'CJ-Access-Token':cjt}})
        .then(r=>r.json()).then(d=>d.data?.list||[]).catch(()=>[])
    ));
    const list=[...r1,...r2];
    if(!list.length){L(`CJ "${keyword}": keine Ergebnisse`,'warn');return null;}

    // Beauty-relevante bevorzugen
    const relevant=list.filter(p=>BEAUTY_WORDS.some(k=>(p.productNameEn||p.productName||'').toLowerCase().includes(k)));
    const pool=relevant.length>0?relevant:list;

    // Score — Bild gibt grossen Bonus, aber wir iterieren trotzdem
    const scored=pool.map(p=>{
      const name=(p.productNameEn||'').toLowerCase();
      const hasImg=p.productImage&&p.productImage.startsWith('https://')?50:0;
      const kwMatch=keyword.split(' ').filter(w=>w.length>2&&name.includes(w.toLowerCase())).length*10;
      const isBeauty=BEAUTY_WORDS.some(k=>name.includes(k))?15:0;
      return{...p,_score:hasImg+kwMatch+isBeauty,_hasImg:!!(p.productImage&&p.productImage.startsWith('https://'))};
    }).sort((a,b)=>b._score-a._score);

    // Gehe durch Liste bis Produkt MIT Bild gefunden
    let chosen=null;
    for(let i=0;i<scored.length;i++){
      if(scored[i]._hasImg){
        chosen=scored[i];
        if(i>0)L(`CJ "${keyword}": Produkt #${i+1} hat Bild (erste ${i} hatten keins) — "${(chosen.productNameEn||'').substring(0,35)}"`,'ok');
        else L(`CJ "${keyword}": "${(chosen.productNameEn||'').substring(0,40)}" hat Bild ✓`,'ok');
        break;
      }
    }

    if(!chosen){
      L(`CJ "${keyword}": Keines der ${scored.length} Produkte hat ein Bild — uebersprungen`,'warn');
      return null;
    }

    const ek=parseFloat(chosen.sellPrice?.split(' -- ')[0]||chosen.sellPrice||0);
    return{cjId:chosen.pid,image:chosen.productImage,ek:ek||null};
  }catch(e){L('CJ Fehler: '+e.message,'err');return null;}
}

async function generateContent(productName,trend){
  if(!CONFIG.CLAUDE_KEY)return{hook:trend.hook,usp:trend.usp,description:trend.usp,bullets:[]};
  try{
    const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':CONFIG.CLAUDE_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:400,messages:[{role:'user',content:`Beauty product copy for: "${productName}". Trending: ${trend.trendReason}. Platform: ${trend.platform}.
JSON only: {"hook":"emotional 10 words","usp":"benefit 15 words","description":"2-3 punchy sentences","bullets":["feature 1","feature 2","feature 3","feature 4","feature 5"]}`}]})});
    const d=await r.json();
    return JSON.parse(d.content[0].text.replace(/\`\`\`json|\`\`\`/g,'').trim());
  }catch(e){return{hook:trend.hook,usp:trend.usp,description:trend.usp,bullets:[]};}
}

// Claude analysiert freie Keywords und findet beste Produkt-Optionen
async function analyzeCustomKeyword(keyword){
  if(!CONFIG.CLAUDE_KEY)return[{name:keyword,cjKeyword:keyword,ek:10,priceMin:25,priceMax:45,margin:70,hook:'Premium beauty product.',usp:'High quality, fast shipping',tags:['Beauty'],platform:'TikTok',trendReason:'Customer search'}];
  try{
    const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':CONFIG.CLAUDE_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:800,messages:[{role:'user',content:`A dropshipper wants to sell beauty products related to: "${keyword}"

Generate 3 specific product variations that would sell well globally. For each:
- Exact product name (English, specific)
- Short CJ Dropshipping search keyword (2-3 words max)
- Realistic dropshipping EK price in USD
- Recommended retail price range
- Target margin %
- Emotional hook (10 words)
- USP (15 words)
- Tags (3 max)
- Why trending

JSON only:
{"products":[{"name":"...","cjKeyword":"...","ek":8,"priceMin":25,"priceMax":45,"margin":72,"hook":"...","usp":"...","tags":["..."],"platform":"TikTok","trendReason":"..."}]}`}]})});
    const d=await r.json();
    const parsed=JSON.parse(d.content[0].text.replace(/\`\`\`json|\`\`\`/g,'').trim());
    return parsed.products||[];
  }catch(e){return[{name:keyword,cjKeyword:keyword.split(' ').slice(0,2).join(' '),ek:10,priceMin:25,priceMax:45,margin:70,hook:'Premium beauty product.',usp:'High quality, worldwide shipping',tags:['Beauty'],platform:'TikTok',trendReason:'Customer search'}];}
}

function calcPrice(ek,product){
  const targetMargin=product.margin/100;
  let vk=ek/(1-targetMargin);
  vk=Math.max(vk,product.priceMin);
  vk=Math.min(vk,product.priceMax);
  vk=Math.ceil(vk)-0.01;
  const compareAt=Math.ceil(vk*1.32)-0.01;
  return{vk:parseFloat(vk.toFixed(2)),compareAt:parseFloat(compareAt.toFixed(2)),margin:Math.round((1-ek/vk)*100)};
}

app.get('/',(req,res)=>res.json({status:'ZoraSkin v7.0 — 50 Produkte + Duplikat-Check + Custom Search'}));

app.get('/api/test',async(req,res)=>{
  const r={};
  try{await getShopifyToken();r.shopify='verbunden';}catch(e){r.shopify='Fehler: '+e.message;}
  try{await getCJToken();r.cj='verbunden';}catch(e){r.cj='Fehler: '+e.message;}
  r.claude=CONFIG.CLAUDE_KEY?'Key vorhanden':'Key fehlt';
  res.json(r);
});

// Alle Shopify Produkt-Titel laden (für Duplikat-Check)
async function getExistingShopifyTitles(shopToken){
  const titles=new Set();
  try{
    const r=await fetch(`https://${CONFIG.SHOPIFY_DOMAIN}/admin/api/2025-01/products.json?limit=250&fields=title`,{headers:{'X-Shopify-Access-Token':shopToken}});
    const d=await r.json();
    (d.products||[]).forEach(p=>titles.add(p.title.toLowerCase().trim()));
  }catch(e){}
  return titles;
}

function isDuplicate(productName,existingTitles){
  const name=productName.toLowerCase().trim();
  if(existingTitles.has(name))return true;
  // Fuzzy check: ähnliche Namen
  for(const existing of existingTitles){
    const words=name.split(' ').filter(w=>w.length>3);
    const matches=words.filter(w=>existing.includes(w)).length;
    if(words.length>0&&matches/words.length>=0.7)return true;
  }
  return false;
}

app.get('/api/shopify/products',async(req,res)=>{
  try{
    const token=await getShopifyToken();
    const r=await fetch(`https://${CONFIG.SHOPIFY_DOMAIN}/admin/api/2025-01/products.json?limit=250`,{headers:{'X-Shopify-Access-Token':token}});
    const d=await r.json();
    res.json({success:true,count:d.products?.length,products:d.products?.map(p=>({id:p.id,title:p.title,price:p.variants?.[0]?.price,images:p.images?.length,status:p.status}))});
  }catch(e){res.status(500).json({success:false,error:e.message});}
});

// Custom Keyword Analyse
app.post('/api/analyze/keyword',async(req,res)=>{
  const{keyword}=req.body;
  if(!keyword)return res.status(400).json({error:'Keyword fehlt'});
  try{
    const products=await analyzeCustomKeyword(keyword);
    res.json({success:true,keyword,products});
  }catch(e){res.status(500).json({success:false,error:e.message});}
});

app.post('/api/agent/run',async(req,res)=>{
  const{limit=10,customKeywords=[],useDefault=true}=req.body;
  const log=[];
  const L=(msg,type='sys')=>{log.push({time:new Date().toISOString(),msg,type});console.log('['+type+'] '+msg);};

  try{
    L('=== ZoraSkin Agent v7.0 gestartet ===','info');
    const shopToken=await getShopifyToken();
    L('Shopify verbunden ✓','ok');
    const cjt=await getCJToken();
    L('CJDropshipping verbunden ✓','ok');

    // Bestehende Produkte laden für Duplikat-Check
    const existingTitles=await getExistingShopifyTitles(shopToken);
    L(`Duplikat-Check: ${existingTitles.size} bestehende Produkte im Shop geladen`,'info');

    // Produkte zusammenstellen
    let allProducts=[];

    // Custom Keywords analysieren
    if(customKeywords.length>0){
      L(`Analysiere ${customKeywords.length} eigene Keywords via AI...`,'info');
      for(const kw of customKeywords){
        const analyzed=await analyzeCustomKeyword(kw);
        allProducts.push(...analyzed.map(p=>({...p,isCustom:true,customKeyword:kw})));
        L(`Keyword "${kw}": ${analyzed.length} Produkte generiert`,'ok');
      }
    }

    // Standard-Produkte hinzufügen
    if(useDefault||allProducts.length<limit){
      const needed=limit-allProducts.length;
      allProducts.push(...PRODUCTS.slice(0,needed));
    }

    // Auf Limit kürzen
    allProducts=allProducts.slice(0,limit);
    L(`Total ${allProducts.length} Produkte werden geprüft`,'info');

    const results=[];
    const skipped=[];
    let published=0;

    for(const product of allProducts){
      // Duplikat-Check
      if(isDuplicate(product.name,existingTitles)){
        L(`⚠ DUPLIKAT übersprungen: "${product.name}" — bereits im Shop`,'warn');
        skipped.push({name:product.name,reason:'Bereits im Shop vorhanden'});
        continue;
      }

      L(`Verarbeite: ${product.name}`,'info');

      // CJ Suche
      const cj=await getCJProduct(cjt,product.cjKeyword||product.name.split(' ').slice(0,2).join(' '),L);

      // Strikt: Nur Produkte MIT Bild werden publiziert
      if(!cj?.image||!cj.image.startsWith('https://')){
        L(`⚠ ÜBERSPRUNGEN (kein Bild): "${product.name}" — CJ hat kein Produktbild gefunden`,'warn');
        skipped.push({name:product.name,reason:'Kein Produktbild bei CJDropshipping gefunden'});
        continue;
      }

      const ek=cj?.ek||product.ek;
      const pricing=calcPrice(ek,product);
      L(`Preis: $${ek.toFixed(2)} EK → $${pricing.vk} VK (${pricing.margin}% Marge)`,'info');

      // AI Content
      const content=await generateContent(product.name,product);

      // Shopify publish
      try{
        const bulletsHtml=(content.bullets||[]).map(b=>`<li>${b}</li>`).join('');
        const body={product:{
          title:product.name,
          body_html:`<p><strong><em>${content.hook}</em></strong></p><p>${content.description||content.usp}</p>${bulletsHtml?`<ul>${bulletsHtml}</ul>`:''}<p>⭐ <strong>Trending on ${product.platform}:</strong> ${product.trendReason}</p><p><em>🌍 Ships worldwide · ↩ 30-day returns · 🔒 Secure payment</em></p>`,
          vendor:'ZoraSkin',
          product_type:'Beauty',
          tags:[...(product.tags||[]),'Trending 2026',product.platform+' Viral',product.isCustom?'Custom Search':'Top Pick'].join(','),
          status:'active',
          variants:[{price:pricing.vk.toString(),compare_at_price:pricing.compareAt.toString(),requires_shipping:true,inventory_management:'shopify',inventory_quantity:999}],
          images:cj?.image&&cj.image.startsWith('https://')?[{src:cj.image,alt:product.name}]:[]
        }};

        const sr=await fetch(`https://${CONFIG.SHOPIFY_DOMAIN}/admin/api/2025-01/products.json`,{method:'POST',headers:{'X-Shopify-Access-Token':shopToken,'Content-Type':'application/json'},body:JSON.stringify(body)});
        if(sr.ok){
          const sd=await sr.json();
          published++;
          existingTitles.add(product.name.toLowerCase().trim()); // Neu hinzugefügte auch tracken
          results.push({name:product.name,shopifyId:sd.product?.id,price:pricing.vk,compareAt:pricing.compareAt,margin:pricing.margin,image:cj?.image?'✓':'✗',platform:product.platform,trendReason:product.trendReason,isCustom:product.isCustom||false});
          L(`✓ LIVE: ${product.name} | $${pricing.vk} (war $${pricing.compareAt}) | ${pricing.margin}% Marge ${cj?.image?'📸':''}${product.isCustom?' [Custom]':''}`,'ok');
        }else{
          const err=await sr.json();
          L(`Fehler bei ${product.name}: ${JSON.stringify(err.errors)}`,'err');
        }
      }catch(e){L('Shopify Fehler: '+e.message,'err');}
    }

    L(`=== FERTIG: ${published} publiziert | ${skipped.length} Duplikate übersprungen ===`,'ok');
    res.json({success:true,published,total:allProducts.length,skipped,skippedCount:skipped.length,results,log});
  }catch(e){
    L('Fehler: '+e.message,'err');
    res.status(500).json({success:false,error:e.message,log});
  }
});

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`ZoraSkin v7.0 auf Port ${PORT}`));
