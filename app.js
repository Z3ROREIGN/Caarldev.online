'use strict';
/* Caarldev — loja + portfólio (SPA sem framework). Rotas por hash: #/discord, #/roblox, #/admin... */
(function () {
  // /p/<produto> e /s/<parte> existem para buscadores e prévias de link; o app usa rotas por # (#/produto/<id>, #/discord).
  const lp = /^\/(p|s)\/([\w-]+)\/?$/.exec(location.pathname);
  if (lp) history.replaceState(null, '', '/' + (lp[1] === 'p' ? `#/produto/${lp[2]}` : `#/${lp[2]}`));
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const brl = (c) => (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const dt = (t) => (t ? new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
  const safeUrl = (u) => (/^(https?:\/\/|assets\/)[^\s"'<>]+$/i.test(u || '') ? u : '');
  const SECS = ['discord', 'roblox', 'outros'];
  const SEC_COLOR = { discord: '#9b8cff', roblox: '#ff5a1f', outros: '#ffc83d' };
  const STATUS = { pendente: 'Aguardando pagamento', aguardando: 'Pagamento em análise', pago: 'Pago', entregue: 'Entregue', cancelado: 'Cancelado', expirado: 'Expirado', reembolsado: 'Reembolsado' };
  const badge = (s) => `<span class="st st-${esc(s)}">${esc(STATUS[s] || s)}</span>`;
  const S = { user: null, config: { sections: {}, contacts: {} }, cats: [], banned: null, loaded: false, cleanup: null, wishBack: 0 };
  const secName = (s) => (S.config.sections[s] && S.config.sections[s].name) || s;
  const toCents = (v) => { v = String(v == null ? '' : v).trim(); if (!v) return 0; if (v.includes(',')) v = v.replace(/\./g, '').replace(',', '.'); const n = parseFloat(v.replace(/[^\d.]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : 0; };
  const pl = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const fromCents = (c) => (c ? (c / 100).toFixed(2).replace('.', ',') : '');
  const stars = (n) => { const k = Math.max(0, Math.min(5, Math.round(Number(n) || 0))); return '★'.repeat(k) + '☆'.repeat(5 - k); };
  // Texto das páginas legais: "## Título", "- item" e parágrafos. Tudo escapado.
  const rich = (t) => {
    let html = '', list = false;
    for (const raw of String(t || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('- ')) { if (!list) { html += '<ul>'; list = true; } html += `<li>${esc(line.slice(2))}</li>`; continue; }
      if (list) { html += '</ul>'; list = false; }
      if (line) html += line.startsWith('## ') ? `<h2>${esc(line.slice(3))}</h2>` : `<p>${esc(line)}</p>`;
    }
    return html + (list ? '</ul>' : '');
  };
  // Carrinho: fica só neste navegador (localStorage, que pode estar bloqueado: tudo em try/catch).
  const cart = {
    get() { try { const a = JSON.parse(localStorage.getItem('cd_cart') || '[]'); return (Array.isArray(a) ? a : []).filter((x) => x && typeof x.pid === 'string').slice(0, 10).map((x) => ({ pid: x.pid, qty: Math.max(1, Math.min(100, parseInt(x.qty, 10) || 1)) })); } catch (_) { return []; } },
    set(a) { try { localStorage.setItem('cd_cart', JSON.stringify(a)); } catch (_) { /* sem armazenamento */ } },
    add(pid, qty) { const a = this.get(), i = a.findIndex((x) => x.pid === pid); if (i >= 0) a[i].qty = Math.min(100, a[i].qty + qty); else if (a.length < 10) a.push({ pid, qty }); else return false; this.set(a); return true; },
    setQty(pid, qty) { this.set(this.get().map((x) => (x.pid === pid ? { pid, qty } : x))); },
    remove(pid) { this.set(this.get().filter((x) => x.pid !== pid)); },
    clear() { this.set([]); },
    count() { return this.get().reduce((n, x) => n + x.qty, 0); },
  };
  const isStaff = () => !!S.user && (S.user.role === 'admin' || S.user.role === 'staff');
  const can = (perm) => isStaff() && (S.user.role === 'admin' || String(perm || '').split(',').some((p) => (S.user.perms || []).includes(p)));

  /* ---------- Rede ---------- */
  async function api(route, o = {}) {
    const q = Object.entries(o.query || {}).filter(([, v]) => v !== '' && v != null);
    const qs = q.length ? '&' + new URLSearchParams(q) : '';
    let res;
    try {
      res = await fetch(`/api/store?r=${route}${qs}`, { method: o.method || 'GET', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'cd' }, body: o.body ? JSON.stringify(o.body) : undefined });
    } catch (_) { throw Object.assign(new Error('Sem conexão. Verifique sua internet e tente de novo.'), { status: 0 }); }
    let j = {}; try { j = await res.json(); } catch (_) { /* resposta sem corpo */ }
    if (!res.ok) throw Object.assign(new Error(j.error || 'Algo deu errado. Tente de novo.'), { status: res.status, setup: j.setup });
    return j;
  }
  const post = (r, body) => api(r, { method: 'POST', body: body || {} });

  /* ---------- Interface: avisos, janelas, formulários ---------- */
  function toast(msg, type = 'ok') {
    const el = document.createElement('div');
    el.className = `toast ${type}`; el.textContent = msg; el.setAttribute('role', type === 'err' ? 'alert' : 'status');
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), type === 'err' ? 6500 : 3800);
  }
  function openModal(html, o = {}) {
    const el = document.createElement('div');
    el.className = 'overlay';
    el.innerHTML = `<div class="modal${o.wide ? ' wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
    $('#modal-root').appendChild(el);
    const prev = document.activeElement;
    const close = () => { el.remove(); if (prev && prev.focus) prev.focus(); };
    el.addEventListener('mousedown', (e) => { if (e.target === el) close(); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    $$('[data-close]', el).forEach((b) => b.addEventListener('click', close));
    const f = $('input:not([type=hidden]),select,textarea', el) || $('button', el);
    if (f) f.focus();
    return { el, close };
  }
  const confirmBox = (title, text, o = {}) => new Promise((ok) => {
    const m = openModal(`<h3>${esc(title)}</h3><p class="muted">${esc(text)}</p><div class="modal-actions"><button class="btn btn-ghost" data-close>Cancelar</button><button class="btn ${o.danger ? 'btn-danger' : ''}" id="cb-ok">${esc(o.ok || 'Confirmar')}</button></div>`);
    let done = false;
    $('#cb-ok', m.el).onclick = () => { done = true; m.close(); ok(true); };
    new MutationObserver((_, ob) => { if (!m.el.isConnected) { ob.disconnect(); if (!done) ok(false); } }).observe($('#modal-root'), { childList: true });
  });
  const promptBox = (title, label, o = {}) => new Promise((ok) => {
    const field = o.textarea ? `<textarea name="v" rows="4" placeholder="${esc(o.placeholder || '')}" ${o.required ? 'required' : ''}></textarea>` : `<input name="v" placeholder="${esc(o.placeholder || '')}" ${o.required ? 'required' : ''}>`;
    const m = openModal(`<form><h3>${esc(title)}</h3><label>${esc(label)}${field}</label><div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancelar</button><button class="btn ${o.danger ? 'btn-danger' : ''}">${esc(o.ok || 'Confirmar')}</button></div></form>`);
    let done = false;
    $('form', m.el).onsubmit = (e) => { e.preventDefault(); done = true; const v = e.target.v.value; m.close(); ok(v); };
    new MutationObserver((_, ob) => { if (!m.el.isConnected) { ob.disconnect(); if (!done) ok(null); } }).observe($('#modal-root'), { childList: true });
  });
  const formObj = (f) => { const o = {}; for (const el of f.elements) { if (el.name) o[el.name] = el.type === 'checkbox' ? el.checked : el.value; } return o; };
  async function run(btn, fn) {
    if (btn) btn.disabled = true;
    try { return await fn(); } catch (e) { toast(e.message, 'err'); } finally { if (btn && btn.isConnected) btn.disabled = false; }
  }
  const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast('Copiado.'); } catch (_) { toast('Não foi possível copiar. Selecione e copie manualmente.', 'err'); } };

  /* ---------- Estado e navegação ---------- */
  async function boot() {
    const b = await api('bootstrap');
    S.user = b.user; S.config = b.config; S.cats = b.categories; S.banned = b.banned; S.wishBack = b.wishBack || 0; S.loaded = true;
  }
  const hasOutros = () => S.cats.some((c) => c.section === 'outros');
  function updateChrome(name) {
    const secs = SECS.filter((s) => s !== 'outros' || hasOutros());
    const on = (n) => (name === n ? ' class="on" aria-current="page"' : '');
    const n = cart.count();
    $('#nav').innerHTML = secs.map((s) => `<a href="#/${s}"${on(s)}>${esc(secName(s))}</a>`).join('') + `<a href="#/portfolio"${on('portfolio')}>Portfólio</a>` +
      (n || name === 'carrinho' ? `<a href="#/carrinho"${on('carrinho')}>Carrinho${n ? ` <b class="cartn">${n}</b>` : ''}</a>` : '') +
      (S.user ? `${isStaff() ? `<a class="btn btn-small" href="#/admin">Painel</a>` : ''}<a href="#/suporte"${on('suporte')}>Suporte</a><a href="#/conta"${on('conta')}>Minha conta${S.wishBack ? ' <i class="dot" title="Um favorito voltou ao estoque"></i>' : ''}</a><button class="linkbtn" data-act="logout">Sair</button>`
        : `<a href="#/entrar"${on('entrar')}>Entrar</a><a class="btn btn-small" href="#/cadastro">Criar conta</a>`);
    const a = S.config.announcement, bn = $('#banner');
    bn.hidden = !a; bn.className = a ? `banner ${esc(a.tone)}` : ''; bn.textContent = a ? a.text : '';
    const c = S.config.contacts || {}, wa = String(c.whatsapp || '').replace(/\D/g, '');
    $('#footer').innerHTML = `<p>© ${new Date().getFullYear()} ${esc(S.config.storeName || 'Caarldev')}. Todos os direitos reservados.</p>
      <div class="foot-links"><a href="#/termos">Termos de uso</a><a href="#/reembolso">Reembolso e garantia</a><a href="#/privacidade">Privacidade</a><a href="#/faq">Perguntas frequentes</a></div>
      <div class="foot-links">${safeUrl(c.discord) ? `<a href="${esc(c.discord)}" target="_blank" rel="noopener">Discord</a>` : ''}${wa ? `<a href="https://wa.me/${wa}" target="_blank" rel="noopener">WhatsApp</a>` : ''}${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}</div>`;
    const h = $('#topo').offsetHeight; document.documentElement.style.setProperty('--navh', h + 'px');
  }
  new ResizeObserver(() => document.documentElement.style.setProperty('--navh', $('#topo').offsetHeight + 'px')).observe($('#topo'));

  const views = {};
  const parseRoute = () => { const [path, qs] = location.hash.replace(/^#\/?/, '').split('?'); return { parts: path.split('/').filter(Boolean), q: Object.fromEntries(new URLSearchParams(qs || '')) }; };
  let seq = 0;
  async function render() {
    const my = ++seq, { parts, q } = parseRoute(), name = parts[0] || 'home', app = $('#app');
    if (S.cleanup) { S.cleanup(); S.cleanup = null; }
    let out;
    try {
      if (!S.loaded) await boot();
      document.body.classList.toggle('plain', name === 'admin');
      out = await (views[name] || views.notfound)(parts.slice(1), q);
    } catch (e) {
      out = { title: 'Ops', html: `<div class="page narrow"><div class="empty"><h2>${e.setup ? 'Loja em configuração' : 'Não foi possível carregar'}</h2><p>${esc(e.message)}</p><a class="btn" href="#/">Tentar de novo</a></div></div>` };
    }
    if (my !== seq) return;
    document.title = out.title ? `${out.title} | Caarldev` : 'Caarldev | Discord, Roblox e Animação 3D';
    app.innerHTML = out.html;
    updateChrome(name);
    window.scrollTo(0, 0);
    if (out.mount) out.mount(app);
  }
  window.addEventListener('hashchange', render);

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'logout') { await run(el, async () => { await post('logout'); S.user = null; S.wishBack = 0; location.hash = '#/'; render(); toast('Você saiu da conta.'); }); }
    if (act === 'copy') copy(el.dataset.copy);
  });

  /* ---------- Componentes ---------- */
  const priceHtml = (p) => `<span class="price">${brl(p.price)}</span>${p.compareAt ? `<s class="was">${brl(p.compareAt)}</s>` : ''}`;
  const soldOut = (p) => !p.stock.unlimited && p.stock.count === 0;
  const stockLabel = (p) => (soldOut(p) ? 'Esgotado' : p.stock.unlimited ? 'Disponível' : p.stock.count <= 5 ? `Restam ${p.stock.count}` : 'Em estoque');
  const card = (p) => `<a class="pcard${soldOut(p) ? ' out' : ''}" href="#/produto/${esc(p.id)}" style="--sec:${SEC_COLOR[p.section] || SEC_COLOR.outros}">
    <div class="pimg">${p.image ? `<img src="${esc(safeUrl(p.image))}" alt="" loading="lazy">` : `<span>${esc(p.categoryName)}</span>`}${p.featured ? '<b class="tag">Destaque</b>' : ''}</div>
    <div class="pbody"><h3>${esc(p.name)}</h3>${p.short ? `<p class="pshort">${esc(p.short)}</p>` : ''}${p.ratingCount ? `<p class="rate"><span class="stars">★</span> ${p.rating.toFixed(1)} <em>(${p.ratingCount})</em></p>` : ''}<div class="pfoot"><div>${priceHtml(p)}</div><span class="stock">${esc(stockLabel(p))}</span></div></div></a>`;
  const empty = (title, text, cta) => `<div class="empty"><h3>${esc(title)}</h3><p>${esc(text)}</p>${cta || ''}</div>`;

  /* ---------- Início ---------- */
  views.home = async () => {
    const [{ products, maintenance }, rv] = await Promise.all([api('products'), api('reviews/recent').catch(() => ({ reviews: [] }))]);
    const count = (s) => products.filter((p) => p.section === s).length;
    const doors = [
      ['discord', secName('discord'), (S.config.sections.discord || {}).tagline, pl(count('discord'), 'produto', 'produtos')],
      ['roblox', secName('roblox'), (S.config.sections.roblox || {}).tagline, pl(count('roblox'), 'produto', 'produtos')],
      ['portfolio', 'Portfólio', 'Animação, modelagem 3D, efeitos e cutscenes com acabamento de cinema.', 'Ver trabalhos'],
    ];
    if (count('outros')) doors.push(['outros', secName('outros'), (S.config.sections.outros || {}).tagline, pl(count('outros'), 'produto', 'produtos')]);
    const feat = products.filter((p) => p.featured).slice(0, 6), list = feat.length ? feat : products.slice(0, 6);
    return {
      title: '', html: `<section class="hero"><p class="hero-kicker">Loja digital e estúdio 3D</p><h1><span>Seu servidor.</span><span>Seu jogo.</span></h1>
        <p class="hero-text">Contas, impulsos e farm de orbs para Discord. Arquivos Rbxl e modelos para Roblox Studio lite. E um portfólio de animação 3D por trás de cada detalhe.</p>
        <div class="hero-actions"><a class="btn" href="#/discord">Comprar para Discord</a><a class="btn btn-ghost" href="#/roblox">Comprar para Roblox</a></div></section>
        ${maintenance ? `<section class="section"><div class="empty"><h3>Loja em manutenção</h3><p>Voltamos em instantes. Você ainda pode ver o portfólio.</p></div></section>` : ''}
        <section class="doors">${doors.map(([id, name, tag, meta]) => `<a class="door" href="#/${id}" style="--sec:${SEC_COLOR[id] || '#ffc83d'}"><h2>${esc(name)}</h2><p>${esc(tag)}</p><span class="door-meta">${esc(meta)}</span></a>`).join('')}</section>
        <section class="section"><h2>${feat.length ? 'Em destaque' : 'Produtos'}</h2>
          ${list.length ? `<div class="pgrid">${list.map(card).join('')}</div>` : empty('Nenhum produto ainda', 'Os produtos aparecem aqui assim que forem cadastrados.', isStaff() ? '<a class="btn" href="#/admin/produtos">Cadastrar produto</a>' : '')}</section>
        ${rv.reviews.length ? `<section class="section"><h2>O que os clientes dizem</h2><div class="quotes">${rv.reviews.map((r) => `<a class="quote" href="#/produto/${esc(r.pid)}"><span class="stars">${stars(r.rating)}</span><p>${esc(r.text)}</p><span class="muted">${esc(r.name)} · ${esc(r.product)}</span></a>`).join('')}</div></section>` : ''}
        <section class="section"><h2>Como comprar</h2><ol class="steps">
          <li><strong>Escolha</strong><span>Abra o produto, defina a quantidade e aplique um cupom, se tiver. Dá para montar um carrinho com vários produtos.</span></li>
          <li><strong>Pague no PIX</strong><span>O pedido reserva o estoque e gera o QR Code na hora. Pague e pronto: a confirmação é automática.</span></li>
          <li><strong>Receba</strong><span>Assim que o pagamento cai, itens e links aparecem no pedido e em Minha conta. Com garantia, se o produto tiver.</span></li></ol></section>`,
    };
  };

  /* ---------- Partes da loja (Discord, Roblox, Outros) ---------- */
  const sectionView = (sec) => async (parts, q) => {
    const { products, maintenance } = await api('products', { query: { section: sec } });
    const cats = S.cats.filter((c) => c.section === sec);
    const head = `<header class="page-head" style="--sec:${SEC_COLOR[sec]}"><h1>${esc(secName(sec))}</h1><p class="lead">${esc((S.config.sections[sec] || {}).tagline || '')}</p></header>`;
    if (maintenance) return { title: secName(sec), html: `<div class="page">${head}${empty('Loja em manutenção', 'Volte em instantes.')}</div>` };
    const chips = `<div class="chips" role="group" aria-label="Categorias"><a href="#/${sec}" class="${q.cat ? '' : 'on'}">Todos</a>${cats.map((c) => `<a href="#/${sec}?cat=${esc(c.id)}" class="${q.cat === c.id ? 'on' : ''}" title="${esc(c.desc)}">${esc(c.name)}</a>`).join('')}</div>`;
    return {
      title: secName(sec), html: `<div class="page">${head}<div class="toolbar">${chips}<input type="search" id="busca" placeholder="Buscar produto" aria-label="Buscar produto"><select id="ordem" aria-label="Ordenar"><option value="">Destaques</option><option value="menor">Menor preço</option><option value="maior">Maior preço</option></select></div><div id="lista"></div></div>`,
      mount(el) {
        const draw = () => {
          const t = $('#busca', el).value.trim().toLowerCase(), o = $('#ordem', el).value;
          let l = products.filter((p) => (!q.cat || p.categoryId === q.cat) && (!t || `${p.name} ${p.short} ${p.tags.join(' ')}`.toLowerCase().includes(t)));
          if (o === 'menor') l.sort((a, b) => a.price - b.price); if (o === 'maior') l.sort((a, b) => b.price - a.price);
          $('#lista', el).innerHTML = l.length ? `<div class="pgrid">${l.map(card).join('')}</div>` : empty('Nada por aqui', products.length ? 'Nenhum produto combina com esse filtro.' : 'Ainda não há produtos nesta parte da loja.');
        };
        $('#busca', el).addEventListener('input', draw); $('#ordem', el).addEventListener('change', draw); draw();
      },
    };
  };
  SECS.forEach((s) => { views[s] = sectionView(s); });

  /* ---------- Produto ---------- */
  const reviewsHtml = (rv) => `<section class="section" id="avaliacoes"><h2>Avaliações${rv.count ? ` <span class="rate"><span class="stars">${stars(rv.avg)}</span> ${rv.avg.toFixed(1)} · ${pl(rv.count, 'avaliação', 'avaliações')}</span>` : ''}</h2>
    ${rv.reviews.length ? rv.reviews.map((r) => `<article class="review"><div class="rvh"><span class="stars">${stars(r.rating)}</span><b>${esc(r.name)}</b><em>${dt(r.at).slice(0, 8)}</em></div>${r.text ? `<p>${esc(r.text)}</p>` : ''}${r.reply ? `<p class="rvreply"><b>Resposta da loja:</b> ${esc(r.reply)}</p>` : ''}</article>`).join('') : '<p class="muted">Ainda não há avaliações deste produto.</p>'}
    ${rv.canReview ? `<form id="rvform" class="stack rvform"><h3>${rv.mine ? 'Sua avaliação' : 'Avaliar este produto'}</h3>
      <div class="starpick" role="radiogroup" aria-label="Nota de 1 a 5">${[5, 4, 3, 2, 1].map((n) => `<label title="${n} estrela${n > 1 ? 's' : ''}"><input type="radio" name="rating" value="${n}" ${rv.mine && rv.mine.rating === n ? 'checked' : ''} required><span>★</span></label>`).join('')}</div>
      <label>Comentário (opcional)<textarea name="text" rows="3" maxlength="600" placeholder="Como foi a sua experiência?">${esc(rv.mine ? rv.mine.text : '')}</textarea></label>
      <div class="actions"><button class="btn">${rv.mine ? 'Atualizar avaliação' : 'Enviar avaliação'}</button>${rv.mine ? '<button type="button" class="btn btn-ghost" id="rvdel">Apagar</button>' : ''}</div>${rv.mine && rv.mine.hidden ? '<p class="fine">Sua avaliação está oculta pela loja.</p>' : ''}</form>` : (S.user ? '<p class="fine">Só quem comprou este produto pode avaliar.</p>' : '')}</section>`;
  const videoHtml = (v) => (!safeUrl(v) ? '' : v.startsWith('https://www.youtube-nocookie.com/embed/')
    ? `<div class="pvideo"><iframe src="${esc(v)}" title="Vídeo do produto" loading="lazy" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`
    : `<div class="pvideo"><video src="${esc(v)}" controls preload="metadata" playsinline></video></div>`);

  views.produto = async ([id]) => {
    const [pr, rv, wl] = await Promise.all([api('products', { query: { id: id || '-' } }), api('reviews', { query: { pid: id || '-' } }).catch(() => ({ reviews: [], count: 0, avg: 0, canReview: false, mine: null })), S.user ? api('wishlist').catch(() => null) : null]);
    const p = pr.products[0];
    if (!p) return { title: 'Produto', html: `<div class="page narrow">${empty('Produto não encontrado', 'Ele pode ter sido removido ou estar indisponível.', `<a class="btn" href="#/">Voltar ao início</a>`)}</div>` };
    const out = soldOut(p), max = Math.max(1, Math.min(p.maxPerOrder, p.stock.unlimited ? 99 : p.stock.count));
    const delivery = p.delivery === 'manual' ? 'Entrega combinada com você depois da confirmação do pagamento.' : 'Liberado na sua conta assim que o pagamento for confirmado.';
    const off = p.compareAt ? Math.round((1 - p.price / p.compareAt) * 100) : 0;
    const gal = [p.image, ...p.gallery].filter((u) => safeUrl(u));
    let fav = !!(wl && wl.ids.includes(p.id));
    const favLabel = () => (fav ? '♥ Nos favoritos' : out ? '♡ Avise-me quando voltar' : '♡ Favoritar');
    return {
      title: p.name, html: `<div class="page"><nav class="crumbs"><a href="#/${esc(p.section)}">${esc(secName(p.section))}</a><span>${esc(p.categoryName)}</span></nav>
        <div class="pdetail" style="--sec:${SEC_COLOR[p.section] || SEC_COLOR.outros}">
          <div class="pgallery">${gal.length ? `<img id="gmain" src="${esc(gal[0])}" alt="${esc(p.name)}">` : `<div class="pimg ph"><span>${esc(p.categoryName)}</span></div>`}
            ${gal.length > 1 ? `<div class="thumbs">${gal.map((u, n) => `<button type="button" class="${n ? '' : 'on'}" data-img="${esc(u)}" aria-label="Imagem ${n + 1}"><img src="${esc(u)}" alt="" loading="lazy"></button>`).join('')}</div>` : ''}${videoHtml(p.video)}</div>
          <div class="pinfo"><h1>${esc(p.name)}</h1><div class="pprice">${priceHtml(p)}${off > 0 ? `<b class="off">-${off}%</b>` : ''}</div>
            ${p.ratingCount ? `<a class="rate" href="#avaliacoes" data-scroll="avaliacoes"><span class="stars">${stars(p.rating)}</span> ${p.rating.toFixed(1)} · ${pl(p.ratingCount, 'avaliação', 'avaliações')}</a>` : ''}
            ${p.short ? `<p class="lead">${esc(p.short)}</p>` : ''}
            <p class="stock-line ${out ? 'bad' : ''}">${esc(stockLabel(p))}${p.sold ? ` · ${p.sold} vendido${p.sold > 1 ? 's' : ''}` : ''}${p.warrantyDays ? ` · Garantia de ${pl(p.warrantyDays, 'dia', 'dias')}` : ''}</p>
            <form id="buy" class="buy">
              <label>Quantidade<input type="number" name="qty" min="1" max="${max}" value="1" ${out ? 'disabled' : ''}></label>
              <label>Cupom<span class="inline"><input name="coupon" placeholder="Opcional" autocomplete="off" ${out ? 'disabled' : ''}><button type="button" class="btn btn-ghost btn-small" id="aplicar" ${out ? 'disabled' : ''}>Aplicar</button></span></label>
              <label class="full">${p.delivery === 'manual' ? 'Seu usuário no Discord ou WhatsApp' : 'Contato (opcional)'}<input name="contact" maxlength="80" ${p.delivery === 'manual' ? 'required' : ''} placeholder="${p.delivery === 'manual' ? 'Para combinarmos a entrega' : 'Discord ou WhatsApp'}" ${out ? 'disabled' : ''}></label>
              <label class="full">CPF de quem vai pagar<input name="cpf" inputmode="numeric" autocomplete="off" maxlength="14" placeholder="000.000.000-00" ${p.price > 0 ? 'required' : ''} ${out ? 'disabled' : ''}></label>
              <div class="total full"><span>Total</span><strong id="total">${brl(p.price)}</strong></div>
              <label class="check full terms"><input type="checkbox" name="terms" required ${out ? 'disabled' : ''}> <span>Li e aceito os <a href="#/termos" target="_blank">Termos de uso</a> e a <a href="#/reembolso" target="_blank">política de reembolso e garantia</a>.</span></label>
              <button class="btn full" ${out ? 'disabled' : ''}>${out ? 'Esgotado' : 'Comprar agora'}</button>
              <button type="button" class="btn btn-ghost full" id="addcart" ${out ? 'disabled' : ''}>Adicionar ao carrinho</button>
              <p class="fine full">${esc(delivery)} Pagamento por PIX com confirmação automática. O CPF é exigido pelo PIX e usado só para gerar a cobrança; não fica guardado.</p>
            </form>
            <div class="actions"><button type="button" class="btn btn-ghost btn-small" id="fav">${favLabel()}</button><button type="button" class="btn btn-ghost btn-small" data-act="copy" data-copy="${esc(location.origin)}/p/${esc(p.id)}">Copiar link do produto</button></div></div></div>
        ${p.description ? `<section class="section"><h2>Sobre este produto</h2><p class="desc">${esc(p.description)}</p></section>` : ''}
        ${p.includes.length ? `<section class="section"><h2>O que vem incluso</h2><ul class="includes">${p.includes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>` : ''}
        ${reviewsHtml(rv)}</div>`,
      mount(el) {
        const f = $('#buy', el); let discount = 0;
        const qty = () => Math.max(1, Math.min(max, parseInt(f.qty.value, 10) || 1));
        const total = () => { $('#total', el).textContent = brl(Math.max(0, p.price * qty() - discount)); };
        f.qty.addEventListener('input', () => { discount = 0; total(); });
        f.cpf.addEventListener('input', () => { const d = f.cpf.value.replace(/\D/g, '').slice(0, 11); f.cpf.value = d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2'); });
        $('#aplicar', el).onclick = (e) => {
          if (!S.user) { toast('Entre na sua conta para aplicar um cupom.', 'err'); return; }
          run(e.target, async () => { const r = await post('coupon/check', { items: [{ productId: p.id, qty: qty() }], coupon: f.coupon.value }); discount = r.discount; total(); toast(r.discount ? `Cupom aplicado: -${brl(r.discount)}` : 'Digite um cupom.'); });
        };
        f.onsubmit = (e) => {
          e.preventDefault();
          if (!S.user) { location.hash = `#/entrar?next=${encodeURIComponent('#/produto/' + p.id)}`; return; }
          run($('.btn:not(.btn-ghost)', f), async () => { const r = await post('order', { items: [{ productId: p.id, qty: qty() }], coupon: f.coupon.value, contact: f.contact.value, cpf: f.cpf.value, terms: f.terms.checked }); location.hash = `#/pedido/${r.order.id}`; });
        };
        $('#addcart', el).onclick = () => { if (cart.add(p.id, qty())) { toast('Adicionado ao carrinho.'); updateChrome('produto'); } else toast('O carrinho aceita no máximo 10 produtos diferentes.', 'err'); };
        $$('[data-img]', el).forEach((b) => b.onclick = () => { $('#gmain', el).src = b.dataset.img; $$('[data-img]', el).forEach((x) => x.classList.toggle('on', x === b)); });
        $$('[data-scroll]', el).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); const t = document.getElementById(a.dataset.scroll); if (t) t.scrollIntoView({ behavior: 'smooth' }); }));
        $('#fav', el).onclick = (e) => {
          if (!S.user) { location.hash = `#/entrar?next=${encodeURIComponent('#/produto/' + p.id)}`; return; }
          run(e.target, async () => { await post('wishlist/toggle', { pid: p.id, on: !fav }); fav = !fav; e.target.textContent = favLabel(); toast(fav ? (out ? 'Favoritado. Avisamos em Minha conta quando voltar ao estoque.' : 'Adicionado aos favoritos.') : 'Removido dos favoritos.'); });
        };
        const rf = $('#rvform', el);
        if (rf) {
          rf.onsubmit = (e) => { e.preventDefault(); run($('.btn', rf), async () => { await post('review/save', { pid: p.id, rating: rf.rating.value, text: rf.text.value }); toast('Obrigado pela avaliação!'); render(); }); };
          const del = $('#rvdel', el); if (del) del.onclick = async () => { if (await confirmBox('Apagar sua avaliação?', 'Ela some da página do produto.', { danger: true, ok: 'Apagar' })) run(del, async () => { await post('review/delete', { pid: p.id }); toast('Avaliação apagada.'); render(); }); };
        }
      },
    };
  };

  /* ---------- Carrinho ---------- */
  views.carrinho = async () => {
    const items = cart.get();
    if (!items.length) return { title: 'Carrinho', html: `<div class="page narrow">${empty('Seu carrinho está vazio', 'Adicione produtos para comprar vários de uma vez, com um único PIX.', '<a class="btn" href="#/">Ver produtos</a>')}</div>` };
    const { products, maintenance } = await api('products');
    if (maintenance) return { title: 'Carrinho', html: `<div class="page narrow">${empty('Loja em manutenção', 'Volte em instantes. Seu carrinho fica guardado.')}</div>` };
    const by = Object.fromEntries(products.map((p) => [p.id, p]));
    const rows = items.map((it) => ({ it, p: by[it.pid] }));
    const gone = rows.filter((r) => !r.p || soldOut(r.p));
    const live = rows.filter((r) => r.p && !soldOut(r.p));
    const hasManual = live.some((r) => r.p.delivery === 'manual');
    const maxOf = (p) => Math.max(1, Math.min(p.maxPerOrder, p.stock.unlimited ? 99 : p.stock.count));
    return {
      title: 'Carrinho', html: `<div class="page"><header class="page-head"><h1>Carrinho</h1></header>
        <div class="cols cartcols"><section class="section"><div class="cartlist">${live.map(({ it, p }) => `<div class="crow" data-pid="${esc(p.id)}">
            <a class="cimg" href="#/produto/${esc(p.id)}">${p.image ? `<img src="${esc(safeUrl(p.image))}" alt="" loading="lazy">` : `<span>${esc(p.categoryName)}</span>`}</a>
            <div class="cinfo"><a href="#/produto/${esc(p.id)}"><strong>${esc(p.name)}</strong></a><span class="muted">${esc(p.categoryName)} · ${brl(p.price)} cada${p.warrantyDays ? ` · garantia de ${p.warrantyDays}d` : ''}</span></div>
            <input type="number" class="cqty" min="1" max="${maxOf(p)}" value="${Math.min(it.qty, maxOf(p))}" aria-label="Quantidade de ${esc(p.name)}">
            <b class="cline">${brl(p.price * Math.min(it.qty, maxOf(p)))}</b><button type="button" class="btn btn-ghost btn-small" data-rm="${esc(p.id)}" aria-label="Remover ${esc(p.name)}">Remover</button></div>`).join('')}
          ${gone.map(({ it, p }) => `<div class="crow gone"><div class="cinfo"><strong>${esc(p ? p.name : 'Produto indisponível')}</strong><span class="muted">${p ? 'Esgotado no momento.' : 'Este produto saiu da loja.'}</span></div><button type="button" class="btn btn-ghost btn-small" data-rm="${esc(it.pid)}">Remover</button></div>`).join('')}</div></section>
        <section class="section"><h2>Resumo</h2>${live.length ? `<form id="co" class="stack">
          <div class="sum"><span>Subtotal</span><b id="sub">${brl(0)}</b></div><div class="sum" id="dsc" hidden><span>Cupom</span><b></b></div><div class="sum total"><span>Total</span><b id="tot">${brl(0)}</b></div>
          <label>Cupom<span class="inline"><input name="coupon" placeholder="Opcional" autocomplete="off"><button type="button" class="btn btn-ghost btn-small" id="aplicar">Aplicar</button></span></label>
          <label>${hasManual ? 'Seu usuário no Discord ou WhatsApp' : 'Contato (opcional)'}<input name="contact" maxlength="80" ${hasManual ? 'required' : ''} placeholder="${hasManual ? 'Para combinarmos as entregas manuais' : 'Discord ou WhatsApp'}"></label>
          <label>CPF de quem vai pagar<input name="cpf" inputmode="numeric" autocomplete="off" maxlength="14" placeholder="000.000.000-00" required></label>
          <label class="check terms"><input type="checkbox" name="terms" required> <span>Li e aceito os <a href="#/termos" target="_blank">Termos de uso</a> e a <a href="#/reembolso" target="_blank">política de reembolso e garantia</a>.</span></label>
          <button class="btn">Finalizar compra</button><p class="fine">Um único PIX para todos os itens. O estoque fica reservado enquanto você paga.</p></form>` : '<p class="muted">Nenhum item disponível para comprar.</p>'}
          <div class="actions"><button type="button" class="btn btn-ghost btn-small" id="limpar">Esvaziar carrinho</button><a class="btn btn-ghost btn-small" href="#/">Continuar comprando</a></div></section></div></div>`,
      mount(el) {
        let discount = 0;
        const qtyOf = (row) => Math.max(1, Math.min(maxOf(row.p), parseInt($('.cqty', row.el).value, 10) || 1));
        live.forEach((r) => { r.el = $(`.crow[data-pid="${CSS.escape(r.p.id)}"]`, el); });
        const sum = () => {
          const sub = live.reduce((s, r) => s + r.p.price * qtyOf(r), 0);
          if ($('#sub', el)) { $('#sub', el).textContent = brl(sub); $('#tot', el).textContent = brl(Math.max(0, sub - discount)); const d = $('#dsc', el); d.hidden = !discount; $('b', d).textContent = `-${brl(discount)}`; }
        };
        live.forEach((r) => { $('.cqty', r.el).addEventListener('input', () => { const q = qtyOf(r); cart.setQty(r.p.id, q); $('.cline', r.el).textContent = brl(r.p.price * q); discount = 0; sum(); updateChrome('carrinho'); }); });
        $$('[data-rm]', el).forEach((b) => b.onclick = () => { cart.remove(b.dataset.rm); render(); });
        $('#limpar', el).onclick = () => { cart.clear(); render(); };
        const f = $('#co', el); if (!f) return;
        sum();
        f.cpf.addEventListener('input', () => { const d = f.cpf.value.replace(/\D/g, '').slice(0, 11); f.cpf.value = d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2'); });
        const payload = () => live.map((r) => ({ productId: r.p.id, qty: qtyOf(r) }));
        $('#aplicar', el).onclick = (e) => {
          if (!S.user) { toast('Entre na sua conta para aplicar um cupom.', 'err'); return; }
          run(e.target, async () => { const r = await post('coupon/check', { items: payload(), coupon: f.coupon.value }); discount = r.discount; sum(); toast(r.discount ? `Cupom aplicado: -${brl(r.discount)}` : 'Digite um cupom.'); });
        };
        f.onsubmit = (e) => {
          e.preventDefault();
          if (!S.user) { location.hash = `#/entrar?next=${encodeURIComponent('#/carrinho')}`; return; }
          run($('.btn:not(.btn-ghost)', f), async () => { const r = await post('order', { items: payload(), coupon: f.coupon.value, contact: f.contact.value, cpf: f.cpf.value, terms: f.terms.checked }); cart.clear(); location.hash = `#/pedido/${r.order.id}`; });
        };
      },
    };
  };

  /* ---------- Entrar e cadastrar ---------- */
  const safeNext = (n) => (/^#\/[a-z]/i.test(n || '') ? n : '#/conta');
  const authView = (mode) => async (parts, q) => {
    if (S.user) { location.hash = '#/conta'; return { html: '' }; }
    const reg = mode === 'cadastro', closed = reg && S.config.registrationOpen === false;
    const next = q.next ? `?next=${encodeURIComponent(q.next)}` : '';
    return {
      title: reg ? 'Criar conta' : 'Entrar', html: `<div class="page narrow"><div class="authbox"><h1>${reg ? 'Criar conta' : 'Entrar'}</h1>
        ${S.banned ? `<p class="notice bad">Esta conta foi banida.${S.banned.reason ? ' Motivo: ' + esc(S.banned.reason) : ''}</p>` : ''}
        ${closed ? '<p class="notice">Os cadastros estão fechados no momento.</p>' : ''}
        <form id="auth" class="stack">${reg ? '<label>Nome<input name="name" autocomplete="name" required maxlength="60"></label>' : ''}
          <label>E-mail<input name="email" type="email" autocomplete="email" required></label>
          <label>Senha<input name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required minlength="${reg ? 8 : 1}"></label>
          ${reg ? '<p class="fine">Use pelo menos 8 caracteres.</p><details class="adminkey"><summary>Sou o administrador da loja</summary><label>Chave de configuração<input name="setupKey" type="password" autocomplete="off"></label><p class="fine">Só é pedida se a variável ADMIN_SETUP_KEY estiver definida no Vercel.</p></details>' : '<label id="codef" hidden>Código de verificação<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="20" placeholder="6 dígitos do app ou código de recuperação"></label>'}
          <button class="btn" ${closed ? 'disabled' : ''}>${reg ? 'Criar conta' : 'Entrar'}</button></form>
        <p class="fine">${reg ? `Já tem conta? <a href="#/entrar${next}">Entrar</a>` : `Ainda não tem conta? <a href="#/cadastro${next}">Criar conta</a>. Esqueceu a senha? Fale com o <a href="#/faq">suporte</a>: geramos uma senha temporária.`}</p></div></div>`,
      mount(el) {
        $('#auth', el).onsubmit = (e) => {
          e.preventDefault();
          run($('button', e.target), async () => {
            const r = await post(reg ? 'register' : 'login', formObj(e.target));
            if (r.needCode) { const cf = $('#codef', el); cf.hidden = false; $('input', cf).focus(); toast('Digite o código do seu app autenticador (ou um código de recuperação).'); return; }
            await boot();
            toast(reg ? 'Conta criada. Bem-vindo!' : 'Você entrou na conta.');
            const to = safeNext(q.next);
            if (location.hash === to) render(); else location.hash = to;
          });
        };
      },
    };
  };
  views.entrar = authView('entrar');
  views.cadastro = authView('cadastro');

  /* ---------- Minha conta ---------- */
  const needLogin = () => { location.hash = `#/entrar?next=${encodeURIComponent(location.hash)}`; return { html: '' }; };
  const orderLabel = (o) => (o.lines.length > 1 ? `${o.lines[0].name} + ${o.lines.length - 1} ${o.lines.length - 1 === 1 ? 'item' : 'itens'}` : `${o.lines[0].name}${o.lines[0].qty > 1 ? ` × ${o.lines[0].qty}` : ''}`);
  const downloadTxt = (name, text) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
  function twofaSetup() {
    return post('account/2fa/setup').then((r) => {
      const m = openModal(`<form class="stack"><h3>Ativar verificação em duas etapas</h3>
        <p>1. No app autenticador (Google Authenticator, Authy, Microsoft Authenticator, 1Password...), adicione uma conta <b>manualmente</b> com esta chave:</p>
        <code class="key">${esc(r.secret.match(/.{1,4}/g).join(' '))}</code>
        <div class="actions"><button type="button" class="btn btn-ghost btn-small" data-act="copy" data-copy="${esc(r.secret)}">Copiar chave</button><a class="btn btn-ghost btn-small" href="${esc(r.uri)}">Abrir no app</a></div>
        <label>2. Digite o código de 6 dígitos que o app mostra<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required></label>
        <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancelar</button><button class="btn">Ativar</button></div></form>`);
      $('form', m.el).onsubmit = (e) => {
        e.preventDefault();
        run($('.btn:not(.btn-ghost)', e.target), async () => {
          const out = await post('account/2fa/enable', { code: e.target.code.value });
          S.user = out.user; m.close();
          const txt = out.codes.join('\n');
          openModal(`<h3>Guarde seus códigos de recuperação</h3><p>Se você perder o celular, cada código abaixo entra na sua conta <b>uma única vez</b>. Eles não aparecem de novo.</p><pre class="delivery-text">${esc(txt)}</pre>
            <div class="modal-actions"><button class="btn btn-ghost" data-act="copy" data-copy="${esc(txt)}">Copiar</button><button class="btn btn-ghost" id="dlc">Baixar .txt</button><button class="btn" data-close>Já guardei</button></div>`);
          $('#dlc').onclick = () => downloadTxt('codigos-de-recuperacao.txt', txt + '\n');
          new MutationObserver((_, ob) => { if (!$('#modal-root').children.length) { ob.disconnect(); render(); } }).observe($('#modal-root'), { childList: true });
        });
      };
    });
  }
  views.conta = async () => {
    if (!S.user) return needLogin();
    const [{ orders }, wl] = await Promise.all([api('orders'), api('wishlist').catch(() => ({ products: [] }))]);
    const rows = orders.map((o) => `<a class="orow" href="#/pedido/${esc(o.id)}"><div><strong>${esc(orderLabel(o))}</strong><span class="muted">${esc(o.code)} · ${dt(o.createdAt)}</span></div><div class="orow-r"><b>${brl(o.total)}</b>${badge(o.status)}</div></a>`).join('');
    const favs = wl.products.map((p) => `<div class="orow static"><div><a href="#/produto/${esc(p.id)}"><strong>${esc(p.name)}</strong></a><span class="muted">${brl(p.price)} · ${esc(stockLabel(p))}</span></div><div class="orow-r">${p.back ? '<span class="st st-entregue">Voltou ao estoque!</span>' : soldOut(p) ? '<span class="st st-cancelado">Esgotado</span>' : ''}<button class="btn btn-ghost btn-small" data-unfav="${esc(p.id)}">Remover</button></div></div>`).join('');
    return {
      title: 'Minha conta', html: `<div class="page"><header class="page-head"><h1>Olá, ${esc(S.user.name.split(' ')[0])}</h1><p class="lead">${esc(S.user.email)}</p></header>
        <div class="cols"><div><section class="section"><h2>Meus pedidos</h2>${orders.length ? `<div class="olist">${rows}</div>` : empty('Nenhum pedido ainda', 'Quando você comprar, o pedido e a entrega aparecem aqui.', '<a class="btn" href="#/">Ver produtos</a>')}</section>
          <section class="section"><h2>Favoritos</h2>${favs ? `<div class="olist">${favs}</div>` : '<p class="muted">Favorite um produto para acompanhá-lo aqui. Se ele estiver esgotado, avisamos nesta página quando voltar ao estoque.</p>'}</section></div>
        <div><section class="section"><h2>Dados da conta</h2><form id="perfil" class="stack"><label>Nome<input name="name" value="${esc(S.user.name)}" required maxlength="60"></label><button class="btn btn-ghost">Salvar nome</button></form>
          <h3 class="mt">Trocar senha</h3><form id="senha" class="stack"><label>Senha atual<input type="password" name="currentPassword" autocomplete="current-password" required></label><label>Nova senha<input type="password" name="newPassword" autocomplete="new-password" minlength="8" required></label><button class="btn btn-ghost">Trocar senha</button></form></section>
          <section class="section"><h2>Segurança</h2><p>Verificação em duas etapas: ${S.user.twofa ? '<b class="ok">ativada</b>' : '<b class="bad">desativada</b>'}.</p>
            <p class="fine">${S.user.twofa ? 'Ao entrar, além da senha, você digita o código do app autenticador.' : 'Proteja a conta (e o que você comprou) com um código do app autenticador a cada login.'}</p>
            ${S.user.twofa ? '<button class="btn btn-ghost" id="tf-off">Desativar</button>' : '<button class="btn" id="tf-on">Ativar verificação em duas etapas</button>'}</section></div></div></div>`,
      mount(el) {
        $('#perfil', el).onsubmit = (e) => { e.preventDefault(); run($('button', e.target), async () => { S.user = (await post('account', { name: e.target.name.value })).user; updateChrome('conta'); toast('Nome atualizado.'); }); };
        $('#senha', el).onsubmit = (e) => { e.preventDefault(); run($('button', e.target), async () => { await post('account', formObj(e.target)); e.target.reset(); toast('Senha alterada.'); }); };
        $$('[data-unfav]', el).forEach((b) => b.onclick = () => run(b, async () => { await post('wishlist/toggle', { pid: b.dataset.unfav, on: false }); await boot(); render(); }));
        const on = $('#tf-on', el); if (on) on.onclick = () => run(on, twofaSetup);
        const off = $('#tf-off', el);
        if (off) off.onclick = () => {
          const m = openModal(`<form class="stack"><h3>Desativar verificação em duas etapas</h3><label>Senha<input type="password" name="password" autocomplete="current-password" required></label><label>Código do app (ou de recuperação)<input name="code" inputmode="numeric" autocomplete="one-time-code" required></label><div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancelar</button><button class="btn btn-danger">Desativar</button></div></form>`);
          $('form', m.el).onsubmit = (e) => { e.preventDefault(); run($('.btn-danger', e.target), async () => { S.user = (await post('account/2fa/disable', formObj(e.target))).user; m.close(); toast('Verificação em duas etapas desativada.'); render(); }); };
        };
      },
    };
  };

  /* ---------- Pedido: pagamento e entrega ---------- */
  const supportLinks = () => {
    const c = S.config.contacts || {}, wa = String(c.whatsapp || '').replace(/\D/g, '');
    const l = [safeUrl(c.discord) && `<a href="${esc(c.discord)}" target="_blank" rel="noopener">Discord</a>`, wa && `<a href="https://wa.me/${wa}" target="_blank" rel="noopener">WhatsApp</a>`, c.email && `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`].filter(Boolean);
    return `<p class="fine">Precisa de ajuda? <a href="#/suporte">Abra um ticket</a>${l.length ? ` ou fale com o suporte: ${l.join(' · ')}` : ''}</p>`;
  };
  const itemList = (items) => `<ul class="items">${items.map((i) => `<li><code>${esc(i)}</code><button class="btn btn-ghost btn-small" data-act="copy" data-copy="${esc(i)}">Copiar</button></li>`).join('')}</ul>${items.length > 1 ? `<button class="btn btn-ghost btn-small" data-act="copy" data-copy="${esc(items.join('\n'))}">Copiar tudo</button>` : ''}`;
  const lineDelivery = (o, l, i, paid) => {
    const d = l.delivered; let h = '';
    if (d) {
      if (d.type === 'items') h += itemList(d.items);
      else if (d.type === 'link') h += `<a class="btn" href="/api/store?r=download&id=${esc(o.id)}&line=${i}" target="_blank" rel="noopener">Baixar ou abrir</a><p class="fine">${d.left != null ? `Downloads restantes: ${d.left}. ` : ''}${d.until ? `Disponível até ${dt(d.until).slice(0, 8)}.` : ''}</p>`;
      else h += `<pre class="delivery-text">${esc(d.text)}</pre>`;
    } else if (paid) h += '<p class="muted">Entrega manual pendente. Fique de olho no Discord ou WhatsApp que você informou.</p>';
    for (const r of l.replacements || []) h += `<h4>Reposição de ${dt(r.at)}</h4>${itemList(r.items)}`;
    if (paid && l.delivered && l.warrantyUntil) {
      if (l.warrantyUntil > Date.now()) h += `<p class="fine">Garantia até ${dt(l.warrantyUntil).slice(0, 8)}. ${l.replaceTicket ? `<a href="#/ticket/${esc(l.replaceTicket)}">Ver pedido de reposição em andamento</a>` : '<button type="button" class="btn btn-ghost btn-small" data-rep="' + i + '">Pedir reposição</button>'}</p>`;
      else h += `<p class="fine">A garantia deste item acabou em ${dt(l.warrantyUntil).slice(0, 8)}.</p>`;
    }
    return h;
  };
  views.pedido = async ([id], q) => {
    if (!S.user) return needLogin();
    const o = (await api('order', { query: { id: id || '-' } })).order, open = o.status === 'pendente' || o.status === 'aguardando';
    const paid = o.status === 'pago' || o.status === 'entregue', pay = o.payment;
    const cancelBtn = '<button class="btn btn-ghost" id="cancelar">Cancelar pedido</button>';
    const payHtml = !open ? '' : pay ? `<section class="section pay"><h2>Pagamento por PIX</h2>
      <div class="pay-grid"><div><span class="muted">Valor exato</span><strong class="big">${brl(o.total)}</strong></div>${pay.qr ? `<div><img class="qr" src="${esc(pay.qr)}" alt="QR Code do PIX" width="220" height="220"></div>` : ''}</div>
      <div><span class="muted">PIX Copia e Cola</span><code class="key pixcode">${esc(pay.copyPaste)}</code></div>
      <div class="actions"><button class="btn" data-act="copy" data-copy="${esc(pay.copyPaste)}">Copiar código PIX</button>${cancelBtn}</div>
      <p>${esc(pay.instructions)}</p>
      <p class="fine">Aguardando o pagamento. Esta página confirma sozinha, não precisa avisar. Estoque reservado até ${dt(o.expiresAt)}; depois disso o pedido expira.</p></section>`
      : `<section class="section pay"><h2>Pagamento</h2><p>${o.status === 'aguardando' ? 'Recebemos o seu aviso. Estamos conferindo o pagamento e você será liberado em seguida.' : 'Este pedido foi criado antes do pagamento automático e não tem PIX. Cancele e faça um novo pedido.'}</p><div class="actions">${cancelBtn}</div></section>`;
    const msg = { expirado: 'Este pedido expirou e o estoque foi liberado. Você pode fazer um novo pedido.', cancelado: 'Pedido cancelado.', reembolsado: 'Pedido reembolsado.' }[o.status];
    return {
      title: `Pedido ${o.code}`, html: `<div class="page narrow"><nav class="crumbs"><a href="#/conta">Minha conta</a><span>${esc(o.code)}</span></nav>
        <header class="page-head"><h1>Pedido ${esc(o.code)}</h1>${badge(o.status)}</header>
        <section class="section">${o.lines.map((l) => `<div class="sum"><div><strong>${esc(l.name)}</strong><span class="muted">${esc(l.catName)} · ${l.qty} un. × ${brl(l.unit)}</span></div><b>${brl(l.unit * l.qty)}</b></div>`).join('')}
          ${o.discount ? `<div class="sum"><span>Cupom ${esc(o.coupon)}</span><b>-${brl(o.discount)}</b></div>` : ''}<div class="sum total"><span>Total</span><b>${brl(o.total)}</b></div><p class="fine">Criado em ${dt(o.createdAt)}</p></section>
        ${payHtml}${paid ? o.lines.map((l, i) => `<section class="section"><h2>${o.lines.length > 1 ? esc(l.name) : 'Sua entrega'}</h2>${lineDelivery(o, l, i, paid)}</section>`).join('') : ''}
        ${msg ? `<section class="section"><p>${esc(msg)}</p></section>` : ''}
        ${paid ? `<p class="fine"><a href="#/suporte?pedido=${esc(o.id)}">Tive um problema com este pedido</a></p>` : ''}${supportLinks()}</div>`,
      mount(el) {
        if (q.erro) toast(q.erro, 'err');
        if (open && pay) { const t = setInterval(async () => { try { const n = (await api('order', { query: { id: o.id } })).order; if (n.status !== o.status) { if (n.status === 'pago' || n.status === 'entregue') toast('Pagamento confirmado!'); render(); } } catch (_) { /* tenta de novo */ } }, 5000); S.cleanup = () => clearInterval(t); }
        const cn = $('#cancelar', el);
        if (cn) cn.onclick = async () => { if (await confirmBox('Cancelar pedido?', 'O estoque reservado volta para a loja.', { danger: true, ok: 'Cancelar pedido' })) run(cn, async () => { await post('order/cancel', { id: o.id }); toast('Pedido cancelado.'); render(); }); };
        $$('[data-rep]', el).forEach((b) => b.onclick = () => {
          const i = +b.dataset.rep, l = o.lines[i], mine = l.delivered && l.delivered.type === 'items' ? l.delivered.items : [];
          const m = openModal(`<form class="stack"><h3>Pedir reposição</h3><p class="muted">${esc(l.name)} · garantia até ${dt(l.warrantyUntil).slice(0, 8)}</p>
            ${mine.length ? `<fieldset class="fieldset"><legend>Quais itens deram problema?</legend>${mine.map((it, n) => `<label class="check"><input type="checkbox" name="it" value="${n}"> <code>${esc(it)}</code></label>`).join('')}</fieldset>` : ''}
            <label>O que aconteceu?<textarea name="text" rows="4" required minlength="5" maxlength="2000" placeholder="Explique o problema com o item"></textarea></label>
            <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancelar</button><button class="btn">Enviar pedido</button></div></form>`);
          $('form', m.el).onsubmit = (e) => { e.preventDefault(); run($('.btn:not(.btn-ghost)', e.target), async () => {
            const items = $$('[name=it]:checked', e.target).map((c) => mine[+c.value]);
            const r = await post('ticket/new', { type: 'reposicao', orderId: o.id, line: i, items, text: e.target.text.value });
            m.close(); toast('Pedido de reposição enviado.'); location.hash = `#/ticket/${r.ticket.id}`;
          }); };
        });
      },
    };
  };

  /* ---------- Suporte (tickets) ---------- */
  const TSTATUS = { aberto: 'Aberto', respondido: 'Respondido', fechado: 'Encerrado' };
  const tbadge = (s) => `<span class="st st-${esc(s)}">${esc(TSTATUS[s] || s)}</span>`;
  views.suporte = async (parts, q) => {
    if (!S.user) return needLogin();
    const [{ tickets }, { orders }] = await Promise.all([api('tickets'), api('orders')]);
    const list = tickets.map((t) => `<a class="orow" href="#/ticket/${esc(t.id)}"><div><strong>${esc(t.subject)}</strong><span class="muted">${esc(t.code)}${t.orderCode ? ' · ' + esc(t.orderCode) : ''} · ${dt(t.updatedAt)}${t.preview ? ' · ' + esc(t.preview) : ''}</span></div><div class="orow-r">${t.resolution ? `<span class="muted">Reposição ${esc(t.resolution)}</span>` : ''}${tbadge(t.status)}</div></a>`).join('');
    return {
      title: 'Suporte', html: `<div class="page narrow"><header class="page-head"><h1>Suporte</h1><p class="lead">Abra um ticket e acompanhe a resposta por aqui.</p></header>
        <section class="section"><h2>Novo ticket</h2><form id="tk" class="stack"><label>Sobre qual pedido? (opcional)<select name="orderId"><option value="">Nenhum pedido</option>${orders.map((o) => `<option value="${esc(o.id)}" ${q.pedido === o.id ? 'selected' : ''}>${esc(o.code)} · ${esc(orderLabel(o))}</option>`).join('')}</select></label>
          <label>Assunto<input name="subject" maxlength="120" placeholder="Resumo do problema"></label><label>Mensagem<textarea name="text" rows="4" required minlength="5" maxlength="2000"></textarea></label>
          <button class="btn">Abrir ticket</button><p class="fine">Se o produto tem garantia, use <b>Pedir reposição</b> dentro do pedido.</p></form></section>
        <section class="section"><h2>Meus tickets</h2>${tickets.length ? `<div class="olist">${list}</div>` : '<p class="muted">Você ainda não abriu nenhum ticket.</p>'}</section>${supportLinks()}</div>`,
      mount(el) { $('#tk', el).onsubmit = (e) => { e.preventDefault(); run($('button', e.target), async () => { const r = await post('ticket/new', formObj(e.target)); toast('Ticket aberto.'); location.hash = `#/ticket/${r.ticket.id}`; }); }; },
    };
  };
  const thread = (t, mine) => t.messages.map((m) => `<div class="msg ${m.system ? 'sys' : (m.by === 'admin') === !!mine ? 'me' : 'other'}"><div class="mh"><b>${esc(m.by === 'admin' ? `Suporte${m.name ? ' · ' + m.name.split(' ')[0] : ''}` : m.name || 'Cliente')}</b><em>${dt(m.at)}</em></div><p>${esc(m.text)}</p></div>`).join('');
  views.ticket = async ([id]) => {
    if (!S.user) return needLogin();
    const t = (await api('ticket', { query: { id: id || '-' } })).ticket;
    return {
      title: t.code, html: `<div class="page narrow"><nav class="crumbs"><a href="#/suporte">Suporte</a><span>${esc(t.code)}</span></nav>
        <header class="page-head"><h1>${esc(t.subject)}</h1>${tbadge(t.status)}</header>
        <p class="fine">${t.orderCode ? `Pedido <a href="#/pedido/${esc(t.orderId)}">${esc(t.orderCode)}</a> · ` : ''}Aberto em ${dt(t.createdAt)}${t.resolution ? ` · Reposição ${esc(t.resolution)}` : ''}</p>
        <section class="section thread" id="thr">${thread(t, false)}</section>
        <section class="section"><form id="rp" class="stack"><label>${t.status === 'fechado' ? 'Responder (reabre o ticket)' : 'Responder'}<textarea name="text" rows="3" required maxlength="2000"></textarea></label>
          <div class="actions"><button class="btn">Enviar</button>${t.status !== 'fechado' ? '<button type="button" class="btn btn-ghost" id="fechar">Encerrar ticket</button>' : ''}</div></form></section></div>`,
      mount(el) {
        $('#rp', el).onsubmit = (e) => { e.preventDefault(); run($('.btn', e.target), async () => { await post('ticket/reply', { id: t.id, text: e.target.text.value }); render(); }); };
        const cl = $('#fechar', el); if (cl) cl.onclick = () => run(cl, async () => { await post('ticket/close', { id: t.id }); toast('Ticket encerrado.'); render(); });
        const timer = setInterval(async () => { try { const n = (await api('ticket', { query: { id: t.id } })).ticket; if (n.messages.length !== t.messages.length && !$('#rp textarea', el).value) render(); } catch (_) { /* tenta de novo */ } }, 20000);
        S.cleanup = () => clearInterval(timer);
      },
    };
  };

  /* ---------- Páginas legais e FAQ ---------- */
  const legalView = (key, title) => async () => {
    const pg = await api('pages');
    const body = key === 'faq' ? `<div class="faq">${pg.faq.map((x) => `<details><summary>${esc(x.q)}</summary>${rich(x.a)}</details>`).join('')}</div>` : `<div class="legal">${rich(pg[key])}</div>`;
    return { title, html: `<div class="page narrow"><header class="page-head"><h1>${esc(title)}</h1></header>${body}${key === 'faq' ? supportLinks() : ''}</div>` };
  };
  views.termos = legalView('terms', 'Termos de uso');
  views.reembolso = legalView('refund', 'Reembolso e garantia');
  views.privacidade = legalView('privacy', 'Privacidade');
  views.faq = legalView('faq', 'Perguntas frequentes');

  /* ---------- Portfólio ---------- */
  views.portfolio = async () => {
    const { items } = await api('portfolio'), mail = (S.config.contacts || {}).email || 'caarldev@gmail.com';
    const media = (w) => (w.video && safeUrl(w.video) ? `<div class="work-media has-media"><video src="${esc(w.video)}" controls preload="metadata" playsinline></video></div>`
      : w.image && safeUrl(w.image) ? `<div class="work-media has-media"><img src="${esc(w.image)}" alt="${esc(w.title)}" loading="lazy"></div>` : `<div class="work-media"><span>${esc(w.tag || 'Trabalho')}</span></div>`);
    const services = [['Animação 3D', 'Movimentos com peso, timing e intenção. Personagens, câmeras e objetos que parecem vivos, de ciclos de andar a combates completos.'], ['Modelos 3D', 'Personagens, armas, props e ambientes com topologia limpa, UVs organizados e texturas PBR prontas para jogo ou render.'], ['Efeitos 3D (VFX)', 'Fogo, fumaça, energia, faíscas e destruição. Efeitos que reforçam a cena sem roubar a atenção do que importa.'], ['Cutscenes', 'Direção de câmera, ritmo, iluminação e atuação dos personagens para contar a história com impacto cinematográfico.'], ['Rigging e texturização', 'Esqueletos e controles fáceis de animar, além de materiais realistas com desgaste, brilho e profundidade.'], ['Iluminação e render', 'Luz que cria atmosfera e direciona o olhar. Renders finais nítidos, consistentes e prontos para entrega.']];
    return {
      title: 'Portfólio', html: `<section class="hero"><p class="hero-kicker">Animação, 3D e cinema em tempo real</p><h1><span>Cada chama</span><span>tem um detalhe.</span></h1>
        <p class="hero-text">Sou o Caarldev. Crio animações, modelos 3D, efeitos e cutscenes com realismo e acabamento profissional, do primeiro rascunho ao render final.</p>
        <div class="hero-actions"><a class="btn" href="#contato" data-scroll="contato">Pedir orçamento</a><a class="btn btn-ghost" href="#trabalhos" data-scroll="trabalhos">Ver trabalhos</a></div></section>
        <section class="section" id="servicos"><h2>O que eu faço</h2><p class="lead">Do personagem ao cenário, cuido de toda a produção visual para que o resultado final pareça uma única obra.</p><div class="grid">${services.map(([t, d]) => `<article class="card"><h3>${t}</h3><p>${d}</p></article>`).join('')}</div></section>
        <section class="section" id="trabalhos"><h2>Trabalhos selecionados</h2><div class="works">${items.map((w) => `<figure class="work ${w.wide ? 'work-wide' : ''}">${media(w)}<figcaption><strong>${esc(w.title)}</strong> ${esc(w.desc)}</figcaption></figure>`).join('')}</div></section>
        <section class="section"><h2>Como eu trabalho</h2><div class="values"><div><h3>Profissionalismo</h3><p>Prazos combinados e cumpridos, comunicação clara em cada etapa e entrega organizada, com arquivos prontos para uso.</p></div><div><h3>Realismo</h3><p>Referências reais, física crível e materiais fiéis à vida. Mesmo no estilizado, a base é sempre sólida.</p></div><div><h3>Detalhe por detalhe</h3><p>Poros, costuras, faíscas, reflexos. Reviso cada quadro até que nada pareça deixado ao acaso.</p></div></div></section>
        <section class="section"><h2>Do briefing ao render final</h2><ol class="steps"><li><strong>Briefing</strong><span>Entendo a ideia, o estilo, as referências e o prazo.</span></li><li><strong>Pré-produção</strong><span>Storyboard, blocking e testes de câmera para aprovar a direção.</span></li><li><strong>Produção</strong><span>Modelagem, rig, animação e efeitos com revisões ao longo do caminho.</span></li><li><strong>Polimento</strong><span>Iluminação, texturas, correção de cor e ajustes finos.</span></li><li><strong>Entrega</strong><span>Render final e arquivos no formato que o seu projeto precisa.</span></li></ol></section>
        <section class="section about"><h2>Sobre o Caarldev</h2><p>Sou artista 3D e dono deste portfólio. Trabalho com animação, modelagem, efeitos e cutscenes para jogos, vídeos e projetos autorais. Gosto de cenas intensas, com cor, movimento e emoção, onde cada detalhe ajuda a contar a história.</p><p>Se você tem uma ideia, eu ajudo a transformá-la em imagem em movimento.</p></section>
        <section class="section contact" id="contato"><h2>Vamos criar algo juntos</h2><p class="lead">Conte sobre o seu projeto, o prazo e o orçamento que você tem em mente. Respondo o mais rápido possível.</p><a class="mail" href="mailto:${esc(mail)}">${esc(mail)}</a>
          <form id="form" class="form"><label>Seu nome<input name="nome" autocomplete="name" required maxlength="80"></label><label>Seu e-mail<input name="email" type="email" autocomplete="email" required></label>
          <label>Tipo de projeto<select name="tipo"><option>Animação</option><option>Modelo 3D</option><option>Efeitos 3D</option><option>Cutscene</option><option>Rigging e texturização</option><option>Iluminação e render</option><option>Outro</option></select></label>
          <label>Prazo desejado<select name="prazo"><option value="">A combinar</option><option>Sem pressa</option><option>Em 1 a 2 semanas</option><option>Em até 1 mês</option><option>Urgente</option></select></label>
          <label>Orçamento estimado<select name="orcamento"><option value="">A combinar</option><option>Até R$ 200</option><option>R$ 200 a R$ 500</option><option>R$ 500 a R$ 1.000</option><option>Acima de R$ 1.000</option></select></label>
          <label>Seu Discord ou WhatsApp (opcional)<input name="contato" maxlength="80" autocomplete="off"></label>
          <label class="full">Link de referência (opcional)<input name="referencia" type="url" placeholder="https://..." maxlength="300"></label>
          <label class="full">Conte sobre o projeto<textarea name="mensagem" rows="5" required minlength="5" maxlength="3000" placeholder="O que você quer criar, estilo, referências, onde vai usar..."></textarea></label><button class="btn" type="submit">Pedir orçamento</button></form></section>`,
      mount(el) {
        $$('[data-scroll]', el).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); const t = document.getElementById(a.dataset.scroll); if (t) t.scrollIntoView({ behavior: 'smooth' }); }));
        $('#form', el).onsubmit = (e) => { e.preventDefault(); run($('button', e.target), async () => { await post('contact', formObj(e.target)); e.target.reset(); toast('Pedido de orçamento enviado. Respondo em breve.'); }); };
      },
    };
  };

  views.notfound = async () => ({ title: 'Página não encontrada', html: `<div class="page narrow">${empty('Página não encontrada', 'O endereço não existe ou mudou de lugar.', '<a class="btn" href="#/">Voltar ao início</a>')}</div>` });

  views.notfound = async () => ({ title: 'Página não encontrada', html: `<div class="page narrow">${empty('Página não encontrada', 'O endereço não existe ou mudou de lugar.', '<a class="btn" href="#/">Voltar ao início</a>')}</div>` });

  /* ====================================================================
     PAINEL ADMIN (#/admin/<aba>)
     ==================================================================== */
  // [id, nome, permissão da equipe]. null = só administrador.
  const TABS = [['geral', 'Visão geral', null], ['relatorios', 'Relatórios', null], ['pedidos', 'Pedidos', 'pedidos'], ['produtos', 'Produtos', 'produtos'], ['estoque', 'Estoque', 'estoque,produtos'], ['categorias', 'Categorias', null], ['usuarios', 'Usuários', null], ['cupons', 'Cupons e afiliados', 'cupons'], ['avaliacoes', 'Avaliações', 'avaliacoes'], ['tickets', 'Tickets', 'tickets'], ['portfolio', 'Portfólio', 'portfolio'], ['mensagens', 'Orçamentos', 'mensagens'], ['paginas', 'Páginas', null], ['config', 'Configurações', null], ['logs', 'Registros', null], ['backup', 'Backup', null]];
  const PERMS = [['pedidos', 'Pedidos (ver, entregar, notas)'], ['tickets', 'Tickets e reposições'], ['mensagens', 'Orçamentos e mensagens'], ['estoque', 'Estoque'], ['produtos', 'Produtos'], ['cupons', 'Cupons e afiliados'], ['portfolio', 'Portfólio'], ['avaliacoes', 'Avaliações']];
  const tabOk = (t) => (t[2] === null ? S.user.role === 'admin' : can(t[2]));
  const tabs = {};
  const head = (t, actions) => `<div class="adm-head"><h2>${esc(t)}</h2><div class="adm-actions">${actions || ''}</div></div>`;
  const kpi = (label, value, sub) => `<div class="kpi"><span>${esc(label)}</span><strong>${value}</strong>${sub ? `<em>${sub}</em>` : ''}</div>`;
  const lowAt = 3;
  const apiUrl = (route, q) => `/api/store?r=${route}${Object.entries(q || {}).filter(([, v]) => v).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('')}`;
  const readFile = (file) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => no(new Error('Não foi possível ler o arquivo.')); r.readAsText(file); });
  const todayBR = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);

  views.admin = async ([tab = 'geral']) => {
    if (!S.user) return needLogin();
    if (!isStaff()) return { title: 'Acesso restrito', html: `<div class="page narrow">${empty('Acesso restrito', 'Esta área é só para a equipe da loja.', '<a class="btn" href="#/">Voltar</a>')}</div>` };
    const allowed = TABS.filter(tabOk);
    if (!allowed.length) return { title: 'Painel', html: `<div class="page narrow">${empty('Sem permissões', 'Peça ao administrador para liberar o seu acesso.', '<a class="btn" href="#/">Voltar</a>')}</div>` };
    if (!tabs[tab] || !allowed.find((t) => t[0] === tab)) tab = allowed[0][0];
    return {
      title: 'Painel', html: `<div class="admin"><aside class="admin-nav" aria-label="Painel"><strong>${S.user.role === 'admin' ? 'Painel' : 'Equipe'}</strong>${allowed.map(([id, n]) => `<a href="#/admin/${id}" class="${id === tab ? 'on' : ''}">${n}</a>`).join('')}</aside><section class="admin-main" id="adm"></section></div>`,
      mount(el) {
        const body = $('#adm', el);
        const load = () => tabs[tab](body, load).catch((e) => { body.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; });
        body.innerHTML = '<p class="muted">Carregando…</p>'; load();
      },
    };
  };

  /* ---------- Visão geral ---------- */
  function chart(series, label) {
    const W = 720, H = 200, pad = 8, max = Math.max(1, ...series.map((s) => s.revenue)), bw = (W - pad * 2) / series.length, step = Math.max(1, Math.ceil(series.length / 7));
    const bars = series.map((s, i) => { const h = Math.round((s.revenue / max) * (H - 44)); return `<g><title>${s.date.split('-').reverse().slice(0, 2).join('/')}: ${brl(s.revenue)} em ${s.orders} pedido(s)</title><rect class="bar" x="${(pad + i * bw + Math.min(2, bw / 4)).toFixed(1)}" y="${H - 24 - Math.max(h, 1)}" width="${Math.max(1, bw - Math.min(4, bw / 2)).toFixed(1)}" height="${Math.max(h, 1)}" rx="2"/></g>`; }).join('');
    const labels = series.map((s, i) => (i % step === 0 ? `<text x="${(pad + i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${s.date.slice(8)}/${s.date.slice(5, 7)}</text>` : '')).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label || 'Receita por dia')}">${bars}${labels}</svg>`;
  }
  tabs.geral = async (el, reload) => {
    const [st, sx] = await Promise.all([api('admin/stats'), api('admin/status')]);
    const t = st.totals, warn = [], tips = [];
    if (!sx.session) warn.push('A variável <b>SESSION_SECRET</b> não está configurada no Vercel. Sem ela ninguém consegue entrar.');
    if (!sx.adminEmails) warn.push('A variável <b>ADMIN_EMAIL</b> não está configurada. Defina o seu e-mail no Vercel e crie a conta com ele para virar admin.');
    if (!sx.misticpay) warn.push('Os pagamentos PIX não estão ligados: configure <b>MISTICPAY_CLIENT_ID</b> e <b>MISTICPAY_CLIENT_SECRET</b> no Vercel (chave de acesso da MisticPay) e faça o redeploy.');
    if (!sx.twofa) warn.push('Sua conta de admin ainda não tem <b>verificação em duas etapas</b>. O painel mexe com dinheiro e estoque: ative em <a href="#/conta">Minha conta</a>.');
    if (!sx.setupKey) tips.push('Defina a variável <b>ADMIN_SETUP_KEY</b> no Vercel. Sem verificação de e-mail, ela impede que outra pessoa crie a conta do administrador antes de você.');
    if (!sx.discord) tips.push('Ligue os <b>avisos no Discord</b> (Configurações) para saber na hora de vendas, entregas manuais, tickets e estoque baixo.');
    const secs = SECS.map((s) => { const v = st.bySection[s] || { revenue: 0, orders: 0 }; return `<li><span>${esc(secName(s))}</span><b>${brl(v.revenue)}</b><em>${v.orders} item(ns)</em></li>`; }).join('');
    const stat = Object.keys(STATUS).map((k) => `<li><span>${badge(k)}</span><b>${st.byStatus[k] || 0}</b></li>`).join('');
    const top = st.topProducts.length ? st.topProducts.map((p) => `<li><span>${esc(p.name)}</span><b>${brl(p.revenue)}</b><em>${p.qty} un.</em></li>`).join('') : '<li class="muted">Sem vendas ainda.</li>';
    const low = st.lowStock.length ? st.lowStock.map((p) => `<li><span>${esc(p.name)}</span><b class="${p.count === 0 ? 'bad' : ''}">${p.count === 0 ? 'Esgotado' : p.count + ' restante(s)'}</b></li>`).join('') : '<li class="muted">Estoque em dia.</li>';
    el.innerHTML = `${head('Visão geral', '<button class="btn btn-ghost btn-small" id="rl">Atualizar</button>')}
      ${warn.map((w) => `<p class="notice bad">${w}</p>`).join('')}${tips.map((w) => `<p class="notice">${w}</p>`).join('')}
      <div class="kpis">${kpi('Receita total', brl(t.revenue), pl(t.paidOrders, 'pedido pago', 'pedidos pagos'))}${kpi('Hoje', brl(st.periods.today.revenue), `${st.periods.today.orders} pedido(s)`)}${kpi('Últimos 7 dias', brl(st.periods.d7.revenue), `${st.periods.d7.orders} pedido(s)`)}${kpi('Últimos 30 dias', brl(st.periods.d30.revenue), `${st.periods.d30.orders} pedido(s)`)}${kpi('Ticket médio', brl(t.avgTicket))}${kpi('Aguardando pagamento', st.byStatus.pendente || 0, st.byStatus.aguardando ? `${st.byStatus.aguardando} em conferência manual` : 'PIX automático')}${kpi('Tickets abertos', st.tickets, '<a href="#/admin/tickets">Ver tickets</a>')}${kpi('Usuários', t.users, `${pl(t.newUsers30, 'novo', 'novos')} em 30 dias · ${pl(t.banned, 'banido', 'banidos')}`)}${kpi('Produtos ativos', t.activeProducts, `${t.products} no total`)}</div>
      <div class="panel"><h3>Receita dos últimos 30 dias</h3>${chart(st.series, 'Receita dos últimos 30 dias')}<p class="fine">Mais números em <a href="#/admin/relatorios">Relatórios</a>.</p></div>
      <div class="cols3"><div class="panel"><h3>Por parte do site</h3><ul class="rows">${secs}</ul></div><div class="panel"><h3>Mais vendidos</h3><ul class="rows">${top}</ul></div><div class="panel"><h3>Status dos pedidos</h3><ul class="rows">${stat}</ul></div></div>
      <div class="cols"><div class="panel"><h3>Precisa de atenção</h3>${st.needsAction.length ? st.needsAction.map((o) => `<div class="orow static"><div><strong>${esc(orderLabel(o))}</strong><span class="muted">${esc(o.code)} · ${esc(o.userName)} · ${dt(o.createdAt)}</span></div><div class="orow-r"><b>${brl(o.total)}</b>${badge(o.status)}<button class="btn btn-small" data-open="${esc(o.id)}">Abrir</button></div></div>`).join('') : '<p class="muted">Nada pendente agora.</p>'}</div>
        <div class="panel"><h3>Estoque baixo</h3><ul class="rows">${low}</ul><a class="btn btn-ghost btn-small" href="#/admin/estoque">Gerenciar estoque</a></div></div>`;
    $('#rl', el).onclick = reload;
    $$('[data-open]', el).forEach((b) => b.onclick = () => orderModal(st.needsAction.find((o) => o.id === b.dataset.open), reload));
  };

  /* ---------- Relatórios ---------- */
  tabs.relatorios = async (el, reload) => {
    const range = tabs.relatorios.range || '30';
    const rp = await api('admin/report', { query: { range } });
    const c = rp.cur, p = rp.prev;
    const dl = (a, b) => { const v = b ? Math.round(((a - b) / b) * 100) : a ? 100 : 0; return `<span class="${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '▲' : '▼'} ${Math.abs(v)}%</span> vs. período anterior`; };
    const table = (rows, cols) => (rows.length ? `<div class="tablewrap"><table class="tbl"><thead><tr>${cols.map((x) => `<th>${x[0]}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((x) => `<td>${x[1](r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<p class="muted">Sem vendas neste período.</p>');
    const funnel = [['Pedidos criados', c.created, p.created], ['Pagos', c.createdPaid, p.createdPaid], ['Expirados', c.expired, p.expired], ['Cancelados', c.canceled, p.canceled], ['Reembolsados', c.refunded, p.refunded]];
    el.innerHTML = `${head('Relatórios')}
      <div class="chips" role="group" aria-label="Período">${[['7', 'Últimos 7 dias'], ['30', 'Últimos 30 dias'], ['90', 'Últimos 90 dias'], ['mes', 'Este mês']].map(([k, n]) => `<a href="#" data-range="${k}" class="${rp.range === k ? 'on' : ''}">${n}</a>`).join('')}</div>
      <div class="kpis">${kpi('Receita', brl(c.revenue), dl(c.revenue, p.revenue))}${kpi('Pedidos pagos', c.paid, dl(c.paid, p.paid))}${kpi('Ticket médio', brl(c.avgTicket), dl(c.avgTicket, p.avgTicket))}${kpi('Conversão', `${c.conversion}%`, `Dos pedidos criados, quantos foram pagos (antes: ${p.conversion}%)`)}${kpi('Novos usuários', c.newUsers, dl(c.newUsers, p.newUsers))}${kpi('Descontos dados', brl(c.discount), `${pl(c.couponOrders, 'pedido', 'pedidos')} com cupom`)}</div>
      <div class="panel"><h3>${esc(rp.label)}: receita por dia</h3>${chart(rp.series, `Receita por dia, ${rp.label}`)}</div>
      <div class="cols"><div class="panel"><h3>Funil de pedidos</h3><ul class="rows">${funnel.map(([n, a, b]) => `<li><span>${n}</span><b>${a}</b><em>antes: ${b}</em></li>`).join('')}</ul><p class="fine">Pedidos criados no período, e o que aconteceu com eles.</p></div>
        <div class="panel"><h3>Por parte do site</h3><ul class="rows">${SECS.map((s) => { const v = rp.bySection[s] || { revenue: 0, qty: 0 }; return `<li><span>${esc(secName(s))}</span><b>${brl(v.revenue)}</b><em>${v.qty} un.</em></li>`; }).join('')}</ul></div></div>
      <div class="cols"><div class="panel"><h3>Por produto</h3>${table(rp.byProduct, [['Produto', (r) => esc(r.name)], ['Un.', (r) => r.qty], ['Receita', (r) => brl(r.revenue)]])}</div>
        <div class="panel"><h3>Por categoria</h3>${table(rp.byCategory, [['Categoria', (r) => `${esc(secName(r.section))} · ${esc(r.name)}`], ['Un.', (r) => r.qty], ['Receita', (r) => brl(r.revenue)]])}</div></div>
      ${rp.truncated ? '<p class="fine">O relatório considera os 4.000 pedidos mais recentes.</p>' : ''}`;
    $$('[data-range]', el).forEach((a) => a.onclick = (e) => { e.preventDefault(); tabs.relatorios.range = a.dataset.range; reload(); });
  };

  /* ---------- Pedidos ---------- */
  function orderModal(o, after) {
    const open = o.status === 'pendente' || o.status === 'aguardando', paid = o.status === 'pago' || o.status === 'entregue', isAdm = S.user.role === 'admin';
    const lineBlock = (l, i) => {
      const d = l.delivered;
      const dv = !d ? '<span class="muted">Ainda não entregue</span>' : d.type === 'items' ? `<ul class="items">${d.items.map((x) => `<li><code>${esc(x)}</code></li>`).join('')}</ul>` : d.type === 'link' ? `<code>${esc(d.url)}</code><span class="fine">Downloads feitos: ${d.downloads || 0}${d.lastAt ? ` · último em ${dt(d.lastAt)}` : ''}</span>` : `<pre class="delivery-text">${esc(d.text)}</pre>`;
      const reps = (l.replacements || []).map((r) => `<li>${dt(r.at)} · ${esc(r.ticket)}: ${r.items.map((x) => `<code>${esc(x)}</code>`).join(' ')}</li>`).join('');
      return `<div class="panel lineblock"><div class="sum"><div><strong>${esc(l.name)}</strong><span class="muted">${esc(l.catName)} · ${l.qty} un. × ${brl(l.unit)} · entrega ${{ items: 'por itens', link: 'por download', manual: 'manual' }[l.mode] || l.mode}${l.warrantyUntil ? ` · garantia até ${dt(l.warrantyUntil).slice(0, 8)}` : ''}</span></div><b>${brl(l.unit * l.qty)}</b></div>
        <h4>Entrega</h4>${dv}${reps ? `<h4>Reposições</h4><ul class="hist">${reps}</ul>` : ''}
        ${l.mode === 'manual' && paid ? `<label>Registrar entrega manual<textarea data-dtext="${i}" rows="3" placeholder="O que o cliente deve receber (dados, instruções...)">${d && d.text ? esc(d.text) : ''}</textarea></label><button class="btn btn-small" data-oa="deliver" data-line="${i}">Salvar entrega</button>` : ''}
        ${d && d.type === 'link' && paid ? `<button class="btn btn-ghost btn-small" data-oa="resetdl" data-line="${i}">Renovar prazo e downloads</button>` : ''}</div>`;
    };
    const m = openModal(`<h3>Pedido ${esc(o.code)} ${badge(o.status)}</h3>
      <div class="detail"><div><span class="muted">Cliente</span><b>${esc(o.userName)}</b><span>${esc(o.userEmail)}</span>${o.contact ? `<span>Contato: ${esc(o.contact)}</span>` : ''}</div>
      <div><span class="muted">Total</span><b>${brl(o.total)}</b><span>${o.discount ? `Cupom ${esc(o.coupon)}: -${brl(o.discount)}` : 'Sem cupom'}</span></div>
      <div><span class="muted">Datas</span><span>Criado: ${dt(o.createdAt)}</span><span>Pago: ${dt(o.paidAt)}</span><span>Entregue: ${dt(o.deliveredAt)}</span></div></div>
      ${o.payIssue ? `<p class="notice bad">${esc(o.payIssue)}</p>` : ''}${o.payRef ? `<p class="fine">MisticPay: transação ${esc(o.payRef)}</p>` : ''}
      ${o.note ? `<p><span class="muted">Observação do cliente:</span> ${esc(o.note)}</p>` : ''}
      ${o.lines.map(lineBlock).join('')}
      <label>Nota interna<textarea id="ntext" rows="2">${esc(o.adminNote || '')}</textarea></label><button class="btn btn-ghost btn-small" data-oa="note">Salvar nota</button>
      <h4>Histórico</h4><ul class="hist">${(o.history || []).slice().reverse().map((h) => `<li><span>${dt(h.at)}</span>${esc(h.what)} <em>${esc(h.by)}</em></li>`).join('')}</ul>
      <div class="modal-actions">${isAdm && (open || o.status === 'expirado') ? '<button class="btn" data-oa="pay">Confirmar pagamento</button>' : ''}${isAdm && open ? '<button class="btn btn-ghost" data-oa="cancel">Cancelar pedido</button>' : ''}${isAdm && paid ? '<label class="check"><input type="checkbox" id="restock"> Devolver ao estoque</label><button class="btn btn-danger" data-oa="refund">Reembolsar</button>' : ''}<button class="btn btn-ghost" data-close>Fechar</button></div>`, { wide: true });
    $$('[data-oa]', m.el).forEach((b) => b.onclick = () => run(b, async () => {
      const a = b.dataset.oa; let extra = {};
      if (a === 'cancel' && !(await confirmBox('Cancelar pedido?', 'O estoque reservado volta para a loja.', { danger: true, ok: 'Cancelar pedido' }))) return;
      if (a === 'refund') { if (!(await confirmBox('Reembolsar pedido?', 'O status muda para reembolsado. O dinheiro você devolve por fora, pelo PIX.', { danger: true, ok: 'Reembolsar' }))) return; extra = { restock: $('#restock', m.el).checked }; }
      if (a === 'deliver') extra = { line: b.dataset.line, text: $(`[data-dtext="${b.dataset.line}"]`, m.el).value };
      if (a === 'resetdl') extra = { line: b.dataset.line };
      if (a === 'note') extra = { text: $('#ntext', m.el).value };
      await post('admin/order', { id: o.id, action: a, ...extra });
      toast('Pedido atualizado.'); m.close(); after();
    }));
  }
  tabs.pedidos = async (el, reload) => {
    const st = tabs.pedidos.filter || (tabs.pedidos.filter = { status: '', q: '', from: '', to: '' });
    const { orders } = await api('admin/orders', { query: st });
    el.innerHTML = `${head('Pedidos', S.user.role === 'admin' ? `<a class="btn btn-ghost btn-small" href="${apiUrl('admin/export', st)}">Exportar CSV</a>` : '')}
      <form id="flt" class="toolbar"><select name="status"><option value="">Todos os status</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${st.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select><input type="search" name="q" value="${esc(st.q)}" placeholder="Código, cliente, e-mail ou produto">
        <label class="inl">De<input type="date" name="from" value="${esc(st.from)}" max="${todayBR()}"></label><label class="inl">Até<input type="date" name="to" value="${esc(st.to)}" max="${todayBR()}"></label><button class="btn btn-small">Filtrar</button><button type="button" class="btn btn-ghost btn-small" id="limpa">Limpar</button></form>
      ${orders.length ? `<div class="tablewrap"><table class="tbl"><thead><tr><th>Pedido</th><th>Data</th><th>Cliente</th><th>Produtos</th><th>Total</th><th>Status</th><th></th></tr></thead><tbody>${orders.map((o) => `<tr><td><b>${esc(o.code)}</b></td><td>${dt(o.createdAt)}</td><td>${esc(o.userName)}<br><span class="muted">${esc(o.userEmail)}</span></td><td>${o.lines.map((l) => `${esc(l.name)} × ${l.qty}`).join('<br>')}</td><td>${brl(o.total)}</td><td>${badge(o.status)}</td><td><button class="btn btn-small" data-open="${esc(o.id)}">Abrir</button></td></tr>`).join('')}</tbody></table></div>` : empty('Nenhum pedido', 'Nenhum pedido encontrado com esses filtros.')}`;
    $('#flt', el).onsubmit = (e) => { e.preventDefault(); Object.assign(st, { status: e.target.status.value, q: e.target.q.value, from: e.target.from.value, to: e.target.to.value }); reload(); };
    $('#limpa', el).onclick = () => { Object.assign(st, { status: '', q: '', from: '', to: '' }); reload(); };
    $$('[data-open]', el).forEach((b) => b.onclick = () => orderModal(orders.find((o) => o.id === b.dataset.open), reload));
  };

  /* ---------- Produtos ---------- */
  function productForm(p, cats, after) {
    p = p || { delivery: 'items', active: true, maxPerOrder: 10 };
    const opts = SECS.map((s) => `<optgroup label="${esc(secName(s))}">${cats.filter((c) => c.section === s).map((c) => `<option value="${esc(c.id)}" ${p.categoryId === c.id ? 'selected' : ''}>${esc(c.name)}${c.active ? '' : ' (oculta)'}</option>`).join('')}</optgroup>`).join('');
    const m = openModal(`<form id="pf" class="stack"><h3>${p.id ? 'Editar produto' : 'Novo produto'}</h3>
      <div class="grid2"><label class="full">Nome<input name="name" required maxlength="90" value="${esc(p.name || '')}"></label>
      <label>Categoria<select name="categoryId" required>${opts}</select></label>
      <label>Preço (R$)<input name="price" inputmode="decimal" required value="${fromCents(p.price) || ''}" placeholder="49,90"></label>
      <label>Preço antigo (R$, opcional)<input name="compareAt" inputmode="decimal" value="${fromCents(p.compareAt)}" placeholder="Aparece riscado"></label>
      <label>Máximo por pedido<input name="maxPerOrder" type="number" min="1" max="100" value="${p.maxPerOrder || 10}"></label>
      <label class="full">Descrição curta<input name="short" maxlength="160" value="${esc(p.short || '')}"></label>
      <label class="full">Descrição completa<textarea name="description" rows="5" maxlength="4000">${esc(p.description || '')}</textarea></label>
      <label class="full">Imagem (URL https)<input name="image" value="${esc(p.image || '')}" placeholder="https://..."></label>
      <label class="full">Mais imagens da galeria (uma URL https por linha, até 6)<textarea name="gallery" rows="3" placeholder="https://...">${esc((p.gallery || []).join('\n'))}</textarea></label>
      <label class="full">Vídeo de demonstração (link do YouTube ou .mp4/.webm)<input name="video" value="${esc(p.video || '')}" placeholder="https://youtu.be/..."></label>
      <label class="full">O que vem incluso (um item por linha)<textarea name="includes" rows="3" placeholder="Scripts prontos&#10;GUIs&#10;Documentação">${esc((p.includes || []).join('\n'))}</textarea></label>
      <label>Garantia (dias, 0 = sem garantia)<input name="warrantyDays" type="number" min="0" max="365" value="${p.warrantyDays || 0}"></label>
      <label class="full">Como é entregue<select name="delivery"><option value="items" ${p.delivery === 'items' ? 'selected' : ''}>Itens em estoque (cada linha é uma unidade: conta, chave, código)</option><option value="link" ${p.delivery === 'link' ? 'selected' : ''}>Link de download (arquivo Rbxl, modelo, pacote)</option><option value="manual" ${p.delivery === 'manual' ? 'selected' : ''}>Entrega manual (impulsos, farm, serviços)</option></select></label>
      <label class="full" data-for="link">Link de download (só aparece depois do pagamento)<input name="link" value="${esc(p.link || '')}" placeholder="https://..."></label>
      <label class="check" data-for="link manual"><input type="checkbox" name="unlimited" ${p.unlimited ? 'checked' : ''}> Estoque ilimitado</label>
      <label data-for="link manual" id="qtyf">Quantidade em estoque<input name="qty" type="number" min="0" value="${p.delivery !== 'items' && p.stock && !p.stock.unlimited ? p.stock.count : ''}"></label>
      <label class="full">Etiquetas (separadas por vírgula)<input name="tags" value="${esc((p.tags || []).join(', '))}"></label>
      <label class="check"><input type="checkbox" name="featured" ${p.featured ? 'checked' : ''}> Destaque na página inicial</label>
      <label class="check"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}> Visível na loja</label></div>
      ${p.delivery === 'items' || !p.id ? '<p class="fine" id="itemsnote">Depois de salvar, adicione os itens na aba Estoque.</p>' : ''}
      <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancelar</button><button class="btn">Salvar produto</button></div></form>`, { wide: true });
    const f = $('#pf', m.el);
    const sync = () => { const dv = f.delivery.value; $$('[data-for]', f).forEach((x) => { x.hidden = !x.dataset.for.split(' ').includes(dv); }); $('#qtyf', f).hidden = $('#qtyf', f).hidden || f.unlimited.checked; const n = $('#itemsnote', m.el); if (n) n.hidden = dv !== 'items'; };
    f.delivery.onchange = sync; f.unlimited.onchange = sync; sync();
    f.onsubmit = (e) => {
      e.preventDefault();
      run($('.btn:not(.btn-ghost)', f), async () => {
        const o = formObj(f); o.price = toCents(o.price); o.compareAt = toCents(o.compareAt); if (p.id) o.id = p.id;
        await post('admin/product/save', o); toast('Produto salvo.'); m.close(); after();
      });
    };
  }
  tabs.produtos = async (el, reload) => {
    const { products, categories } = await api('admin/products');
    el.innerHTML = `${head('Produtos', '<button class="btn btn-small" id="novo">Novo produto</button>')}
      <div class="bulkbar" id="bulk" hidden><b id="bcount"></b><select id="bact"><option value="show">Mostrar na loja</option><option value="hide">Ocultar</option><option value="feature">Destacar</option><option value="unfeature">Tirar destaque</option><option value="move">Mover para categoria</option><option value="price">Reajustar preço (%)</option><option value="delete">Apagar</option></select>
        <select id="bcat" hidden>${categories.map((c) => `<option value="${esc(c.id)}">${esc(secName(c.section))} · ${esc(c.name)}</option>`).join('')}</select><input id="bpct" type="number" step="1" min="-90" max="500" placeholder="% (ex.: 10 ou -15)" hidden><button class="btn btn-small" id="bgo">Aplicar</button></div>
      ${products.length ? `<div class="tablewrap"><table class="tbl"><thead><tr><th><input type="checkbox" id="selall" aria-label="Selecionar todos"></th><th>Produto</th><th>Categoria</th><th>Preço</th><th>Estoque</th><th>Vendidos</th><th>Nota</th><th>Visível</th><th>Destaque</th><th></th></tr></thead><tbody>${products.map((p) => `<tr class="${p.active ? '' : 'dim'}"><td><input type="checkbox" data-sel="${esc(p.id)}" aria-label="Selecionar ${esc(p.name)}"></td><td><b>${esc(p.name)}</b></td><td>${esc(secName(p.section))} · ${esc(p.categoryName)}</td><td>${brl(p.price)}</td><td class="${!p.stock.unlimited && p.stock.count <= lowAt ? 'bad' : ''}">${p.stock.unlimited ? 'Ilimitado' : p.stock.count}</td><td>${p.sold}</td><td>${p.ratingCount ? `${p.rating.toFixed(1)} (${p.ratingCount})` : '<span class="muted">-</span>'}</td>
        <td><button class="sw ${p.active ? 'on' : ''}" data-tog="active" data-id="${esc(p.id)}" aria-label="Alternar visibilidade" aria-pressed="${p.active}"></button></td><td><button class="sw ${p.featured ? 'on' : ''}" data-tog="featured" data-id="${esc(p.id)}" aria-label="Alternar destaque" aria-pressed="${p.featured}"></button></td>
        <td class="nowrap"><button class="btn btn-ghost btn-small" data-edit="${esc(p.id)}">Editar</button> <button class="btn btn-ghost btn-small" data-dup="${esc(p.id)}">Duplicar</button> <button class="btn btn-ghost btn-small" data-del="${esc(p.id)}">Apagar</button></td></tr>`).join('')}</tbody></table></div>` : empty('Nenhum produto', 'Cadastre o primeiro produto para ele aparecer na loja.')}`;
    $('#novo', el).onclick = () => productForm(null, categories, reload);
    $$('[data-edit]', el).forEach((b) => b.onclick = () => productForm(products.find((p) => p.id === b.dataset.edit), categories, reload));
    $$('[data-tog]', el).forEach((b) => b.onclick = () => run(b, async () => { await post('admin/product/toggle', { id: b.dataset.id, field: b.dataset.tog }); reload(); }));
    $$('[data-dup]', el).forEach((b) => b.onclick = () => run(b, async () => { await post('admin/product/duplicate', { id: b.dataset.dup }); toast('Produto duplicado (fica oculto até você revisar).'); reload(); }));
    $$('[data-del]', el).forEach((b) => b.onclick = async () => { if (await confirmBox('Apagar produto?', 'O produto e o estoque dele serão removidos. Os pedidos antigos continuam no histórico.', { danger: true, ok: 'Apagar' })) run(b, async () => { await post('admin/product/delete', { id: b.dataset.del }); toast('Produto apagado.'); reload(); }); });
    // ações em massa
    const sels = () => $$('[data-sel]:checked', el).map((c) => c.dataset.sel);
    const sync = () => { const n = sels().length; $('#bulk', el).hidden = !n; $('#bcount', el).textContent = pl(n, 'selecionado', 'selecionados'); const a = $('#bact', el).value; $('#bcat', el).hidden = a !== 'move'; $('#bpct', el).hidden = a !== 'price'; };
    $$('[data-sel]', el).forEach((c) => c.onchange = sync);
    const all = $('#selall', el); if (all) all.onchange = () => { $$('[data-sel]', el).forEach((c) => { c.checked = all.checked; }); sync(); };
    $('#bact', el).onchange = sync;
    $('#bgo', el).onclick = async (e) => {
      const a = $('#bact', el).value, ids = sels();
      if (a === 'delete' && !(await confirmBox(`Apagar ${pl(ids.length, 'produto', 'produtos')}?`, 'Os produtos e o estoque deles serão removidos.', { danger: true, ok: 'Apagar' }))) return;
      if (a === 'price' && !(await confirmBox('Reajustar preços?', `Os preços de ${pl(ids.length, 'produto', 'produtos')} mudam em ${$('#bpct', el).value || 0}%.`, { ok: 'Reajustar' }))) return;
      run(e.target, async () => { const r = await post('admin/product/bulk', { ids, action: a, categoryId: $('#bcat', el).value, percent: $('#bpct', el).value }); toast(`${pl(r.changed, 'produto atualizado', 'produtos atualizados')}.`); reload(); });
    };
  };

  /* ---------- Estoque ---------- */
  async function stockModal(p, after) {
    const s = await api('admin/stock', { query: { id: p.id } });
    let body;
    if (s.delivery === 'items') {
      body = `<label>Adicionar itens (uma linha por unidade)<textarea id="lines" rows="5" placeholder="usuario:senha&#10;usuario2:senha2"></textarea></label>
        <label>Ou carregue um arquivo .txt ou .csv (cada linha vira uma unidade)<input type="file" id="sfile" accept=".txt,.csv,text/plain,text/csv"></label><button class="btn btn-small" data-sa="add">Adicionar ao estoque</button>
        <h4>${s.count} item(ns) em estoque${s.count > s.items.length ? ` (mostrando ${s.items.length})` : ''}</h4>
        ${s.items.length ? `<ul class="items scroll">${s.items.map((i, n) => `<li><code>${esc(i)}</code><button class="btn btn-ghost btn-small" data-rm="${n}">Remover</button></li>`).join('')}</ul><button class="btn btn-danger btn-small" data-sa="clear">Limpar todo o estoque</button>` : '<p class="muted">Estoque vazio.</p>'}`;
    } else if (s.unlimited) body = '<p>Este produto tem estoque ilimitado. Para controlar a quantidade, edite o produto e desmarque “Estoque ilimitado”.</p>';
    else body = `<p>Quantidade atual: <b>${s.count}</b></p><label>Quantidade<input id="qty" type="number" value="${s.count}"></label><div class="actions"><button class="btn btn-small" data-sa="set">Definir total</button><button class="btn btn-ghost btn-small" data-sa="adjust">Somar ou subtrair</button></div>`;
    const m = openModal(`<h3>Estoque: ${esc(p.name)}</h3>${body}<div class="modal-actions"><button class="btn btn-ghost" data-close>Fechar</button></div>`, { wide: true });
    const send = (b, payload, msg) => run(b, async () => { await post('admin/stock', { id: p.id, ...payload }); toast(msg); m.close(); after(); stockModal(p, after); });
    $$('[data-sa]', m.el).forEach((b) => b.onclick = async () => {
      const a = b.dataset.sa;
      if (a === 'add') return send(b, { action: 'add', lines: $('#lines', m.el).value }, 'Itens adicionados.');
      if (a === 'clear') { if (await confirmBox('Limpar estoque?', 'Todos os itens disponíveis serão apagados.', { danger: true, ok: 'Limpar' })) send(b, { action: 'clear' }, 'Estoque limpo.'); return; }
      send(b, { action: a, qty: $('#qty', m.el).value }, 'Estoque atualizado.');
    });
    const sf = $('#sfile', m.el);
    if (sf) sf.onchange = async () => { try { const t = await readFile(sf.files[0]); const ta = $('#lines', m.el); ta.value = (ta.value ? ta.value.replace(/\s+$/, '') + '\n' : '') + t.replace(/^\ufeff/, '').replace(/\r/g, '').split('\n').filter((x) => x.trim()).join('\n'); toast(`${ta.value.split('\n').length} linha(s) carregada(s). Confira e clique em Adicionar.`); } catch (e) { toast(e.message, 'err'); } };
    $$('[data-rm]', m.el).forEach((b) => b.onclick = () => send(b, { action: 'remove', value: s.items[+b.dataset.rm] }, 'Item removido.'));
  }
  tabs.estoque = async (el, reload) => {
    const { products } = await api('admin/products');
    el.innerHTML = `${head('Estoque')}${products.length ? `<div class="tablewrap"><table class="tbl"><thead><tr><th>Produto</th><th>Tipo</th><th>Disponível</th><th></th></tr></thead><tbody>${products.map((p) => `<tr><td><b>${esc(p.name)}</b><br><span class="muted">${esc(secName(p.section))} · ${esc(p.categoryName)}</span></td><td>${{ items: 'Itens', link: 'Download', manual: 'Manual' }[p.delivery]}</td><td class="${!p.stock.unlimited && p.stock.count <= lowAt ? 'bad' : ''}">${p.stock.unlimited ? 'Ilimitado' : p.stock.count}</td><td><button class="btn btn-small" data-st="${esc(p.id)}">Gerenciar</button></td></tr>`).join('')}</tbody></table></div>` : empty('Sem produtos', 'Cadastre produtos para controlar o estoque.')}`;
    $$('[data-st]', el).forEach((b) => b.onclick = () => run(b, () => stockModal(products.find((p) => p.id === b.dataset.st), reload)));
  };

  /* ---------- Categorias ---------- */
  tabs.categorias = async (el, reload) => {
    const { categories } = await api('admin/categories');
    const form = (c, sec) => {
      c = c || { section: sec || 'discord', active: true };
      const m = openModal(`<form class="stack"><h3>${c.id ? 'Editar categoria' : 'Nova categoria'}</h3><label>Parte do site<select name="section">${SECS.map((s) => `<option value="${s}" ${c.section === s ? 'selected' : ''}>${esc(secName(s))}</option>`).join('')}</select></label>
        <label>Nome<input name="name" required maxlength="50" value="${esc(c.name || '')}"></label><label>Descrição<input name="desc" maxlength="160" value="${esc(c.desc || '')}"></label><label>Ordem<input name="order" type="number" min="0" value="${c.order ?? ''}"></label><label class="check"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}> Visível na loja</label>
        <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancelar</button><button class="btn">Salvar</button></div></form>`);
      $('form', m.el).onsubmit = (e) => { e.preventDefault(); run($('.btn:not(.btn-ghost)', e.target), async () => { const o = formObj(e.target); if (c.id) o.id = c.id; await post('admin/category/save', o); await boot(); toast('Categoria salva.'); m.close(); reload(); }); };
    };
    el.innerHTML = `${head('Categorias', '<button class="btn btn-small" id="nova">Nova categoria</button>')}<p class="muted">Cada categoria pertence a uma parte do site. Use “Outros” para qualquer produto que não seja de Discord ou Roblox.</p>
      ${SECS.map((s) => `<div class="panel"><div class="adm-head"><h3>${esc(secName(s))}</h3><button class="btn btn-ghost btn-small" data-add="${s}">Adicionar aqui</button></div><ul class="rows">${categories.filter((c) => c.section === s).map((c) => `<li class="${c.active ? '' : 'dim'}"><span><b>${esc(c.name)}</b> <em>${esc(c.desc)}</em></span><span class="nowrap"><button class="btn btn-ghost btn-small" data-ed="${esc(c.id)}">Editar</button> <button class="btn btn-ghost btn-small" data-rm="${esc(c.id)}">Apagar</button></span></li>`).join('') || '<li class="muted">Nenhuma categoria.</li>'}</ul></div>`).join('')}`;
    $('#nova', el).onclick = () => form();
    $$('[data-add]', el).forEach((b) => b.onclick = () => form(null, b.dataset.add));
    $$('[data-ed]', el).forEach((b) => b.onclick = () => form(categories.find((c) => c.id === b.dataset.ed)));
    $$('[data-rm]', el).forEach((b) => b.onclick = () => {
      const c = categories.find((x) => x.id === b.dataset.rm), others = categories.filter((x) => x.id !== c.id);
      const m = openModal(`<form class="stack"><h3>Apagar “${esc(c.name)}”?</h3><p class="muted">Se houver produtos nela, escolha para onde movê-los.</p><label>Mover produtos para<select name="moveTo"><option value="">Ninguém (só se estiver vazia)</option>${others.map((x) => `<option value="${esc(x.id)}">${esc(secName(x.section))} · ${esc(x.name)}</option>`).join('')}</select></label><div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancelar</button><button class="btn btn-danger">Apagar categoria</button></div></form>`);
      $('form', m.el).onsubmit = (e) => { e.preventDefault(); run($('.btn-danger', e.target), async () => { await post('admin/category/delete', { id: c.id, moveTo: e.target.moveTo.value }); await boot(); toast('Categoria apagada.'); m.close(); reload(); }); };
    });
  };

  /* ---------- Usuários ---------- */
  const ROLE = { admin: 'Admin', staff: 'Equipe', user: 'Cliente' };
  tabs.usuarios = async (el, reload) => {
    const st = tabs.usuarios.q || '';
    const { users } = await api('admin/users', { query: { q: st } });
    el.innerHTML = `${head('Usuários', `<a class="btn btn-ghost btn-small" href="${apiUrl('admin/export/users')}">Exportar CSV</a>`)}<form id="flt" class="toolbar"><input type="search" name="q" value="${esc(st)}" placeholder="Buscar por nome ou e-mail"><button class="btn btn-small">Buscar</button></form>
      <div class="tablewrap"><table class="tbl"><thead><tr><th>Usuário</th><th>Cargo</th><th>2FA</th><th>Pedidos</th><th>Cadastro</th><th>Último acesso</th><th></th></tr></thead><tbody>${users.map((u) => `<tr class="${u.banned ? 'dim' : ''}"><td><b>${esc(u.name)}</b> ${u.banned ? '<span class="st st-cancelado">Banido</span>' : ''}<br><span class="muted">${esc(u.email)}</span>${u.banned && u.banReason ? `<br><span class="muted">Motivo: ${esc(u.banReason)}</span>` : ''}</td><td>${ROLE[u.role] || 'Cliente'}${u.role === 'staff' ? `<br><span class="muted">${u.perms.map((p) => esc((PERMS.find((x) => x[0] === p) || [p, p])[1].split(' (')[0])).join(', ')}</span>` : ''}</td><td>${u.twofa ? 'Sim' : '<span class="muted">Não</span>'}</td><td>${u.orders}</td><td>${dt(u.createdAt)}</td><td>${dt(u.lastLogin)}</td>
        <td class="nowrap">${u.banned ? `<button class="btn btn-small" data-ua="unban" data-id="${esc(u.id)}">Desbanir</button>` : `<button class="btn btn-ghost btn-small" data-ua="ban" data-id="${esc(u.id)}">Banir</button>`} <button class="btn btn-ghost btn-small" data-ua="role" data-id="${esc(u.id)}">Cargo</button> <button class="btn btn-ghost btn-small" data-ua="resetpw" data-id="${esc(u.id)}">Nova senha</button>${u.twofa ? ` <button class="btn btn-ghost btn-small" data-ua="reset2fa" data-id="${esc(u.id)}">Resetar 2FA</button>` : ''} <button class="btn btn-ghost btn-small" data-ua="delete" data-id="${esc(u.id)}">Apagar</button></td></tr>`).join('')}</tbody></table></div>`;
    $('#flt', el).onsubmit = (e) => { e.preventDefault(); tabs.usuarios.q = e.target.q.value; reload(); };
    $$('[data-ua]', el).forEach((b) => b.onclick = async () => {
      const a = b.dataset.ua, id = b.dataset.id, u = users.find((x) => x.id === id); let extra = {};
      if (a === 'role') {
        const m = openModal(`<form class="stack"><h3>Cargo de ${esc(u.name)}</h3>
          <label class="check"><input type="radio" name="role" value="user" ${u.role === 'user' ? 'checked' : ''}> Cliente</label>
          <label class="check"><input type="radio" name="role" value="staff" ${u.role === 'staff' ? 'checked' : ''}> Equipe (acesso só ao que você marcar)</label>
          <fieldset class="fieldset" id="permf"><legend>Permissões da equipe</legend>${PERMS.map(([k, n]) => `<label class="check"><input type="checkbox" name="p_${k}" ${u.perms.includes(k) ? 'checked' : ''}> ${esc(n)}</label>`).join('')}<p class="fine">Confirmar pagamento, cancelar, reembolsar, usuários, configurações e relatórios continuam só para administradores.</p></fieldset>
          <label class="check"><input type="radio" name="role" value="admin" ${u.role === 'admin' ? 'checked' : ''}> Administrador (acesso total)</label>
          <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancelar</button><button class="btn">Salvar cargo</button></div></form>`);
        const f = $('form', m.el), sync = () => { $('#permf', f).hidden = f.role.value !== 'staff'; };
        $$('[name=role]', f).forEach((r) => r.onchange = sync); sync();
        f.onsubmit = (e) => { e.preventDefault(); run($('.btn:not(.btn-ghost)', f), async () => {
          const role = f.role.value, perms = PERMS.map(([k]) => k).filter((k) => f[`p_${k}`].checked);
          await post('admin/user', { id, action: role === 'staff' ? 'staff' : role === 'admin' ? 'promote' : 'demote', perms });
          toast('Cargo atualizado.'); m.close(); reload();
        }); };
        return;
      }
      if (a === 'ban') { const r = await promptBox('Banir usuário', 'Motivo (o usuário verá essa mensagem)', { ok: 'Banir', danger: true, placeholder: 'Ex.: chargeback, abuso, fraude' }); if (r === null) return; extra = { reason: r }; }
      if (a === 'delete' && !(await confirmBox('Apagar conta?', 'A conta some para sempre. Os pedidos continuam no histórico. Para impedir que a pessoa volte, prefira banir.', { danger: true, ok: 'Apagar conta' }))) return;
      if (a === 'resetpw' && !(await confirmBox('Gerar nova senha?', 'A senha atual deixa de valer e a pessoa é desconectada.', { ok: 'Gerar' }))) return;
      if (a === 'reset2fa' && !(await confirmBox('Resetar a verificação em duas etapas?', 'Use quando a pessoa perdeu o celular e os códigos de recuperação. Ela entra só com a senha e pode ativar de novo.', { ok: 'Resetar' }))) return;
      run(b, async () => {
        const r = await post('admin/user', { id, action: a, ...extra });
        if (r.tempPassword) openModal(`<h3>Senha temporária</h3><p>Envie ao usuário e peça para trocar em Minha conta. Ela não será mostrada de novo.</p><code class="key">${esc(r.tempPassword)}</code><div class="modal-actions"><button class="btn btn-ghost" data-act="copy" data-copy="${esc(r.tempPassword)}">Copiar</button><button class="btn" data-close>Fechar</button></div>`); else toast('Feito.');
        reload();
      });
    });
  };

  /* ---------- Cupons e afiliados ---------- */
  tabs.cupons = async (el, reload) => {
    const { coupons } = await api('admin/coupons');
    const form = (c) => {
      c = c || { type: 'percent', active: true, value: 10 };
      const m = openModal(`<form class="stack"><h3>${c.code ? 'Editar cupom' : 'Novo cupom'}</h3><div class="grid2"><label>Código<input name="code" required maxlength="30" value="${esc(c.code || '')}" ${c.code ? 'readonly' : ''} placeholder="BEMVINDO10"></label>
        <label>Tipo<select name="type"><option value="percent" ${c.type === 'percent' ? 'selected' : ''}>Porcentagem (%)</option><option value="fixed" ${c.type === 'fixed' ? 'selected' : ''}>Valor fixo (R$)</option></select></label>
        <label>Valor<input name="value" required value="${c.type === 'fixed' ? fromCents(c.value) : c.value}" inputmode="decimal"></label>
        <label>Limite de usos no total (0 = ilimitado)<input name="maxUses" type="number" min="0" value="${c.maxUses || 0}"></label>
        <label>Usos por cliente (0 = ilimitado)<input name="perUser" type="number" min="0" value="${c.perUser || 0}"></label>
        <label>Pedido mínimo (R$)<input name="minTotal" inputmode="decimal" value="${fromCents(c.minTotal)}"></label>
        <label>Vale para<select name="section"><option value="">Toda a loja</option>${SECS.map((s) => `<option value="${s}" ${c.section === s ? 'selected' : ''}>${esc(secName(s))}</option>`).join('')}</select></label>
        <label>Validade (opcional)<input name="expires" type="date" value="${c.expiresAt ? new Date(c.expiresAt - 3 * 3600e3).toISOString().slice(0, 10) : ''}"></label>
        <label class="check"><input type="checkbox" name="firstOrder" ${c.firstOrder ? 'checked' : ''}> Só na primeira compra do cliente</label><label class="check"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}> Ativo</label></div>
        <fieldset class="fieldset"><legend>Afiliado / indicação (opcional)</legend><div class="grid2"><label>Nome do afiliado<input name="affiliateName" maxlength="60" value="${esc(c.affiliateName || '')}" placeholder="Quem divulga esse código"></label><label>Comissão (%) sobre as vendas pagas<input name="commissionPct" type="number" min="0" max="100" value="${c.commissionPct || 0}"></label></div></fieldset>
        <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancelar</button><button class="btn">Salvar cupom</button></div></form>`);
      $('form', m.el).onsubmit = (e) => {
        e.preventDefault();
        run($('.btn:not(.btn-ghost)', e.target), async () => {
          const o = formObj(e.target);
          o.value = o.type === 'fixed' ? toCents(o.value) : parseInt(o.value, 10); o.minTotal = toCents(o.minTotal);
          o.expiresAt = o.expires ? new Date(o.expires + 'T23:59:59-03:00').getTime() : 0;
          await post('admin/coupon/save', o); toast('Cupom salvo.'); m.close(); reload();
        });
      };
    };
    el.innerHTML = `${head('Cupons e afiliados', '<button class="btn btn-small" id="novo">Novo cupom</button>')}${coupons.length ? `<div class="tablewrap"><table class="tbl"><thead><tr><th>Código</th><th>Desconto</th><th>Usos</th><th>Regras</th><th>Vendas pagas</th><th>Afiliado</th><th></th></tr></thead><tbody>${coupons.map((c) => `<tr class="${c.active ? '' : 'dim'}"><td><b>${esc(c.code)}</b></td><td>${c.type === 'percent' ? c.value + '%' : brl(c.value)}</td><td>${c.used}${c.maxUses ? ' / ' + c.maxUses : ''}</td>
      <td class="muted">${[c.section ? esc(secName(c.section)) : 'Toda a loja', c.minTotal ? `mín. ${brl(c.minTotal)}` : '', c.perUser ? `${c.perUser}x por cliente` : '', c.firstOrder ? '1ª compra' : '', c.expiresAt ? `até ${dt(c.expiresAt).slice(0, 8)}` : ''].filter(Boolean).join(' · ')}</td>
      <td>${c.paidOrders} · ${brl(c.revenue)}</td><td>${c.commissionPct ? `${esc(c.affiliateName || 'Afiliado')} (${c.commissionPct}%)<br><span class="muted">Comissão ${brl(c.commission)} · pago ${brl(c.paidOut || 0)} · <b class="${c.owed ? 'bad' : ''}">devida ${brl(c.owed)}</b></span>` : '<span class="muted">-</span>'}</td>
      <td class="nowrap">${c.commissionPct ? `<button class="btn btn-small" data-pay="${esc(c.code)}">Registrar pagamento</button> ` : ''}<button class="btn btn-ghost btn-small" data-ed="${esc(c.code)}">Editar</button> <button class="btn btn-ghost btn-small" data-rm="${esc(c.code)}">Apagar</button></td></tr>`).join('')}</tbody></table></div>` : empty('Nenhum cupom', 'Crie códigos de desconto para campanhas, clientes fiéis ou afiliados.')}`;
    $('#novo', el).onclick = () => form();
    $$('[data-ed]', el).forEach((b) => b.onclick = () => form(coupons.find((c) => c.code === b.dataset.ed)));
    $$('[data-pay]', el).forEach((b) => b.onclick = async () => {
      const c = coupons.find((x) => x.code === b.dataset.pay), v = await promptBox('Registrar pagamento de comissão', `Quanto você pagou a ${c.affiliateName || 'o afiliado'}? (R$) Devido agora: ${brl(c.owed)}`, { ok: 'Registrar', placeholder: fromCents(c.owed) });
      if (v === null) return;
      run(b, async () => { await post('admin/coupon/payout', { code: c.code, amount: toCents(v) }); toast('Pagamento registrado.'); reload(); });
    });
    $$('[data-rm]', el).forEach((b) => b.onclick = async () => { if (await confirmBox('Apagar cupom?', 'Pedidos que já usaram o cupom não mudam, mas as estatísticas dele somem.', { danger: true, ok: 'Apagar' })) run(b, async () => { await post('admin/coupon/delete', { code: b.dataset.rm }); toast('Cupom apagado.'); reload(); }); });
  };

  /* ---------- Avaliações ---------- */
  tabs.avaliacoes = async (el, reload) => {
    const { reviews } = await api('admin/reviews');
    el.innerHTML = `${head('Avaliações')}${reviews.length ? reviews.map((r) => `<div class="panel ${r.hidden ? 'dim' : ''}"><div class="adm-head"><h3><span class="stars">${stars(r.rating)}</span> ${esc(r.product)}</h3><span class="muted">${esc(r.name)} · ${dt(r.at)}${r.hidden ? ' · oculta' : ''}</span></div>${r.text ? `<p class="desc">${esc(r.text)}</p>` : '<p class="muted">Sem comentário.</p>'}${r.reply ? `<p class="rvreply"><b>Sua resposta:</b> ${esc(r.reply)}</p>` : ''}
      <div class="actions"><button class="btn btn-small" data-rv="reply" data-p="${esc(r.pid)}" data-u="${esc(r.uid)}" data-t="${esc(r.reply || '')}">${r.reply ? 'Editar resposta' : 'Responder'}</button><button class="btn btn-ghost btn-small" data-rv="${r.hidden ? 'show' : 'hide'}" data-p="${esc(r.pid)}" data-u="${esc(r.uid)}">${r.hidden ? 'Mostrar' : 'Ocultar'}</button><button class="btn btn-ghost btn-small" data-rv="delete" data-p="${esc(r.pid)}" data-u="${esc(r.uid)}">Apagar</button></div></div>`).join('') : empty('Nenhuma avaliação', 'As avaliações dos clientes que compraram aparecem aqui.')}`;
    $$('[data-rv]', el).forEach((b) => b.onclick = async () => {
      const a = b.dataset.rv; let text;
      if (a === 'reply') { text = await promptBox('Responder avaliação', 'Sua resposta aparece embaixo da avaliação', { ok: 'Salvar', value: b.dataset.t }); if (text === null) return; }
      if (a === 'delete' && !(await confirmBox('Apagar avaliação?', 'Ela some da loja e o cliente pode avaliar de novo.', { danger: true, ok: 'Apagar' }))) return;
      run(b, async () => { await post('admin/review', { action: a, pid: b.dataset.p, uid: b.dataset.u, text }); toast('Feito.'); reload(); });
    });
  };

  /* ---------- Tickets ---------- */
  tabs.tickets = async (el, reload) => {
    const st = tabs.tickets.filter || (tabs.tickets.filter = { status: 'aberto', q: '' });
    const { tickets } = await api('admin/tickets', { query: st });
    el.innerHTML = `${head('Tickets')}<form id="flt" class="toolbar"><select name="status"><option value="">Todos</option>${Object.entries(TSTATUS).map(([k, v]) => `<option value="${k}" ${st.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select><input type="search" name="q" value="${esc(st.q)}" placeholder="Código, cliente, assunto ou pedido"><button class="btn btn-small">Filtrar</button></form>
      ${tickets.length ? `<div class="tablewrap"><table class="tbl"><thead><tr><th>Ticket</th><th>Cliente</th><th>Assunto</th><th>Pedido</th><th>Atualizado</th><th>Status</th><th></th></tr></thead><tbody>${tickets.map((t) => `<tr><td><b>${esc(t.code)}</b>${t.type === 'reposicao' ? '<br><span class="st st-pendente">Reposição</span>' : ''}</td><td>${esc(t.userName)}</td><td>${esc(t.subject)}<br><span class="muted">${esc(t.preview)}</span></td><td>${esc(t.orderCode || '-')}</td><td>${dt(t.updatedAt)}</td><td>${tbadge(t.status)}${t.resolution ? `<br><span class="muted">${esc(t.resolution)}</span>` : ''}</td><td><button class="btn btn-small" data-tk="${esc(t.id)}">Abrir</button></td></tr>`).join('')}</tbody></table></div>` : empty('Nenhum ticket', 'Nenhum ticket com esses filtros.')}`;
    $('#flt', el).onsubmit = (e) => { e.preventDefault(); Object.assign(st, { status: e.target.status.value, q: e.target.q.value }); reload(); };
    $$('[data-tk]', el).forEach((b) => b.onclick = () => run(b, async () => ticketModal(b.dataset.tk, reload)));
  };
  async function ticketModal(id, after) {
    const { ticket: t, order } = await api('admin/ticket', { query: { id } });
    const rep = t.type === 'reposicao' && !t.resolution;
    const ol = order ? order.lines[t.line] : null;
    const m = openModal(`<h3>${esc(t.code)} · ${esc(t.subject)} ${tbadge(t.status)}</h3>
      <p class="fine">${esc(t.userName)}${order ? ` · pedido <b>${esc(order.code)}</b> (${esc(orderLabel(order))})` : ''}${ol && ol.warrantyUntil ? ` · garantia até ${dt(ol.warrantyUntil).slice(0, 8)}` : ''}${t.resolution ? ` · reposição ${esc(t.resolution)}` : ''}</p>
      ${t.ref && t.ref.items.length ? `<div class="panel"><h4>Itens com problema segundo o cliente</h4><ul class="items">${t.ref.items.map((x) => `<li><code>${esc(x)}</code></li>`).join('')}</ul></div>` : ''}
      <div class="thread">${thread(t, true)}</div>
      <form id="rp" class="stack"><label>Responder<textarea name="text" rows="3" maxlength="2000"></textarea></label>
        <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Fechar</button>${rep ? '<button type="button" class="btn" data-ta="approve">Aprovar reposição</button><button type="button" class="btn btn-danger" data-ta="deny">Negar e encerrar</button>' : ''}<button type="button" class="btn btn-ghost" data-ta="${t.status === 'fechado' ? 'open' : 'close'}">${t.status === 'fechado' ? 'Reabrir' : 'Encerrar'}</button><button class="btn">Enviar resposta</button></div></form>`, { wide: true });
    const f = $('#rp', m.el), done = (msg) => { toast(msg); m.close(); after(); };
    f.onsubmit = (e) => { e.preventDefault(); if (!f.text.value.trim()) return; run($('.btn:not(.btn-ghost):not(.btn-danger)', f), async () => { await post('admin/ticket/reply', { id, text: f.text.value }); done('Resposta enviada.'); }); };
    $$('[data-ta]', f).forEach((b) => b.onclick = async () => {
      const a = b.dataset.ta;
      if (a === 'approve') { if (!(await confirmBox('Aprovar reposição?', 'Itens novos saem do estoque e aparecem no pedido do cliente.', { ok: 'Aprovar' }))) return; return run(b, async () => { await post('admin/ticket/approve', { id }); done('Reposição aprovada.'); }); }
      if (a === 'deny') return run(b, async () => { await post('admin/ticket/deny', { id, text: f.text.value }); done('Pedido negado e ticket encerrado.'); });
      run(b, async () => { await post('admin/ticket/status', { id, status: a === 'open' ? 'aberto' : 'fechado' }); done('Ticket atualizado.'); });
    });
  }

  /* ---------- Portfólio ---------- */
  tabs.portfolio = async (el) => {
    let { items } = await api('portfolio');
    const draw = () => {
      el.innerHTML = `${head('Portfólio', '<button class="btn btn-ghost btn-small" id="add">Adicionar trabalho</button><button class="btn btn-small" id="save">Salvar alterações</button>')}<p class="muted">Use links https de imagem ou vídeo (por exemplo, do Discord, Imgur ou YouTube direto em .mp4). Os trabalhos aparecem na página Portfólio.</p>
        <div id="plist">${items.map((w, i) => `<div class="pitem panel" data-i="${i}"><div class="grid2"><label>Título<input name="title" value="${esc(w.title)}" maxlength="80"></label><label>Etiqueta<input name="tag" value="${esc(w.tag)}" maxlength="30"></label><label class="full">Descrição<input name="desc" value="${esc(w.desc)}" maxlength="200"></label><label>Imagem (URL)<input name="image" value="${esc(w.image)}"></label><label>Vídeo (URL .mp4)<input name="video" value="${esc(w.video)}"></label><label class="check"><input type="checkbox" name="wide" ${w.wide ? 'checked' : ''}> Destaque largo</label></div>
        <div class="actions"><button class="btn btn-ghost btn-small" data-mv="-1">Subir</button><button class="btn btn-ghost btn-small" data-mv="1">Descer</button><button class="btn btn-ghost btn-small" data-rmv>Remover</button></div></div>`).join('') || '<p class="muted">Nenhum trabalho. Adicione o primeiro.</p>'}</div>`;
      $('#add', el).onclick = () => { collect(); items.push({ id: '', title: 'Novo trabalho', tag: '', desc: '', image: '', video: '', wide: false }); draw(); };
      $('#save', el).onclick = (e) => run(e.target, async () => { collect(); items = (await post('admin/portfolio/save', { items })).items; toast('Portfólio salvo.'); draw(); });
      $$('.pitem', el).forEach((box) => {
        const i = +box.dataset.i;
        $$('[data-mv]', box).forEach((b) => b.onclick = () => { collect(); const j = i + +b.dataset.mv; if (j < 0 || j >= items.length) return; [items[i], items[j]] = [items[j], items[i]]; draw(); });
        $('[data-rmv]', box).onclick = () => { collect(); items.splice(i, 1); draw(); };
      });
    };
    const collect = () => { $$('.pitem', el).forEach((box) => { const w = items[+box.dataset.i]; ['title', 'tag', 'desc', 'image', 'video'].forEach((k) => { w[k] = $(`[name=${k}]`, box).value; }); w.wide = $('[name=wide]', box).checked; }); };
    draw();
  };

  /* ---------- Orçamentos e mensagens ---------- */
  tabs.mensagens = async (el, reload) => {
    const { messages } = await api('admin/messages');
    const SM = { novo: 'Novo', conversando: 'Em conversa', fechado: 'Fechado' };
    el.innerHTML = `${head('Orçamentos e mensagens')}${messages.length ? messages.map((m) => `<div class="panel ${m.status === 'fechado' ? 'dim' : ''}"><div class="adm-head"><h3>${esc(m.nome)} <span class="muted">· ${esc(m.tipo)}</span> <span class="st st-${m.status === 'novo' ? 'pendente' : m.status === 'fechado' ? 'cancelado' : 'pago'}">${SM[m.status] || 'Novo'}</span></h3><span class="muted">${dt(m.at)}</span></div>
      <div class="detail"><div><span class="muted">Prazo</span><b>${esc(m.prazo || 'A combinar')}</b></div><div><span class="muted">Orçamento</span><b>${esc(m.orcamento || 'A combinar')}</b></div><div><span class="muted">Contato</span><b>${esc(m.contato || m.email)}</b></div></div>
      <p class="desc">${esc(m.mensagem)}</p>${safeUrl(m.referencia) ? `<p><a href="${esc(m.referencia)}" target="_blank" rel="noopener">Referência enviada</a></p>` : ''}
      <div class="actions"><a class="btn btn-small" href="mailto:${esc(m.email)}?subject=${encodeURIComponent('Re: seu projeto')}">Responder ${esc(m.email)}</a><select data-ms="${esc(m.id)}" aria-label="Status">${Object.entries(SM).map(([k, v]) => `<option value="${k}" ${(m.status || 'novo') === k ? 'selected' : ''}>${v}</option>`).join('')}</select><button class="btn btn-ghost btn-small" data-rm="${esc(m.id)}">Apagar</button></div></div>`).join('') : empty('Nenhuma mensagem', 'Os pedidos de orçamento do portfólio aparecem aqui.')}`;
    $$('[data-ms]', el).forEach((s) => s.onchange = () => run(s, async () => { await post('admin/message/status', { id: s.dataset.ms, status: s.value }); toast('Status atualizado.'); reload(); }));
    $$('[data-rm]', el).forEach((b) => b.onclick = () => run(b, async () => { await post('admin/message/delete', { id: b.dataset.rm }); reload(); }));
  };

  /* ---------- Páginas (termos, reembolso, privacidade, FAQ) ---------- */
  tabs.paginas = async (el, reload) => {
    const { pages: p, defaults: d } = await api('admin/pages');
    const faq = (p.faq && p.faq.length ? p.faq : d.faq).map((x) => ({ q: x.q, a: x.a }));
    const area = (k, n) => `<div class="panel"><div class="adm-head"><h3>${n}</h3><button type="button" class="btn btn-ghost btn-small" data-def="${k}">Restaurar texto padrão</button></div><textarea name="${k}" rows="12" maxlength="20000">${esc(p[k] || d[k])}</textarea></div>`;
    el.innerHTML = `${head('Páginas')}<p class="notice">Os textos padrão são <b>modelos</b>: leia e ajuste para a sua realidade (e, se puder, peça a revisão de um advogado) antes de divulgar. Use <code>## Título</code> para subtítulos e <code>- item</code> para listas. <code>{{loja}}</code> e <code>{{contato}}</code> são preenchidos sozinhos.</p>
      <form id="pg" class="stack">${area('terms', 'Termos de uso')}${area('refund', 'Reembolso e garantia')}${area('privacy', 'Política de privacidade')}
        <div class="panel"><div class="adm-head"><h3>Perguntas frequentes</h3><button type="button" class="btn btn-ghost btn-small" id="addq">Adicionar pergunta</button></div><div id="faqs"></div></div><button class="btn">Salvar páginas</button></form>`;
    const box = $('#faqs', el);
    const drawFaq = () => { box.innerHTML = faq.map((x, i) => `<div class="faqrow"><label>Pergunta<input data-fq="${i}" value="${esc(x.q)}" maxlength="200"></label><label>Resposta<textarea data-fa="${i}" rows="3" maxlength="2000">${esc(x.a)}</textarea></label><button type="button" class="btn btn-ghost btn-small" data-fx="${i}">Remover</button></div>`).join(''); };
    const grab = () => { $$('[data-fq]', box).forEach((i) => { faq[+i.dataset.fq].q = i.value; }); $$('[data-fa]', box).forEach((i) => { faq[+i.dataset.fa].a = i.value; }); };
    drawFaq();
    box.onclick = (e) => { const x = e.target.closest('[data-fx]'); if (x) { grab(); faq.splice(+x.dataset.fx, 1); drawFaq(); } };
    $('#addq', el).onclick = () => { grab(); faq.push({ q: '', a: '' }); drawFaq(); };
    $$('[data-def]', el).forEach((b) => b.onclick = () => { $(`[name=${b.dataset.def}]`, el).value = d[b.dataset.def]; });
    $('#pg', el).onsubmit = (e) => { e.preventDefault(); grab(); run($('button:not(.btn-ghost)', e.target), async () => { const o = formObj(e.target); await post('admin/pages/save', { terms: o.terms, refund: o.refund, privacy: o.privacy, faq }); toast('Páginas salvas.'); }); };
  };

  /* ---------- Configurações ---------- */
  tabs.config = async (el) => {
    const { config: c } = await api('admin/settings');
    const ck = (v) => (v ? 'checked' : ''), ct = c.contacts || {}, nt = c.notify || {};
    const ev = [['paid', 'Pedido pago'], ['attention', 'Pedido que precisa de atenção (valor errado, reembolso)'], ['lowstock', 'Estoque baixo ou esgotado'], ['ticket', 'Novo ticket, reposição ou mensagem de cliente'], ['contact', 'Novo pedido de orçamento (portfólio)'], ['review', 'Nova avaliação'], ['neworder', 'Novo pedido criado (aguardando PIX)']];
    el.innerHTML = `${head('Configurações')}<form id="cfg" class="stack">
      <div class="panel"><h3>Loja</h3><label>Nome da loja<input name="storeName" value="${esc(c.storeName)}" maxlength="40"></label>
        ${SECS.map((s) => `<div class="grid2"><label>Nome da parte “${s}”<input name="n_${s}" value="${esc(c.sections[s].name)}" maxlength="30"></label><label>Frase de apoio<input name="t_${s}" value="${esc(c.sections[s].tagline)}" maxlength="160"></label></div>`).join('')}</div>
      <div class="panel"><h3>Contatos de suporte</h3><p class="fine">Aparecem no rodapé, no pedido e nas páginas de ajuda.</p><div class="grid2"><label>Link do Discord (convite)<input name="c_discord" value="${esc(ct.discord || '')}" placeholder="https://discord.gg/..."></label><label>WhatsApp (com DDD)<input name="c_whatsapp" value="${esc(ct.whatsapp || '')}" placeholder="+55 11 91234-5678"></label><label class="full">E-mail de suporte<input name="c_email" type="email" value="${esc(ct.email || '')}"></label></div></div>
      <div class="panel"><h3>Aviso no topo do site</h3><label class="check"><input type="checkbox" name="a_active" ${ck(c.announcement.active)}> Mostrar aviso</label><div class="grid2"><label>Cor<select name="a_tone">${[['info', 'Informação'], ['ok', 'Positivo'], ['warn', 'Alerta']].map(([k, v]) => `<option value="${k}" ${c.announcement.tone === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label><label>Texto<input name="a_text" value="${esc(c.announcement.text)}" maxlength="240"></label></div></div>
      <div class="panel"><h3>Pagamento por PIX (MisticPay)</h3><p class="fine">A cobrança e a confirmação são automáticas. A chave que recebe o dinheiro fica na sua conta da MisticPay.</p><label>Instruções mostradas ao cliente<textarea name="p_instructions" rows="3" maxlength="500">${esc(c.pix.instructions)}</textarea></label></div>
      <div class="panel"><h3>Avisos no Discord</h3><p class="fine">Crie um webhook no canal (Editar canal, Integrações, Webhooks) e cole o endereço aqui, ou defina <code>DISCORD_WEBHOOK_URL</code> no Vercel (a variável tem prioridade). Nenhum aviso marca @everyone.</p>
        <label>Endereço do webhook<input name="n_webhook" value="${esc(nt.webhook || '')}" placeholder="https://discord.com/api/webhooks/..." autocomplete="off"></label>
        <div class="checks">${ev.map(([k, n]) => `<label class="check"><input type="checkbox" name="nv_${k}" ${ck(nt[k])}> ${n}</label>`).join('')}</div><div class="actions"><button type="button" class="btn btn-ghost btn-small" id="dtest">Salvar e enviar teste</button></div></div>
      <div class="panel"><h3>Downloads de arquivos</h3><p class="fine">Vale para produtos entregues por link. 0 = sem limite. O endereço real do arquivo nunca aparece na página do cliente, mas quem baixa consegue ver o destino: para proteção total, hospede em armazenamento privado.</p><div class="grid2"><label>Prazo para baixar (dias)<input type="number" name="d_days" min="0" max="3650" value="${c.download.days}"></label><label>Máximo de downloads por pedido<input type="number" name="d_max" min="0" max="1000" value="${c.download.max}"></label></div></div>
      <div class="panel"><h3>Regras da loja</h3><div class="grid2"><label>Tempo de reserva do pedido (minutos)<input type="number" name="reserveMinutes" min="5" max="1440" value="${c.reserveMinutes}"></label><label>Avisar estoque baixo a partir de<input type="number" name="lowStock" min="0" value="${c.lowStock}"></label></div>
        <label class="check"><input type="checkbox" name="registrationOpen" ${ck(c.registrationOpen)}> Permitir novos cadastros</label><label class="check"><input type="checkbox" name="maintenance" ${ck(c.maintenance)}> Modo manutenção (fecha a loja para clientes; admins continuam comprando e testando)</label></div>
      <button class="btn">Salvar configurações</button></form>`;
    const collect = (f) => {
      const o = formObj(f), sections = {}, notify = { webhook: o.n_webhook };
      SECS.forEach((s) => { sections[s] = { name: o['n_' + s], tagline: o['t_' + s] }; });
      ev.forEach(([k]) => { notify[k] = o['nv_' + k]; });
      return { storeName: o.storeName, sections, announcement: { active: o.a_active, tone: o.a_tone, text: o.a_text }, pix: { instructions: o.p_instructions }, contacts: { discord: o.c_discord, whatsapp: o.c_whatsapp, email: o.c_email }, notify, download: { days: o.d_days, max: o.d_max }, reserveMinutes: o.reserveMinutes, lowStock: o.lowStock, registrationOpen: o.registrationOpen, maintenance: o.maintenance };
    };
    const f = $('#cfg', el);
    f.onsubmit = (e) => { e.preventDefault(); run($('button:not(.btn-ghost)', e.target), async () => { await post('admin/settings/save', collect(f)); await boot(); updateChrome('admin'); toast('Configurações salvas.'); }); };
    $('#dtest', el).onclick = (e) => run(e.target, async () => { await post('admin/settings/save', collect(f)); await post('admin/discord/test'); toast('Teste enviado. Confira o canal no Discord.'); });
  };

  /* ---------- Registros ---------- */
  tabs.logs = async (el) => {
    const { logs } = await api('admin/logs');
    el.innerHTML = `${head('Registro de ações', `<a class="btn btn-ghost btn-small" href="${apiUrl('admin/export/logs')}">Exportar CSV</a>`)}${logs.length ? `<div class="tablewrap"><table class="tbl"><thead><tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Detalhe</th></tr></thead><tbody>${logs.map((l) => `<tr><td>${dt(l.at)}</td><td>${esc(l.by)}</td><td>${esc(l.action)}</td><td>${esc(l.detail)}</td></tr>`).join('')}</tbody></table></div>` : empty('Sem registros', 'As ações feitas no painel aparecem aqui.')}`;
  };

  /* ---------- Backup ---------- */
  tabs.backup = async (el) => {
    el.innerHTML = `${head('Backup')}<p class="notice">Tudo da loja fica no banco Redis (pedidos, estoque, usuários, avaliações, tickets, configurações). Baixe um backup de vez em quando e guarde em lugar seguro. <b>O arquivo contém senhas criptografadas e chaves de 2FA: não compartilhe.</b></p>
      <div class="panel"><h3>Baixar backup</h3><form id="bk" class="stack"><label>Sua senha de admin<input type="password" name="password" autocomplete="current-password" required></label><button class="btn">Baixar backup (.json)</button></form><p class="fine">Se a loja ficar muito grande (arquivo acima de 4 MB), o Vercel pode recusar o download; nesse caso, use o painel do Upstash para exportar.</p></div>
      <div class="panel"><h3>Restaurar backup</h3><p class="fine">Recria as chaves que estão no arquivo (substitui o que existir com o mesmo nome). Não apaga o que não estiver no arquivo.</p><form id="rs" class="stack"><label>Arquivo de backup (.json)<input type="file" name="file" accept=".json,application/json" required></label><label>Sua senha de admin<input type="password" name="password" autocomplete="current-password" required></label><label>Digite RESTAURAR para confirmar<input name="confirm" autocomplete="off" required></label><button class="btn btn-danger">Restaurar</button></form></div>`;
    $('#bk', el).onsubmit = (e) => {
      e.preventDefault();
      run($('button', e.target), async () => {
        const res = await fetch('/api/store?r=admin/backup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'cd' }, body: JSON.stringify({ password: e.target.password.value }) });
        if (!res.ok) { let m = 'Não foi possível gerar o backup.'; try { m = (await res.json()).error || m; } catch (_) { /* resposta não era JSON */ } throw new Error(m); }
        downloadTxt(`backup-loja-${todayBR()}.json`, await res.text()); e.target.reset(); toast('Backup baixado.');
      });
    };
    $('#rs', el).onsubmit = (e) => {
      e.preventDefault();
      run($('button', e.target), async () => {
        const f = e.target; let data;
        try { data = JSON.parse(await readFile(f.file.files[0])); } catch (_) { throw new Error('Esse arquivo não é um backup válido.'); }
        const r = await post('admin/restore', { password: f.password.value, confirm: f.confirm.value, data });
        f.reset(); toast(`${pl(r.restored, 'item restaurado', 'itens restaurados')}.`);
      });
    };
  };

  render();
})();
