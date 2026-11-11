'use strict';
/* Caarldev — loja + portfólio (SPA sem framework). Rotas por hash: #/discord, #/roblox, #/admin... */
(function () {
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
  const S = { user: null, config: { sections: {}, contacts: {} }, cats: [], banned: null, loaded: false, cleanup: null };
  const secName = (s) => (S.config.sections[s] && S.config.sections[s].name) || s;
  const toCents = (v) => { v = String(v == null ? '' : v).trim(); if (!v) return 0; if (v.includes(',')) v = v.replace(/\./g, '').replace(',', '.'); const n = parseFloat(v.replace(/[^\d.]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : 0; };
  const pl = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const fromCents = (c) => (c ? (c / 100).toFixed(2).replace('.', ',') : '');

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
    S.user = b.user; S.config = b.config; S.cats = b.categories; S.banned = b.banned; S.loaded = true;
  }
  const hasOutros = () => S.cats.some((c) => c.section === 'outros');
  function updateChrome(name) {
    const secs = SECS.filter((s) => s !== 'outros' || hasOutros());
    const on = (n) => (name === n ? ' class="on" aria-current="page"' : '');
    $('#nav').innerHTML = secs.map((s) => `<a href="#/${s}"${on(s)}>${esc(secName(s))}</a>`).join('') + `<a href="#/portfolio"${on('portfolio')}>Portfólio</a>` +
      (S.user ? `${S.user.role === 'admin' ? `<a class="btn btn-small" href="#/admin">Painel</a>` : ''}<a href="#/conta"${on('conta')}>Minha conta</a><button class="linkbtn" data-act="logout">Sair</button>`
        : `<a href="#/entrar"${on('entrar')}>Entrar</a><a class="btn btn-small" href="#/cadastro">Criar conta</a>`);
    const a = S.config.announcement, bn = $('#banner');
    bn.hidden = !a; bn.className = a ? `banner ${esc(a.tone)}` : ''; bn.textContent = a ? a.text : '';
    const c = S.config.contacts || {}, wa = String(c.whatsapp || '').replace(/\D/g, '');
    $('#footer').innerHTML = `<p>© ${new Date().getFullYear()} ${esc(S.config.storeName || 'Caarldev')}. Todos os direitos reservados.</p><div class="foot-links">${safeUrl(c.discord) ? `<a href="${esc(c.discord)}" target="_blank" rel="noopener">Discord</a>` : ''}${wa ? `<a href="https://wa.me/${wa}" target="_blank" rel="noopener">WhatsApp</a>` : ''}${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}</div>`;
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
    if (act === 'logout') { await run(el, async () => { await post('logout'); S.user = null; location.hash = '#/'; render(); toast('Você saiu da conta.'); }); }
    if (act === 'copy') copy(el.dataset.copy);
  });

  /* ---------- Componentes ---------- */
  const priceHtml = (p) => `<span class="price">${brl(p.price)}</span>${p.compareAt ? `<s class="was">${brl(p.compareAt)}</s>` : ''}`;
  const soldOut = (p) => !p.stock.unlimited && p.stock.count === 0;
  const stockLabel = (p) => (soldOut(p) ? 'Esgotado' : p.stock.unlimited ? 'Disponível' : p.stock.count <= 5 ? `Restam ${p.stock.count}` : 'Em estoque');
  const card = (p) => `<a class="pcard${soldOut(p) ? ' out' : ''}" href="#/produto/${esc(p.id)}" style="--sec:${SEC_COLOR[p.section] || SEC_COLOR.outros}">
    <div class="pimg">${p.image ? `<img src="${esc(safeUrl(p.image))}" alt="" loading="lazy">` : `<span>${esc(p.categoryName)}</span>`}${p.featured ? '<b class="tag">Destaque</b>' : ''}</div>
    <div class="pbody"><h3>${esc(p.name)}</h3>${p.short ? `<p class="pshort">${esc(p.short)}</p>` : ''}<div class="pfoot"><div>${priceHtml(p)}</div><span class="stock">${esc(stockLabel(p))}</span></div></div></a>`;
  const empty = (title, text, cta) => `<div class="empty"><h3>${esc(title)}</h3><p>${esc(text)}</p>${cta || ''}</div>`;

  /* ---------- Início ---------- */
  views.home = async () => {
    const { products, maintenance } = await api('products');
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
          ${list.length ? `<div class="pgrid">${list.map(card).join('')}</div>` : empty('Nenhum produto ainda', 'Os produtos aparecem aqui assim que forem cadastrados.', S.user && S.user.role === 'admin' ? '<a class="btn" href="#/admin/produtos">Cadastrar produto</a>' : '')}</section>
        <section class="section"><h2>Como comprar</h2><ol class="steps">
          <li><strong>Escolha</strong><span>Abra o produto, defina a quantidade e aplique um cupom, se tiver.</span></li>
          <li><strong>Pague no PIX</strong><span>O pedido reserva o estoque e gera o QR Code na hora. Pague e pronto: a confirmação é automática.</span></li>
          <li><strong>Receba</strong><span>Assim que o pagamento cai, itens e links aparecem no pedido e em Minha conta.</span></li></ol></section>`,
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
  views.produto = async ([id]) => {
    const p = (await api('products', { query: { id: id || '-' } })).products[0];
    if (!p) return { title: 'Produto', html: `<div class="page narrow">${empty('Produto não encontrado', 'Ele pode ter sido removido ou estar indisponível.', `<a class="btn" href="#/">Voltar ao início</a>`)}</div>` };
    const out = soldOut(p), max = Math.max(1, Math.min(p.maxPerOrder, p.stock.unlimited ? 99 : p.stock.count));
    const delivery = p.delivery === 'manual' ? 'Entrega combinada com você depois da confirmação do pagamento.' : 'Liberado na sua conta assim que o pagamento for confirmado.';
    const off = p.compareAt ? Math.round((1 - p.price / p.compareAt) * 100) : 0;
    return {
      title: p.name, html: `<div class="page"><nav class="crumbs"><a href="#/${esc(p.section)}">${esc(secName(p.section))}</a><span>${esc(p.categoryName)}</span></nav>
        <div class="pdetail" style="--sec:${SEC_COLOR[p.section] || SEC_COLOR.outros}">
          <div class="pgallery">${p.image ? `<img src="${esc(safeUrl(p.image))}" alt="${esc(p.name)}">` : `<div class="pimg ph"><span>${esc(p.categoryName)}</span></div>`}</div>
          <div class="pinfo"><h1>${esc(p.name)}</h1><div class="pprice">${priceHtml(p)}${off > 0 ? `<b class="off">-${off}%</b>` : ''}</div>
            ${p.short ? `<p class="lead">${esc(p.short)}</p>` : ''}
            <p class="stock-line ${out ? 'bad' : ''}">${esc(stockLabel(p))}${p.sold ? ` · ${p.sold} vendido${p.sold > 1 ? 's' : ''}` : ''}</p>
            <form id="buy" class="buy">
              <label>Quantidade<input type="number" name="qty" min="1" max="${max}" value="1" ${out ? 'disabled' : ''}></label>
              <label>Cupom<span class="inline"><input name="coupon" placeholder="Opcional" autocomplete="off" ${out ? 'disabled' : ''}><button type="button" class="btn btn-ghost btn-small" id="aplicar" ${out ? 'disabled' : ''}>Aplicar</button></span></label>
              <label class="full">${p.delivery === 'manual' ? 'Seu usuário no Discord ou WhatsApp' : 'Contato (opcional)'}<input name="contact" maxlength="80" ${p.delivery === 'manual' ? 'required' : ''} placeholder="${p.delivery === 'manual' ? 'Para combinarmos a entrega' : 'Discord ou WhatsApp'}" ${out ? 'disabled' : ''}></label>
              <label class="full">CPF de quem vai pagar<input name="cpf" inputmode="numeric" autocomplete="off" maxlength="14" placeholder="000.000.000-00" ${p.price > 0 ? 'required' : ''} ${out ? 'disabled' : ''}></label>
              <div class="total full"><span>Total</span><strong id="total">${brl(p.price)}</strong></div>
              <button class="btn full" ${out ? 'disabled' : ''}>${out ? 'Esgotado' : 'Comprar agora'}</button>
              <p class="fine full">${esc(delivery)} Pagamento por PIX com confirmação automática. O CPF é exigido pelo PIX e usado só para gerar a cobrança; não fica guardado.</p>
            </form></div></div>
        ${p.description ? `<section class="section"><h2>Sobre este produto</h2><p class="desc">${esc(p.description)}</p></section>` : ''}</div>`,
      mount(el) {
        const f = $('#buy', el); let discount = 0;
        const qty = () => Math.max(1, Math.min(max, parseInt(f.qty.value, 10) || 1));
        const total = () => { $('#total', el).textContent = brl(Math.max(0, p.price * qty() - discount)); };
        f.qty.addEventListener('input', () => { discount = 0; total(); });
        f.cpf.addEventListener('input', () => { const d = f.cpf.value.replace(/\D/g, '').slice(0, 11); f.cpf.value = d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2'); });
        $('#aplicar', el).onclick = (e) => {
          if (!S.user) { toast('Entre na sua conta para aplicar um cupom.', 'err'); return; }
          run(e.target, async () => { const r = await post('coupon/check', { productId: p.id, qty: qty(), coupon: f.coupon.value }); discount = r.discount; total(); toast(r.discount ? `Cupom aplicado: -${brl(r.discount)}` : 'Digite um cupom.'); });
        };
        f.onsubmit = (e) => {
          e.preventDefault();
          if (!S.user) { location.hash = `#/entrar?next=${encodeURIComponent('#/produto/' + p.id)}`; return; }
          run($('.btn:not(.btn-ghost)', f), async () => { const r = await post('order', { productId: p.id, qty: qty(), coupon: f.coupon.value, contact: f.contact.value, cpf: f.cpf.value }); location.hash = `#/pedido/${r.order.id}`; });
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
          ${reg ? '<p class="fine">Use pelo menos 8 caracteres.</p>' : ''}
          <button class="btn" ${closed ? 'disabled' : ''}>${reg ? 'Criar conta' : 'Entrar'}</button></form>
        <p class="fine">${reg ? `Já tem conta? <a href="#/entrar${next}">Entrar</a>` : `Ainda não tem conta? <a href="#/cadastro${next}">Criar conta</a>`}</p></div></div>`,
      mount(el) {
        $('#auth', el).onsubmit = (e) => {
          e.preventDefault();
          run($('button', e.target), async () => {
            const r = await post(reg ? 'register' : 'login', formObj(e.target));
            S.user = r.user; S.banned = null;
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
  views.conta = async () => {
    if (!S.user) return needLogin();
    const { orders } = await api('orders');
    const rows = orders.map((o) => `<a class="orow" href="#/pedido/${esc(o.id)}"><div><strong>${esc(o.lines[0].name)}${o.lines[0].qty > 1 ? ` × ${o.lines[0].qty}` : ''}</strong><span class="muted">${esc(o.code)} · ${dt(o.createdAt)}</span></div><div class="orow-r"><b>${brl(o.total)}</b>${badge(o.status)}</div></a>`).join('');
    return {
      title: 'Minha conta', html: `<div class="page"><header class="page-head"><h1>Olá, ${esc(S.user.name.split(' ')[0])}</h1><p class="lead">${esc(S.user.email)}</p></header>
        <div class="cols"><section class="section"><h2>Meus pedidos</h2>${orders.length ? `<div class="olist">${rows}</div>` : empty('Nenhum pedido ainda', 'Quando você comprar, o pedido e a entrega aparecem aqui.', '<a class="btn" href="#/">Ver produtos</a>')}</section>
        <section class="section"><h2>Dados da conta</h2><form id="perfil" class="stack"><label>Nome<input name="name" value="${esc(S.user.name)}" required maxlength="60"></label><button class="btn btn-ghost">Salvar nome</button></form>
          <h3 class="mt">Trocar senha</h3><form id="senha" class="stack"><label>Senha atual<input type="password" name="currentPassword" autocomplete="current-password" required></label><label>Nova senha<input type="password" name="newPassword" autocomplete="new-password" minlength="8" required></label><button class="btn btn-ghost">Trocar senha</button></form></section></div></div>`,
      mount(el) {
        $('#perfil', el).onsubmit = (e) => { e.preventDefault(); run($('button', e.target), async () => { S.user = (await post('account', { name: e.target.name.value })).user; updateChrome('conta'); toast('Nome atualizado.'); }); };
        $('#senha', el).onsubmit = (e) => { e.preventDefault(); run($('button', e.target), async () => { await post('account', formObj(e.target)); e.target.reset(); toast('Senha alterada.'); }); };
      },
    };
  };

  /* ---------- Pedido: pagamento e entrega ---------- */
  const supportLinks = () => {
    const c = S.config.contacts || {}, wa = String(c.whatsapp || '').replace(/\D/g, '');
    const l = [safeUrl(c.discord) && `<a href="${esc(c.discord)}" target="_blank" rel="noopener">Discord</a>`, wa && `<a href="https://wa.me/${wa}" target="_blank" rel="noopener">WhatsApp</a>`, c.email && `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`].filter(Boolean);
    return l.length ? `<p class="fine">Precisa de ajuda? Fale com o suporte: ${l.join(' · ')}</p>` : '';
  };
  const deliveryHtml = (d) => {
    if (!d) return '';
    if (d.type === 'items') return `<ul class="items">${d.items.map((i) => `<li><code>${esc(i)}</code><button class="btn btn-ghost btn-small" data-act="copy" data-copy="${esc(i)}">Copiar</button></li>`).join('')}</ul><button class="btn btn-ghost btn-small" data-act="copy" data-copy="${esc(d.items.join('\n'))}">Copiar tudo</button>`;
    if (d.type === 'link') return safeUrl(d.url) ? `<a class="btn" href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">Baixar ou abrir</a>` : '<p class="muted">O link ainda não foi informado. Fale com o suporte.</p>';
    return `<pre class="delivery-text">${esc(d.text)}</pre>`;
  };
  views.pedido = async ([id]) => {
    if (!S.user) return needLogin();
    const o = (await api('order', { query: { id: id || '-' } })).order, l = o.lines[0], open = o.status === 'pendente' || o.status === 'aguardando';
    const pay = o.payment;
    const cancelBtn = '<button class="btn btn-ghost" id="cancelar">Cancelar pedido</button>';
    const payHtml = !open ? '' : pay ? `<section class="section pay"><h2>Pagamento por PIX</h2>
      <div class="pay-grid"><div><span class="muted">Valor exato</span><strong class="big">${brl(o.total)}</strong></div>${pay.qr ? `<div><img class="qr" src="${esc(pay.qr)}" alt="QR Code do PIX" width="220" height="220"></div>` : ''}</div>
      <div><span class="muted">PIX Copia e Cola</span><code class="key pixcode">${esc(pay.copyPaste)}</code></div>
      <div class="actions"><button class="btn" data-act="copy" data-copy="${esc(pay.copyPaste)}">Copiar código PIX</button>${cancelBtn}</div>
      <p>${esc(pay.instructions)}</p>
      <p class="fine">Aguardando o pagamento. Esta página confirma sozinha, não precisa avisar. Estoque reservado até ${dt(o.expiresAt)}; depois disso o pedido expira.</p></section>`
      : `<section class="section pay"><h2>Pagamento</h2><p>${o.status === 'aguardando' ? 'Recebemos o seu aviso. Estamos conferindo o pagamento e você será liberado em seguida.' : 'Este pedido foi criado antes do pagamento automático e não tem PIX. Cancele e faça um novo pedido.'}</p><div class="actions">${cancelBtn}</div></section>`;
    const msg = { pago: 'Pagamento confirmado. A entrega será feita por contato direto; fique de olho no Discord ou WhatsApp que você informou.', expirado: 'Este pedido expirou e o estoque foi liberado. Você pode fazer um novo pedido.', cancelado: 'Pedido cancelado.', reembolsado: 'Pedido reembolsado.' }[o.status];
    return {
      title: `Pedido ${o.code}`, html: `<div class="page narrow"><nav class="crumbs"><a href="#/conta">Minha conta</a><span>${esc(o.code)}</span></nav>
        <header class="page-head"><h1>Pedido ${esc(o.code)}</h1>${badge(o.status)}</header>
        <section class="section"><div class="sum"><div><strong>${esc(l.name)}</strong><span class="muted">${esc(l.catName)} · ${l.qty} un.</span></div><b>${brl(o.subtotal)}</b></div>
          ${o.discount ? `<div class="sum"><span>Cupom ${esc(o.coupon)}</span><b>-${brl(o.discount)}</b></div>` : ''}<div class="sum total"><span>Total</span><b>${brl(o.total)}</b></div><p class="fine">Criado em ${dt(o.createdAt)}</p></section>
        ${payHtml}${o.status === 'entregue' ? `<section class="section"><h2>Sua entrega</h2>${deliveryHtml(o.delivery)}</section>` : ''}
        ${msg ? `<section class="section"><p>${esc(msg)}</p></section>` : ''}${supportLinks()}</div>`,
      mount(el) {
        if (open && pay) { const t = setInterval(async () => { try { const n = (await api('order', { query: { id: o.id } })).order; if (n.status !== o.status) { if (n.status === 'pago' || n.status === 'entregue') toast('Pagamento confirmado!'); render(); } } catch (_) { /* tenta de novo */ } }, 5000); S.cleanup = () => clearInterval(t); }
        const cn = $('#cancelar', el);
        if (cn) cn.onclick = async () => { if (await confirmBox('Cancelar pedido?', 'O estoque reservado volta para a loja.', { danger: true, ok: 'Cancelar pedido' })) run(cn, async () => { await post('order/cancel', { id: o.id }); toast('Pedido cancelado.'); render(); }); };
      },
    };
  };

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
        <section class="section contact" id="contato"><h2>Vamos criar algo juntos</h2><p class="lead">Conte um pouco sobre o seu projeto. Respondo por e-mail o mais rápido possível.</p><a class="mail" href="mailto:${esc(mail)}">${esc(mail)}</a>
          <form id="form" class="form"><label>Seu nome<input name="nome" autocomplete="name" required maxlength="80"></label><label>Seu e-mail<input name="email" type="email" autocomplete="email" required></label>
          <label>Tipo de projeto<select name="tipo"><option>Animação</option><option>Modelo 3D</option><option>Efeitos 3D</option><option>Cutscene</option><option>Outro</option></select></label>
          <label class="full">Mensagem<textarea name="mensagem" rows="5" required minlength="5" maxlength="3000"></textarea></label><button class="btn" type="submit">Enviar mensagem</button></form></section>`,
      mount(el) {
        $$('[data-scroll]', el).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); const t = document.getElementById(a.dataset.scroll); if (t) t.scrollIntoView({ behavior: 'smooth' }); }));
        $('#form', el).onsubmit = (e) => { e.preventDefault(); run($('button', e.target), async () => { await post('contact', formObj(e.target)); e.target.reset(); toast('Mensagem enviada. Respondo em breve.'); }); };
      },
    };
  };

  views.notfound = async () => ({ title: 'Página não encontrada', html: `<div class="page narrow">${empty('Página não encontrada', 'O endereço não existe ou mudou de lugar.', '<a class="btn" href="#/">Voltar ao início</a>')}</div>` });

  /* ====================================================================
     PAINEL ADMIN (#/admin/<aba>)
     ==================================================================== */
  const TABS = [['geral', 'Visão geral'], ['pedidos', 'Pedidos'], ['produtos', 'Produtos'], ['estoque', 'Estoque'], ['categorias', 'Categorias'], ['usuarios', 'Usuários'], ['cupons', 'Cupons'], ['portfolio', 'Portfólio'], ['mensagens', 'Mensagens'], ['config', 'Configurações'], ['logs', 'Registros']];
  const tabs = {};
  const head = (t, actions) => `<div class="adm-head"><h2>${esc(t)}</h2><div class="adm-actions">${actions || ''}</div></div>`;
  const kpi = (label, value, sub) => `<div class="kpi"><span>${esc(label)}</span><strong>${value}</strong>${sub ? `<em>${sub}</em>` : ''}</div>`;
  const lowAt = 3;

  views.admin = async ([tab = 'geral']) => {
    if (!S.user) return needLogin();
    if (S.user.role !== 'admin') return { title: 'Acesso restrito', html: `<div class="page narrow">${empty('Acesso restrito', 'Esta área é só para administradores.', '<a class="btn" href="#/">Voltar</a>')}</div>` };
    if (!tabs[tab]) tab = 'geral';
    return {
      title: 'Painel', html: `<div class="admin"><aside class="admin-nav" aria-label="Painel"><strong>Painel</strong>${TABS.map(([id, n]) => `<a href="#/admin/${id}" class="${id === tab ? 'on' : ''}">${n}</a>`).join('')}</aside><section class="admin-main" id="adm"></section></div>`,
      mount(el) {
        const body = $('#adm', el);
        const load = () => tabs[tab](body, load).catch((e) => { body.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; });
        body.innerHTML = '<p class="muted">Carregando…</p>'; load();
      },
    };
  };

  /* ---------- Visão geral ---------- */
  function chart(series) {
    const W = 720, H = 200, pad = 8, max = Math.max(1, ...series.map((s) => s.revenue)), bw = (W - pad * 2) / series.length;
    const bars = series.map((s, i) => { const h = Math.round((s.revenue / max) * (H - 44)); return `<g><title>${s.date.split('-').reverse().slice(0, 2).join('/')}: ${brl(s.revenue)} em ${s.orders} pedido(s)</title><rect class="bar" x="${(pad + i * bw + 2).toFixed(1)}" y="${H - 24 - Math.max(h, 1)}" width="${(bw - 4).toFixed(1)}" height="${Math.max(h, 1)}" rx="2"/></g>`; }).join('');
    const labels = series.map((s, i) => (i % 5 === 0 ? `<text x="${(pad + i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${s.date.slice(8)}/${s.date.slice(5, 7)}</text>` : '')).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Receita dos últimos 30 dias">${bars}${labels}</svg>`;
  }
  tabs.geral = async (el, reload) => {
    const [st, sx] = await Promise.all([api('admin/stats'), api('admin/status')]);
    const t = st.totals, warn = [];
    if (!sx.session) warn.push('A variável <b>SESSION_SECRET</b> não está configurada no Vercel. Sem ela ninguém consegue entrar.');
    if (!sx.adminEmails) warn.push('A variável <b>ADMIN_EMAIL</b> não está configurada. Defina o seu e-mail no Vercel e crie a conta com ele para virar admin.');
    if (!sx.misticpay) warn.push('Os pagamentos PIX não estão ligados: configure <b>MISTICPAY_CLIENT_ID</b> e <b>MISTICPAY_CLIENT_SECRET</b> no Vercel (chave de acesso da MisticPay) e faça o redeploy.');
    const secs = SECS.map((s) => { const v = st.bySection[s] || { revenue: 0, orders: 0 }; return `<li><span>${esc(secName(s))}</span><b>${brl(v.revenue)}</b><em>${v.orders} pedido(s)</em></li>`; }).join('');
    const stat = Object.keys(STATUS).map((k) => `<li><span>${badge(k)}</span><b>${st.byStatus[k] || 0}</b></li>`).join('');
    const top = st.topProducts.length ? st.topProducts.map((p) => `<li><span>${esc(p.name)}</span><b>${brl(p.revenue)}</b><em>${p.qty} un.</em></li>`).join('') : '<li class="muted">Sem vendas ainda.</li>';
    const low = st.lowStock.length ? st.lowStock.map((p) => `<li><span>${esc(p.name)}</span><b class="${p.count === 0 ? 'bad' : ''}">${p.count === 0 ? 'Esgotado' : p.count + ' restante(s)'}</b></li>`).join('') : '<li class="muted">Estoque em dia.</li>';
    el.innerHTML = `${head('Visão geral', '<button class="btn btn-ghost btn-small" id="rl">Atualizar</button>')}
      ${warn.map((w) => `<p class="notice bad">${w}</p>`).join('')}
      <div class="kpis">${kpi('Receita total', brl(t.revenue), pl(t.paidOrders, 'pedido pago', 'pedidos pagos'))}${kpi('Hoje', brl(st.periods.today.revenue), `${st.periods.today.orders} pedido(s)`)}${kpi('Últimos 7 dias', brl(st.periods.d7.revenue), `${st.periods.d7.orders} pedido(s)`)}${kpi('Últimos 30 dias', brl(st.periods.d30.revenue), `${st.periods.d30.orders} pedido(s)`)}${kpi('Ticket médio', brl(t.avgTicket))}${kpi('Aguardando pagamento', st.byStatus.pendente || 0, st.byStatus.aguardando ? `${st.byStatus.aguardando} em conferência manual` : 'PIX automático')}${kpi('Usuários', t.users, `${pl(t.newUsers30, 'novo', 'novos')} em 30 dias · ${pl(t.banned, 'banido', 'banidos')}`)}${kpi('Produtos ativos', t.activeProducts, `${t.products} no total`)}</div>
      <div class="panel"><h3>Receita dos últimos 30 dias</h3>${chart(st.series)}</div>
      <div class="cols3"><div class="panel"><h3>Por parte do site</h3><ul class="rows">${secs}</ul></div><div class="panel"><h3>Mais vendidos</h3><ul class="rows">${top}</ul></div><div class="panel"><h3>Status dos pedidos</h3><ul class="rows">${stat}</ul></div></div>
      <div class="cols"><div class="panel"><h3>Precisa de atenção</h3>${st.needsAction.length ? st.needsAction.map((o) => `<div class="orow static"><div><strong>${esc(o.lines[0].name)}</strong><span class="muted">${esc(o.code)} · ${esc(o.userName)} · ${dt(o.createdAt)}</span></div><div class="orow-r"><b>${brl(o.total)}</b>${badge(o.status)}<button class="btn btn-small" data-open="${esc(o.id)}">Abrir</button></div></div>`).join('') : '<p class="muted">Nada pendente agora.</p>'}</div>
        <div class="panel"><h3>Estoque baixo</h3><ul class="rows">${low}</ul><a class="btn btn-ghost btn-small" href="#/admin/estoque">Gerenciar estoque</a></div></div>`;
    $('#rl', el).onclick = reload;
    $$('[data-open]', el).forEach((b) => b.onclick = () => orderModal(st.needsAction.find((o) => o.id === b.dataset.open), reload));
  };

  /* ---------- Pedidos ---------- */
  function orderModal(o, after) {
    const l = o.lines[0], open = o.status === 'pendente' || o.status === 'aguardando', paid = o.status === 'pago' || o.status === 'entregue';
    const d = o.delivery, canDeliver = paid && (!d || d.type === 'manual');
    const dv = !d ? '<span class="muted">Ainda não entregue</span>' : d.type === 'items' ? `<ul class="items">${d.items.map((i) => `<li><code>${esc(i)}</code></li>`).join('')}</ul>` : d.type === 'link' ? `<code>${esc(d.url)}</code>` : `<pre class="delivery-text">${esc(d.text)}</pre>`;
    const m = openModal(`<h3>Pedido ${esc(o.code)} ${badge(o.status)}</h3>
      <div class="detail"><div><span class="muted">Cliente</span><b>${esc(o.userName)}</b><span>${esc(o.userEmail)}</span>${o.contact ? `<span>Contato: ${esc(o.contact)}</span>` : ''}</div>
      <div><span class="muted">Produto</span><b>${esc(l.name)}</b><span>${esc(l.catName)} · ${l.qty} un.</span></div>
      <div><span class="muted">Total</span><b>${brl(o.total)}</b><span>${o.discount ? `Cupom ${esc(o.coupon)}: -${brl(o.discount)}` : 'Sem cupom'}</span></div>
      <div><span class="muted">Datas</span><span>Criado: ${dt(o.createdAt)}</span><span>Pago: ${dt(o.paidAt)}</span><span>Entregue: ${dt(o.deliveredAt)}</span></div></div>
      ${o.payIssue ? `<p class="notice bad">${esc(o.payIssue)}</p>` : ''}${o.payRef ? `<p class="fine">MisticPay: transação ${esc(o.payRef)}</p>` : ''}
      ${o.note ? `<p><span class="muted">Observação do cliente:</span> ${esc(o.note)}</p>` : ''}${o.claimNote ? `<p><span class="muted">Aviso de pagamento:</span> ${esc(o.claimNote)}</p>` : ''}
      <h4>Entrega</h4>${dv}
      ${canDeliver ? `<label>Registrar entrega manual<textarea id="dtext" rows="3" placeholder="O que o cliente deve receber (dados, instruções...)">${d && d.text ? esc(d.text) : ''}</textarea></label><button class="btn btn-small" data-oa="deliver">Salvar entrega</button>` : ''}
      <label>Nota interna<textarea id="ntext" rows="2">${esc(o.adminNote || '')}</textarea></label><button class="btn btn-ghost btn-small" data-oa="note">Salvar nota</button>
      <h4>Histórico</h4><ul class="hist">${(o.history || []).slice().reverse().map((h) => `<li><span>${dt(h.at)}</span>${esc(h.what)} <em>${esc(h.by)}</em></li>`).join('')}</ul>
      <div class="modal-actions">${open || o.status === 'expirado' ? '<button class="btn" data-oa="pay">Confirmar pagamento</button>' : ''}${open ? '<button class="btn btn-ghost" data-oa="cancel">Cancelar pedido</button>' : ''}${paid ? '<label class="check"><input type="checkbox" id="restock"> Devolver ao estoque</label><button class="btn btn-danger" data-oa="refund">Reembolsar</button>' : ''}<button class="btn btn-ghost" data-close>Fechar</button></div>`, { wide: true });
    $$('[data-oa]', m.el).forEach((b) => b.onclick = () => run(b, async () => {
      const a = b.dataset.oa; let extra = {};
      if (a === 'cancel' && !(await confirmBox('Cancelar pedido?', 'O estoque reservado volta para a loja.', { danger: true, ok: 'Cancelar pedido' }))) return;
      if (a === 'refund') { if (!(await confirmBox('Reembolsar pedido?', 'O status muda para reembolsado. O dinheiro você devolve por fora, pelo PIX.', { danger: true, ok: 'Reembolsar' }))) return; extra = { restock: $('#restock', m.el).checked }; }
      if (a === 'deliver') extra = { text: $('#dtext', m.el).value };
      if (a === 'note') extra = { text: $('#ntext', m.el).value };
      await post('admin/order', { id: o.id, action: a, ...extra });
      toast('Pedido atualizado.'); m.close(); after();
    }));
  }
  tabs.pedidos = async (el, reload) => {
    const st = tabs.pedidos.filter || (tabs.pedidos.filter = { status: '', q: '' });
    const { orders } = await api('admin/orders', { query: st });
    el.innerHTML = `${head('Pedidos', '<a class="btn btn-ghost btn-small" href="/api/store?r=admin/export">Exportar CSV</a>')}
      <form id="flt" class="toolbar"><select name="status"><option value="">Todos os status</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${st.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select><input type="search" name="q" value="${esc(st.q)}" placeholder="Código, cliente, e-mail ou produto"><button class="btn btn-small">Filtrar</button></form>
      ${orders.length ? `<div class="tablewrap"><table class="tbl"><thead><tr><th>Pedido</th><th>Data</th><th>Cliente</th><th>Produto</th><th>Total</th><th>Status</th><th></th></tr></thead><tbody>${orders.map((o) => `<tr><td><b>${esc(o.code)}</b></td><td>${dt(o.createdAt)}</td><td>${esc(o.userName)}<br><span class="muted">${esc(o.userEmail)}</span></td><td>${esc(o.lines[0].name)} × ${o.lines[0].qty}</td><td>${brl(o.total)}</td><td>${badge(o.status)}</td><td><button class="btn btn-small" data-open="${esc(o.id)}">Abrir</button></td></tr>`).join('')}</tbody></table></div>` : empty('Nenhum pedido', 'Quando alguém comprar, o pedido aparece aqui.')}`;
    $('#flt', el).onsubmit = (e) => { e.preventDefault(); st.status = e.target.status.value; st.q = e.target.q.value; reload(); };
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
      ${products.length ? `<div class="tablewrap"><table class="tbl"><thead><tr><th>Produto</th><th>Categoria</th><th>Preço</th><th>Estoque</th><th>Vendidos</th><th>Visível</th><th>Destaque</th><th></th></tr></thead><tbody>${products.map((p) => `<tr class="${p.active ? '' : 'dim'}"><td><b>${esc(p.name)}</b></td><td>${esc(secName(p.section))} · ${esc(p.categoryName)}</td><td>${brl(p.price)}</td><td class="${!p.stock.unlimited && p.stock.count <= lowAt ? 'bad' : ''}">${p.stock.unlimited ? 'Ilimitado' : p.stock.count}</td><td>${p.sold}</td>
        <td><button class="sw ${p.active ? 'on' : ''}" data-tog="active" data-id="${esc(p.id)}" aria-label="Alternar visibilidade" aria-pressed="${p.active}"></button></td><td><button class="sw ${p.featured ? 'on' : ''}" data-tog="featured" data-id="${esc(p.id)}" aria-label="Alternar destaque" aria-pressed="${p.featured}"></button></td>
        <td class="nowrap"><button class="btn btn-ghost btn-small" data-edit="${esc(p.id)}">Editar</button> <button class="btn btn-ghost btn-small" data-del="${esc(p.id)}">Apagar</button></td></tr>`).join('')}</tbody></table></div>` : empty('Nenhum produto', 'Cadastre o primeiro produto para ele aparecer na loja.')}`;
    $('#novo', el).onclick = () => productForm(null, categories, reload);
    $$('[data-edit]', el).forEach((b) => b.onclick = () => productForm(products.find((p) => p.id === b.dataset.edit), categories, reload));
    $$('[data-tog]', el).forEach((b) => b.onclick = () => run(b, async () => { await post('admin/product/toggle', { id: b.dataset.id, field: b.dataset.tog }); reload(); }));
    $$('[data-del]', el).forEach((b) => b.onclick = async () => { if (await confirmBox('Apagar produto?', 'O produto e o estoque dele serão removidos. Os pedidos antigos continuam no histórico.', { danger: true, ok: 'Apagar' })) run(b, async () => { await post('admin/product/delete', { id: b.dataset.del }); toast('Produto apagado.'); reload(); }); });
  };

  /* ---------- Estoque ---------- */
  async function stockModal(p, after) {
    const s = await api('admin/stock', { query: { id: p.id } });
    let body;
    if (s.delivery === 'items') {
      body = `<label>Adicionar itens (uma linha por unidade)<textarea id="lines" rows="5" placeholder="usuario:senha&#10;usuario2:senha2"></textarea></label><button class="btn btn-small" data-sa="add">Adicionar ao estoque</button>
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
  tabs.usuarios = async (el, reload) => {
    const st = tabs.usuarios.q || '';
    const { users } = await api('admin/users', { query: { q: st } });
    el.innerHTML = `${head('Usuários')}<form id="flt" class="toolbar"><input type="search" name="q" value="${esc(st)}" placeholder="Buscar por nome ou e-mail"><button class="btn btn-small">Buscar</button></form>
      <div class="tablewrap"><table class="tbl"><thead><tr><th>Usuário</th><th>Cargo</th><th>Pedidos</th><th>Cadastro</th><th>Último acesso</th><th></th></tr></thead><tbody>${users.map((u) => `<tr class="${u.banned ? 'dim' : ''}"><td><b>${esc(u.name)}</b> ${u.banned ? '<span class="st st-cancelado">Banido</span>' : ''}<br><span class="muted">${esc(u.email)}</span>${u.banned && u.banReason ? `<br><span class="muted">Motivo: ${esc(u.banReason)}</span>` : ''}</td><td>${u.role === 'admin' ? 'Admin' : 'Cliente'}</td><td>${u.orders}</td><td>${dt(u.createdAt)}</td><td>${dt(u.lastLogin)}</td>
        <td class="nowrap">${u.banned ? `<button class="btn btn-small" data-ua="unban" data-id="${esc(u.id)}">Desbanir</button>` : `<button class="btn btn-ghost btn-small" data-ua="ban" data-id="${esc(u.id)}">Banir</button>`} <button class="btn btn-ghost btn-small" data-ua="${u.role === 'admin' ? 'demote' : 'promote'}" data-id="${esc(u.id)}">${u.role === 'admin' ? 'Tirar admin' : 'Tornar admin'}</button> <button class="btn btn-ghost btn-small" data-ua="resetpw" data-id="${esc(u.id)}">Nova senha</button> <button class="btn btn-ghost btn-small" data-ua="delete" data-id="${esc(u.id)}">Apagar</button></td></tr>`).join('')}</tbody></table></div>`;
    $('#flt', el).onsubmit = (e) => { e.preventDefault(); tabs.usuarios.q = e.target.q.value; reload(); };
    $$('[data-ua]', el).forEach((b) => b.onclick = async () => {
      const a = b.dataset.ua, id = b.dataset.id; let extra = {};
      if (a === 'ban') { const r = await promptBox('Banir usuário', 'Motivo (o usuário verá essa mensagem)', { ok: 'Banir', danger: true, placeholder: 'Ex.: chargeback, abuso, fraude' }); if (r === null) return; extra = { reason: r }; }
      if (a === 'delete' && !(await confirmBox('Apagar conta?', 'A conta some para sempre. Os pedidos continuam no histórico. Para impedir que a pessoa volte, prefira banir.', { danger: true, ok: 'Apagar conta' }))) return;
      if (a === 'resetpw' && !(await confirmBox('Gerar nova senha?', 'A senha atual deixa de valer e a pessoa é desconectada.', { ok: 'Gerar' }))) return;
      run(b, async () => {
        const r = await post('admin/user', { id, action: a, ...extra });
        if (r.tempPassword) { const m = openModal(`<h3>Senha temporária</h3><p>Envie ao usuário e peça para trocar em Minha conta. Ela não será mostrada de novo.</p><code class="key">${esc(r.tempPassword)}</code><div class="modal-actions"><button class="btn btn-ghost" data-act="copy" data-copy="${esc(r.tempPassword)}">Copiar</button><button class="btn" data-close>Fechar</button></div>`); void m; } else toast('Feito.');
        reload();
      });
    });
  };

  /* ---------- Cupons ---------- */
  tabs.cupons = async (el, reload) => {
    const { coupons } = await api('admin/coupons');
    const form = (c) => {
      c = c || { type: 'percent', active: true, value: 10 };
      const m = openModal(`<form class="stack"><h3>${c.code ? 'Editar cupom' : 'Novo cupom'}</h3><div class="grid2"><label>Código<input name="code" required maxlength="30" value="${esc(c.code || '')}" ${c.code ? 'readonly' : ''} placeholder="BEMVINDO10"></label>
        <label>Tipo<select name="type"><option value="percent" ${c.type === 'percent' ? 'selected' : ''}>Porcentagem (%)</option><option value="fixed" ${c.type === 'fixed' ? 'selected' : ''}>Valor fixo (R$)</option></select></label>
        <label>Valor<input name="value" required value="${c.type === 'fixed' ? fromCents(c.value) : c.value}" inputmode="decimal"></label>
        <label>Limite de usos (0 = ilimitado)<input name="maxUses" type="number" min="0" value="${c.maxUses || 0}"></label>
        <label>Pedido mínimo (R$)<input name="minTotal" inputmode="decimal" value="${fromCents(c.minTotal)}"></label>
        <label>Vale para<select name="section"><option value="">Toda a loja</option>${SECS.map((s) => `<option value="${s}" ${c.section === s ? 'selected' : ''}>${esc(secName(s))}</option>`).join('')}</select></label>
        <label>Validade (opcional)<input name="expires" type="date" value="${c.expiresAt ? new Date(c.expiresAt - 3 * 3600e3).toISOString().slice(0, 10) : ''}"></label><label class="check"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}> Ativo</label></div>
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
    el.innerHTML = `${head('Cupons', '<button class="btn btn-small" id="novo">Novo cupom</button>')}${coupons.length ? `<div class="tablewrap"><table class="tbl"><thead><tr><th>Código</th><th>Desconto</th><th>Usos</th><th>Mínimo</th><th>Vale para</th><th>Validade</th><th></th></tr></thead><tbody>${coupons.map((c) => `<tr class="${c.active ? '' : 'dim'}"><td><b>${esc(c.code)}</b></td><td>${c.type === 'percent' ? c.value + '%' : brl(c.value)}</td><td>${c.used}${c.maxUses ? ' / ' + c.maxUses : ''}</td><td>${c.minTotal ? brl(c.minTotal) : '—'}</td><td>${c.section ? esc(secName(c.section)) : 'Toda a loja'}</td><td>${c.expiresAt ? dt(c.expiresAt).slice(0, 8) : '—'}</td><td class="nowrap"><button class="btn btn-ghost btn-small" data-ed="${esc(c.code)}">Editar</button> <button class="btn btn-ghost btn-small" data-rm="${esc(c.code)}">Apagar</button></td></tr>`).join('')}</tbody></table></div>` : empty('Nenhum cupom', 'Crie códigos de desconto para campanhas e clientes fiéis.')}`;
    $('#novo', el).onclick = () => form();
    $$('[data-ed]', el).forEach((b) => b.onclick = () => form(coupons.find((c) => c.code === b.dataset.ed)));
    $$('[data-rm]', el).forEach((b) => b.onclick = async () => { if (await confirmBox('Apagar cupom?', b.dataset.rm, { danger: true, ok: 'Apagar' })) run(b, async () => { await post('admin/coupon/delete', { code: b.dataset.rm }); reload(); }); });
  };

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

  /* ---------- Mensagens, configurações e registros ---------- */
  tabs.mensagens = async (el, reload) => {
    const { messages } = await api('admin/messages');
    el.innerHTML = `${head('Mensagens do portfólio')}${messages.length ? messages.map((m) => `<div class="panel"><div class="adm-head"><h3>${esc(m.nome)} <span class="muted">· ${esc(m.tipo)}</span></h3><span class="muted">${dt(m.at)}</span></div><p class="desc">${esc(m.mensagem)}</p><div class="actions"><a class="btn btn-small" href="mailto:${esc(m.email)}?subject=${encodeURIComponent('Re: seu projeto')}">Responder ${esc(m.email)}</a><button class="btn btn-ghost btn-small" data-rm="${esc(m.id)}">Apagar</button></div></div>`).join('') : empty('Nenhuma mensagem', 'Os contatos enviados pelo formulário do portfólio aparecem aqui.')}`;
    $$('[data-rm]', el).forEach((b) => b.onclick = () => run(b, async () => { await post('admin/message/delete', { id: b.dataset.rm }); reload(); }));
  };
  tabs.config = async (el) => {
    const { config: c } = await api('admin/settings');
    const ck = (v) => (v ? 'checked' : '');
    el.innerHTML = `${head('Configurações')}<form id="cfg" class="stack">
      <div class="panel"><h3>Loja</h3><label>Nome da loja<input name="storeName" value="${esc(c.storeName)}" maxlength="40"></label>
        ${SECS.map((s) => `<div class="grid2"><label>Nome da parte “${s}”<input name="n_${s}" value="${esc(c.sections[s].name)}" maxlength="30"></label><label>Frase de apoio<input name="t_${s}" value="${esc(c.sections[s].tagline)}" maxlength="160"></label></div>`).join('')}</div>
      <div class="panel"><h3>Aviso no topo do site</h3><label class="check"><input type="checkbox" name="a_active" ${ck(c.announcement.active)}> Mostrar aviso</label><div class="grid2"><label>Cor<select name="a_tone">${[['info', 'Informação'], ['ok', 'Positivo'], ['warn', 'Alerta']].map(([k, v]) => `<option value="${k}" ${c.announcement.tone === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label><label>Texto<input name="a_text" value="${esc(c.announcement.text)}" maxlength="240"></label></div></div>
      <div class="panel"><h3>Pagamento por PIX (MisticPay)</h3><p class="fine">A cobrança e a confirmação são automáticas. A chave que recebe o dinheiro fica na sua conta da MisticPay.</p><label>Instruções mostradas ao cliente<textarea name="p_instructions" rows="3" maxlength="500">${esc(c.pix.instructions)}</textarea></label></div>
      <div class="panel"><h3>Regras da loja</h3><div class="grid2"><label>Tempo de reserva do pedido (minutos)<input type="number" name="reserveMinutes" min="5" max="1440" value="${c.reserveMinutes}"></label><label>Avisar estoque baixo a partir de<input type="number" name="lowStock" min="0" value="${c.lowStock}"></label></div>
        <label class="check"><input type="checkbox" name="registrationOpen" ${ck(c.registrationOpen)}> Permitir novos cadastros</label><label class="check"><input type="checkbox" name="maintenance" ${ck(c.maintenance)}> Modo manutenção (fecha a loja para clientes; admins continuam comprando e testando)</label></div>
      <button class="btn">Salvar configurações</button></form>`;
    $('#cfg', el).onsubmit = (e) => {
      e.preventDefault();
      run($('button', e.target), async () => {
        const o = formObj(e.target), sections = {};
        SECS.forEach((s) => { sections[s] = { name: o['n_' + s], tagline: o['t_' + s] }; });
        await post('admin/settings/save', { storeName: o.storeName, sections, announcement: { active: o.a_active, tone: o.a_tone, text: o.a_text }, pix: { instructions: o.p_instructions }, contacts: { discord: o.c_discord, whatsapp: o.c_whatsapp, email: o.c_email }, reserveMinutes: o.reserveMinutes, lowStock: o.lowStock, registrationOpen: o.registrationOpen, maintenance: o.maintenance });
        await boot(); updateChrome('admin'); toast('Configurações salvas.');
      });
    };
  };
  tabs.logs = async (el) => {
    const { logs } = await api('admin/logs');
    el.innerHTML = `${head('Registro de ações')}${logs.length ? `<div class="tablewrap"><table class="tbl"><thead><tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Detalhe</th></tr></thead><tbody>${logs.map((l) => `<tr><td>${dt(l.at)}</td><td>${esc(l.by)}</td><td>${esc(l.action)}</td><td>${esc(l.detail)}</td></tr>`).join('')}</tbody></table></div>` : empty('Sem registros', 'As ações feitas no painel aparecem aqui.')}`;
  };

  render();
})();
