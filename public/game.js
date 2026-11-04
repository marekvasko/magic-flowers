// Čarovná záhrada – klient
(() => {
  const D = window.GameData;
  const $ = id => document.getElementById(id);
  const W = D.W, H = D.H;

  const SHIRTS = ['#4a90d9', '#e05a5a', '#5cb85c', '#f0ad4e', '#9b59d0', '#20b2aa', '#ff7eb6', '#555555'];
  const HAIRS = ['#5b3a1a', '#2b1a10', '#e8c36a', '#c0532a', '#9e9e9e', '#d96fa8', '#3a6ea5'];
  const EMOJI = { wave: '👋', heart: '❤️', laugh: '😂', flower: '🌸', dance: '🎵', sleep: '💤', search: '🔍' };
  const SECRETS = [
    'Mesiac šepká: „Keď sa dvaja roztancujú v kruhu z húb, víly to nevydržia a pridajú sa…“',
    'Mesiac šepká: „Kto pije jesenný odvar víl, môže tancovať aj sám.“',
    'Mesiac šepká: „Papraďový kvet otvára oči len v noci. Hľadaj ho v tieni.“',
    'Mesiac šepká: „Tri dúhy v jednom kotlíku… a obloha sa zasmeje.“',
    'Mesiac šepká: „Studňa má na dne viac než len vodu. Občas aj semienko z rozprávky.“'
  ];

  const S = {
    ws: null, id: 0, room: '', name: '', look: null,
    tiles: [], tick: 0, market: null, board: [], rep: 0, up: {}, canCap: 5, plotLimit: 8, plotsUsed: 0, maxActive: 1, day: 1, min: 390, weather: 'sun', timeAt: 0, tickMs: 1000, daySeconds: 300, mode: 'running', storage: {},
    me: { x: D.SPAWN.x, y: D.SPAWN.y, dir: 0, phase: 0, moving: false, jz: 0, jv: 0, crawl: false }, crawlKey: false, crawlTgl: false, myEmote: null,
    others: new Map(), inv: {}, coins: 0, water: 20, recipes: [], seen: [], vily: false,
    sel: 'hoe', area: 'garden', areaSeq: 0, tilesGen: 0, storageRate: D.STORAGE_AGE_RATE, icehouse: { built: false, ice: 0 }, quest: null, eternal: false, names: [],
    keys: {}, stick: { x: 0, y: 0 }, path: null, pendingAct: null, tapMark: null, lastSent: '', sentAt: 0,
    fx: [], screenFx: [], bubbles: {}, modal: null, cauldron: [], brewed: null, anchors: {}, joined: false,
    skyTaps: [], tipIdx: Math.floor(Math.random() * D.TIPS.length), stuckT: 0
  };

  window.MF = S; // pre ladenie v konzole

  // ---------- Zvuky ----------
  let actx = null;
  function sfx(kind) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const notes = { pop: [660, 880], hop: [392, 784], water: [420, 300], magic: [523, 659, 784, 1047], coin: [988, 1319], dig: [140, 110], bad: [220, 180] }[kind] || [440];
      notes.forEach((f, i) => {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = kind === 'dig' ? 'triangle' : 'sine'; o.frequency.value = f;
        const t0 = actx.currentTime + i * 0.08;
        g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
        o.connect(g).connect(actx.destination); o.start(t0); o.stop(t0 + 0.2);
      });
    } catch (e) { }
  }

  // ---------- Prihlásenie ----------
  const params = new URLSearchParams(location.search);
  const stored = JSON.parse(localStorage.getItem('mf') || '{}');
  $('jName').value = stored.name || '';
  $('jRoom').value = params.get('room') || stored.room || '';
  let look = stored.look || { shirt: SHIRTS[(Math.random() * SHIRTS.length) | 0], hair: HAIRS[(Math.random() * HAIRS.length) | 0], hat: true };

  function swatches(el, list, key) {
    el.innerHTML = '';
    list.forEach(col => {
      const b = document.createElement('button');
      b.className = 'sw' + (look[key] === col ? ' on' : ''); b.style.background = col;
      b.onclick = () => { look[key] = col; swatches(el, list, key); preview(); };
      el.appendChild(b);
    });
  }
  function preview() {
    const c = $('jPreview').getContext('2d');
    c.clearRect(0, 0, 96, 96);
    Art.char(c, 48, 88, 90, look, 0, 0, {});
  }
  swatches($('jShirt'), SHIRTS, 'shirt'); swatches($('jHair'), HAIRS, 'hair'); preview();

  $('jGo').onclick = () => {
    S.name = $('jName').value.trim() || 'Záhradník';
    S.room = ($('jRoom').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || 'zahrada').slice(0, 16);
    S.look = look;
    localStorage.setItem('mf', JSON.stringify({ name: S.name, room: S.room, look }));
    history.replaceState(null, '', location.pathname + '?room=' + S.room);
    sfx('pop');
    connect();
  };

  // ---------- Sieť ----------
  function send(m) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(m)); }
  function connect() {
    $('conn').classList.remove('hidden');
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    S.ws = ws;
    ws.onopen = () => send({ t: 'join', room: S.room, name: S.name, look: S.look });
    ws.onmessage = e => onMsg(JSON.parse(e.data));
    ws.onclose = () => {
      if (S.ws !== ws) return;
      if (S.joined) { $('conn').textContent = 'Spojenie stratené – pripájam znova…'; $('conn').classList.remove('hidden'); setTimeout(connect, 1500); }
    };
  }

  function onMsg(m) {
    // počas stmavovania pred prechodom sa správy z novej plochy odložia, kým sa svet za čiernou nevymení
    if (S.areaFx && S.areaFx.pending && m.t !== 'area' && m.t !== 'welcome' && m.t !== 'error') { S.areaFx.queue.push(m); return; }
    switch (m.t) {
      case 'welcome':
        if (S.areaFx) endAreaFx(true); // nové pripojenie – rozbehnutý prechod už neplatí
        S.id = m.id; S.tiles = m.tiles; S.me.x = m.x; S.me.y = m.y; S.joined = true;
        S.area = m.area || 'garden'; S.areaSeq = m.seq | 0; S.tilesGen++;
        findAnchors();
        if (!localStorage.getItem('mfHint')) { localStorage.setItem('mfHint', '1'); setTimeout(() => toast('👆 Potiahni prstom kdekoľvek pre pohyb · ťukni na objekt pre akciu'), 600); }
        $('join').classList.add('hidden'); $('game').classList.remove('hidden'); $('conn').classList.add('hidden');
        resize();
        break;
      case 'me':
        S.coins = m.coins; S.water = m.water; S.inv = m.inv; S.recipes = m.recipes; S.seen = m.seen; S.vily = m.vily;
        S.fb = m.fb || {}; S.fbTick = m.tick;
        Object.assign(S, { rep: m.rep || 0, up: m.up || {}, canCap: m.canCap, plotLimit: m.plotLimit, plotsUsed: m.plotsUsed, maxActive: m.maxActive });
        if (S.sel && !S.inv[S.sel]) S.sel = 'hoe'; // '' = prázdna ruka (vybraté prázdne miesto v lište)
        renderHotbar(); updateHud();
        if (S.modal && S.modal.refresh) S.modal.refresh();
        break;
      case 'area': areaChange(m); break; // prechod do inej plochy (záhrada ↔ hory)
      case 'room':
        S.storageRate = m.storageRate || D.STORAGE_AGE_RATE; S.icehouse = m.icehouse || { built: false, ice: 0 };
        S.eternal = m.eternal; S.storageFb = m.storageFb || {}; S.storageTick = m.tick; S.names = m.names; S.mode = m.mode; S.daySeconds = m.daySeconds; S.storage = m.storage || {};
        if (S.modal && S.modal.refresh) S.modal.refresh();
        break;
      case 'market': S.market = m; if (S.modal && S.modal.refresh) S.modal.refresh(); break;
      case 'board': S.board = m.list; if (S.modal && S.modal.refresh) S.modal.refresh(); break;
      case 'tile': S.tiles[m.i] = m.v; break;
      case 'tiles': S.tiles = m.tiles; S.tilesGen++; findAnchors(); break;
      case 'time':
        // Server posiela celé číslo kroku; deň a minúta sa z neho odvodia, medzi krokmi len plynulo dopočítame.
        S.tick = m.tick; S.tickMs = m.tickMs; S.day = D.dayOfTick(m.tick); S.min = D.minOfTick(m.tick);
        S.weather = m.weather; S.mode = m.mode; S.daySeconds = m.daySeconds; S.timeAt = performance.now(); updateHud();
        break;
      case 'pl': {
        const seen = new Set();
        for (const p of m.list) {
          seen.add(p.id);
          if (p.id === S.id) { S.myEmote = p.e; S.mySi = p.si; continue; }
          let o = S.others.get(p.id);
          if (!o) { o = { x: p.x, y: p.y, phase: 0, jz: 0, jv: 0, j: p.j }; S.others.set(p.id, o); }
          if (p.j !== o.j && !o.jz) o.jv = JUMP_V; // iný hráč skočil
          Object.assign(o, { id: p.id, tx: p.x, ty: p.y, dir: p.dir, a: p.a, look: p.look || {}, name: p.name, e: p.e, cr: !!p.cr, j: p.j, si: p.si });
        }
        for (const id of [...S.others.keys()]) if (!seen.has(id)) S.others.delete(id);
        break;
      }
      case 'sleep': {
        const was = S.asleep;
        S.asleep = m.ids.includes(S.id); S.ff = m.ff; S.sleepN = m.ids.length; S.sleepTotal = m.total;
        if (S.asleep) { stopWalk(); S.stick.x = S.stick.y = 0; }
        if (was && !S.asleep && m.ids.length === 0 && !m.ff) sfx('magic');
        renderSleep();
        break;
      }
      case 'toast': toast(m.text, m.kind); if (m.kind === 'magic') sfx('magic'); else if (m.kind === 'gift') sfx('coin'); break;
      case 'chat': chatLine(m.name, m.text); S.bubbles[m.id] = { text: m.text, until: performance.now() + Math.min(10000, 4000 + m.text.length * 60) }; break;
      case 'fx': spawnFx(m); break;
      case 'brewed': S.brewed = m.k; S.cauldron = []; sfx(m.k === 'sliz' ? 'bad' : 'magic'); if (S.modal && S.modal.refresh) S.modal.refresh(); break;
      case 'error': alert(m.text); S.joined = false; $('conn').classList.add('hidden'); break;
    }
  }

  // ---------- Prechod do inej plochy: stmavnutie do čiernej, výmena sveta, meno plochy, rozjasnenie ----------
  const AREA_FADE = 300, AREA_HOLD = 900; // ms; meno plochy ostane na čiernej ≈ 0,9 s, aby sa dalo prečítať
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  let areaHideT = 0;
  function applyArea(m) {
    S.area = m.area; S.areaSeq = m.seq; S.tiles = m.tiles; S.tilesGen++;
    S.me.x = m.x; S.me.y = m.y; S.others.clear(); stopWalk();
    findAnchors();
  }
  // vzhľad clony podľa cieľovej plochy (D.AREA_FX): farba žiary, ikona, meno a ozdoby rozložené po okrajoch
  function paintAreaFade(area) {
    const el = $('areaFade'), f = D.AREA_FX[area] || {}, deco = f.deco || ['✨'];
    el.style.setProperty('--af-glow', f.glow || '#ffffff88');
    el.querySelector('.af-icon').textContent = f.icon || '✨';
    el.querySelector('.af-name').textContent = D.AREA_NAMES[area] || area;
    const N = 16, box = el.querySelector('.af-deco');
    box.innerHTML = '';
    for (let i = 0; i < N; i++) {
      // obvod obdĺžnika: hore, vpravo, dole, vľavo (v % obrazovky, kúsok od okraja)
      const u = (i + 0.5) / N * 4, side = Math.floor(u), k = u - side, a = 4 + k * 92, sp = document.createElement('span');
      const [l, t] = side === 0 ? [a, 3] : side === 1 ? [93, a] : side === 2 ? [100 - a, 92] : [3, 100 - a];
      sp.textContent = deco[i % deco.length];
      sp.style.left = l + '%'; sp.style.top = t + '%'; sp.style.animationDelay = (-(i * 0.37) % 1.4) + 's';
      box.appendChild(sp);
    }
  }
  function areaChange(m) {
    stopWalk(); S.keys = {}; S.stick.x = S.stick.y = 0;
    const fx = S.areaFx;
    if (fx && fx.pending) { fx.msg = m; paintAreaFade(m.area); return; } // ešte stmavuje – platí posledná správa
    if (fx) { applyArea(m); paintAreaFade(m.area); clearTimeout(fx.timer); fx.timer = setTimeout(endAreaFx, AREA_HOLD); return; } // už je čierno
    const el = $('areaFade');
    clearTimeout(areaHideT);
    paintAreaFade(m.area);
    el.classList.remove('hidden', 'named'); void el.offsetWidth; el.classList.add('on');
    sfx('magic');
    const nfx = S.areaFx = { pending: true, msg: m, queue: [] };
    nfx.timer = setTimeout(() => {
      nfx.pending = false;
      applyArea(nfx.msg); // svet sa prestavia za čiernou
      el.classList.add('named');
      for (const q of nfx.queue.splice(0)) onMsg(q);
      nfx.timer = setTimeout(endAreaFx, AREA_HOLD);
    }, reducedMotion() ? 0 : AREA_FADE);
  }
  function endAreaFx(now) {
    const el = $('areaFade');
    if (S.areaFx) clearTimeout(S.areaFx.timer);
    S.areaFx = null;
    el.classList.remove('on');
    areaHideT = setTimeout(() => el.classList.add('hidden'), now === true || reducedMotion() ? 0 : AREA_FADE);
  }

  function findAnchors() {
    S.anchors = {};
    for (let i = 0; i < S.tiles.length; i++) {
      const g = S.tiles[i].g;
      if ((g === 'hut' || g === 'house' || g === 'stall' || g === 'well' || g === 'cauldron' || g === 'icehouse') && !S.anchors[g]) S.anchors[g] = { x: i % W, y: (i / W) | 0 };
    }
  }

  // ---------- Pomocné ----------
  // ladenie: window.MF_TIME = { season: 0–3, min: 0–1439 } prepíše zobrazený čas (len lokálne vykresľovanie, nie server)
  // Hráč hrabe v tráve (si = index hľadaného políčka, inak -1) – hlinku a trávu kreslia častice vo svete (particles3d.mjs).
  const searching = o => o && o.si != null && o.si >= 0;
  function curMin() { if (window.MF_TIME && window.MF_TIME.min != null) return window.MF_TIME.min; return realMin(); }
  function realMin() { return (S.min + Math.min(D.MIN_PER_TICK, (performance.now() - S.timeAt) / S.tickMs * D.MIN_PER_TICK)) % 1440; }
  function season() { return window.MF_TIME && window.MF_TIME.season != null ? window.MF_TIME.season : D.seasonOf(S.day); }
  const GLACIER_MAX = D.glacierLevels(D.buildMountains()); // pôvodná výška ľadu na políčkach hôr
  function tileAt(x, y) { return (x < 0 || y < 0 || x >= W || y >= H) ? null : S.tiles[y * W + x]; }
  function solid(x, y) { const t = tileAt(Math.floor(x), Math.floor(y)); return !t || !!D.BLOCK[t.g]; }
  function playerOn(tx, ty) {
    for (const o of S.others.values()) if (Math.hypot(o.x - (tx + 0.5), o.y - (ty + 0.5)) < 0.8) return o;
    return null;
  }
  function frontTile() {
    if (S.me.a != null) return { x: Math.floor(S.me.x) + Math.round(Math.cos(S.me.a)), y: Math.floor(S.me.y) + Math.round(Math.sin(S.me.a)) };
    const d = [[0, 1], [-1, 0], [1, 0], [0, -1]][S.me.dir];
    return { x: Math.floor(S.me.x) + d[0], y: Math.floor(S.me.y) + d[1] };
  }

  function toast(text, kind) {
    const box = $('toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = text;
    box.appendChild(el);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    setTimeout(() => el.classList.add('out'), kind === 'magic' ? 7000 : 4000);
    setTimeout(() => el.remove(), kind === 'magic' ? 7600 : 4600);
  }
  function chatEl(name, text) {
    const el = document.createElement('div');
    el.className = 'chatline';
    el.innerHTML = '<b></b> ';
    el.firstChild.textContent = name + ':';
    el.appendChild(document.createTextNode(text));
    return el;
  }
  // História chatu (posledných 50 správ) – ukáže sa po otvorení chatu (T alebo 💬)
  function chatLine(name, text) {
    const hist = $('chathist'), atEnd = hist.scrollTop + hist.clientHeight >= hist.scrollHeight - 4;
    hist.appendChild(chatEl(name, text));
    while (hist.children.length > 50) hist.removeChild(hist.firstChild);
    if (atEnd) hist.scrollTop = hist.scrollHeight;
    const el = chatEl(name, text);
    $('chatlog').appendChild(el);
    while ($('chatlog').children.length > 5) $('chatlog').removeChild($('chatlog').firstChild);
    chatWheel();
    setTimeout(() => el.classList.add('out'), 9000);
    setTimeout(() => { el.remove(); chatWheel(); }, 10000);
  }
  // Kolotoč v histórii: okno má 15 riadkov, spodných 13 je normálne, 14. a 15. riadok prichádzajú z pozadia –
  // správa je tam menšia, naklonená, priesvitnejšia a zasunutá za správu pod ňou (staršie sú vždy za novšími).
  // Posúvaním nahor sa správa vysunie dopredu a za ňou sa objaví ďalšia; vďaka 2 prázdnym riadkom navrchu (CSS padding)
  // sa dopredu dostane aj najstaršia. Pri menej ako 14 správach nič.
  // Počíta sa z polohy v rozložení (offsetTop), nie z bounding boxu, aby transformácia neovplyvňovala sama seba.
  const CHAT_ROW = 25;
  function chatWheel() {
    const box = $('chathist');
    if (!$('chatbox').classList.contains('open')) return;
    const H = parseFloat(getComputedStyle(box).maxHeight) || 0, flat = H - 2 * CHAT_ROW;
    const bottom = box.scrollTop + box.clientHeight, items = box.children;
    for (let i = 0; i < items.length; i++) {
      const el = items[i], e = Math.max(0, (bottom - el.offsetTop - flat) / (2 * CHAT_ROW)), d = Math.min(1, e);
      el.style.zIndex = i + 1;
      el.style.transform = d ? `translateY(${(d * CHAT_ROW).toFixed(1)}px) perspective(500px) rotateX(${(d * 30).toFixed(1)}deg) scale(${(1 - d * 0.15).toFixed(3)})` : '';
      el.style.opacity = e ? Math.max(0, 1 - e * 0.8).toFixed(2) : '';
    }
  }
  let wheelRaf = 0;
  $('chathist').addEventListener('scroll', () => { if (!wheelRaf) wheelRaf = requestAnimationFrame(() => { wheelRaf = 0; chatWheel(); }); }, { passive: true });

  // ---------- Kontextová akcia ----------
  function ctxAction(tx, ty) {
    const t = tileAt(tx, ty);
    if (!t) return null;
    const sel = S.sel;
    if (sel === 'fl_papradie') return { i: '✨', l: 'Želanie', ui: 'wish' };
    const other = playerOn(tx, ty);
    if (other) {
      if (sel === 'po_laska') return { i: '💕', l: 'Darovať' };
      if (!sel || D.isTool(sel)) return { i: '👋', l: 'Zamávať' };
      return { i: '🎁', l: 'Darovať' };
    }
    switch (t.g) {
      case 'stall': return { i: '🛒', l: 'Trh', ui: 'shop' };
      case 'cauldron': return { i: '⚗️', l: 'Kotlík', ui: 'cauldron' };
      case 'babka': case 'hut': return { i: '👵', l: 'Babka', ui: 'babka' };
      case 'house': return { i: '🏠', l: 'Domček', ui: 'house' };
      case 'well': return sel === 'can' ? { i: '💧', l: 'Načrieť' } : { i: '🪙', l: 'Prianie' };
      case 'water':
        if (sel === 'pick' && season() === 3) return t.cut ? { i: '🕳️', l: 'Otvor v ľade', info: true } : { i: '🧊', l: 'Vysekať ľad' };
        return sel === 'can' ? { i: '💧', l: 'Načrieť' } : null;
      case 'glacier': return sel === 'pick' && t.ice ? { i: '🧊', l: 'Vysekať ľad' } : { i: '🧊', l: 'Ľadovec', info: true };
      case 'icehouse': return { i: '🧊', l: 'Ľadovňa', ui: 'icehouse' };
      case 'lot': return { i: '🪧', l: 'Pozemok', info: true };
      case 'shroom': case 'ring': return { i: '🍄', l: 'Huby', info: true };
    }
    const s = t.s, p = s && s.p;
    if (p && !p.d && D.stageOf(p) === 3) return (p.sp === 'papradie' && !D.isNight(curMin())) ? { i: '🌙', l: 'Čaká na noc' } : { i: '🧺', l: 'Zbierať' };
    if (sel === 'hoe') {
      if (p && p.d) return { i: '🧹', l: 'Vyčistiť' };
      if (!s && D.TILLABLE[t.g]) return { i: '⛏️', l: 'Kopať' };
      if (s && !p && (!s.o || s.o === S.name.toLowerCase())) return { i: '🔄', l: 'Zarovnať' };
    }
    // neprekopaná tráva a v ruke nič, čo by tu niečo robilo → hľadať divé semienka (ako na serveri)
    if (t.g === 'grass' && !s && sel !== 'hoe' && !sel.startsWith('po_')) return { i: '🔍', l: 'Hľadať' };
    if (sel === 'can' && s) return { i: '💧', l: 'Poliať' };
    if ((sel.startsWith('seed_') || D.isWild(sel)) && s && !p) return { i: '🌱', l: 'Sadiť' };
    if (sel === 'compost' && s && !s.r) return { i: '🟤', l: 'Pohnojiť' };
    if (sel.startsWith('po_')) return { i: '🧪', l: 'Použiť' };
    if (p && !p.d) return { i: '🔍', l: 'Pozrieť', info: true };
    return null;
  }

  // ---- Čerstvosť odrezaných kvetov ----
  // Najstaršia várka kvetu: { age (kroky), fresh (0.5–1), left (kroky do zvädnutia) }
  function oldestBatch(id, inStorage) {
    const fb = inStorage ? S.storageFb : S.fb, base = inStorage ? S.storageTick : S.fbTick;
    const list = fb && fb[id];
    if (!list || !list.length) return null;
    const rate = inStorage ? S.storageRate : 1, sp = id.slice(3), ice = id === 'ice';
    const age = list[0].age + Math.max(0, S.tick - (base || S.tick)) * rate;
    const life = ice ? D.ICE_LIFE : D.SPECIES[sp].life * TPD; // ľad sa do pol dňa roztopí
    return { age, fresh: ice ? 1 : D.freshness(sp, age), left: Math.max(0, (life - age) / rate), rem: Math.max(0, 1 - age / life) };
  }
  const freshColor = rem => rem > 0.6 ? '#3aa04a' : rem > 0.3 ? '#e8b21c' : '#d0502a';
  function freshText(id, inStorage) {
    const o = oldestBatch(id, inStorage);
    if (!o) return '';
    return `čerstvosť ${Math.round(o.fresh * 100)} % · najstaršie zvädnú o ${fmtLeft(o.left)}`;
  }

  function plantInfo(tx, ty) {
    const t = tileAt(tx, ty), p = t.s && t.s.p;
    if (!p) return;
    const sp = D.SPECIES[p.sp];
    if (!sp) return toast('Divé semienko – uvidíme, čo z neho vyrastie, keď vyklíči.' + (p.d ? ' Žiaľ, zahynulo.' : t.s.w ? '' : ' · smäd'));
    const st = ['semienko', 'klíčok', 'púčik', 'kvitne'][D.stageOf(p)];
    const shade = D.isShade(S.tiles, tx, ty);
    const notes = [];
    if (sp.light !== 'any' && (sp.light === 'shade') !== shade) notes.push(sp.light === 'shade' ? 'chce tieň' : 'chce slnko');
    if (sp.soil && sp.soil !== t.s.k && !(sp.soil === 'rich' && t.s.r) && !(sp.soil === 'sand' && t.s.k === 'rock')) notes.push({ sand: 'chce piesok', rock: 'chce skalku', rich: 'chce kompost' }[sp.soil]);
    if (!t.s.w) notes.push('smäd');
    if (R3) { const sh = R3.sunHoursAt(tx, ty); if (sh != null) notes.push(`☀️ ~${sh.toFixed(1).replace('.', ',')} h slnka denne`); }
    if (D.stageOf(p) === 3 && p.bt != null && !p.d) notes.push((sp.perennial ? 'odkvitne' : 'zvädne') + ' o ' + fmtLeft(sp.life * TPD - (S.tick - p.bt)));
    toast(`${sp.name}: ${st} (${Math.floor(p.prog)}/${sp.days} dní) · ${'⭐'.repeat(p.q)}${notes.length ? ' · ' + notes.join(', ') : ' · spokojná 😊'}`);
  }

  // Hľadať sa dá len stojac priamo na políčku – kým tam hráč nie je, najprv tam dôjde
  const onTile = (tx, ty) => Math.hypot(S.me.x - (tx + 0.5), S.me.y - (ty + 0.5)) <= 0.3;
  function walkOnto(tx, ty) {
    const path = findPath((x, y) => x === tx && y === ty);
    if (!path) return;
    S.path = path; S.pendingAct = { x: tx, y: ty, onTile: true }; S.stuckT = 0;
  }

  function doAction(tx, ty) {
    const a = ctxAction(tx, ty);
    if (!a) return;
    if (a.ui) return openUI(a.ui);
    if (a.l === 'Hľadať' && !onTile(tx, ty)) return walkOnto(tx, ty);
    if (a.info) {
      if (a.l === 'Huby') toast(D.isNight(curMin()) ? 'Huby slabo svietia… Skús tu zatancovať 💃' : 'Kruh z húb. Babka hovorí, že tu v noci tancujú víly. 🍄');
      else if (a.l === 'Ľadovec') {
        const t = tileAt(tx, ty);
        const have = S.tiles.reduce((s, x) => s + (x.ice || 0), 0), max = GLACIER_MAX.reduce((s, v) => s + v, 0);
        const state = ` Ľadovec má ${Math.round(have / max * 100)} % ľadu – dorastie len v daždi alebo snehu.`;
        toast((!S.inv.pick ? 'Na ľad potrebuješ krompáč – kúpiš ho na trhu (záložka Vylepšiť). ⛏️'
          : t.ice ? `Tu ešte vysekáš ${t.ice}× ľad. Vyber v lište krompáč. ⛏️` : 'Tu je ľad vysekaný až po dno. 🧊') + state);
      } else if (a.l === 'Otvor v ľade') toast('Tu už je otvor v ľade. Cez noc zamrzne – skús iné miesto. 🧊');
      else if (a.l === 'Pozemok') toast(`Pozemok pre ľadovňu. Postaviť ju môže ktokoľvek zo záhrady na trhu (záložka Vylepšiť) za ${D.ICEHOUSE.price} 🪙. 🧊`);
      else plantInfo(tx, ty);
      return;
    }
    if (a.l === 'Hľadať') { const me = S.me; send({ t: 'move', x: me.x, y: me.y, dir: me.dir, a: me.a, cr: me.crawl, ar: S.areaSeq }); } // server musí vedieť, že už stojím na políčku
    send({ t: 'act', x: tx, y: ty, item: S.sel });
    if (a.l === 'Kopať' || a.l === 'Vysekať ľad') sfx('dig'); else if (a.l === 'Poliať' || a.l === 'Načrieť') sfx('water'); else sfx('pop');
  }

  // ---------- Vstupy ----------
  // Skok (medzerník) a plazenie (Shift) sú len pre parádu – nič nemenia, ostatní hráči ich však vidia
  const JUMP_V = 5.6, JUMP_G = 23, CRAWL_SPEED = 0.45; // výskok ≈ 0,7 políčka, ≈ 0,5 s
  function jump() {
    const me = S.me;
    if (S.asleep || me.jz > 0 || me.crawl) return;
    me.jv = JUMP_V; me.jz = 0.001;
    send({ t: 'jump' }); sfx('hop');
  }
  function setCrawlToggle(on) { S.crawlTgl = on; $('bCrawl').classList.toggle('on', on); }
  const KEYMAP = { ArrowUp: 'u', KeyW: 'u', ArrowDown: 'd', KeyS: 'd', ArrowLeft: 'l', KeyA: 'l', ArrowRight: 'r', KeyD: 'r' };
  addEventListener('keydown', e => {
    if (!S.joined || S.asleep || S.areaFx || document.activeElement.tagName === 'INPUT') return;
    S.kbd = true;
    if (KEYMAP[e.code]) { S.keys[KEYMAP[e.code]] = true; stopWalk(); e.preventDefault(); }
    if (e.code === 'Space') { if (!e.repeat) jump(); e.preventDefault(); }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') S.crawlKey = true;
    if (e.code === 'KeyE' || e.code === 'Enter') { const f = frontTile(); doAction(f.x, f.y); e.preventDefault(); }
    if (e.code === 'Escape') closeModal();
    if (/^Digit[1-9]$/.test(e.code)) { const ids = hotbarIds(); selectItem(ids[+e.code.slice(5) - 1] || ''); }
    if (e.code === 'KeyQ') { const ids = hotbarIds().concat(''); selectItem(ids[(ids.indexOf(S.sel) + 1) % ids.length]); }
    if (e.code === 'KeyT') { e.preventDefault(); openChat(); }
    if (R3 && e.code === 'BracketLeft') R3.rotate(-1);
    if (R3 && e.code === 'BracketRight') R3.rotate(1);
  });
  addEventListener('keyup', e => {
    if (KEYMAP[e.code]) S.keys[KEYMAP[e.code]] = false;
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') S.crawlKey = false;
  });
  addEventListener('blur', () => { S.keys = {}; S.crawlKey = false; });
  // Mobil: tlačidlá pre palec vpravo dole (skok, plazenie zap/vyp)
  $('bJump').addEventListener('pointerdown', e => { e.preventDefault(); jump(); });
  $('bCrawl').addEventListener('pointerdown', e => { e.preventDefault(); setCrawlToggle(!S.crawlTgl); sfx('pop'); });

  document.querySelectorAll('#emotes button[data-e]').forEach(b => b.addEventListener('click', () => { send({ t: 'emote', e: b.dataset.e }); sfx('pop'); }));

  // Joystick – objaví sa tam, kde hráč začne ťahať prstom (kdekoľvek na obrazovke); kotva sa nehýbe
  const cv = $('cv'), ctx = cv.getContext('2d');
  // Three.js kreslí do #gl, #cv zostáva navrchu ako prekrytie (mená, efekty) a prijíma dotyky
  let R3 = null;
  $('rotL').onclick = () => R3 && R3.rotate(-1);
  $('rotR').onclick = () => R3 && R3.rotate(1);
  import('/render3d.mjs').then(() => {
    R3 = window.Render3D.create({
      S, searching, glCanvas: $('gl'), ov: cv, ovCtx: ctx, EMOJI, curMin, season, ctxAction, frontTile
    });
    window._r3pick = (x, y) => R3.pick(x, y); // pre ladenie / testy
    window._r3 = R3;
  }).catch(e => { console.error(e); toast('3D sa nepodarilo načítať – skús obnoviť stránku.'); });
  const gameEl = $('game'), joy = $('joy'), joyKnob = $('joyKnob');
  const JOY_R = 50, DRAG_START = 10;
  const ptrs = new Map();
  let joyId = null, joyBase = null;
  function joyMove(x, y) {
    let dx = x - joyBase.x, dy = y - joyBase.y, d = Math.hypot(dx, dy);
    if (d > JOY_R) { dx *= JOY_R / d; dy *= JOY_R / d; d = JOY_R; } // kotva ostáva na mieste
    joyKnob.style.transform = `translate(${dx}px,${dy}px)`;
    S.stick = d / JOY_R < 0.15 ? { x: 0, y: 0 } : { x: dx / JOY_R, y: dy / JOY_R };
  }
  function endJoy() { joyId = null; S.stick = { x: 0, y: 0 }; joyKnob.style.transform = ''; joy.classList.add('hidden'); }
  cv.addEventListener('pointerdown', e => {
    if (!S.joined) return;
    if (e.pointerType === 'touch') gameEl.classList.add('touch');
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch (err) { }
    ptrs.set(e.pointerId, { x0: e.clientX, y0: e.clientY, joy: false });
  });
  cv.addEventListener('pointermove', e => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    const r = gameEl.getBoundingClientRect();
    if (e.pointerId === joyId) return joyMove(e.clientX - r.left, e.clientY - r.top);
    if (joyId === null && !p.joy && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > DRAG_START) {
      joyId = e.pointerId; p.joy = true;
      stopWalk();
      joyBase = { x: p.x0 - r.left, y: p.y0 - r.top };
      joy.style.left = joyBase.x + 'px'; joy.style.top = joyBase.y + 'px';
      joy.classList.remove('hidden');
      joyMove(e.clientX - r.left, e.clientY - r.top);
    }
  });
  const ptrEnd = e => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    ptrs.delete(e.pointerId);
    if (e.pointerId === joyId) return endJoy();
    if (e.type === 'pointerup' && !p.joy && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) <= DRAG_START) {
      if (joyId !== null) jump(); // ťuknutie druhým prstom počas riadenia joystickom = skok
      else tapWorld(e.clientX, e.clientY);
    }
  };
  cv.addEventListener('pointerup', ptrEnd);
  cv.addEventListener('pointercancel', ptrEnd);

  // Ťuknutie na objekt: blízko → akcia hneď, ďaleko → dôjde tam a urobí ju
  const GROUND = { 'Zarovnať': 1, 'Kopať': 1, 'Poliať': 1, 'Sadiť': 1, 'Pohnojiť': 1, 'Vyčistiť': 1, 'Použiť': 1, 'Vysekať ľad': 1 };
  const REACH = 1.7;
  function inReach(tx, ty) { return Math.hypot(S.me.x - (tx + 0.5), S.me.y - (ty + 0.5)) <= REACH; }
  function stopWalk() { S.path = null; S.pendingAct = null; }

  // BFS po políčkach – nájde cestu k prvému políčku, ktoré spĺňa podmienku
  function findPath(goal) {
    const sx = Math.floor(S.me.x), sy = Math.floor(S.me.y);
    const prev = new Int32Array(W * H).fill(-2);
    const q = [sy * W + sx];
    prev[q[0]] = -1;
    for (let qi = 0; qi < q.length; qi++) {
      const i = q[qi], x = i % W, y = (i / W) | 0;
      if (goal(x, y)) {
        const path = [];
        for (let k = i; k !== -1; k = prev[k]) path.unshift({ x: k % W + 0.5, y: ((k / W) | 0) + 0.5 });
        return path;
      }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, n = ny * W + nx;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || prev[n] !== -2) continue;
        if (D.BLOCK[S.tiles[n].g]) continue;
        prev[n] = i; q.push(n);
      }
    }
    return null;
  }

  function tapWorld(cx, cy) {
    if (S.asleep || S.areaFx) return;
    if (!R3) return;
    const tgt = R3.pick(cx, cy); // lúč do 3D scény
    if (!tgt) return;
    if (!tileAt(tgt.x, tgt.y)) return;
    const a = ctxAction(tgt.x, tgt.y);
    S.tapMark = { x: tgt.x, y: tgt.y, t: performance.now(), act: !!a };
    stopWalk();
    if (a && (inReach(tgt.x, tgt.y) || a.ui === 'wish' || a.info)) {
      face(tgt.x + 0.5 - S.me.x, tgt.y + 0.5 - S.me.y);
      doAction(tgt.x, tgt.y);
      if (!a.info || inReach(tgt.x, tgt.y)) return;
    }
    const cx0 = tgt.x + 0.5, cy0 = tgt.y + 0.5;
    const walkable = !D.BLOCK[tileAt(tgt.x, tgt.y).g];
    let path;
    if (a && !GROUND[a.l] && !a.info) {
      // objekt: dôjdi k nemu a urob akciu
      path = findPath((x, y) => Math.hypot(x + 0.5 - cx0, y + 0.5 - cy0) <= 1.45 && (x !== tgt.x || y !== tgt.y || walkable));
      if (path) S.pendingAct = { x: tgt.x, y: tgt.y };
    } else {
      // zem: dôjdi na políčko (alebo čo najbližšie k nemu)
      path = walkable ? findPath((x, y) => x === tgt.x && y === tgt.y) : findPath((x, y) => Math.hypot(x + 0.5 - cx0, y + 0.5 - cy0) <= 1.45);
    }
    if (!path) return;
    if (path.length > 1 && Math.hypot(path[0].x - S.me.x, path[0].y - S.me.y) < 0.6) path.shift();
    S.path = path; S.stuckT = 0;
  }

  function face(dx, dy) {
    if (Math.abs(dx) > Math.abs(dy)) S.me.dir = dx < 0 ? 1 : 2; else S.me.dir = dy < 0 ? 3 : 0;
  }

  // ---------- Hotbar ----------
  function hotbarIds() {
    const order = id => id === 'hoe' ? 0 : id === 'can' ? 1 : id === 'pick' ? 1.5 : id === 'compost' ? 2 : id.startsWith('seed_') || D.isWild(id) ? 3 : id.startsWith('fl_') ? 4 : id === 'wilted' ? 4.5 : 5;
    const spOrder = Object.keys(D.SPECIES);
    const rank = id => { const k = id.replace(/^(seed_|fl_|po_)/, ''); const i = spOrder.indexOf(k); return i < 0 ? 99 : i; };
    return Object.keys(S.inv).filter(id => S.inv[id] > 0).sort((a, b) => order(a) - order(b) || rank(a) - rank(b));
  }
  function selectItem(id) { if (id == null) return; S.sel = id; renderHotbar(); }
  function renderHotbar() {
    const bar = $('hotbar');
    const ids = hotbarIds();
    bar.innerHTML = '';
    for (const [i, id] of ids.entries()) {
      const d = document.createElement('div');
      d.className = 'slot' + (id === S.sel ? ' on' : '');
      d.innerHTML = `<img src="${Art.icon(id)}">` + (i < 9 ? `<span class="k">${i + 1}</span>` : '');
      if (id === 'can') d.innerHTML += `<div class="wbar"><i style="width:${S.water / S.canCap * 100}%"></i></div>`;
      else if (id.startsWith('fl_') || id === 'ice') { // čerstvosť najstaršieho kusu (ľad: kým sa neroztopí)
        const o = oldestBatch(id);
        if (o) d.innerHTML += `<span class="n">${S.inv[id]}</span><div class="wbar fresh"><i style="width:${o.rem * 100}%;background:${freshColor(o.rem)}"></i></div>`;
        else d.innerHTML += `<span class="n">${S.inv[id]}</span>`;
      }
      else if (id !== 'hoe' && id !== 'pick') d.innerHTML += `<span class="n">${S.inv[id]}</span>`;
      d.onclick = () => selectItem(id);
      bar.appendChild(d);
    }
    // doplní rad (mobil 6, počítač 9 miest); prvé prázdne miesto je vždy vidieť – jeho výberom máš prázdnu ruku
    for (let i = ids.length; i < Math.max(9, ids.length + 1); i++) {
      const d = Object.assign(document.createElement('div'), { className: 'slot empty' + (i === ids.length ? ' keep' + (S.sel === '' ? ' on' : '') : '') });
      d.onclick = () => selectItem('');
      bar.appendChild(d);
    }
    const sel = bar.querySelector('.on');
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    let txt = D.itemName(S.sel);
    if (!S.sel) txt = 'Prázdna ruka · hľadaj v tráve divé semienka 🔍';
    if (S.sel === 'can') txt += ` · ${S.water}/${S.canCap} 💧`;
    if (S.sel === 'hoe') txt += ` · pole ${S.plotsUsed}/${S.plotLimit >= 999 ? '∞' : S.plotLimit}`;
    if (S.sel.startsWith('seed_')) {
      const sp = D.SPECIES[S.sel.slice(5)];
      txt += ' · ' + sp.seasons.map(s => D.SEASON_ICONS[s]).join('') + ' · ' + ({ sun: '☀️', shade: '🌳', any: '⛅' })[sp.light] + (sp.soil ? ' · ' + ({ sand: 'piesok', rich: 'kompost', rock: 'skalka' })[sp.soil] : '');
    }
    if (S.sel.startsWith('fl_')) txt += ' · ' + freshText(S.sel);
    if (D.isWild(S.sel)) txt += ' · ' + D.SEASON_ICONS[+S.sel.slice(5)] + ' · nevedno, čo z neho vyrastie';
    if (S.sel === 'wilted') txt += ` · ${D.WILTED_PER_COMPOST} ks = 1 kompost (v sklade)`;
    if (S.sel === 'pick') txt += ' · ľad na ľadovci v horách, v zime aj na jazierku';
    if (S.sel === 'ice') {
      const o = oldestBatch('ice');
      txt += ` ${S.inv.ice || 0}/${D.ICE_CARRY} · ťažký` + (o ? ` · roztopí sa o ${fmtLeft(o.left)}` : '');
    }
    if (S.sel.startsWith('po_')) txt += ' · ' + D.POTIONS[S.sel.slice(3)].desc;
    $('selName').textContent = txt;
  }

  function updateHud() {
    const m = curMin(), h = Math.floor(m / 60), mm = Math.floor(m % 60 / 10) * 10;
    const se = season();
    const dayInSeason = (S.day - 1) % D.DAYS_PER_SEASON + 1;
    $('hDate').textContent = (S.area === 'hory' ? '🏔️ ' : '') + `${D.SEASON_ICONS[se]} ${D.SEASONS[se]} · deň ${dayInSeason}/${D.DAYS_PER_SEASON}`;
    $('hClock').textContent = String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
    $('hSky').textContent = (h >= 20 || h < 5) ? '🌙' : '☀️';
    $('hWeather').textContent = { rain: '🌧️', snow: '🌨️', sun: '' }[S.weather] + (S.eternal ? '🌸' : '') + (S.vily ? '🧚' : '');
    $('hCoins').textContent = `🪙 ${S.coins} ⭐${D.repLevel(S.rep)}`;
  }

  $('hSky').addEventListener('click', () => {
    const now = performance.now();
    S.skyTaps = S.skyTaps.filter(t => now - t < 3000); S.skyTaps.push(now);
    if (S.skyTaps.length >= 7) {
      S.skyTaps = [];
      const h = curMin() / 60;
      if (h >= 20 || h < 5) { toast(SECRETS[Math.floor(Math.random() * SECRETS.length)], 'magic'); sfx('magic'); }
      else toast('😎 Slnko ťa oslepilo. Skús to radšej v noci…');
    }
  });

  // ---------- Modálne okná ----------
  function openModal(title, render) {
    $('mTitle').textContent = title;
    S.modal = { refresh: () => { $('mBody').innerHTML = ''; render($('mBody')); } };
    S.modal.refresh();
    $('modal').classList.remove('hidden');
  }
  function closeModal() { $('modal').classList.add('hidden'); S.modal = null; S.brewed = null; }
  $('mClose').onclick = closeModal;
  $('modal').addEventListener('click', e => { if (e.target === $('modal')) closeModal(); });
  $('bBook').onclick = () => openUI('book');
  $('bMenu').onclick = () => openUI('menu');

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const k in attrs || {}) { if (k === 'onclick') el.onclick = attrs[k]; else if (k === 'html') el.innerHTML = attrs[k]; else el.setAttribute(k, attrs[k]); }
    for (const k of kids) if (k != null) el.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
    return el;
  }
  const img = id => h('img', { src: Art.icon(id) });
  const seasonBadges = sp => {
    const box = h('span');
    sp.seasons.forEach(s => box.appendChild(h('span', { class: 'badge' + (s === season() ? ' now' : '') }, D.SEASON_ICONS[s] + ' ' + D.SEASONS[s])));
    return box;
  };

  function openUI(kind) {
    sfx('pop');
    if (kind === 'shop') return openShop('buy');
    if (kind === 'cauldron') { S.brewed = null; return openModal('⚗️ Čarovný kotlík', renderCauldron); }
    if (kind === 'babka') { S.tipIdx = (S.tipIdx + 1) % D.TIPS.length; return openModal('👵 Babka bylinkárka', renderBabka); }
    if (kind === 'book') return openBook('flowers');
    if (kind === 'menu') return openModal('☰ Menu', renderMenu);
    if (kind === 'help') return openModal('❓ Ako hrať', renderHelp);
    if (kind === 'storage') return openModal('📦 Spoločný sklad', renderStorage);
    if (kind === 'house') return openModal('🏠 Domček', renderHouse);
    if (kind === 'wish') return openModal('✨ Papraďový kvet', renderWish);
    if (kind === 'icehouse') return openModal('🧊 Ľadovňa', renderIcehouse);
  }

  // ---- Pomocné pre ekonomiku ----
  const TPD = D.TICKS_PER_DAY;
  function fmtLeft(ticks) {
    if (ticks <= 0) return 'teraz';
    const hTotal = Math.round(ticks * D.MIN_PER_TICK / 60);
    const d = Math.floor(hTotal / 24), hh = hTotal % 24;
    return (d ? d + ' d ' : '') + (hh || !d ? hh + ' h' : '');
  }
  function fmtTick(t) { const m = D.minOfTick(t); return `deň ${D.dayOfTick(t)}, ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }
  // Trend ceny za posledný deň ako ikonka: vždy 3 šípky natesno nad sebou, farebné sú
  // 1 (malá zmena), 2 (veľká) alebo 3 (veľmi veľká), zvyšok je sivý. Bez zmeny = všetky sivé.
  // upIsGood: pri predaji je rast ceny dobrý (zelený), pri nákupe zlý (červený).
  function priceTrend(hist, cur, upIsGood) {
    const hh = hist || [];
    const prev = hh.length >= 2 ? hh[hh.length - 2] : hh.length ? hh[0] : cur;
    const pct = prev ? (cur - prev) / prev : 0;
    const a = Math.abs(pct), up = pct > 0;
    const n = a < 0.03 ? 0 : a < 0.15 ? 1 : a < 0.35 ? 2 : 3;
    const col = n ? ((up === upIsGood) ? '#2e8b3a' : '#c0392b') : null;
    const GRAY = '#d9d1c1';
    // šípky sa vyfarbujú v smere pohybu: pri raste odspodu, pri poklese zhora
    let paths = '';
    for (let i = 0; i < 3; i++) {
      const y = 2 + i * 6;
      const lit = n && (up ? i >= 3 - n : i < n);
      const d = (up || !n) ? `M2 ${y + 5}L8 ${y}L14 ${y + 5}` : `M2 ${y}L8 ${y + 5}L14 ${y}`;
      paths += `<path d="${d}" fill="none" stroke="${lit ? col : GRAY}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    const el = document.createElement('span');
    el.className = 'tr';
    el.title = n ? `${up ? 'Rast' : 'Pokles'} o ${Math.round(a * 100)} % za deň` : 'Cena sa za deň takmer nezmenila';
    el.innerHTML = `<svg width="16" height="21" viewBox="0 0 16 21">${paths}</svg>`;
    return el;
  }
  function marketSellPrice(id) {
    const M = S.market;
    if (!M) return D.sellPrice(id);
    if (id.startsWith('fl_') && M.flowers[id.slice(3)]) return M.flowers[id.slice(3)].p;
    if (id.startsWith('seed_') && M.seeds[id.slice(5)]) return Math.max(1, Math.round(M.seeds[id.slice(5)].p * 0.4));
    if (id === 'compost') return Math.max(1, Math.round(M.compost.p * 0.5));
    if (id === 'ice') return D.ICE_PRICE[D.seasonOf(S.day)];
    return D.sellPrice(id);
  }
  function festivalBanner(body) {
    const M = S.market;
    if (!M) return;
    const list = mult => Object.entries(mult).map(([sp, x]) => `${D.SPECIES[sp].name} ×${String(x).replace('.', ',')}`).join(', ');
    if (M.festival) body.appendChild(h('div', { class: 'row', style: 'background:#fff1d6;border-color:#e08a1e' }, h('div', { class: 'info' }, h('b', null, `${M.festival.icon} Práve je ${M.festival.name}!`), h('small', null, 'Vyšší výkup: ' + list(M.festival.mult)))));
    else if (M.upcoming) body.appendChild(h('div', { class: 'row' }, h('div', { class: 'info' }, h('b', null, `📅 ${M.upcoming.icon} ${M.upcoming.name} o ${fmtLeft(M.upcoming.start - S.tick)}`), h('small', null, 'Vyšší výkup: ' + list(M.upcoming.mult)))));
  }

  function openShop(tab) {
    openModal('🛒 Trh', body => {
      const M = S.market;
      body.appendChild(h('div', { class: 'tabs' },
        h('button', { class: tab === 'buy' ? 'on' : '', onclick: () => openShop('buy') }, 'Kúpiť'),
        h('button', { class: tab === 'sell' ? 'on' : '', onclick: () => openShop('sell') }, 'Predať'),
        h('button', { class: tab === 'up' ? 'on' : '', onclick: () => openShop('up') }, 'Vylepšiť'),
        h('button', { class: tab === 'news' ? 'on' : '', onclick: () => openShop('news') }, 'Správy')));
      body.appendChild(h('div', { style: 'text-align:center;font-weight:700;margin-bottom:8px' }, `Máš 🪙 ${S.coins} · ⭐ reputácia ${S.rep} (úroveň ${D.repLevel(S.rep)})`));
      if (!M) return body.appendChild(h('p', null, 'Načítavam trh…'));
      if (tab === 'buy') {
        festivalBanner(body);
        const se = season();
        const rank = sp => D.SPECIES[sp].seasons.includes(se) ? 0 : D.SPECIES[sp].seasons.includes((se + 1) % 4) ? 1 : 2;
        const ids = ['compost'].concat(Object.keys(M.seeds).sort((a, b) => rank(a) - rank(b)).map(sp => 'seed_' + sp));
        for (const id of ids) {
          const q = id === 'compost' ? M.compost : M.seeds[id.slice(5)];
          const sp = id.startsWith('seed_') ? D.SPECIES[id.slice(5)] : null;
          const lockedRep = sp && D.MIN_SEED_REP[id.slice(5)];
          const info = h('div', { class: 'info' }, h('b', null, sp ? sp.name : 'Kompost'),
            sp ? seasonBadges(sp) : h('small', null, 'Výživná pôda: rýchlejší rast a +1 kvet pri zbere'));
          const st = q.st > 0 ? `na sklade ${q.st}` : 'VYPREDANÉ';
          const line = h('small', null, `${st} · ${q.p} 🪙 `);
          line.appendChild(priceTrend(q.h, q.p, false));
          info.appendChild(line);
          if (sp) info.appendChild(h('small', null, `${sp.days} dní · ${'💧'.repeat(sp.water)} · ${({ sun: '☀️', shade: '🌳', any: '⛅' })[sp.light]}${sp.soil ? ' · ' + ({ sand: 'piesok', rich: 'kompost', rock: 'len skalka' })[sp.soil] : ''}`));
          if (lockedRep && D.repLevel(S.rep) < lockedRep) info.appendChild(h('small', { style: 'color:#b0432a' }, `🔒 od reputácie ${lockedRep}`));
          const b1 = h('button', { class: 'btn', onclick: () => send({ t: 'buy', id, n: 1 }) }, q.p + '🪙');
          const b5 = h('button', { class: 'btn alt', onclick: () => send({ t: 'buy', id, n: 5 }) }, '×5');
          if (!q.st || S.coins < q.p) { b1.disabled = true; b5.disabled = true; }
          body.appendChild(h('div', { class: 'row', style: q.st ? '' : 'opacity:.6' }, img(id), info, h('div', { class: 'btns' }, b1, b5)));
        }
      } else if (tab === 'sell') {
        festivalBanner(body);
        body.appendChild(h('small', { style: 'display:block;margin-bottom:6px' }, 'Každý predaný kus trochu zníži výkupnú cenu – trh sa nasycuje. Cez noc zákazníci kvety rozkúpia.'));
        const ids = hotbarIds().filter(id => !D.isTool(id) && marketSellPrice(id) > 0);
        if (!ids.length) body.appendChild(h('p', null, 'Nemáš nič na predaj. Vypestuj nejaké kvety! 🌷'));
        for (const id of ids) {
          const n = S.inv[id], f = id.startsWith('fl_') && M.flowers[id.slice(3)];
          const o = f && oldestBatch(id);
          const p = o ? Math.max(1, Math.round(marketSellPrice(id) * o.fresh)) : marketSellPrice(id);
          const line = h('small', null, `${n} ks · ${p} 🪙/ks `);
          if (f) { line.appendChild(priceTrend(f.h, f.p, true)); line.appendChild(document.createTextNode(` · na trhu ${f.st} ks`)); }
          const info = h('div', { class: 'info' }, h('b', null, D.itemName(id)), line);
          if (o) info.appendChild(h('small', { style: `color:${freshColor(o.rem)};font-weight:700` }, `🌷 ${freshText(id)}`));
          body.appendChild(h('div', { class: 'row' }, img(id), info,
            h('div', { class: 'btns' },
              h('button', { class: 'btn', onclick: () => { send({ t: 'sell', id, n: 1 }); sfx('coin'); } }, '1'),
              h('button', { class: 'btn alt', onclick: () => { send({ t: 'sell', id, n }); sfx('coin'); } }, 'Všetko'))));
        }
      } else if (tab === 'up') {
        const lvl = D.repLevel(S.rep), next = D.REP_LEVELS[lvl + 1];
        body.appendChild(h('div', { class: 'row', style: 'flex-direction:column;align-items:stretch' },
          h('b', null, `⭐ Reputácia: ${S.rep} · úroveň ${lvl}`),
          h('div', { style: 'height:8px;background:#eee;border-radius:4px;overflow:hidden' }, h('div', { style: `height:100%;width:${next ? Math.min(100, (S.rep - D.REP_LEVELS[lvl]) / (next - D.REP_LEVELS[lvl]) * 100) : 100}%;background:#e8a21c` })),
          h('small', null, next ? `Do úrovne ${lvl + 1} chýba ${next - S.rep}. Reputáciu získaš za splnené zákazky na nástenke pri babke.` : 'Najvyššia úroveň!'),
          h('small', null, `Naraz môžeš mať ${S.maxActive} ${S.maxActive === 1 ? 'zákazku' : 'zákazky'}. Veľké zákazky sa objavujú od úrovne 2, plesnivec od úrovne 2.`)));
        for (const kind in D.UPGRADES) {
          const u = D.UPGRADES[kind], cur = (S.up && S.up[kind]) || 0, nx = u.levels[cur + 1];
          const info = h('div', { class: 'info' }, h('b', null, `${u.icon} ${u.name}`), h('small', null, `teraz: ${u.levels[cur].v === 999 ? 'neobmedzene' : u.levels[cur].v} ${u.unit}` + (kind === 'plots' ? ` (využité ${S.plotsUsed})` : '')));
          let btn;
          if (!nx) btn = h('button', { class: 'btn gray', disabled: 'disabled' }, 'Max');
          else {
            info.appendChild(h('small', null, `ďalej: ${nx.v === 999 ? 'neobmedzene' : nx.v} ${u.unit}` + (nx.rep ? ` · treba ⭐${nx.rep}` : '')));
            btn = h('button', { class: 'btn', onclick: () => send({ t: 'upgrade', kind }) }, nx.price + '🪙');
            if (S.coins < nx.price || lvl < nx.rep) btn.disabled = true;
          }
          body.appendChild(h('div', { class: 'row' }, h('div', { style: 'font-size:30px;width:40px;text-align:center' }, u.icon), info, h('div', { class: 'btns' }, btn)));
        }
        // Náradie (raz na hráča) a spoločná stavba – ľadovňa
        const buyRow = (icon, name, desc, have, price, rep, onclick) => {
          const btn = have ? h('button', { class: 'btn gray', disabled: 'disabled' }, have) : h('button', { class: 'btn', onclick }, price + '🪙');
          if (!have && (S.coins < price || lvl < rep)) btn.disabled = true;
          body.appendChild(h('div', { class: 'row' }, h('div', { style: 'font-size:30px;width:40px;text-align:center' }, icon),
            h('div', { class: 'info' }, h('b', null, `${icon} ${name}`), h('small', null, desc + (rep ? ` · treba ⭐${rep}` : ''))), h('div', { class: 'btns' }, btn)));
        };
        for (const id in D.TOOLS) {
          const T = D.TOOLS[id];
          buyRow(T.icon, T.name, T.desc, S.inv[id] ? 'Máš' : null, T.price, T.rep, () => send({ t: 'buyTool', id }));
        }
        const B = D.ICEHOUSE;
        buyRow(B.icon, B.name, `Spoločná stavba pri domčeku pre ${B.cap} blokov ľadu. Kým je v nej ľad, kvety v sklade vädnú 4× pomalšie (inak 2×). Ľad sa topí, v zime nie.`,
          S.icehouse.built ? 'Stojí' : null, B.price, B.rep, () => send({ t: 'build', id: 'icehouse' }));
      } else {
        festivalBanner(body);
        if (!M.news.length) body.appendChild(h('p', null, 'Zatiaľ žiadne správy.'));
        for (const n of M.news) body.appendChild(h('div', { class: 'row' }, h('div', { class: 'info' }, h('small', null, fmtTick(n.tick)), h('span', { style: 'font-size:14px' }, n.text))));
      }
    });
  }

  function renderCauldron(body) {
    const slots = h('div', { class: 'cauldron-slots' });
    for (let i = 0; i < 3; i++) {
      const id = S.cauldron[i];
      slots.appendChild(h('div', { class: 'cslot', onclick: () => { S.cauldron.splice(i, 1); S.modal.refresh(); } }, id ? img(id) : null));
    }
    if (S.brewed) {
      const p = D.POTIONS[S.brewed];
      body.appendChild(h('div', { class: 'row', style: 'border-color:#9b59d0;background:#f7eeff' }, img('po_' + S.brewed),
        h('div', { class: 'info' }, h('b', null, 'Uvarené: ' + p.name + '!'), h('small', null, p.desc))));
    }
    body.appendChild(h('p', { style: 'margin:4px 0;font-size:14px;text-align:center' }, 'Vlož do kotlíka tri kvety a uvidíš, čo sa stane…'));
    body.appendChild(slots);
    body.appendChild(h('button', { class: 'big', style: 'margin-bottom:12px', onclick: () => { if (S.cauldron.length === 3) send({ t: 'brew', items: S.cauldron.slice() }); } }, S.cauldron.length === 3 ? '🔥 Uvariť!' : `Vyber ešte ${3 - S.cauldron.length}`));
    const grid = h('div', { class: 'grid' });
    const flowers = hotbarIds().filter(id => id.startsWith('fl_'));
    if (!flowers.length) body.appendChild(h('p', null, 'Nemáš žiadne kvety. Najprv nejaké vypestuj. 🌱'));
    for (const id of flowers) {
      const left = S.inv[id] - S.cauldron.filter(x => x === id).length;
      grid.appendChild(h('div', { class: 'gcell', style: left ? '' : 'opacity:.35', onclick: () => { if (left > 0 && S.cauldron.length < 3) { S.cauldron.push(id); S.brewed = null; S.modal.refresh(); } } }, img(id), h('span', { class: 'n' }, String(left))));
    }
    body.appendChild(grid);
    body.appendChild(h('h3', { style: 'margin:14px 0 6px' }, `📜 Objavené recepty (${S.recipes.length}/${Object.keys(D.RECIPES).length})`));
    if (!S.recipes.length) body.appendChild(h('small', null, 'Zatiaľ žiadne. Babka a studňa vraj poznajú pár tajomstiev.'));
    for (const key of S.recipes) {
      const k = D.RECIPES[key];
      const row = h('div', { class: 'row' });
      key.split('+').forEach(sp => row.appendChild(img('fl_' + sp)));
      row.appendChild(h('span', null, '→'));
      row.appendChild(img('po_' + k));
      row.appendChild(h('div', { class: 'info' }, h('b', null, D.POTIONS[k].name)));
      body.appendChild(row);
    }
  }

  function renderBabka(body) {
    const pc = h('canvas', { width: 80, height: 90 });
    Art.char(pc.getContext('2d'), 40, 86, 80, { shirt: '#7b4a9e', hair: '#eee' }, 0, 0, { babka: true });
    const hr = curMin() / 60;
    const hello = hr < 10 ? 'Dobré ránko' : hr < 18 ? 'Dobrý deň' : 'Dobrý večer';
    body.appendChild(h('div', { class: 'dlg' }, pc, h('div', { class: 'bubble' }, `${hello}, ${S.name}! Na nástenke pri mojej chalúpke nechávajú ľudia zákazky. Zober si, čo stihneš – termín sa musí dodržať. 💡 ${D.TIPS[S.tipIdx]}`)));
    const me = S.name.toLowerCase();
    const list = (S.board || []);
    const mine = list.filter(c => c.takenBy === me);
    const kindLbl = { short: 'krátka', long: 'na budúce obdobie', big: 'veľká' };
    const card = (c, actions) => {
      const sp = D.SPECIES[c.sp];
      const info = h('div', { class: 'info' },
        h('b', null, `${c.n}× ${sp.name}`),
        h('small', null, `${D.GIVERS[c.giver]} · ${kindLbl[c.kind]}`),
        h('small', null, `⏰ termín o ${fmtLeft(c.due - S.tick)}` + (!c.takenBy ? ` · rezervovať do ${fmtLeft(c.openUntil - S.tick)}` : '')),
        h('small', null, `🎁 ${c.reward} 🪙 · ⭐ +${c.rep}` + (c.item ? ` · ${c.item.n}× ${D.itemName(c.item.id)}` : '')));
      if (c.takenBy) info.appendChild(h('small', null, `📦 odovzdané ${c.got}/${c.n}`));
      return h('div', { class: 'row', style: c.kind === 'big' ? 'border-color:#e08a1e' : c.kind === 'long' ? 'border-color:#9b59d0' : '' }, img('fl_' + c.sp), info, h('div', { class: 'btns', style: 'flex-direction:column' }, ...actions));
    };
    body.appendChild(h('h3', { style: 'margin:10px 0 6px' }, `📋 Moje zákazky (${mine.length}/${S.maxActive})`));
    if (!mine.length) body.appendChild(h('small', null, 'Zatiaľ nemáš žiadnu. Zarezervuj si nejakú z nástenky.'));
    for (const c of mine) {
      const have = S.inv['fl_' + c.sp] || 0;
      const b = h('button', { class: 'btn alt', onclick: () => send({ t: 'cdeliver', id: c.id }) }, `Odovzdať (${have})`);
      if (!have) b.disabled = true;
      body.appendChild(card(c, [b]));
    }
    body.appendChild(h('h3', { style: 'margin:14px 0 6px' }, '📌 Nástenka'));
    const open = list.filter(c => !c.takenBy);
    if (!open.length) body.appendChild(h('small', null, 'Nástenka je prázdna. Ráno pribudnú nové zákazky.'));
    for (const c of open) {
      const b = h('button', { class: 'btn', onclick: () => send({ t: 'ctake', id: c.id }) }, 'Zarezervovať');
      if (mine.length >= S.maxActive) b.disabled = true;
      body.appendChild(card(c, [b]));
    }
    const others = list.filter(c => c.takenBy && c.takenBy !== me);
    if (others.length) {
      body.appendChild(h('h3', { style: 'margin:14px 0 6px' }, '👥 Zákazky ostatných'));
      for (const c of others) body.appendChild(card(c, [h('small', null, c.takenBy)]));
    }
    body.appendChild(h('button', { class: 'btn gray', style: 'margin-top:10px;width:100%', onclick: () => { S.tipIdx = (S.tipIdx + 1) % D.TIPS.length; S.modal.refresh(); } }, 'Ďalšia rada'));
  }

  function openBook(tab) {
    openModal('📖 Herbár', body => {
      body.appendChild(h('div', { class: 'tabs' },
        h('button', { class: tab === 'flowers' ? 'on' : '', onclick: () => openBook('flowers') }, '🌼 Kvety'),
        h('button', { class: tab === 'potions' ? 'on' : '', onclick: () => openBook('potions') }, '🧪 Elixíry')));
      if (tab === 'flowers') {
        for (const k in D.SPECIES) {
          const sp = D.SPECIES[k];
          const known = !sp.magic || S.seen.includes(k);
          const card = h('div', { class: 'card' + (sp.magic ? ' magic' : '') + (known ? '' : ' locked') });
          if (!known) {
            card.appendChild(h('div', { style: 'width:56px;height:56px;font-size:40px;text-align:center' }, '❔'));
            card.appendChild(h('div', null, h('b', null, '??? – čarovný kvet'), h('p', null, sp.shape === 'fern' ? 'Starí ľudia o ňom rozprávajú len potichu… v noci, pri lese.' : 'Vraj sa zrodil z lásky.')));
          } else {
            card.appendChild(img('fl_' + k));
            card.appendChild(h('div', null, h('b', null, sp.name), h('div', { class: 'latin' }, sp.latin), seasonBadges(sp),
              h('div', { style: 'font-size:12.5px;margin-top:3px' }, `⏱ ${sp.days} dní · ${'💧'.repeat(sp.water)} · ${({ sun: '☀️ slnko', shade: '🌳 tieň', any: '⛅ hocikde' })[sp.light]}${sp.soil ? ' · ' + ({ sand: '🏖️ piesok', rich: '🟤 výživná pôda', rock: '🪨 len skalka' })[sp.soil] : ''}${sp.perennial ? ' · ♻️ trvalka' : ''} · ✂️ vo váze ${sp.life} ${sp.life === 1 ? 'deň' : sp.life < 5 ? 'dni' : 'dní'}`),
              h('p', null, sp.fact)));
          }
          body.appendChild(card);
        }
      } else {
        for (const k in D.POTIONS) {
          if (k === 'sliz') continue;
          const key = Object.keys(D.RECIPES).find(r => D.RECIPES[r] === k);
          const known = S.recipes.includes(key);
          const card = h('div', { class: 'card' + (known ? ' magic' : ' locked') }, img('po_' + k),
            h('div', null, h('b', null, known ? D.POTIONS[k].name : '??? elixír'), h('p', null, known ? D.POTIONS[k].desc + ' Recept: ' + key.split('+').map(s => D.SPECIES[s].name).join(' + ') : 'Recept zatiaľ nepoznáš. Experimentuj v kotlíku alebo sa pýtaj babky.')));
          body.appendChild(card);
        }
      }
    });
  }

  function renderMenu(body) {
    const link = location.origin + location.pathname + '?room=' + S.room;
    body.appendChild(h('div', { class: 'row' }, h('div', { class: 'info' }, h('b', null, 'Záhrada: ' + S.room), h('small', null, 'Hráči: ' + S.names.join(', ')))));
    body.appendChild(h('div', { class: 'row' }, h('div', { class: 'info' }, h('b', null, 'Pozvi kamaráta'), h('small', { style: 'word-break:break-all' }, link)),
      h('button', { class: 'btn', onclick: () => { (navigator.share ? navigator.share({ title: 'Čarovná záhrada', url: link }) : navigator.clipboard.writeText(link).then(() => toast('Odkaz skopírovaný 📋'))).catch(() => { }); } }, 'Zdieľať')));
    // Nastavenia sveta – platia pre všetkých hráčov v tejto záhrade
    body.appendChild(h('h3', { style: 'margin:12px 0 6px' }, '⚙️ Nastavenia sveta'));
    const setBtn = (label, on, patch) => h('button', { class: 'btn' + (on ? '' : ' gray'), style: 'flex:1', onclick: () => send(Object.assign({ t: 'settings', mode: S.mode }, patch)) }, label);
    body.appendChild(h('div', { class: 'row', style: 'flex-direction:column;align-items:stretch' },
      h('b', null, 'Keď nikto nehrá'),
      h('div', { style: 'display:flex;gap:6px' },
        setBtn('▶️ Svet beží ďalej', S.mode === 'running', { mode: 'running' }),
        setBtn('⏸️ Svet sa pozastaví', S.mode === 'paused', { mode: 'paused' })),
      h('small', null, S.mode === 'running' ? 'Rastliny rastú (a smädia) aj keď si offline. Po návrate uvidíš, čo sa zmenilo.' : 'Čas plynie len vtedy, keď je v záhrade aspoň jeden hráč.')));
    body.appendChild(h('div', { class: 'row' }, h('div', { class: 'info' },
      h('b', null, `🕰️ Herný deň trvá ${Math.round(S.daySeconds / 60)} minút`),
      h('small', null, `Ročné obdobie = ${D.DAYS_PER_SEASON} dni (~${Math.round(S.daySeconds * D.DAYS_PER_SEASON / 60)} min), rok ≈ ${Math.round(S.daySeconds * D.DAYS_PER_SEASON * 4 / 3600 * 10) / 10} h.`))));
    // Nastavenie tohto zariadenia (3D): odrazy na vode – náročnosť podľa výkonu telefónu/počítača
    if (R3) {
      body.appendChild(h('h3', { style: 'margin:12px 0 6px' }, '📱 Toto zariadenie'));
      const opts = [['none', 'žiadne'], ['medium', 'stredné'], ['real', 'skutočné']];
      const btns = opts.map(([q, l]) => h('button', { class: 'btn' + (R3.waterQuality === q ? '' : ' gray'), style: 'flex:1', onclick: () => {
        R3.setWaterQuality(q); btns.forEach((b, i) => b.classList.toggle('gray', opts[i][0] !== q));
      } }, l));
      body.appendChild(h('div', { class: 'row', style: 'flex-direction:column;align-items:stretch' },
        h('b', null, '🌊 Odrazy vody'), h('div', { style: 'display:flex;gap:6px' }, ...btns),
        h('small', null, 'Platí len na tomto zariadení. Skutočné odrazy ukážu vo vode aj hráčov a kvety, ale viac zaťažia telefón.')));
      const popts = [['low', 'menej'], ['high', 'viac']];
      const pbtns = popts.map(([q, l]) => h('button', { class: 'btn' + (R3.particleQuality === q ? '' : ' gray'), style: 'flex:1', onclick: () => {
        R3.setParticleQuality(q); pbtns.forEach((b, i) => b.classList.toggle('gray', popts[i][0] !== q));
      } }, l));
      body.appendChild(h('div', { class: 'row', style: 'flex-direction:column;align-items:stretch' },
        h('b', null, '✨ Častice (dážď, oheň, lístie, víly)'), h('div', { style: 'display:flex;gap:6px' }, ...pbtns),
        h('small', null, 'Platí len na tomto zariadení. Na slabšom telefóne zvoľ menej.')));
    }
    body.appendChild(h('button', { class: 'big', style: 'margin:6px 0', onclick: () => openUI('help') }, '❓ Ako hrať'));
    body.appendChild(h('button', { class: 'btn gray', style: 'width:100%;padding:12px', onclick: () => { S.joined = false; S.ws && S.ws.close(); location.reload(); } }, 'Odísť zo záhrady'));
  }

  // Domček: posteľ (spánok) a spoločný sklad
  function renderHouse(body) {
    const ok = D.canSleep(realMin());
    const b = h('button', { class: 'btn', onclick: () => { send({ t: 'sleep', on: true }); closeModal(); } }, '🛏️ Ísť spať');
    if (!ok) b.disabled = true;
    const n = S.sleepTotal || 1;
    const note = !ok ? 'Spať sa dá od 18:00 do 6:00.'
      : n > 1 ? `Noc prebehne, keď pôjdu spať všetci v záhrade (${S.sleepN || 0}/${n} spí).` : 'Noc prebehne rýchlo až do rána.';
    body.appendChild(h('div', { class: 'row' }, h('div', { class: 'info' }, h('b', null, '🛏️ Posteľ'), h('small', null, note)), h('div', { class: 'btns' }, b)));
    renderStorage(body);
  }

  // Ľadovňa: koľko ľadu v nej je, ako rýchlo sa topí, vloženie ľadu z batohu
  function renderIcehouse(body) {
    const B = D.ICEHOUSE, ice = S.icehouse.ice || 0, se = season();
    const melt = B.melt[se], full = Math.ceil(ice);
    body.appendChild(h('div', { class: 'row', style: 'flex-direction:column;align-items:stretch' },
      h('b', null, `🧊 Ľad: ${full}/${B.cap}`),
      h('div', { style: 'height:10px;background:#eee;border-radius:5px;overflow:hidden' }, h('div', { style: `height:100%;width:${ice / B.cap * 100}%;background:#6ec6ff` })),
      h('small', null, ice <= 0 ? 'Ľadovňa je prázdna – sklad chladí len trochu (kvety vädnú 2× pomalšie).'
        : `Sklad je vychladený – kvety v ňom vädnú 4× pomalšie. ` + (melt ? `Ľad sa roztopí asi o ${fmtLeft(ice / melt * 12)}.` : 'V zime sa ľad netopí. ❄️'))));
    const n = S.inv.ice || 0;
    const b = h('button', { class: 'btn', onclick: () => send({ t: 'icehouse', n }) }, n ? `Vložiť ľad (${n})` : 'Nemáš ľad');
    if (!n || full >= B.cap) b.disabled = true;
    body.appendChild(h('div', { class: 'row' }, img('ice'), h('div', { class: 'info' }, h('b', null, 'Doplniť ľad'),
      h('small', null, 'Ľad vysekáš krompáčom na ľadovci v horách (chodník na severovýchode záhrady), v zime aj na zamrznutom jazierku.')), h('div', { class: 'btns' }, b)));
  }

  // Prekrytie počas spánku: čakanie na ostatných, potom zrýchlená noc
  function renderSleep() {
    const el = $('sleep');
    el.classList.toggle('hidden', !S.asleep);
    if (!S.asleep) return;
    if (S.modal) closeModal();
    $('slTxt').textContent = S.ff ? 'Spíš… noc ubieha 🌙' : `Čakáš, kým pôjdu spať aj ostatní (${S.sleepN}/${S.sleepTotal}).`;
    $('slWake').classList.toggle('hidden', !!S.ff);
  }
  $('slWake').onclick = () => send({ t: 'sleep', on: false });

  function renderStorage(body) {
    body.appendChild(h('p', { style: 'margin:4px 0 10px;font-size:14px' }, 'Sklad je spoločný pre všetkých v záhrade. Peniaze má každý svoje. ' +
      (S.storageRate < D.STORAGE_AGE_RATE ? '🧊 Ľadovňa sklad chladí – kvety v ňom vädnú 4× pomalšie.' : '❄️ V chlade skladu kvety vädnú 2× pomalšie.' + (S.icehouse.built ? ' Doplň ľad do ľadovne a budú vädnúť 4× pomalšie.' : ''))));
    const wl = S.inv.wilted || 0;
    if (wl) {
      const k = Math.floor(wl / D.WILTED_PER_COMPOST);
      const b = h('button', { class: 'btn alt', onclick: () => send({ t: 'compostWilted' }) }, k ? `Skompostovať → ${k}× kompost` : `treba ${D.WILTED_PER_COMPOST}`);
      if (!k) b.disabled = true;
      body.appendChild(h('div', { class: 'row' }, img('wilted'), h('div', { class: 'info' }, h('b', null, `Zvädnuté kvety: ${wl}`), h('small', null, `${D.WILTED_PER_COMPOST} zvädnuté = 1 kompost`)), h('div', { class: 'btns' }, b)));
    }
    const section = (title, items, from) => {
      body.appendChild(h('h3', { style: 'margin:10px 0 6px' }, title));
      const ids = Object.keys(items).filter(id => items[id] > 0 && !D.isTool(id) && id !== 'ice'); // ľad patrí do ľadovne
      if (!ids.length) body.appendChild(h('small', null, from === 'inv' ? 'Nemáš nič, čo by sa dalo uložiť.' : 'Sklad je prázdny.'));
      for (const id of ids) {
        const n = items[id], t = from === 'inv' ? 'store' : 'unstore';
        const ft = id.startsWith('fl_') ? freshText(id, from !== 'inv') : '';
        body.appendChild(h('div', { class: 'row' }, h('img', { src: Art.icon(id) }), h('div', { class: 'info' }, h('b', null, D.itemName(id)), h('small', null, n + ' ks'), ft ? h('small', null, '🌷 ' + ft) : null),
          h('div', { class: 'btns' },
            h('button', { class: 'btn', onclick: () => send({ t, id, n: 1 }) }, from === 'inv' ? 'Uložiť 1' : 'Vziať 1'),
            h('button', { class: 'btn alt', onclick: () => send({ t, id, n }) }, 'Všetko'))));
      }
    };
    section('📦 V sklade', S.storage, 'storage');
    section('🎒 V batohu', S.inv, 'inv');
  }

  function renderHelp(body) {
    body.appendChild(h('div', { class: 'help', html: `
      <p>🕹️ <b>Pohyb:</b> polož prst kdekoľvek na obrazovku a potiahni – v mieste dotyku sa objaví joystick. Alebo ťukni na miesto, kam chceš ísť. Na počítači šípky/WASD (E alebo Enter = akcia na políčku pred tebou) alebo ťahanie myšou.</p>
      <p>🦘 <b>Skok a plazenie:</b> medzerník = skok, držaný Shift = plazenie. Na mobile tlačidlá ⤴ a 🐛 vpravo dole; počas riadenia joystickom stačí ťuknúť druhým prstom kamkoľvek a skočíš.</p>
      <p>👆 <b>Ťuknutím na objekt</b> (trh, babka, kotlík, studňa, kvet, kamarát) s ním hneď niečo urobíš – ak je ďaleko, postavička k nemu dôjde sama.</p>
      <p>🟡 <b>Práca so zemou:</b> ťukni na políčko vedľa seba – čo sa stane, závisí od vybranej veci v lište. Vzdialené políčko najprv dôjdeš, druhým ťuknutím ho napr. prekopeš.</p>
      <p>⛏️ <b>Motykou</b> prekopeš trávu, piesok, lesnú pôdu alebo skalku. 🌱 Potom zasaď <b>semienka</b> a 💧 <b>polievaj</b> krhlou (načrieš v jazierku alebo studni).</p>
      <p>☀️🌳 Každý kvet má svoje nároky: <b>ročné obdobie, svetlo, pôdu a vodu</b> – nájdeš ich v 📖 Herbári. Spokojná rastlina dá až 3 kvety, kompost pridá ešte jeden.</p>
      <p>🛏️ <b>Spánok:</b> od 18:00 si môžeš ísť ľahnúť do domčeka. Keď spia všetci v záhrade, noc rýchlo prebehne až do 6:00 (ale prídeš o nočné čary).</p>
      <p>🌙 Nový deň začína o 6:00 – vtedy rastliny porastú. Každé obdobie trvá ${D.DAYS_PER_SEASON} dni. V zime prežijú len zimné kvety!</p>
      <p>🪙 <b>Začínaš chudobne:</b> pár semienok, malá krhla a povolenie na 8 políčok. Väčšiu krhlu, pole a kompostér kúpiš na trhu (Vylepšiť).</p>
      <p>🛒 <b>Trh žije:</b> semienok je obmedzene a v sezóne zdražejú – kupuj ich vopred, keď veľkoobchodník privezie tovar na ďalšie obdobie. Výkupná cena kvetov klesá, keď ich je na trhu veľa, a rastie počas sviatkov (ohlásené 2 dni vopred). Na trhu obchoduje aj záhradník Jano, špekulant Fero a kvetinárka Zuzka – sleduj Správy.</p>
      <p>📋 <b>Zákazky</b> nájdeš na nástenke pri 👵 babke. Zarezervuj si ich, termín platí; odovzdávať môžeš aj po častiach. Za splnenie dostaneš peniaze a ⭐ reputáciu, za nesplnenie reputáciu stratíš. ⚗️ V babkinom <b>kotlíku</b> sa z troch kvetov varia elixíry.</p>
      <p>🥀 <b>Kvety vädnú:</b> odrezaný kvet vydrží len pár dní (mak 2, tulipán 4, chryzantéma 7…) a s vekom klesá jeho výkupná cena. Rozkvitnutá rastlina na poli po čase odkvitne. V chladnom sklade vädnú kvety 2× pomalšie, zvädnuté sa dajú skompostovať.</p>
      <p>📦 V <b>domčeku</b> je spoločný sklad pre celú záhradu – peniaze má každý svoje.</p>
      <p>🏔️ <b>Hory:</b> chodník na severovýchodnom okraji záhrady (za babkinou chalúpkou) vedie do hôr. Na ľadovci pod skalami vysekáš <b>krompáčom</b> ⛏️ ľad – každé ťuknutie zoberie vrchnú vrstvu. Ľadu je málo: ľadovec sám nedorastá, len keď prší alebo sneží, a v teple sa topí od okrajov. Kto ho vykope priveľa, nechá ostatných bez ľadu. V zime vysekáš ľad aj na zamrznutom jazierku (z každého políčka raz za deň).</p>
      <p>🧊 Uneseš najviac ${D.ICE_CARRY} kusov ľadu, ťahá ťa dolu (chodíš pomalšie) a do pol dňa sa ti v batohu roztopí – ponáhľaj sa s ním do ľadovne. V lete ho trh dobre vykúpi, v zime takmer vôbec.</p>
      <p>🧊 <b>Ľadovňa</b> pri domčeku (kúpi ju ktokoľvek na trhu v záložke Vylepšiť) drží ${D.ICEHOUSE.cap} blokov ľadu. Kým je v nej ľad, kvety v sklade vädnú 4× pomalšie. Ľad sa topí – v lete rýchlo, v zime vôbec – tak ho dopĺňaj.</p>
      <p>⚙️ V menu sa dá nastaviť, či svet <b>beží ďalej aj bez hráčov</b>, a ako dlho trvá herný deň.</p>
      <p>🎁 Darovať môžeš čokoľvek – vyber vec a ťukni na kamaráta. 💃 Tancovať a mávať môžeš tlačidlami.</p>
      <p>✨ A v lese… v lese sa vraj dejú čary. Ale to si musíte objaviť sami.</p>` }));
  }

  function renderWish(body) {
    body.appendChild(h('p', { style: 'text-align:center' }, 'Kvet papradia sa rozžiaril v tvojich dlaniach. Máš jedno želanie…'));
    const opts = [
      ['zlato', '💰 Zlatý dážď', 'Každý hráč v záhrade dostane 400 mincí.'],
      ['jar', '🌸 Večná jar', 'Záhrada sa navždy polieva sama a kvetom nevadí ročné obdobie.'],
      ['poklad', '🎁 Poklad víl', 'Dúhové semienka, plesnivce a nové papraďové semienko.']
    ];
    for (const [k, t, d] of opts) body.appendChild(h('button', { class: 'wish', onclick: () => { send({ t: 'wish', kind: k }); closeModal(); } }, h('b', null, t), d));
  }

  // Chat
  const closeChat = () => { $('chatbox').classList.remove('open'); $('chatIn').blur(); chatWheel(); };
  function openChat() { $('chatbox').classList.add('open'); $('chathist').scrollTop = $('chathist').scrollHeight; chatWheel(); $('chatIn').focus(); }
  $('bChat').onclick = () => { if ($('chatbox').classList.contains('open')) closeChat(); else openChat(); };
  const sendChat = () => { const v = $('chatIn').value.trim(); if (v) send({ t: 'chat', text: v }); $('chatIn').value = ''; chatCount(); closeChat(); };
  $('chatSend').onclick = sendChat;
  // Limit správy (rovnaký ako na serveri); počítadlo sa ukáže 20 znakov pred koncom
  $('chatIn').maxLength = D.CHAT_MAX;
  const chatCount = () => { const n = $('chatIn').value.length; $('chatCount').textContent = n >= D.CHAT_MAX - 20 ? `${n}/${D.CHAT_MAX}` : ''; $('chatCount').classList.toggle('full', n >= D.CHAT_MAX); };
  $('chatIn').addEventListener('input', chatCount);
  // Enter/Escape patria len chatu – sendChat/closeChat zruší fokus, takže by ich inak zachytila hra (Enter = akcia)
  $('chatIn').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); sendChat(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeChat(); }
  });

  // ---------- Efekty ----------
  function spawnFx(m) {
    const P = (o) => S.fx.push(Object.assign({ life: 0, max: 1, vx: 0, vy: 0, g: 0, size: 0.06 }, o));
    const R = (a) => (Math.random() - 0.5) * a;
    switch (m.k) {
      case 'pop': case 'sparkle':
        for (let i = 0; i < (m.k === 'sparkle' ? 30 : 12); i++) P({ x: m.x, y: m.y - 0.3, vx: R(3), vy: -Math.random() * 2.5, g: 3, color: i % 3 ? m.c || '#ffd54f' : '#fff', max: 0.9 + Math.random() * 0.5, star: m.k === 'sparkle' });
        break;
      case 'ice': for (let i = 0; i < 12; i++) P({ x: m.x, y: m.y, vx: R(2.5), vy: -Math.random() * 2.2, g: 6, color: i % 3 ? '#cdeeff' : '#ffffff', max: 0.7 }); break;
      case 'dirt': for (let i = 0; i < 10; i++) P({ x: m.x, y: m.y, vx: R(2.5), vy: -Math.random() * 2, g: 6, color: '#7a4a20', max: 0.6 }); break;
      case 'drops': for (let i = 0; i < 10; i++) P({ x: m.x + R(0.6), y: m.y - 0.8, vy: 1 + Math.random(), g: 4, color: '#5fb8ff', max: 0.5 }); break;
      case 'splash': for (let i = 0; i < 14; i++) P({ x: m.x, y: m.y, vx: R(3), vy: -Math.random() * 3, g: 7, color: '#8fd3ff', max: 0.6 }); if (R3) R3.ripple(m.x, m.y, 1); break;
      case 'hearts': for (let i = 0; i < 10; i++) P({ x: m.x + R(1), y: m.y - 0.6, vx: R(0.5), vy: -0.8 - Math.random(), text: '❤️', max: 1.8 }); break;
      case 'gift': P({ x: m.x, y: m.y - 1, vy: -0.6, text: '🎁', max: 1.5 }); break;
      case 'wave': P({ x: m.x, y: m.y - 1.2, vy: -0.4, text: '👋', max: 1.2 }); break;
      case 'burp': for (let i = 0; i < 5; i++) P({ x: m.x + R(0.6), y: m.y - 1, vy: -0.5 - Math.random() * 0.5, text: '🫧', max: 1.6 }); break;
      case 'brew': for (let i = 0; i < 20; i++) P({ x: m.x + R(0.5), y: m.y - 0.6, vx: R(0.6), vy: -1 - Math.random() * 1.5, color: m.c, max: 1.4, size: 0.09 }); break;
      case 'glimmer': for (let i = 0; i < 16; i++) P({ x: m.x + R(4), y: m.y + R(4), vy: -0.3, color: '#b9ffdf', max: 1.5, star: true }); break;
      case 'fairies':
        for (let i = 0; i < 9; i++) P({ fairy: true, cx: m.x, cy: m.y, a: i * 0.7, rad: 1 + Math.random() * 1.5, max: 9, color: ['#ff9cf0', '#9cf0ff', '#fff59c'][i % 3] });
        for (let i = 0; i < 40; i++) P({ x: m.x + R(5), y: m.y + R(5), vy: -0.4, color: '#fff8b0', max: 2 + Math.random() * 3, star: true });
        break;
      case 'rainbow': S.screenFx.push({ k: 'rainbow', life: 0, max: 10 }); break;
      case 'gold': S.screenFx.push({ k: 'gold', life: 0, max: 4, coins: Array.from({ length: 50 }, () => ({ x: Math.random(), y: -Math.random(), v: 0.3 + Math.random() * 0.4 })) }); break;
    }
  }

  // ---------- Herná slučka ----------
  // Hra zaberá celú obrazovku; prekrytie #cv má rozlíšenie displeja, výrez sveta (D.VIEW_DIAG) nastaví 3D kamera.
  function resize() {
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const r = cv.getBoundingClientRect();
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    if (R3) R3.resize();
  }
  addEventListener('resize', resize);
  // Chat aj tlačidlá skoku a plazenia sa držia nad lištou nástrojov, nech je akokoľvek vysoká (mobil / počítač)
  function barH() { const app = $('app'), r = $('bottom').getBoundingClientRect(); app.style.setProperty('--bar-h', Math.max(0, Math.round(app.getBoundingClientRect().bottom - r.top)) + 'px'); }
  new ResizeObserver(barH).observe($('bottom'));
  addEventListener('resize', barH);
  addEventListener('resize', () => chatWheel());

  function update(dt) {
    const me = S.me;
    let vx = S.stick.x, vy = S.stick.y;
    if (S.asleep || S.areaFx) { vx = vy = 0; S.keys = {}; S.path = null; }
    if (S.keys.l) vx -= 1; if (S.keys.r) vx += 1; if (S.keys.u) vy -= 1; if (S.keys.d) vy += 1;
    if (R3 && (vx || vy)) [vx, vy] = R3.screenToWorld(vx, vy); // joystick je vzhľadom na obrazovku, kamera je otočená
    if (vx || vy) stopWalk();
    if (S.path) {
      const pa = S.pendingAct;
      if (pa && !pa.onTile && inReach(pa.x, pa.y) && S.path.length <= 1) {
        stopWalk(); face(pa.x + 0.5 - me.x, pa.y + 0.5 - me.y); doAction(pa.x, pa.y);
      } else {
        const wp = S.path[0], dx = wp.x - me.x, dy = wp.y - me.y, d = Math.hypot(dx, dy);
        if (d < 0.1) {
          S.path.shift();
          if (!S.path.length) {
            S.path = null;
            if (pa) { S.pendingAct = null; face(pa.x + 0.5 - me.x, pa.y + 0.5 - me.y); doAction(pa.x, pa.y); }
          }
        } else { const sp = Math.min(1, d / (3.8 * dt)); vx = dx / d * sp; vy = dy / d * sp; }
      }
    }
    const len = Math.hypot(vx, vy);
    if (len > 1) { vx /= len; vy /= len; }
    me.moving = len > 0.05;
    me.crawl = !S.asleep && (S.crawlKey || S.crawlTgl) && !me.jz;
    if (me.jz > 0 || me.jv > 0) { me.jz += me.jv * dt; me.jv -= JUMP_G * dt; if (me.jz <= 0) me.jz = me.jv = 0; }
    if (me.moving) {
      // ťažký ľad v náručí spomaľuje
      const sp = 3.8 * dt * (me.crawl ? CRAWL_SPEED : 1) * Math.max(0.4, 1 - D.ICE_SLOW * (S.inv.ice || 0));
      const ox = me.x, oy = me.y;
      const rx = 0.26, ry = 0.16;
      const nx = me.x + vx * sp;
      if (!solid(nx - rx, me.y - ry) && !solid(nx + rx, me.y - ry) && !solid(nx - rx, me.y + ry) && !solid(nx + rx, me.y + ry)) me.x = nx;
      const ny = me.y + vy * sp;
      if (!solid(me.x - rx, ny - ry) && !solid(me.x + rx, ny - ry) && !solid(me.x - rx, ny + ry) && !solid(me.x + rx, ny + ry)) me.y = ny;
      face(vx, vy);
      me.a = Math.atan2(vy, vx); // presný smer pre 8-smerový sprite
      me.phase += dt * (me.crawl ? 7 : 11);
      if (S.path) {
        if (Math.hypot(me.x - ox, me.y - oy) < sp * 0.1) { S.stuckT += dt; if (S.stuckT > 0.6) stopWalk(); }
        else S.stuckT = 0;
      }
    } else me.phase = 0;
    // odoslanie pozície
    const now = performance.now();
    const key = me.x.toFixed(2) + ',' + me.y.toFixed(2) + ',' + me.dir + ',' + (me.a != null ? me.a.toFixed(1) : '') + ',' + me.crawl;
    if (key !== S.lastSent && now - S.sentAt > 90) { send({ t: 'move', x: me.x, y: me.y, dir: me.dir, a: me.a, cr: me.crawl, ar: S.areaSeq }); S.lastSent = key; S.sentAt = now; }
    // ostatní hráči
    for (const o of S.others.values()) {
      const dx = o.tx - o.x, dy = o.ty - o.y;
      const k = Math.min(1, dt * 12);
      o.x += dx * k; o.y += dy * k;
      o.phase = Math.hypot(dx, dy) > 0.02 ? o.phase + dt * (o.cr ? 7 : 11) : 0;
      if (o.jz > 0 || o.jv > 0) { o.jz += o.jv * dt; o.jv -= JUMP_G * dt; if (o.jz <= 0) o.jz = o.jv = 0; }
    }
    // efekty
    for (const p of S.fx) {
      p.life += dt;
      if (p.fairy) continue;
      p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt;
    }
    S.fx = S.fx.filter(p => p.life < p.max);
    for (const f of S.screenFx) f.life += dt;
    S.screenFx = S.screenFx.filter(f => f.life < f.max);
    if (S.vily && Math.random() < dt * 0.8) S.fx.push({ fairy: true, cx: me.x + (Math.random() - 0.5) * 6, cy: me.y + (Math.random() - 0.5) * 6, a: Math.random() * 6, rad: 0.5 + Math.random(), life: 0, max: 4, color: '#ff9cf0' });
  }

  let last = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (S.joined) { update(dt); if (R3) R3.frame(now / 1000); }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
