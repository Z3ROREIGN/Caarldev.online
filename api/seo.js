'use strict';
// Páginas para buscadores e prévias de link (Discord, WhatsApp): /p/<produto>, /s/<parte>, /sitemap.xml e /robots.txt.
// Elas trazem título, descrição, imagem e dados estruturados; ao abrir no navegador, o app (app.js) assume e mostra a loja normal.
const S = require('../lib/shop');
const { str, brl } = require('../lib/util');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function baseUrl(req) {
  let b = process.env.SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
  if (!b) {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return '';
    b = `${String(req.headers['x-forwarded-proto'] || 'https').split(',')[0]}://${host}`;
  }
  b = b.replace(/\/+$/, '');
  return /^https?:\/\//i.test(b) ? b : 'https://' + b;
}
const abs = (base, u) => (/^https?:\/\//i.test(u || '') ? u : u ? `${base}/${String(u).replace(/^\//, '')}` : `${base}/assets/og.jpg`);

// Mesmo esqueleto do index.html (caminhos absolutos, porque a página pode estar em /p/<id>).
function shell({ base, path, title, desc, image, type = 'website', jsonld, body = '', noindex }) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="theme-color" content="#1a0907">
${noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${esc(base + path)}">`}
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="${type}">
<meta property="og:site_name" content="Caarldev">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(base + path)}">
<meta property="og:image" content="${esc(image)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@600;800;900&family=Manrope:wght@400;500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css">
<link rel="stylesheet" href="/store.css">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>` : ''}
</head>
<body>
<div class="bg" aria-hidden="true"><video id="bgvideo" autoplay muted loop playsinline preload="metadata" poster="/assets/fundo-poster.jpg"><source src="/assets/fundo.webm" type="video/webm"><source src="/assets/fundo.mp4" type="video/mp4"></video><div class="bg-shade"></div></div>
<header class="nav" id="topo"><div class="nav-row"><a class="logo" href="/#/">Caarldev</a><nav id="nav" aria-label="Principal"></nav></div><div id="banner" hidden></div></header>
<main id="app" tabindex="-1">${body}</main>
<footer class="footer" id="footer"></footer>
<div id="toasts" aria-live="polite"></div>
<div id="modal-root"></div>
<script src="/app.js" defer></script>
</body>
</html>`;
}

module.exports = async (req, res) => {
  const u = new URL(req.url, 'http://x'), q = Object.fromEntries(u.searchParams), base = baseUrl(req);
  const send = (code, type, text, cache = 'public, s-maxage=300, stale-while-revalidate=600') => {
    res.statusCode = code; res.setHeader('Content-Type', type); res.setHeader('Cache-Control', cache); res.end(text);
  };
  const html = (code, o) => send(code, 'text/html; charset=utf-8', shell({ base, ...o }), code === 200 ? undefined : 'no-store');
  const generic = { path: '/', title: 'Caarldev | Discord, Roblox e Animação 3D', desc: 'Loja do Caarldev: Discord, Roblox e portfólio de animação 3D.', image: abs(base, '') };
  try {
    if (q.t === 'robots') return send(200, 'text/plain; charset=utf-8', `User-agent: *\nAllow: /\nDisallow: /api/\n${base ? `\nSitemap: ${base}/sitemap.xml\n` : ''}`);
    const cfg = await S.getCfg(), name = cfg.storeName || 'Caarldev';
    if (q.t === 'sitemap') {
      const prods = await S.listProducts({});
      const urls = [['/', ''], ...['discord', 'roblox', 'outros'].map((s) => [`/s/${s}`, '']), ...prods.map((p) => [`/p/${p.id}`, ''])];
      return send(200, 'application/xml; charset=utf-8', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(([p]) => `<url><loc>${esc(base + p)}</loc></url>`).join('\n')}\n</urlset>\n`);
    }
    if (q.t === 'p') {
      const p = (await S.listProducts({ id: str(q.id, 40) }))[0];
      if (!p) return html(404, { ...generic, path: `/p/${esc(str(q.id, 40))}`, title: `Produto não encontrado | ${name}`, noindex: true });
      const desc = str(p.short || p.description || `${p.name} na ${name}`, 300).replace(/\s+/g, ' ').slice(0, 200);
      const out = !p.stock.unlimited && p.stock.count === 0;
      const jsonld = {
        '@context': 'https://schema.org', '@type': 'Product', name: p.name, description: desc, image: [abs(base, p.image)],
        offers: { '@type': 'Offer', priceCurrency: 'BRL', price: (p.price / 100).toFixed(2), availability: `https://schema.org/${out ? 'OutOfStock' : 'InStock'}`, url: `${base}/p/${p.id}` },
        ...(p.ratingCount ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: p.rating, reviewCount: p.ratingCount } } : {}),
      };
      return html(200, {
        base, path: `/p/${p.id}`, title: `${p.name} | ${name}`, desc: `${brl(p.price)}${out ? ' · Esgotado' : ''} · ${desc}`, image: abs(base, p.image), type: 'product', jsonld,
        body: `<div class="page"><h1>${esc(p.name)}</h1><p>${esc(brl(p.price))}</p><p>${esc(p.description || p.short || '')}</p><p><a class="btn" href="/#/produto/${esc(p.id)}">Ver na loja</a></p></div>`,
      });
    }
    if (q.t === 's') {
      const sec = ['discord', 'roblox', 'outros'].includes(q.sec) ? q.sec : '';
      if (!sec) return html(404, { ...generic, title: `Página não encontrada | ${name}`, noindex: true });
      const label = (cfg.sections[sec] && cfg.sections[sec].name) || sec, tag = (cfg.sections[sec] && cfg.sections[sec].tagline) || '';
      const prods = await S.listProducts({ section: sec });
      return html(200, {
        base, path: `/s/${sec}`, title: `${label} | ${name}`, desc: tag || `${label} na ${name}`, image: abs(base, ''),
        body: `<div class="page"><h1>${esc(label)}</h1><p>${esc(tag)}</p><ul>${prods.map((p) => `<li><a href="/p/${esc(p.id)}">${esc(p.name)}</a> · ${esc(brl(p.price))}</li>`).join('')}</ul></div>`,
      });
    }
    return html(404, { ...generic, noindex: true });
  } catch (e) {
    console.error('[seo]', String((e && e.message) || e));
    return html(200, { ...generic, base });     // se o banco falhar, o visitante ainda abre o app normal
  }
};
