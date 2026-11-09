// Čarovná záhrada – klient (#136: TypeScript, jeden balík esbuild; 3D pohľad sa načíta až po štarte ako ďalší kúsok)
import * as D from '../shared/data.ts';
import * as Bk from '../shared/book.ts';
import type { Level } from '../shared/book.ts';
import type { ItemId, Potion, Species, SpeciesId, UpgradeId } from '../shared/data.ts';
import * as Players from '../shared/players.ts';
import * as SpiderModel from '../shared/spidermodel.ts';
import type { ClientMessage, Emote, MarketItemView, ServerMessage, TileView, ToastKind, WebView, WishKind } from '../shared/protocol.ts';
import type { Contract, WorldMode } from '../shared/save.ts';
import { entries, isRecord, keys, lookup, must } from '../shared/util.ts';
import { Art } from './art.ts';
import { createVehicles } from './vehicles.ts';
import type { Render3D } from './render3d.ts';
import type { ClientState, CtxAction, Dir, FxParticle, MsgOf, OtherPlayer, Pt, UiKind } from './state.ts';

(() => {
  const $ = (id: string): HTMLElement => must(document.getElementById(id) ?? undefined);
  // prvok daného druhu (vstupné pole, plátno) – inak chyba v HTML
  const $as = <T extends HTMLElement>(id: string, type: new () => T): T => { const el = $(id); if (!(el instanceof type)) throw new Error('#' + id + ': zlý druh prvku'); return el; };
  const $in = (id: string): HTMLInputElement => $as(id, HTMLInputElement);
  const $cv = (id: string): HTMLCanvasElement => $as(id, HTMLCanvasElement);
  const ctx2d = (cv: HTMLCanvasElement): CanvasRenderingContext2D => must(cv.getContext('2d') ?? undefined);
  // položky podľa textového kľúča (id predmetu je napr. 'fl_mak', 'po_duha', 'seed_ruza')
  const speciesOf = (k: string): Species | undefined => D.isSpeciesId(k) ? D.SPECIES[k] : undefined;
  const potionOf = (k: string): Potion | undefined => D.isPotionId(k) ? D.POTIONS[k] : undefined;

  const SHIRTS = ['#4a90d9', '#e05a5a', '#5cb85c', '#f0ad4e', '#9b59d0', '#20b2aa', '#ff7eb6', '#555555'];
  const HAIRS = ['#5b3a1a', '#2b1a10', '#e8c36a', '#c0532a', '#9e9e9e', '#d96fa8', '#3a6ea5'];
  const EMOJI: Readonly<Record<string, string>> = { wave: '👋', heart: '❤️', laugh: '😂', flower: '🌸', dance: '🎵', sleep: '💤', search: '🔍', pull: '🕸️' };
  const EMOTES: readonly Emote[] = ['dance', 'wave', 'heart', 'laugh', 'flower'];
  const isEmote = (e: string | undefined): e is Emote => EMOTES.some(x => x === e);
  const SECRETS = [
    'Mesiac šepká: „Keď sa dvaja roztancujú v kruhu z húb, víly to nevydržia a pridajú sa…“',
    'Mesiac šepká: „Kto pije jesenný odvar víl, môže tancovať aj sám.“',
    'Mesiac šepká: „Papraďový kvet otvára oči len v noci. Hľadaj ho v tieni.“',
    'Mesiac šepká: „Tri dúhy v jednom kotlíku… a obloha sa zasmeje.“',
    'Mesiac šepká: „Studňa má na dne viac než len vodu. Občas aj semienko z rozprávky.“'
  ];

  const S: ClientState = {
    ws: null, id: 0, room: '', name: '', look: null,
    tiles: [], tick: 0, market: null, board: [], rep: 0, up: {}, canCap: 5, plotLimit: 8, plotsUsed: 0, maxActive: 1, orders: [], orderLimit: 2, day: 1, min: 390, weather: 'sun', timeAt: 0, tickMs: 1000, daySeconds: 300, mode: 'running', storage: {},
    me: { x: D.SPAWN.x, y: D.SPAWN.y, dir: 0, phase: 0, moving: false, jz: 0, jv: 0, crawl: false }, crawlKey: false, crawlTgl: false, myEmote: null,
    others: new Map(), inv: {}, coins: 0, water: 20, recipes: [], seen: [], vily: false,
    sel: 'hoe', area: 'garden', areaSeq: 0, W: D.W, H: D.H, tilesGen: 0, storageRate: D.STORAGE_AGE_RATE, icehouse: { built: false, ice: 0, bl: 0 }, dielna: { built: false, loom: false }, loom: { busy: false, mine: null, ready: 0 }, eternal: false, names: [],
    keys: {}, stick: { x: 0, y: 0 }, path: null, pendingAct: null, tapMark: null, lastSent: '', sentAt: 0,
    fx: [], screenFx: [], bubbles: {}, modal: null, cauldron: [], brewed: null, brewHint: null, anchors: {}, joined: false,
    skyTaps: [], tipIdx: Math.floor(Math.random() * D.TIPS.length), stuckT: 0,
    // pavúky (#57): pavučiny v Lese divov (webTile: políčko → pavučina), nory a čistina pradleny, kútové pavučiny krížiaka,
    // pavúky na ploche (plynulo dobiehajú polohu zo servera) a spomalenie (lepkavá pavučina, pavúk na chrbte)
    webs: [], webTile: new Map(), homes: [], websGen: 0, corner: [], cornerGen: 0, spiders: new Map(), slowK: 1, slowUntil: 0, web: null,
    r3: null
  };

  window.MF = S; // pre ladenie v konzole
  // fúrik a sane (#158): stav, predpoveď pohybu, okno, riadky v Dielni a miesto v lište
  const Veh = createVehicles({ S, send, toast, openModal, changed: () => { renderHotbar(); if (S.modal) S.modal.refresh(); }, left: t => fmtLeft(t), findPath: goal => findPath(goal) });

  // ---------- Zvuky ----------
  let actx: AudioContext | null = null;
  type Sfx = 'pop' | 'hop' | 'water' | 'magic' | 'coin' | 'dig' | 'bad';
  const NOTES: Readonly<Record<Sfx, readonly number[]>> = { pop: [660, 880], hop: [392, 784], water: [420, 300], magic: [523, 659, 784, 1047], coin: [988, 1319], dig: [140, 110], bad: [220, 180] };
  function sfx(kind: Sfx): void {
    try {
      const ac = actx = actx || new (window.webkitAudioContext ?? AudioContext)();
      NOTES[kind].forEach((f, i) => {
        const o = ac.createOscillator(), g = ac.createGain();
        o.type = kind === 'dig' ? 'triangle' : 'sine'; o.frequency.value = f;
        const t0 = ac.currentTime + i * 0.08;
        g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
        o.connect(g).connect(ac.destination); o.start(t0); o.stop(t0 + 0.2);
      });
    } catch { /* bez zvuku (prehliadač ho nepovolil) */ }
  }

  // ---------- Prihlásenie ----------
  const params = new URLSearchParams(location.search);
  // uložené meno, záhrada a vzhľad (localStorage – mohlo ho zmeniť čokoľvek, preto overené)
  const raw: unknown = JSON.parse(localStorage.getItem('mf') || '{}');
  const stored = isRecord(raw) ? raw : {};
  const str = (v: unknown): string => typeof v === 'string' ? v : '';
  $in('jName').value = str(stored['name']);
  $in('jRoom').value = params.get('room') || str(stored['room']);
  const savedLook = isRecord(stored['look']) ? stored['look'] : null;
  const look = { shirt: str(savedLook?.['shirt']) || must(SHIRTS[(Math.random() * SHIRTS.length) | 0]), hair: str(savedLook?.['hair']) || must(HAIRS[(Math.random() * HAIRS.length) | 0]), hat: savedLook ? savedLook['hat'] === true : true };

  function swatches(el: HTMLElement, list: readonly string[], key: 'shirt' | 'hair'): void {
    el.innerHTML = '';
    list.forEach(col => {
      const b = document.createElement('button');
      b.className = 'sw' + (look[key] === col ? ' on' : ''); b.style.background = col;
      b.onclick = () => { look[key] = col; swatches(el, list, key); preview(); };
      el.appendChild(b);
    });
  }
  function preview(): void {
    const c = ctx2d($cv('jPreview'));
    c.clearRect(0, 0, 96, 96);
    Art.char(c, 48, 88, 90, look, 0, 0, {});
  }
  swatches($('jShirt'), SHIRTS, 'shirt'); swatches($('jHair'), HAIRS, 'hair'); preview();

  $('jGo').onclick = () => {
    S.name = $in('jName').value.trim() || 'Záhradník';
    S.room = ($in('jRoom').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || 'zahrada').slice(0, 16);
    S.look = look;
    localStorage.setItem('mf', JSON.stringify({ name: S.name, room: S.room, look }));
    history.replaceState(null, '', location.pathname + '?room=' + S.room);
    sfx('pop');
    connect();
  };

  // ---------- Sieť ----------
  function send(m: ClientMessage): void { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(m)); }
  function connect(): void {
    $('conn').classList.remove('hidden');
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    S.ws = ws;
    ws.onopen = () => { send({ t: 'join', room: S.room, name: S.name, look: S.look }); };
    ws.onmessage = (e: MessageEvent<string>) => { onMsg(JSON.parse(e.data) as ServerMessage); }; // správy servera (protocol.ts)
    ws.onclose = () => {
      if (S.ws !== ws) return;
      if (S.joined) { $('conn').textContent = 'Spojenie stratené – pripájam znova…'; $('conn').classList.remove('hidden'); setTimeout(connect, 1500); }
    };
  }

  function onMsg(m: ServerMessage): void {
    // počas stmavovania pred prechodom sa správy z novej plochy odložia, kým sa svet za čiernou nevymení
    if (S.areaFx && S.areaFx.phase === 'out' && m.t !== 'area' && m.t !== 'welcome' && m.t !== 'error') { S.areaFx.queue.push(m); return; }
    switch (m.t) {
      case 'welcome':
        if (S.areaFx) endAreaFx(true); // nové pripojenie – rozbehnutý prechod už neplatí
        S.id = m.id; S.tiles = m.tiles; S.me.x = m.x; S.me.y = m.y; S.joined = true; S.others.clear(); // hráči sa načítajú znova (aj po znovupripojení)
        S.area = m.area; S.areaSeq = m.seq | 0; S.tilesGen++;
        S.W = m.w || D.W; S.H = m.h || D.H;
        findAnchors();
        if (!localStorage.getItem('mfHint')) { localStorage.setItem('mfHint', '1'); setTimeout(() => { toast('👆 Potiahni prstom kdekoľvek pre pohyb · ťukni na objekt pre akciu'); }, 600); }
        $('join').classList.add('hidden'); $('game').classList.remove('hidden'); $('conn').classList.add('hidden');
        resize();
        break;
      case 'me':
        S.coins = m.coins; S.water = m.water; S.inv = m.inv; S.recipes = m.recipes; S.seen = m.seen; S.vily = m.vily;
        S.fb = m.fb; S.fbTick = m.tick;
        Object.assign(S, { rep: m.rep, up: m.up, canCap: m.canCap, plotLimit: m.plotLimit, plotsUsed: m.plotsUsed, maxActive: m.maxActive, loom: m.loom, orders: m.orders, orderLimit: m.orderLimit });
        if (S.sel && !S.inv[S.sel]) S.sel = 'hoe'; // '' = prázdna ruka (vybraté prázdne miesto v lište)
        renderHotbar(); updateHud();
        if (S.modal) S.modal.refresh();
        break;
      case 'area': areaChange(m); break; // prechod do inej plochy (záhrada ↔ hory, záhrada ↔ Les na pomedzí)
      case 'room':
        S.storageRate = m.storageRate || D.STORAGE_AGE_RATE; S.icehouse = m.icehouse; S.dielna = m.dielna;
        S.eternal = m.eternal; S.storageFb = m.storageFb; S.storageTick = m.tick; S.names = m.names; S.mode = m.mode; S.daySeconds = m.daySeconds; S.storage = m.storage;
        if (S.modal) S.modal.refresh();
        break;
      case 'plots': S.plotsUsed = m.used; S.plotLimit = m.limit; updateHud(); if (S.modal) S.modal.refresh(); break; // spoločné povolenie na pole
      case 'market': S.market = m; if (S.modal) S.modal.refresh(); break;
      case 'board': S.board = m.list; if (S.modal) S.modal.refresh(); break;
      case 'tile': S.tiles[m.i] = m.v; break;
      case 'pos': S.me.x = m.x; S.me.y = m.y; stopWalk(); Veh.resync(); break; // server pohyb odmietol (neprechodná zem) – späť na potvrdené miesto; spolujazdca vezie fúrik
      case 'tiles': S.tiles = m.tiles; S.tilesGen++; findAnchors(); break;
      case 'time':
        // Server posiela celé číslo kroku; deň a minúta sa z neho odvodia, medzi krokmi len plynulo dopočítame.
        S.tick = m.tick; S.tickMs = m.tickMs; S.day = D.dayOfTick(m.tick); S.min = D.minOfTick(m.tick);
        S.weather = m.weather; S.mode = m.mode; S.daySeconds = m.daySeconds; S.timeAt = performance.now(); updateHud();
        break;
      case 'pl': {
        // vlastná postavička nikdy medzi ostatnými (#125)
        const mine = Players.syncOthers(S.others, m.list, S.id, (o, p) => {
          if (p.j !== o.j && !o.jz) o.jv = JUMP_V; // iný hráč skočil
          Object.assign(o, { id: p.id, tx: p.x, ty: p.y, dir: p.dir, a: p.a, look: p.look, name: p.name, e: p.e, cr: !!p.cr, lp: !!p.lp, j: p.j, si: p.si, wb: p.wb || 0 });
        }, (p): OtherPlayer => ({ x: p.x, y: p.y, phase: 0, jz: 0, jv: 0, j: p.j, id: p.id, tx: p.x, ty: p.y, dir: p.dir, a: p.a, look: p.look, name: p.name, e: p.e, cr: false, lp: false, si: -1, wb: 0 }));
        if (mine) { S.myEmote = mine.e; S.mySi = mine.si; }
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
      case 'toast': toast(m.text, m.kind, m.icon && Veh.icon(m.icon)); if (m.kind === 'magic') sfx('magic'); else if (m.kind === 'gift') sfx('coin'); break;
      case 'chat': chatLine(m.name, m.text); S.bubbles[m.id] = { text: m.text, until: performance.now() + Math.min(10000, 4000 + m.text.length * 60) }; break;
      case 'fx': spawnFx(m); break;
      case 'webs': setWebs(m.webs, m.homes); break;
      case 'corner': if (m.area === S.area) { S.corner = m.list; S.cornerGen++; } break;
      case 'sp': {
        const seen = new Set<string>();
        for (const p of m.list) {
          seen.add(p.id);
          const o = S.spiders.get(p.id), c = 'c' in p && !!p.c; // c = na chrbte hráča (server to dnes neposiela)
          const next = { id: p.id, k: p.k, tx: p.x, ty: p.y, a: p.a, m: !!p.m, c, h: !!p.h, tz: p.z || 0, n: p.n || null, u: !!p.u }; // n = na kmeni
          if (o) Object.assign(o, next); else S.spiders.set(p.id, { x: p.x, y: p.y, phase: 0, ...next });
        }
        for (const id of [...S.spiders.keys()]) if (!seen.has(id)) S.spiders.delete(id);
        break;
      }
      case 'webbed': { const now = performance.now(); S.web = { start: now, stuck: m.stuck, end: now + m.ms, k: m.k }; stopWalk(); break; } // pavúk ťa zabalil do pavučiny
      case 'shove': S.me.x = m.x; S.me.y = m.y; stopWalk(); break; // stará pradlena odhodila hráča za okraj čistiny
      case 'dock': { // mólo a loďka (#160); nastúpenie a vystúpenie posunie postavičku správa pos (server)
        const was = mySeat();
        S.dock = { built: m.built, boat: m.boat, seats: m.seats, flip: m.flip };
        if (was !== mySeat()) { stopWalk(); S.stick.x = S.stick.y = 0; }
        if (S.modal) S.modal.refresh();
        break;
      }
      case 'brewed': S.brewed = m.k; S.brewHint = m.hint ?? null; S.cauldron = []; sfx(m.k === 'sliz' ? 'bad' : 'magic'); if (S.modal) S.modal.refresh(); break;
      case 'error': alert(m.text); S.joined = false; $('conn').classList.add('hidden'); break;
      case 'vehicles': Veh.onList(m.list); break; // fúrik a sane (#158)
    }
  }

  // ---------- Prechod do inej plochy: stmavnutie do čiernej, výmena sveta, meno plochy, rozjasnenie ----------
  const AREA_FADE = 300, AREA_HOLD = 900; // ms; meno plochy ostane na čiernej ≈ 0,9 s, aby sa dalo prečítať
  const reducedMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;
  let areaHideT: ReturnType<typeof setTimeout> | undefined;
  function applyArea(m: MsgOf<'area'>): void {
    S.area = m.area; S.areaSeq = m.seq; S.tiles = m.tiles; S.tilesGen++;
    S.W = m.w || D.W; S.H = m.h || D.H; // každá plocha má vlastnú veľkosť
    S.me.x = m.x; S.me.y = m.y; S.others.clear(); stopWalk();
    setWebs([], []); S.corner = []; S.cornerGen++; S.spiders.clear(); S.slowUntil = 0; S.web = null;
    findAnchors();
  }
  function setWebs(webs: WebView[], homes: MsgOf<'webs'>['homes']): void {
    S.webs = webs; S.homes = homes; S.websGen++;
    S.webTile = new Map();
    for (const wb of S.webs) for (let k = 0; k < wb.n; k++) S.webTile.set((wb.y + (wb.ax ? k : 0)) * S.W + wb.x + (wb.ax ? 0 : k), wb);
  }
  const cornerAt = (tx: number, ty: number): boolean => S.corner.some(c => c.x === tx && c.y === ty);
  // vzhľad clony podľa cieľovej plochy (D.AREA_FX): farba žiary, ikona, meno a ozdoby rozložené po okrajoch
  function paintAreaFade(area: D.AreaId): void {
    const el = $('areaFade'), f = D.AREA_FX[area], deco = f.deco.length ? f.deco : ['✨'];
    const part = (sel: string): Element => must(el.querySelector(sel) ?? undefined);
    el.style.setProperty('--af-glow', f.glow || '#ffffff88');
    part('.af-icon').textContent = f.icon || '✨';
    part('.af-name').textContent = D.AREA_NAMES[area] || area;
    const N = 16, box = part('.af-deco');
    box.innerHTML = '';
    for (let i = 0; i < N; i++) {
      // obvod obdĺžnika: hore, vpravo, dole, vľavo (v % obrazovky, kúsok od okraja)
      const u = (i + 0.5) / N * 4, side = Math.floor(u), k = u - side, a = 4 + k * 92, sp = document.createElement('span');
      const [l, t] = side === 0 ? [a, 3] : side === 1 ? [93, a] : side === 2 ? [100 - a, 92] : [3, 100 - a];
      sp.textContent = deco[i % deco.length] ?? '✨';
      sp.style.left = l + '%'; sp.style.top = t + '%'; sp.style.animationDelay = (-(i * 0.37) % 1.4) + 's';
      box.appendChild(sp);
    }
  }
  // Priebeh prechodu (S.areaFx.phase): 'out' – stmavuje sa, 'build' – za čiernou sa stavia svet novej plochy,
  // 'named' – meno plochy svieti AREA_HOLD ms, potom sa rozjasní (endAreaFx). Stavba 3D sveta je ťažká a na mobile
  // na stovky ms zastaví stránku – meno sa preto ukáže až po nej a čas AREA_HOLD beží až odvtedy.
  function areaChange(m: MsgOf<'area'>): void {
    stopWalk(); S.keys = {}; S.stick.x = S.stick.y = 0;
    const fx = S.areaFx;
    if (fx && fx.phase === 'out') { fx.msg = m; paintAreaFade(m.area); return; } // ešte stmavuje – platí posledná správa
    if (fx) { clearTimeout(fx.timer); applyArea(m); paintAreaFade(m.area); showAreaName(fx); return; } // už je čierno
    const el = $('areaFade');
    clearTimeout(areaHideT);
    paintAreaFade(m.area);
    el.classList.remove('hidden', 'named'); el.getBoundingClientRect(); el.classList.add('on'); // prepočet rozloženia – prechod sa spustí znova
    sfx('magic');
    const nfx: NonNullable<ClientState['areaFx']> = S.areaFx = { phase: 'out', msg: m, queue: [] };
    nfx.timer = setTimeout(() => {
      applyArea(nfx.msg); // svet sa prestavia za čiernou
      showAreaName(nfx); // už nie 'out' – odložené správy sa vybavia (inak by sa znova odložili a stratili: hlásenie o príchode, fúriky)
      for (const q of nfx.queue.splice(0)) onMsg(q);
    }, reducedMotion() ? 0 : AREA_FADE);
  }
  // Počká, kým 3D pohľad postaví a nakreslí svet novej plochy (najviac 4 s), potom ukáže meno a nechá ho svietiť AREA_HOLD.
  function showAreaName(fx: NonNullable<ClientState['areaFx']>): void {
    fx.phase = 'build';
    const el = $('areaFade'), t0 = performance.now(), gen = S.tilesGen, tok = fx.tok = Symbol('čakanie'); // platí len posledné čakanie
    const live = (): boolean => S.areaFx === fx && fx.tok === tok;
    const ready = (): boolean => !R3 || (S.worldGen ?? -1) >= gen || performance.now() - t0 > 4000;
    const step = (): void => {
      if (!live()) return; // medzitým prechod skončil alebo prišla ďalšia plocha
      if (!ready()) { requestAnimationFrame(step); return; }
      requestAnimationFrame(() => { // ešte jeden snímok, nech je postavený svet naozaj nakreslený
        if (!live()) return;
        fx.phase = 'named';
        el.classList.add('named');
        fx.timer = setTimeout(endAreaFx, AREA_HOLD);
      });
    };
    requestAnimationFrame(step);
  }
  function endAreaFx(now?: boolean): void {
    const el = $('areaFade');
    if (S.areaFx) clearTimeout(S.areaFx.timer);
    S.areaFx = null;
    el.classList.remove('on');
    areaHideT = setTimeout(() => { el.classList.add('hidden'); }, now === true || reducedMotion() ? 0 : AREA_FADE);
  }

  function findAnchors(): void {
    S.anchors = {};
    for (let i = 0; i < S.tiles.length; i++) {
      const g = must(S.tiles[i]).g;
      if ((g === 'hut' || g === 'house' || g === 'stall' || g === 'well' || g === 'cauldron' || g === 'icehouse' || g === 'dielna') && !S.anchors[g]) S.anchors[g] = { x: i % S.W, y: (i / S.W) | 0 };
    }
  }

  // ---------- Pomocné ----------
  // ladenie: window.MF_TIME = { season: 0–3, min: 0–1439 } prepíše zobrazený čas (len lokálne vykresľovanie, nie server)
  // Hráč hrabe v tráve (si = index hľadaného políčka, inak -1) – hlinku a trávu kreslia častice vo svete (particles3d.ts).
  const searching = (o: { si?: number | undefined } | null | undefined): boolean => !!o && o.si != null && o.si >= 0;
  function curMin(): number { if (window.MF_TIME && window.MF_TIME.min != null) return window.MF_TIME.min; return realMin(); }
  // server posiela čas najviac raz za sekundu; medzitým ho dopočítame z tickMs (najviac o 1,5 s dopredu, keby správa meškala)
  function realMin(): number { const el = Math.min(1500, performance.now() - S.timeAt); return (S.min + el / S.tickMs * D.MIN_PER_TICK) % 1440; }
  function season(): number { return window.MF_TIME && window.MF_TIME.season != null ? window.MF_TIME.season : D.seasonOf(S.day); }
  const GLACIER_MAX = D.glacierLevels(D.buildMountains()); // pôvodná výška ľadu na políčkach hôr
  function tileAt(x: number, y: number): TileView | null { return (x < 0 || y < 0 || x >= S.W || y >= S.H) ? null : S.tiles[y * S.W + x] ?? null; }
  // Dá sa vstúpiť na políčko pod bodom (x, y) z políčka here? Na ľadovec len o pol bloku vyššie (vo výskoku o blok),
  // plazením vôbec nie cez výškový rozdiel – políčka, na ktorých už čiastočne leží (overlap), ho však nezadržia.
  function solid(x: number, y: number, here: TileView | null, lift: number, crawl: boolean, overlap: Set<number>): boolean {
    const tx = Math.floor(x), ty = Math.floor(y), t = tileAt(tx, ty);
    if (!t) return true;
    if (crawl && D.passable(t) && overlap.has(ty * S.W + tx)) return false;
    return !D.canStep(here, t, lift, crawl);
  }
  // ---- Loďka (#160) ----
  // Moje miesto v loďke: 0 = veslujem, 1 = vezie ma kamarát, -1 = nie som v loďke (kľúč ako na serveri: meno malými písmenami)
  const myKeyOf = (name: string): string => name.replace(/[<>*]/g, '').trim().slice(0, 14).toLowerCase();
  const myKey = (): string => myKeyOf(S.name);
  function mySeat(): number { const d = S.dock; return d && d.built && S.area === 'garden' ? d.seats.indexOf(myKey()) : -1; }
  // Kde je loďka: keď veslujem, idem s ňou ja (predpoveď), inak poloha zo servera
  function boatPos(): Pt | null { const d = S.dock; if (!d || !d.built) return null; return mySeat() === 0 ? { x: S.me.x, y: S.me.y } : d.boat; }
  // Ťuknutie na loďku (nastúpiť) alebo – v loďke – na breh či mólo vedľa nej (vystúpiť); rovnako ako server (dock.ts resolveAct)
  function boatAction(tx: number, ty: number, t: TileView, sel: string): CtxAction | null {
    const d = S.dock, b = boatPos();
    if (!d || !d.built || !b || S.area !== 'garden') return null;
    if (mySeat() >= 0) {
      if (!D.isLand(t) || t.g === 'gate' || (t.s && sel)) return null;
      return Math.hypot(tx + 0.5 - b.x, ty + 0.5 - b.y) <= D.DOCK.reach ? { i: '🛶', l: 'Vystúpiť' } : { i: '🛶', l: 'Ďaleko od loďky', info: true };
    }
    if (d.flip) return t.g === 'dock' && !sel ? { i: '🛶', l: 'Loďka v zime', info: true } : null;
    if (t.g !== 'water' || Math.hypot(tx + 0.5 - b.x, ty + 0.5 - b.y) > 1 || (sel && !D.isTool(sel))) return null; // voda pod loďkou (~2 bloky)
    return { i: '🛶', l: 'Nastúpiť' };
  }
  // Cesta loďkou po vode (BFS po políčkach, na ktoré sa loďka celá zmestí) k políčku, ktoré spĺňa podmienku
  function findBoatPath(goal: (x: number, y: number) => boolean): Pt[] | null {
    const sx = Math.floor(S.me.x), sy = Math.floor(S.me.y), prev = new Int32Array(S.W * S.H).fill(-2), q = [sy * S.W + sx];
    prev[sy * S.W + sx] = -1;
    for (let qi = 0; qi < q.length; qi++) {
      const i = must(q[qi]), x = i % S.W, y = (i / S.W) | 0;
      if (goal(x, y)) {
        const path: Pt[] = [];
        for (let k = i; k !== -1; k = prev[k] ?? -1) path.unshift({ x: k % S.W + 0.5, y: ((k / S.W) | 0) + 0.5 });
        return path;
      }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, ny = y + dy, n = ny * S.W + nx;
        if (nx < 0 || ny < 0 || nx >= S.W || ny >= S.H || prev[n] !== -2 || !D.boatFits(S.tiles, nx + 0.5, ny + 0.5)) continue;
        prev[n] = i; q.push(n);
      }
    }
    return null;
  }

  function playerOn(tx: number, ty: number): OtherPlayer | null {
    for (const o of S.others.values()) if (Math.hypot(o.x - (tx + 0.5), o.y - (ty + 0.5)) < 0.8) return o;
    return null;
  }
  function frontTile(): Pt {
    if (S.me.a != null) return { x: Math.floor(S.me.x) + Math.round(Math.cos(S.me.a)), y: Math.floor(S.me.y) + Math.round(Math.sin(S.me.a)) };
    const d = ([[0, 1], [-1, 0], [1, 0], [0, -1]] as const)[S.me.dir] ?? [0, 1];
    return { x: Math.floor(S.me.x) + d[0], y: Math.floor(S.me.y) + d[1] };
  }

  function toast(text: string, kind?: ToastKind, icon?: string): void {
    const box = $('toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = text;
    if (icon) el.prepend(Object.assign(document.createElement('img'), { src: icon, alt: '', style: 'height:1.8em;vertical-align:middle;margin:-0.3em 0.3em -0.3em 0' })); // fúrik, sane (#158)
    box.appendChild(el);
    while (box.firstChild && box.children.length > 3) box.removeChild(box.firstChild);
    setTimeout(() => { el.classList.add('out'); }, kind === 'magic' ? 7000 : 4000);
    setTimeout(() => { el.remove(); }, kind === 'magic' ? 7600 : 4600);
  }
  function chatEl(name: string, text: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'chatline';
    el.innerHTML = '<b></b> ';
    must(el.firstChild ?? undefined).textContent = name + ':';
    el.appendChild(document.createTextNode(text));
    return el;
  }
  // História chatu (posledných 50 správ) – ukáže sa po otvorení chatu (T alebo 💬)
  function chatLine(name: string, text: string): void {
    const hist = $('chathist'), atEnd = hist.scrollTop + hist.clientHeight >= hist.scrollHeight - 4;
    hist.appendChild(chatEl(name, text));
    while (hist.firstChild && hist.children.length > 50) hist.removeChild(hist.firstChild);
    if (atEnd) hist.scrollTop = hist.scrollHeight;
    const el = chatEl(name, text);
    const log = $('chatlog');
    log.appendChild(el);
    while (log.firstChild && log.children.length > 5) log.removeChild(log.firstChild);
    chatWheel();
    setTimeout(() => { el.classList.add('out'); }, 9000);
    setTimeout(() => { el.remove(); chatWheel(); }, 10000);
  }
  // Kolotoč v histórii: okno má 15 riadkov, spodných 13 je normálne, 14. a 15. riadok prichádzajú z pozadia –
  // správa je tam menšia, naklonená, priesvitnejšia a zasunutá za správu pod ňou (staršie sú vždy za novšími).
  // Posúvaním nahor sa správa vysunie dopredu a za ňou sa objaví ďalšia; vďaka 2 prázdnym riadkom navrchu (CSS padding)
  // sa dopredu dostane aj najstaršia. Pri menej ako 14 správach nič.
  // Počíta sa z polohy v rozložení (offsetTop), nie z bounding boxu, aby transformácia neovplyvňovala sama seba.
  const CHAT_ROW = 25;
  function chatWheel(): void {
    const box = $('chathist');
    if (!$('chatbox').classList.contains('open')) return;
    const H = parseFloat(getComputedStyle(box).maxHeight) || 0, flat = H - 2 * CHAT_ROW;
    const bottom = box.scrollTop + box.clientHeight, items = box.children;
    for (let i = 0; i < items.length; i++) {
      const el = items[i];
      if (!(el instanceof HTMLElement)) continue;
      const e = Math.max(0, (bottom - el.offsetTop - flat) / (2 * CHAT_ROW)), d = Math.min(1, e);
      el.style.zIndex = String(i + 1);

      el.style.transform = d ? `translateY(${(d * CHAT_ROW).toFixed(1)}px) perspective(500px) rotateX(${(d * 30).toFixed(1)}deg) scale(${(1 - d * 0.15).toFixed(3)})` : '';
      el.style.opacity = e ? Math.max(0, 1 - e * 0.8).toFixed(2) : '';
    }
  }
  let wheelRaf = 0;
  $('chathist').addEventListener('scroll', () => { if (!wheelRaf) wheelRaf = requestAnimationFrame(() => { wheelRaf = 0; chatWheel(); }); }, { passive: true });

  // ---------- Kontextová akcia ----------
  function ctxAction(tx: number, ty: number): CtxAction | null {
    const t = tileAt(tx, ty);
    if (!t) return null;
    const veh = Veh.ctxAt(tx, ty); // fúrik či sane na políčku (#158)
    if (veh) return veh;
    const sel = S.sel;
    if (sel === 'fl_papradie') return { i: '✨', l: 'Želanie', ui: 'wish' };
    const boat = boatAction(tx, ty, t, sel); // loďka má prednosť pred hráčom, ktorý v nej sedí (ako na serveri)
    if (boat) return boat;
    const other = playerOn(tx, ty);
    const crewmate = !!other && mySeat() >= 0 && !!S.dock?.seats.includes(myKeyOf(other.name)); // spolujazdec v loďke (#161) – ako na serveri
    if (other && !crewmate) {
      if (sel === 'po_laska') return { i: '💕', l: 'Darovať' };
      if (!sel || D.isTool(sel)) return { i: '👋', l: 'Zamávať' };
      return { i: '🎁', l: 'Darovať' };
    }
    if (S.area === 'les' && S.webTile.has(ty * S.W + tx)) return sel === 'lamp' ? { i: '🕸️', l: 'Pavučina', info: true } : { i: '🕸️', l: 'Ťahať hodváb' };
    if (cornerAt(tx, ty)) return { i: '🧹', l: 'Odstrániť pavučinu' };
    const ma = masterNow();
    if (ma && S.area === 'garden' && Math.floor(ma.x) === tx && Math.floor(ma.y) === ty) return ma.still ? { i: '🧵', l: 'Majster', ui: 'majster' } : { i: '🧵', l: 'Majster na ceste', info: true, ma };
    switch (t.g) {
      case 'stall': return { i: '🛒', l: 'Trh', ui: 'shop' };
      case 'cauldron': return { i: '⚗️', l: 'Kotlík', ui: 'cauldron' };
      case 'babka': case 'hut': return { i: '👵', l: 'Babka', ui: 'babka' };
      case 'house': return { i: '🏠', l: 'Domček', ui: 'house' };
      case 'well': return sel === 'can' ? { i: '💧', l: 'Načrieť' } : { i: '🪙', l: 'Prianie' };
      case 'water':
        if (sel === 'pick' && season() === 3) return t.cut ? { i: '🕳️', l: 'Otvor v ľade', info: true } : { i: '🧊', l: 'Vysekať ľad' };
        if (sel === 'can') return season() === 3 && !t.cut ? { i: '🧊', l: 'Zamrznuté', info: true } : { i: '💧', l: 'Načrieť' };
        return waterAction(t, tx, ty, sel);
      case 'glacier':
        if (sel === 'pick') return t.ice ? { i: '🧊', l: 'Vysekať ľad' } : { i: '🧊', l: 'Ľadovec', info: true };
        return S.inv.pick ? null : { i: '🧊', l: 'Ľadovec', info: true }; // bez krompáča v ruke sa po ľadovci len chodí
      case 'icehouse': // s prikrývkou v ruke ju izoluješ; s kvetom či iným predmetom (nie náradím) vysvetlí, čo do nej patrí (#63)
        if (sel === 'blanket') return { i: '🧶', l: 'Izolovať' };
        return sel && sel !== 'ice' && !D.isTool(sel) ? { i: '🧊', l: 'Ľadovňa', ui: 'icehouse', only: true } : { i: '🧊', l: 'Ľadovňa', ui: 'icehouse' };
      case 'dielna': return { i: '🪚', l: 'Dielňa', ui: 'dielna' };
      case 'majster': return S.dielna.loom ? null : { i: '🧵', l: 'Miesto majstra', info: true }; // majster tu práve nie je (inak ho chytí riadok vyššie); po kúpe krosien už nič
      case 'lot': return { i: '🪧', l: 'Pozemok', info: true };
      case 'shroom': case 'ring': return { i: '🍄', l: 'Huby', info: true };
    }
    // mimo záhrady sa nepestuje ani nehľadá – použiť sa dá len elixír
    if (S.area !== 'garden') return sel.startsWith('po_') ? { i: '🧪', l: 'Použiť' } : null;
    const s = t.s, p = s?.p;
    if (p && !p.d && D.stageOf(p) === 3) return (p.sp === 'papradie' && !D.isNight(curMin())) ? { i: '🌙', l: 'Čaká na noc' } : { i: '🧺', l: 'Zbierať' };
    if (sel === 'hoe') {
      if (p && p.d) return { i: '🧹', l: 'Vyčistiť' };
      if (!s && D.TILLABLE[t.g]) return { i: '⛏️', l: 'Kopať' };
      if (D.canLevel(t)) return { i: '🔄', l: 'Zarovnať' }; // ktokoľvek, ako na serveri
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

  // Vodné kvety v jazierku a v plese (#38) – ako waterAct na serveri: zber, odstránenie uhynutej rastliny, sadenie
  function waterAction(t: NonNullable<ReturnType<typeof tileAt>>, tx: number, ty: number, sel: string): CtxAction | null {
    if (!D.waterSpot(S.area, ty * S.W + tx)) return null;
    const p = t.s?.p;
    if (p && !p.d && D.stageOf(p) === 3) return { i: '🧺', l: 'Zbierať' };
    if (sel === 'hoe' && p && p.d) return { i: '🧹', l: 'Vyčistiť' };
    if (sel.startsWith('seed_') && !t.s) return { i: '🌱', l: 'Sadiť' };
    if (p && !p.d) return { i: '🔍', l: 'Pozrieť', info: true };
    return null;
  }

  // ---- Čerstvosť odrezaných kvetov ----
  // Najstaršia várka kvetu: { age (kroky), fresh (0.5–1), left (kroky do zvädnutia) }
  function oldestBatch(id: string, inStorage?: boolean): { age: number; fresh: number; left: number; rem: number } | null {
    const fb = inStorage ? S.storageFb : S.fb, base = inStorage ? S.storageTick : S.fbTick;
    const first = fb && lookup(fb, id)?.[0];
    if (!first) return null;
    const rate = inStorage ? S.storageRate : 1, sp = id.slice(3), ice = id === 'ice', spec = speciesOf(sp);
    if (!ice && !spec) return null;
    const age = first.age + Math.max(0, S.tick - (base || S.tick)) * rate;
    const life = ice || !spec ? D.ICE_LIFE : spec.life * TPD; // ľad sa do pol dňa roztopí
    return { age, fresh: ice || !D.isSpeciesId(sp) ? 1 : D.freshness(sp, age), left: Math.max(0, (life - age) / rate), rem: Math.max(0, 1 - age / life) };
  }
  const freshColor = (rem: number): string => rem > 0.6 ? '#3aa04a' : rem > 0.3 ? '#e8b21c' : '#d0502a';
  function freshText(id: string, inStorage?: boolean): string {
    const o = oldestBatch(id, inStorage);
    if (!o) return '';
    return `čerstvosť ${Math.round(o.fresh * 100)} % · najstaršie zvädnú o ${fmtLeft(o.left)}`;
  }

  function plantInfo(tx: number, ty: number): void {
    const t = tileAt(tx, ty), s = t?.s, p = s?.p;
    if (!t || !s || !p) return;
    const sp = speciesOf(p.sp);
    if (!sp) { toast('Divé semienko – uvidíme, čo z neho vyrastie, keď vyklíči.' + (p.d ? ' Žiaľ, zahynulo.' : s.w ? '' : ' · smäd')); return; }
    const st = ['semienko', 'klíčok', 'púčik', 'kvitne'][D.stageOf(p)] ?? '';
    const shade = D.isShade(S.tiles, tx, ty);
    const notes: string[] = [];
    if (sp.light !== 'any' && (sp.light === 'shade') !== shade) notes.push(sp.light === 'shade' ? 'chce tieň' : 'chce slnko');
    if (sp.soil && sp.soil !== s.k && !(sp.soil === 'rich' && s.r) && !(sp.soil === 'sand' && s.k === 'rock')) notes.push({ sand: 'chce piesok', rock: 'chce skalku', rich: 'chce kompost' }[sp.soil]);
    if (!s.w) notes.push('smäd');
    if (R3) { const sh = R3.sunHoursAt(tx, ty); if (sh != null) notes.push(`☀️ ~${sh.toFixed(1).replace('.', ',')} h slnka denne`); }
    if (D.stageOf(p) === 3 && p.bt != null && !p.d) notes.push((sp.perennial ? 'odkvitne' : 'zvädne') + ' o ' + fmtLeft(sp.life * TPD - (S.tick - p.bt)));
    toast(`${sp.name}: ${st} (${Math.floor(p.prog)}/${sp.days} dní) · ${'⭐'.repeat(p.q)}${notes.length ? ' · ' + notes.join(', ') : ' · spokojná 😊'}`);
  }

  // Hľadať sa dá len stojac priamo na políčku – kým tam hráč nie je, najprv tam dôjde
  const onTile = (tx: number, ty: number): boolean => Math.hypot(S.me.x - (tx + 0.5), S.me.y - (ty + 0.5)) <= 0.3;
  function walkOnto(tx: number, ty: number): void {
    const path = findPath((x, y) => x === tx && y === ty);
    if (!path) return;
    S.path = path; S.pendingAct = { x: tx, y: ty, onTile: true }; S.stuckT = 0;
  }

  // kde je majster hodvábu teraz (podľa herného času, ako na serveri); null = je preč (leto, zima)
  const masterNow = (): D.MasterPos | null => D.masterAt(S.day, curMin(), S.dielna.loom); // po kúpe krosien už nechodí
  const onDielnaLot = (tx: number, ty: number): boolean => { const L = D.DIELNA.lot; return tx >= L.x0 && tx <= L.x1 && ty >= L.y0 && ty <= L.y1; };
  function doAction(tx: number, ty: number): void {
    const a = ctxAction(tx, ty);
    if (!a) return;
    if (a.only) toast('Do ľadovne patrí len ľad 🧊 (a hodvábne prikrývky na izoláciu). Kvety ulož do skladu v domčeku – ľad v ľadovni ho chladí, takže v ňom vädnú 4× pomalšie.');
    if (a.ui) { openUI(a.ui); return; }
    if (a.l === 'Hľadať' && !onTile(tx, ty)) { walkOnto(tx, ty); return; }
    if (a.info) {
      if (a.l === 'Huby') toast(D.isNight(curMin()) ? 'Huby slabo svietia… Skús tu zatancovať 💃' : 'Kruh z húb. Babka hovorí, že tu v noci tancujú víly. 🍄');
      else if (a.l === 'Ľadovec') {
        const t = tileAt(tx, ty);
        const have = S.tiles.reduce((s, x) => s + (x.ice || 0), 0), max = GLACIER_MAX.reduce((s, v) => s + v, 0);
        const state = ` Ľadovec má ${Math.round(have / max * 100)} % ľadu – dorastie len v daždi alebo snehu.`;
        toast((!S.inv.pick ? 'Na ľad potrebuješ krompáč – kúpiš ho na trhu (záložka Vylepšiť). ⛏️'
          : t?.ice ? `Tu ešte vysekáš ${t.ice}× ľad. Vyber v lište krompáč. ⛏️` : 'Tu je ľad vysekaný až po dno. 🧊') + state);
      } else if (a.l === 'Zamrznuté') toast(D.frozenWaterText(S.area));
      else if (a.l === 'Otvor v ľade') toast('Tu už je otvor v ľade. Cez noc zamrzne – skús iné miesto. 🧊');
      else if (a.l === 'Pavučina') toast('S lampášom v ruke hodváb neutrhneš – potrebuješ voľnú ruku. Vyber si v lište niečo iné alebo prázdnu ruku. 🕸️');
      else if (a.l === 'Majster na ceste' && a.ma) toast(D.masterRoadText(a.ma));
      else if (a.l === 'Ďaleko od loďky') toast('Priveslujte bližšie k brehu – vystúpiť sa dá len hneď vedľa loďky. 🛶');
      else if (a.l === 'Loďka v zime') toast('V zime leží loďka prevrátená na móle. Na vodu pôjde až na jar. ❄️');
      else if (a.l === 'Miesto majstra') toast(masterNow() ? 'Majster hodvábu je na noc u babky v chalúpke. Ráno o 6:00 sa vráti na trh. 🧵' : 'Tu predáva majster hodvábu – do dedinky chodí len na jar a na jeseň. 🧵');
      else if (a.l === 'Pozemok') toast(onDielnaLot(tx, ty)
        ? `Pozemok pre Dielňu. Postaviť ju môže ktokoľvek zo záhrady na trhu (záložka Vylepšiť) za ${D.DIELNA.price} 🪙 (treba ⭐${D.DIELNA.rep}). 🪚`
        : `Pozemok pre ľadovňu. Postaviť ju môže ktokoľvek zo záhrady na trhu (záložka Vylepšiť) za ${D.ICEHOUSE.price} 🪙. 🧊`);
      else plantInfo(tx, ty);
      return;
    }
    if (a.l === 'Hľadať') { const me = S.me; send({ t: 'move', x: me.x, y: me.y, dir: me.dir, a: me.a, cr: me.crawl, lp: S.sel === 'lamp', ar: S.areaSeq }); } // server musí vedieť, že už stojím na políčku
    send({ t: 'act', x: tx, y: ty, item: S.sel });
    if (a.l === 'Kopať' || a.l === 'Vysekať ľad' || a.l === 'Ťahať hodváb') sfx('dig'); else if (a.l === 'Poliať' || a.l === 'Načrieť') sfx('water'); else sfx('pop');
  }

  // ---------- Vstupy ----------
  // Skok (medzerník) a plazenie (Shift) sú len pre parádu – nič nemenia, ostatní hráči ich však vidia
  const JUMP_V = 5.6, JUMP_G = 23, CRAWL_SPEED = 0.45; // výskok ≈ 0,7 políčka, ≈ 0,5 s
  function jump(): void {
    const me = S.me;
    if (S.asleep || me.jz > 0 || me.crawl || mySeat() >= 0) return; // v loďke sa neskáče
    me.jv = JUMP_V; me.jz = 0.001;
    send({ t: 'jump' }); sfx('hop');
  }
  function setCrawlToggle(on: boolean): void { S.crawlTgl = on; $('bCrawl').classList.toggle('on', on); }
  const KEYMAP: Readonly<Record<string, Dir>> = { ArrowUp: 'u', KeyW: 'u', ArrowDown: 'd', KeyS: 'd', ArrowLeft: 'l', KeyA: 'l', ArrowRight: 'r', KeyD: 'r' };
  addEventListener('keydown', e => {
    if (!S.joined || S.asleep || S.areaFx || document.activeElement?.tagName === 'INPUT') return;
    S.kbd = true;
    const k = lookup(KEYMAP, e.code);
    if (k) { S.keys[k] = true; stopWalk(); e.preventDefault(); }
    if (e.code === 'Space') { if (!e.repeat) jump(); e.preventDefault(); }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') S.crawlKey = true;
    if (e.code === 'KeyE' || e.code === 'Enter') { const f = frontTile(); doAction(f.x, f.y); e.preventDefault(); }
    if (e.code === 'Escape') closeModal();
    if (/^Digit[1-9]$/.test(e.code)) { const ids = hotbarIds(); selectItem(ids[+e.code.slice(5) - 1] || ''); }
    if (e.code === 'KeyQ') { const ids: (ItemId | '')[] = [...hotbarIds(), '']; selectItem(ids[(ids.indexOf(S.sel) + 1) % ids.length]); }
    if (e.code === 'KeyT') { e.preventDefault(); openChat(); }
    if (R3 && e.code === 'BracketLeft') R3.rotate(-1);
    if (R3 && e.code === 'BracketRight') R3.rotate(1);
  });
  addEventListener('keyup', e => {
    const k = lookup(KEYMAP, e.code);
    if (k) S.keys[k] = false;
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') S.crawlKey = false;
  });
  addEventListener('blur', () => { S.keys = {}; S.crawlKey = false; });
  // Mobil: tlačidlá pre palec vpravo dole (skok, plazenie zap/vyp)
  $('bJump').addEventListener('pointerdown', e => { e.preventDefault(); jump(); });
  $('bCrawl').addEventListener('pointerdown', e => { e.preventDefault(); setCrawlToggle(!S.crawlTgl); sfx('pop'); });

  document.querySelectorAll<HTMLElement>('#emotes button[data-e]').forEach(b => { b.addEventListener('click', () => { const e = b.dataset['e']; if (isEmote(e)) send({ t: 'emote', e }); sfx('pop'); }); });

  // Joystick – objaví sa tam, kde hráč začne ťahať prstom (kdekoľvek na obrazovke); kotva sa nehýbe
  const cv = $cv('cv'), ctx = ctx2d(cv);
  // Three.js kreslí do #gl, #cv zostáva navrchu ako prekrytie (mená, efekty) a prijíma dotyky
  let R3: Render3D | null = null;
  $('rotL').onclick = () => { R3?.rotate(-1); };
  $('rotR').onclick = () => { R3?.rotate(1); };
  // 3D pohľad aj s Three.js je samostatný kúsok balíka (esbuild ho načíta až teraz)
  import('./render3d.ts').then(M => {
    const r3 = R3 = S.r3 = M.create({
      S, searching, glCanvas: $cv('gl'), ov: cv, ovCtx: ctx, EMOJI, curMin, season, ctxAction, frontTile
    });
    r3.setStats(Fps.on);
  }).catch((e: unknown) => { console.error(e); toast('3D sa nepodarilo načítať – skús obnoviť stránku.'); });
  // Počítadlo snímok (FPS): zapína sa v menu, platí len na tomto zariadení. Vypnuté nerobí nič navyše.
  const Fps = (() => {
    const N = 120; // graf: posledných 120 snímok
    let on = false, el: HTMLElement | null = null, last = 0, lastText = 0;
    const frames: number[] = [], cpu: number[] = [];
    const txt = h('div'), gc = h('canvas', { width: N, height: 30 });
    try { on = localStorage.getItem('mfFps') === '1'; } catch { /* súkromné okno bez úložiska */ }
    const f1 = (v: number): string => v.toFixed(1).replace('.', ',');
    function build(): HTMLElement {
      const box = el = h('div', { id: 'fps' }, txt, gc);
      $('game').appendChild(box);
      return box;
    }
    function set(v: boolean): void {
      on = v; frames.length = cpu.length = 0; last = 0;
      try { localStorage.setItem('mfFps', v ? '1' : '0'); } catch { /* súkromné okno bez úložiska */ }
      if (R3) R3.setStats(v);
      if (!v && el) { el.remove(); el = null; }
    }
    function draw(): void {
      const c = ctx2d(gc), H = gc.height;
      c.clearRect(0, 0, N, H);
      c.fillStyle = '#ffffff22'; c.fillRect(0, H - 16.7 / 50 * H, N, 1); // čiara 60 FPS (16,7 ms)
      frames.forEach((ms, i) => { c.fillStyle = ms > 34 ? '#ff6b6b' : ms > 18 ? '#ffd166' : '#7bd88f'; const bh = Math.min(H, ms / 50 * H); c.fillRect(i + N - frames.length, H - bh, 1, bh); });
    }
    // now = čas snímku z requestAnimationFrame, cpuMs = koľko trval 3D snímok (R3.frame)
    function tick(now: number, cpuMs: number): void {
      if (last) { frames.push(now - last); cpu.push(cpuMs); if (frames.length > N) { frames.shift(); cpu.shift(); } }
      last = now;
      if (now - lastText < 250 || !frames.length) return;
      lastText = now;
      if (!el) el = build();
      const avg = frames.reduce((a, b) => a + b, 0) / frames.length, cAvg = cpu.reduce((a, b) => a + b, 0) / cpu.length;
      const r = R3 ? R3.stats() : null;
      txt.textContent = [
        `${Math.round(1000 / avg)} FPS · ${f1(avg)} ms`,
        `min ${f1(Math.min(...frames))} · max ${f1(Math.max(...frames))}`,
        `3D (CPU) ${f1(cAvg)} ms`,
        r ? `tiene ${f1(r.shadow)} · odraz ${f1(r.refl)}` : '',
        r ? `scéna ${f1(r.scene)} ms` : '',
        r ? `kreslení ${r.calls} · △ ${r.triangles >= 1e4 ? Math.round(r.triangles / 1000) + ' tis.' : r.triangles}` : '',
        r ? `geom. ${r.geometries} · text. ${r.textures}` : '',
        r ? `${r.w}×${r.h} (×${f1(r.pr)})` : ''
      ].filter(Boolean).join('\n');
      draw();
    }
    return { get on(): boolean { return on; }, set, tick };
  })();
  const gameEl = $('game'), joy = $('joy'), joyKnob = $('joyKnob');
  const JOY_R = 50, DRAG_START = 10;
  const ptrs = new Map<number, { x0: number; y0: number; joy: boolean }>();
  let joyId: number | null = null, joyBase: Pt = { x: 0, y: 0 };
  function joyMove(x: number, y: number): void {
    let dx = x - joyBase.x, dy = y - joyBase.y, d = Math.hypot(dx, dy);
    if (d > JOY_R) { dx *= JOY_R / d; dy *= JOY_R / d; d = JOY_R; } // kotva ostáva na mieste
    joyKnob.style.transform = `translate(${dx}px,${dy}px)`;
    S.stick = d / JOY_R < 0.15 ? { x: 0, y: 0 } : { x: dx / JOY_R, y: dy / JOY_R };
  }
  function endJoy(): void { joyId = null; S.stick = { x: 0, y: 0 }; joyKnob.style.transform = ''; joy.classList.add('hidden'); }
  cv.addEventListener('pointerdown', e => {
    if (!S.joined) return;
    if (e.pointerType === 'touch') gameEl.classList.add('touch');
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch { /* ukazovateľ už zmizol */ }
    ptrs.set(e.pointerId, { x0: e.clientX, y0: e.clientY, joy: false });
  });
  cv.addEventListener('pointermove', e => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    const r = gameEl.getBoundingClientRect();
    if (e.pointerId === joyId) { joyMove(e.clientX - r.left, e.clientY - r.top); return; }
    if (joyId === null && !p.joy && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > DRAG_START) {
      joyId = e.pointerId; p.joy = true;
      stopWalk();
      joyBase = { x: p.x0 - r.left, y: p.y0 - r.top };
      joy.style.left = joyBase.x + 'px'; joy.style.top = joyBase.y + 'px';
      joy.classList.remove('hidden');
      joyMove(e.clientX - r.left, e.clientY - r.top);
    }
  });
  const ptrEnd = (e: PointerEvent): void => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    ptrs.delete(e.pointerId);
    if (e.pointerId === joyId) { endJoy(); return; }
    if (e.type === 'pointerup' && !p.joy && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) <= DRAG_START) {
      if (joyId !== null) jump(); // ťuknutie druhým prstom počas riadenia joystickom = skok
      else tapWorld(e.clientX, e.clientY);
    }
  };
  cv.addEventListener('pointerup', ptrEnd);
  cv.addEventListener('pointercancel', ptrEnd);

  // Ťuknutie na objekt: blízko → akcia hneď, ďaleko → dôjde tam a urobí ju
  const GROUND = new Set(['Zarovnať', 'Kopať', 'Poliať', 'Sadiť', 'Pohnojiť', 'Vyčistiť', 'Použiť', 'Vysekať ľad']);
  const REACH = 1.7;
  function inReach(tx: number, ty: number): boolean { return Math.hypot(S.me.x - (tx + 0.5), S.me.y - (ty + 0.5)) <= REACH; }
  function stopWalk(): void { S.path = null; S.pendingAct = null; Veh.cancelWalk(); } // aj chôdza k fúriku (#158)
  // Zabalený do pavučiny: najprv stojí (stuck), potom sa rýchlosť s pavučinou, ktorá sa zodiera, vracia od k k plnej
  function webSpeed(now: number): number {
    const w = S.web;
    if (!w || now >= w.end) return 1;
    if (now < w.start + w.stuck) return 0;
    return w.k + (1 - w.k) * (now - w.start - w.stuck) / Math.max(1, w.end - w.start - w.stuck);
  }
  // V pavučine (zaboril som sa do nej – server, alebo práve stojím na jej políčku) idem pomalšie, kým ju neprerazím
  function webDrag(): number {
    if (S.area !== 'les') return 1;
    const key = S.name.toLowerCase(), me = S.me;
    const inIt = S.webs.some(w => w.in && w.in[key] != null) || S.webTile.has(Math.floor(me.y) * S.W + Math.floor(me.x));
    return inIt ? D.WEB.drag : 1;
  }
  // koľko pavučiny je ešte na mne (1 → 0) – pre kreslenie postavičky
  S.webLeft = () => { const w = S.web, now = performance.now(); if (!w || now >= w.end) return 0; return (w.end - now) / (w.end - w.start); };

  // BFS po políčkach – nájde cestu k prvému políčku, ktoré spĺňa podmienku
  function findPath(goal: (x: number, y: number) => boolean): Pt[] | null {
    const sx = Math.floor(S.me.x), sy = Math.floor(S.me.y);
    const prev = new Int32Array(S.W * S.H).fill(-2);
    const q = [sy * S.W + sx];
    prev[sy * S.W + sx] = -1;
    for (let qi = 0; qi < q.length; qi++) {
      const i = must(q[qi]), x = i % S.W, y = (i / S.W) | 0;
      if (goal(x, y)) {
        const path: Pt[] = [];
        for (let k = i; k !== -1; k = prev[k] ?? -1) path.unshift({ x: k % S.W + 0.5, y: ((k / S.W) | 0) + 0.5 });
        return path;
      }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, ny = y + dy, n = ny * S.W + nx;
        if (nx < 0 || ny < 0 || nx >= S.W || ny >= S.H || prev[n] !== -2) continue;
        if (!D.canStep(S.tiles[i], S.tiles[n], 0, S.me.crawl)) continue;
        if (S.webTile.has(n)) continue; // ťuknutím sa do pavučiny nevbehne (joystickom áno)
        prev[n] = i; q.push(n);
      }
    }
    return null;
  }

  const SEEN_WALK = 0.9; // v tme sa ťuknutím chodí len tam, kde je políčko viditeľné aspoň takto (0–1)
  function tapWorld(cx: number, cy: number): void {
    if (S.asleep || S.areaFx) return;
    if (!R3) return;
    const tgt = R3.pick(cx, cy); // lúč do 3D scény
    if (!tgt) return;
    if (!tileAt(tgt.x, tgt.y)) return;
    const a = ctxAction(tgt.x, tgt.y);
    S.tapMark = { x: tgt.x, y: tgt.y, t: performance.now(), act: !!a };
    stopWalk();
    if (a && a.ui === 'vehicle' && !inReach(tgt.x, tgt.y) && Veh.walkTo()) return; // fúrik z diaľky: dôjde k nemu (aj za idúcim) a otvorí ho (#158)
    if (a && (inReach(tgt.x, tgt.y) || a.ui === 'wish' || a.info)) {
      face(tgt.x + 0.5 - S.me.x, tgt.y + 0.5 - S.me.y);
      doAction(tgt.x, tgt.y);
      if (!a.info || (inReach(tgt.x, tgt.y) && a.l !== 'Ľadovec')) return; // na ľadovec sa dá aj vyjsť
    }
    const seat = mySeat();
    if (seat >= 0) { // v loďke: veslár ťuknutím vesluje po vode k políčku (a ak je tam čo robiť, urobí to), spolujazdec sa len vezie
      if (seat > 0) return;
      const bx = tgt.x + 0.5, by = tgt.y + 0.5;
      const bp = findBoatPath((x, y) => (x === tgt.x && y === tgt.y) || Math.hypot(x + 0.5 - bx, y + 0.5 - by) <= (a ? 1.2 : 0.75));
      if (!bp) return;
      const b0 = bp[0];
      if (bp.length > 1 && b0 && Math.hypot(b0.x - S.me.x, b0.y - S.me.y) < 0.6) bp.shift();
      S.path = bp; S.stuckT = 0;
      if (a && !a.info) S.pendingAct = { x: tgt.x, y: tgt.y };
      return;
    }
    const cx0 = tgt.x + 0.5, cy0 = tgt.y + 0.5;
    // v tme (Les divov) vedie ťuknutie len na miesto, ktoré hráč naozaj vidí (nezahalené tmou – aj vďaka cudziemu lampášu),
    // a nie okľukou ďaleko; či je v ceste strom, sa nerieši
    const dark = D.isDark(S.area);
    if (dark && R3.seenAt(cx0, cy0) < SEEN_WALK) return;
    const dist = Math.hypot(cx0 - S.me.x, cy0 - S.me.y);
    const walkable = D.passable(tileAt(tgt.x, tgt.y));
    let path: Pt[] | null;
    if (a && !GROUND.has(a.l) && !a.info) {
      // objekt: dôjdi k nemu a urob akciu
      path = findPath((x, y) => Math.hypot(x + 0.5 - cx0, y + 0.5 - cy0) <= 1.45 && (x !== tgt.x || y !== tgt.y || walkable));
      if (path) S.pendingAct = { x: tgt.x, y: tgt.y };
    } else {
      // zem: dôjdi na políčko (alebo čo najbližšie k nemu)
      // (na privysoký ľad sa nevylezie – vtedy čo najbližšie k nemu)
      path = (walkable && findPath((x, y) => x === tgt.x && y === tgt.y)) || findPath((x, y) => Math.hypot(x + 0.5 - cx0, y + 0.5 - cy0) <= 1.45);
    }
    if (!path || (dark && path.length > 2 * dist + 3)) return;
    const p0 = path[0];
    if (path.length > 1 && p0 && Math.hypot(p0.x - S.me.x, p0.y - S.me.y) < 0.6) path.shift();
    S.path = path; S.stuckT = 0;
  }

  function face(dx: number, dy: number): void {
    if (Math.abs(dx) > Math.abs(dy)) S.me.dir = dx < 0 ? 1 : 2; else S.me.dir = dy < 0 ? 3 : 0;
  }

  // ---------- Hotbar ----------
  function hotbarIds(): ItemId[] {
    const order = (id: string): number => id === 'hoe' ? 0 : id === 'can' ? 1 : id === 'pick' ? 1.5 : id === 'lamp' ? 1.6 : id === 'compost' ? 2 : id.startsWith('seed_') || D.isWild(id) ? 3 : id.startsWith('fl_') ? 4 : id === 'wilted' ? 4.5 : id === 'silk' ? 4.6 : id === 'blanket' ? 4.7 : 5;
    const spOrder: string[] = keys(D.SPECIES);
    const rank = (id: string): number => { const k = id.replace(/^(seed_|fl_|po_)/, ''); const i = spOrder.indexOf(k); return i < 0 ? 99 : i; };
    return keys(S.inv).filter(id => (S.inv[id] ?? 0) > 0).sort((a, b) => order(a) - order(b) || rank(a) - rank(b));
  }
  function selectItem(id: ItemId | '' | undefined): void { if (id == null) return; S.sel = id; renderHotbar(); }
  function renderHotbar(): void {
    const bar = $('hotbar');
    const ids = hotbarIds();
    bar.innerHTML = '';
    const vs = Veh.hotbarSlot(); // fúrik či sane, kým ich držím alebo v nich sedím (#158)
    if (vs) bar.appendChild(vs);
    for (const [i, id] of ids.entries()) {
      const d = document.createElement('div');
      d.className = 'slot' + (id === S.sel ? ' on' : '');
      d.innerHTML = `<img src="${Art.icon(id)}">` + (i < 9 ? `<span class="k">${i + 1}</span>` : '');
      const n = S.inv[id] ?? 0;
      if (id === 'can') d.innerHTML += `<div class="wbar"><i style="width:${S.water / S.canCap * 100}%"></i></div>`;
      else if (id.startsWith('fl_') || id === 'ice') { // čerstvosť najstaršieho kusu (ľad: kým sa neroztopí)
        const o = oldestBatch(id);
        if (o) d.innerHTML += `<span class="n">${n}</span><div class="wbar fresh"><i style="width:${o.rem * 100}%;background:${freshColor(o.rem)}"></i></div>`;
        else d.innerHTML += `<span class="n">${n}</span>`;
      }
      else if (id !== 'hoe' && id !== 'pick' && id !== 'lamp') d.innerHTML += `<span class="n">${n}</span>`;
      d.onclick = () => { selectItem(id); };
      bar.appendChild(d);
    }
    // doplní rad (mobil 6, počítač 9 miest); prvé prázdne miesto je vždy vidieť – jeho výberom máš prázdnu ruku
    for (let i = ids.length; i < Math.max(9, ids.length + 1); i++) {
      const d = Object.assign(document.createElement('div'), { className: 'slot empty' + (i === ids.length ? ' keep' + (S.sel === '' ? ' on' : '') : '') });
      d.onclick = () => { selectItem(''); };
      bar.appendChild(d);
    }
    const sel = bar.querySelector('.on');
    if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    let txt = D.itemName(S.sel);
    if (!S.sel) txt = 'Prázdna ruka · hľadaj v tráve divé semienka 🔍';
    if (S.sel === 'can') txt += ` · ${S.water}/${S.canCap} 💧`;
    if (S.sel === 'hoe') txt += ` · pole záhrady ${S.plotsUsed}/${S.plotLimit}`;
    const seedSp = S.sel.startsWith('seed_') ? speciesOf(S.sel.slice(5)) : undefined;
    if (seedSp) {
      const sp = seedSp;
      txt += ' · ' + sp.seasons.map(s => D.SEASON_ICONS[s]).join('') + ' · ' + ({ sun: '☀️', shade: '🌳', any: '⛅' })[sp.light] + (sp.soil ? ' · ' + ({ sand: 'piesok', rich: 'kompost', rock: 'skalka' })[sp.soil] : '');
    }
    if (S.sel.startsWith('fl_')) txt += ' · ' + freshText(S.sel);
    if (D.isWild(S.sel)) txt += ' · ' + (D.SEASON_ICONS[+S.sel.slice(5)] ?? '') + ' · nevedno, čo z neho vyrastie';
    if (S.sel === 'wilted') txt += ` · ${D.WILTED_PER_COMPOST} ks = 1 kompost (v sklade)`;
    if (S.sel === 'pick') txt += ' · ľad na ľadovci v horách, v zime aj na jazierku';
    if (S.sel === 'lamp') txt += ' · v ruke svieti, keď je tma';
    if (S.sel === 'silk') txt += ` · z pavučín v Lese divov · ${D.BLANKET_SILK} ks = 1 prikrývka (majster hodvábu, krosná v Dielni)`;
    if (S.sel === 'blanket') txt += ' · ťukni s ňou na ľadovňu – izoluje ju, ľad sa topí pomalšie';
    if (S.sel === 'ice') {
      const o = oldestBatch('ice');
      txt += ` ${S.inv.ice || 0}/${D.ICE_CARRY} · ťažký` + (o ? ` · roztopí sa o ${fmtLeft(o.left)}` : '');
    }
    const selPotion = S.sel.startsWith('po_') ? potionOf(S.sel.slice(3)) : undefined;
    if (selPotion) txt += ' · ' + selPotion.desc;
    $('selName').textContent = txt;
  }

  function updateHud(): void {
    const m = curMin(), h = Math.floor(m / 60), mm = Math.floor(m % 60 / 10) * 10;
    const se = season();
    const dayInSeason = (S.day - 1) % D.DAYS_PER_SEASON + 1;
    $('hDate').textContent = (S.area !== 'garden' ? D.AREA_FX[S.area].icon + ' ' : '') + `${D.SEASON_ICONS[se] ?? ''} ${D.SEASONS[se] ?? ''} · deň ${dayInSeason}/${D.DAYS_PER_SEASON}`;
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
      if (h >= 20 || h < 5) { toast(must(SECRETS[Math.floor(Math.random() * SECRETS.length)]), 'magic'); sfx('magic'); }

      else toast('😎 Slnko ťa oslepilo. Skús to radšej v noci…');
    }
  });

  // ---------- Modálne okná ----------
  function openModal(title: string, render: (body: HTMLElement) => void): void {
    $('mTitle').textContent = title;
    S.modal = { refresh: () => { $('mBody').innerHTML = ''; render($('mBody')); } };
    S.modal.refresh();
    $('modal').classList.remove('hidden');
  }
  function closeModal(): void { $('modal').classList.add('hidden'); S.modal = null; S.brewed = null; S.brewHint = null; }
  $('mClose').onclick = closeModal;
  $('modal').addEventListener('click', e => { if (e.target === $('modal')) closeModal(); });
  $('bBook').onclick = () => { openUI('book'); };
  $('bMenu').onclick = () => { openUI('menu'); };

  // Prvok stránky: atribúty (onclick = obsluha kliknutia, html = obsah ako HTML, ostatné ako atribúty) a deti
  type Attrs = { onclick?: () => void; html?: string; [attr: string]: string | number | (() => void) | null | undefined };
  function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...kids: (Node | string | null | undefined)[]): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null) continue;
      if (typeof v === 'function') { if (k === 'onclick') el.onclick = v; }
      else if (k === 'html') el.innerHTML = String(v);
      else el.setAttribute(k, String(v));
    }
    for (const k of kids) if (k != null) el.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
    return el;
  }
  const img = (id: string): HTMLImageElement => h('img', { src: Art.icon(id) });
  const seasonBadges = (sp: Species): HTMLElement => {
    const box = h('span');
    sp.seasons.forEach(s => box.appendChild(h('span', { class: 'badge' + (s === season() ? ' now' : '') }, D.SEASON_ICONS[s] + ' ' + D.SEASONS[s])));
    return box;
  };

  function openUI(kind: UiKind): void {
    sfx('pop');
    if (kind === 'shop') { openShop('buy'); return; }
    if (kind === 'cauldron') { S.brewed = null; openModal('⚗️ Čarovný kotlík', renderCauldron); return; }
    if (kind === 'babka') { S.tipIdx = D.nextTipIdx(S.tipIdx, S.recipes.length > 0); openModal('👵 Babka bylinkárka', renderBabka); return; }
    if (kind === 'book') { openBook('flowers'); return; }
    if (kind === 'menu') { openModal('☰ Menu', renderMenu); return; }
    if (kind === 'help') { openModal('❓ Ako hrať', renderHelp); return; }
    if (kind === 'storage') { openModal('📦 Spoločný sklad', renderStorage); return; }
    if (kind === 'house') { openModal('🏠 Domček', renderHouse); return; }
    if (kind === 'wish') { openModal('✨ Papraďový kvet', renderWish); return; }
    if (kind === 'icehouse') { openModal('🧊 Ľadovňa', renderIcehouse); return; }
    if (kind === 'dielna') { openModal('🪚 Dielňa', renderDielna); return; }
    if (kind === 'vehicle') { Veh.open(); return; } // fúrik a sane (#158)
    openModal('🧵 ' + D.MASTER.name, renderMaster); // majster
  }

  // ---- Pomocné pre ekonomiku ----
  const TPD = D.TICKS_PER_DAY;
  function fmtLeft(ticks: number): string {
    if (ticks <= 0) return 'teraz';
    const hTotal = Math.round(ticks * D.MIN_PER_TICK / 60);
    const d = Math.floor(hTotal / 24), hh = hTotal % 24;
    return (d ? d + ' d ' : '') + (hh || !d ? hh + ' h' : '');
  }
  function fmtTick(t: number): string { const m = Math.floor(D.minOfTick(t)); return `deň ${D.dayOfTick(t)}, ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }
  // Trend ceny za posledný deň ako ikonka: vždy 3 šípky natesno nad sebou, farebné sú
  // 1 (malá zmena), 2 (veľká) alebo 3 (veľmi veľká), zvyšok je sivý. Bez zmeny = všetky sivé.
  // upIsGood: pri predaji je rast ceny dobrý (zelený), pri nákupe zlý (červený).
  function priceTrend(hist: readonly number[] | undefined, cur: number, upIsGood: boolean): HTMLElement {
    const hh = hist || [];
    const prev = (hh.length >= 2 ? hh[hh.length - 2] : hh[0]) ?? cur;
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
      paths += `<path d="${d}" fill="none" stroke="${lit && col ? col : GRAY}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    const el = document.createElement('span');
    el.className = 'tr';
    el.title = n ? `${up ? 'Rast' : 'Pokles'} o ${Math.round(a * 100)} % za deň` : 'Cena sa za deň takmer nezmenila';
    el.innerHTML = `<svg width="16" height="21" viewBox="0 0 16 21">${paths}</svg>`;
    return el;
  }
  function marketSellPrice(id: string): number {
    const M = S.market;
    if (!M) return D.sellPrice(id);
    const fl = id.startsWith('fl_') ? lookup(M.flowers, id.slice(3)) : undefined, seed = id.startsWith('seed_') ? lookup(M.seeds, id.slice(5)) : undefined;
    if (fl) return fl.p;
    const sp = id.slice(5);
    if (seed && D.isSpeciesId(sp)) return Math.max(1, Math.round(D.seedSellBase(sp, seed.p) * D.SEED_SELL_BACK));
    if (id === 'compost') return Math.max(1, Math.round(M.compost.p * 0.5));
    if (id === 'ice') return D.ICE_PRICE[D.seasonOf(S.day)] ?? 0;
    return D.sellPrice(id);
  }
  function festivalBanner(body: HTMLElement): void {
    const M = S.market;
    if (!M) return;
    const list = (mult: Partial<Record<SpeciesId, number>>): string => entries(mult).map(([sp, x]) => `${D.SPECIES[sp].name} ×${String(x).replace('.', ',')}`).join(', ');
    if (M.festival) body.appendChild(h('div', { class: 'row', style: 'background:#fff1d6;border-color:#e08a1e' }, h('div', { class: 'info' }, h('b', null, `${M.festival.icon} Práve je ${M.festival.name}!`), h('small', null, 'Vyšší výkup: ' + list(M.festival.mult)))));
    else if (M.upcoming) body.appendChild(h('div', { class: 'row' }, h('div', { class: 'info' }, h('b', null, `📅 ${M.upcoming.icon} ${M.upcoming.name} o ${fmtLeft(M.upcoming.start - S.tick)}`), h('small', null, 'Vyšší výkup: ' + list(M.upcoming.mult)))));
  }

  // ---- Trh s knihou objednávok (#112) ----
  // Počítadlo kusov a otvorený blok Dopyt / Ponuka pri položke (kľúč 'buy:<id>' / 'sell:<id>'); pamätá sa, kým je okno otvorené
  const shopN = new Map<string, number>();
  let shopOpen: string | null = null;
  const num = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(1).replace('.', ','));
  // Položka trhu pre tovar s knihou (null = tovar bez knihy: pevná výkupná cena)
  function bookView(id: string): MarketItemView | null {
    const M = S.market;
    if (!M || !Bk.isBookItem(id)) return null;
    if (id === 'compost') return M.compost;
    const sp = id.startsWith('seed_') ? id.slice(5) : id.slice(3);
    return (id.startsWith('seed_') ? lookup(M.seeds, sp) : lookup(M.flowers, sp)) ?? null;
  }
  // Úrovne knihy bez vlastných objednávok (sám so sebou sa neobchoduje)
  const others = (l: readonly Level[]): Level[] => l.filter(x => x.w !== S.name);
  // Čerstvosť i-teho predávaného kusu kvetu z batohu (najstaršie idú prvé)
  function sellFresh(id: string): (i: number) => number {
    const list = (S.fb && lookup(S.fb, id)) || [], sp = id.slice(3), extra = Math.max(0, S.tick - (S.fbTick ?? S.tick));
    return i => {
      if (!D.isSpeciesId(sp)) return 1;
      for (const b of list) { if (i < b.n) return D.freshness(sp, b.age + extra); i -= b.n; }
      return 1;
    };
  }
  // Riadok tovaru s počítadlom, okamžitým obchodom a blokom Dopyt / Ponuka. side = čo robí hráč (kúpiť / predať).
  function tradeRow(body: HTMLElement, id: ItemId, side: 'buy' | 'sell', info: HTMLElement, q: MarketItemView | null, fixed: number): void {
    const key = side + ':' + id, have = S.inv[id] ?? 0;
    const lv = q ? others(side === 'buy' ? q.a : q.b) : [];
    const avail = lv.reduce((a, l) => a + l.n, 0), fresh = side === 'sell' && id.startsWith('fl_') ? sellFresh(id) : undefined;
    const total = (k: number): { n: number; total: number; worst: number; first: string | null } => (q ? Bk.walk(lv, k, fresh) : { n: k, total: k * fixed, worst: fixed, first: null });
    // Najviac kusov: pri nákupe koľko zaplatí (aj nad ponuku – pre dopyt podľa priemernej ceny), pri predaji čo má
    const ref = (k: number): number => {
      if (!q) return k * fixed;
      if (avail >= k) return total(k).total;
      if (avail > 0) return Math.round(total(avail).total / avail * k);
      return k * q.p;
    };
    let max = side === 'sell' ? have : 0;
    if (side === 'buy') while (max < 99 && ref(max + 1) <= S.coins) max++;
    const n = Math.max(1, Math.min(shopN.get(key) ?? 1, Math.max(1, max)));
    const setN = (k: number): void => { shopN.set(key, Math.max(1, Math.min(k, Math.max(1, max)))); refreshModal(); };
    const now = total(n), avg = ref(n) / n;
    // riadok s cenou: Ø za kus pre zvolené množstvo, trend, zásoba a kto je prvý protivník
    const line = h('small', null, (side === 'sell' ? `${have} ks · ` : '') + `Ø ${num(Math.round(avg * 10) / 10)} 🪙/ks `);
    if (q) line.appendChild(priceTrend(q.h, q.p, side === 'sell'));
    if (q && side === 'buy') line.appendChild(document.createTextNode(avail ? ` · na sklade ${avail}` : ' · VYPREDANÉ'));
    if (q && side === 'sell' && id.startsWith('fl_')) line.appendChild(document.createTextNode(` · na trhu ${q.st} ks`));
    const first = lv[0];
    if (first && first.w) line.appendChild(h('span', { class: 'who' }, side === 'buy' ? ` · 🏷️ ${first.w}` : ` · ${first.w} kúpi za ${first.p}`));
    info.appendChild(line);
    if (side === 'buy' && first && first.fr != null) info.appendChild(h('small', { class: 'fr' }, `🌷 čerstvosť ${Math.round(first.fr * 100)} %`));
    const open = shopOpen === key && !!q;
    const cnt = h('div', { class: 'cnt' },
      h('button', { onclick: () => { setN(n - 1); } }, '−'), h('span', null, String(n)), h('button', { onclick: () => { setN(n + 1); } }, '+'),
      side === 'buy' ? h('button', { onclick: () => { setN(n + 5); } }, '+5') : h('button', { onclick: () => { setN(have); } }, 'Všetko'));
    const inst = h('button', { class: 'btn', onclick: () => { send({ t: side, id, n, lim: now.worst }); if (side === 'sell') sfx('coin'); shopN.delete(key); } }, `${now.total} 🪙`);
    if (now.n < n || !now.total || (side === 'buy' && now.total > S.coins) || (side === 'sell' && have < n)) { inst.disabled = true; inst.textContent = '— 🪙'; }
    const ctl = h('div', { class: 'ctl' }, cnt, h('div', { class: 'grow' }), inst);
    if (q) ctl.appendChild(h('button', { class: 'btn tg' + (open ? ' on' : ''), onclick: () => { shopOpen = open ? null : key; refreshModal(); } }, side === 'buy' ? 'Dopyt' : 'Ponuka'));
    const item = h('div', { class: 'item' + (open ? ' open' : '') }, h('div', { class: 'top' }, img(id), info), ctl);
    if (open) {
      // štyri ceny: násobky okamžitej ceny, zelená = lepšie pre hráča, červená = horšie
      const colors = side === 'buy' ? ['g2', 'g1', 'r1', 'r2'] : ['r2', 'r1', 'g1', 'g2'];
      const four = h('div', { class: 'four' });
      Bk.STEPS.forEach((f, i) => {
        const p = Bk.stepPrice(avg, f), t = p * n;
        const b = h('button', { class: 'btn ' + (colors[i] ?? ''), title: `${p} 🪙/ks`, onclick: () => { send({ t: 'order', id, side, n, p }); shopOpen = null; shopN.delete(key); } }, `${t} 🪙`);
        if ((side === 'buy' && t > S.coins) || (side === 'sell' && have < n) || S.orders.length >= S.orderLimit) b.disabled = true;
        four.appendChild(b);
      });
      item.appendChild(h('div', { class: 'blk' }, h('div', { class: 'lbl' }, side === 'buy' ? 'Dopyt' : 'Ponuka'), four));
    }
    body.appendChild(item);
  }

  function openShop(tab: 'buy' | 'sell' | 'mine' | 'up' | 'news'): void {
    openModal('🛒 Trh', body => {
      const M = S.market;
      body.appendChild(h('div', { class: 'tabs tabs5' },
        h('button', { class: tab === 'buy' ? 'on' : '', onclick: () => { openShop('buy'); } }, 'Kúpiť'),
        h('button', { class: tab === 'sell' ? 'on' : '', onclick: () => { openShop('sell'); } }, 'Predať'),
        h('button', { class: tab === 'mine' ? 'on' : '', onclick: () => { openShop('mine'); } }, 'Moje'),
        h('button', { class: tab === 'up' ? 'on' : '', onclick: () => { openShop('up'); } }, 'Vylepšiť'),
        h('button', { class: tab === 'news' ? 'on' : '', onclick: () => { openShop('news'); } }, 'Správy')));
      body.appendChild(h('div', { style: 'text-align:center;font-weight:700;margin-bottom:8px' }, `Máš 🪙 ${S.coins} · ⭐ reputácia ${S.rep} (úroveň ${D.repLevel(S.rep)})`));
      if (!M) { body.appendChild(h('p', null, 'Načítavam trh…')); return; }
      if (tab === 'buy') {
        festivalBanner(body);
        const se = season();
        const rank = (sp: SpeciesId): number => D.SPECIES[sp].seasons.some(s => s === se) ? 0 : D.SPECIES[sp].seasons.some(s => s === (se + 1) % 4) ? 1 : 2;
        // kvety sa dajú kúpiť, keď ich niekto (hráč, Jano) ponúka
        const fls = keys(M.flowers).filter(sp => others(lookup(M.flowers, sp)?.a ?? []).length).map(sp => `fl_${sp}` as const);
        const ids: ItemId[] = ['compost', ...keys(M.seeds).sort((a, b) => rank(a) - rank(b)).map(sp => `seed_${sp}` as const), ...fls];
        for (const id of ids) {
          const q = bookView(id);
          if (!q) continue;
          const sp = speciesOf(id.startsWith('seed_') ? id.slice(5) : id.slice(3)) ?? null;
          const info = h('div', { class: 'info' }, h('b', null, sp ? D.itemName(id) : 'Kompost'));
          if (id.startsWith('seed_') && sp) {
            const lockedRep = lookup(D.MIN_SEED_REP, id.slice(5));
            info.appendChild(h('small', null, `${sp.days} dní · ${'💧'.repeat(sp.water)} · ${({ sun: '☀️', shade: '🌳', any: '⛅' })[sp.light]}${sp.soil ? ' · ' + ({ sand: 'piesok', rich: 'kompost', rock: 'len skalka' })[sp.soil] : ''}`));
            if (lockedRep && D.repLevel(S.rep) < lockedRep) info.appendChild(h('small', { style: 'color:#b0432a' }, `🔒 od reputácie ${lockedRep}`));
          }
          tradeRow(body, id, 'buy', info, q, 0);
        }
      } else if (tab === 'sell') {
        festivalBanner(body);
        body.appendChild(h('small', { style: 'display:block;margin-bottom:6px' }, 'Každý predaný kus trochu zníži výkupnú cenu – trh sa nasycuje. Cez noc zákazníci kvety rozkúpia. Ponuku za vyššiu cenu môže kúpiť iný hráč.'));
        const ids = hotbarIds().filter(id => !D.isTool(id) && (Bk.isBookItem(id) || marketSellPrice(id) > 0));
        if (!ids.length) body.appendChild(h('p', null, 'Nemáš nič na predaj. Vypestuj nejaké kvety! 🌷'));
        for (const id of ids) {
          const info = h('div', { class: 'info' }, h('b', null, D.itemName(id)));
          const o = id.startsWith('fl_') ? oldestBatch(id) : null;
          tradeRow(body, id, 'sell', info, bookView(id), marketSellPrice(id));
          if (o) info.appendChild(h('small', { class: 'fr', style: `color:${freshColor(o.rem)}` }, `🌷 ${freshText(id)}`));
        }
      } else if (tab === 'mine') {
        body.appendChild(h('small', { style: 'display:block;color:#7a6a4a;margin-bottom:6px' }, `Otvorené: ${S.orders.length} z ${S.orderLimit} · vyššia reputácia dovolí viac · objednávka platí ${Bk.ORDER_DAYS} dni`));
        if (!S.orders.length) body.appendChild(h('p', null, 'Nemáš žiadne otvorené objednávky. Dopyt alebo Ponuku zadáš pri tovare v Kúpiť a Predať. 🏷️'));
        for (const o of S.orders) {
          const buy = o.side === 'buy', done = o.q - o.rem;
          const parts = [`${done} z ${o.q} ${buy ? 'kúpené' : 'predané'}`, `${o.p} 🪙/ks`];
          if (buy) parts.push(`odložené ${o.coins} 🪙`);
          if (o.exp != null) parts.push(`ešte ${fmtLeft(o.exp - S.tick)}`);
          if (o.fr != null) parts.push(`čerstvosť ${Math.round(o.fr * 100)} %`);
          body.appendChild(h('div', { class: 'row' }, img(o.item),
            h('div', { class: 'info' }, h('b', null, h('span', { class: 'kind', style: `background:${buy ? '#6b3fa0' : '#8b5a2b'}` }, buy ? 'Dopyt' : 'Ponuka'), D.itemName(o.item)),
              h('small', null, parts.join(' · ')), h('div', { class: 'bar' }, h('div', { style: `width:${Math.round(done / o.q * 100)}%` }))),
            h('div', { class: 'btns' }, h('button', { class: 'btn gray', onclick: () => { send({ t: 'cancelOrder', id: o.id }); } }, 'Zrušiť'))));
        }
      } else if (tab === 'up') {
        const lvl = D.repLevel(S.rep), next = D.REP_LEVELS[lvl + 1], cur = D.REP_LEVELS[lvl] ?? 0;
        body.appendChild(h('div', { class: 'row', style: 'flex-direction:column;align-items:stretch' },
          h('b', null, `⭐ Reputácia: ${S.rep} · úroveň ${lvl}`),
          h('div', { style: 'height:8px;background:#eee;border-radius:4px;overflow:hidden' }, h('div', { style: `height:100%;width:${next ? Math.min(100, (S.rep - cur) / (next - cur) * 100) : 100}%;background:#e8a21c` })),
          h('small', null, next ? `Do úrovne ${lvl + 1} chýba ${next - S.rep}. Reputáciu získaš za splnené zákazky na nástenke pri babke.` : 'Najvyššia úroveň!'),
          h('small', null, `Naraz môžeš mať ${S.maxActive} ${S.maxActive === 1 ? 'zákazku' : 'zákazky'}. Veľké zákazky sa objavujú od úrovne 2, plesnivec od úrovne 2.`)));
        for (const kind of keys<UpgradeId>(D.UPGRADES)) {
          const u = D.UPGRADES[kind], cur = S.up[kind] || 0, nx = u.levels[cur + 1];
          const info = h('div', { class: 'info' }, h('b', null, `${u.icon} ${u.name}`), h('small', null, `teraz: ${u.levels[cur]?.v ?? ''} ${u.unit}` + (u.shared ? ` pre celú záhradu (obrobené ${S.plotsUsed})` : '')));
          let btn: HTMLButtonElement;
          if (!nx) btn = h('button', { class: 'btn gray', disabled: 'disabled' }, 'Max');
          else {
            info.appendChild(h('small', null, `ďalej: ${nx.v} ${u.unit}` + (u.shared ? ' pre všetkých' : '') + (nx.rep ? ` · treba ⭐${nx.rep}` : '')));
            btn = h('button', { class: 'btn', onclick: () => { send({ t: 'upgrade', kind }); } }, String(nx.price) + '🪙');
            if (S.coins < (nx.price ?? 0) || lvl < (nx.rep ?? 0)) btn.disabled = true;
          }
          body.appendChild(h('div', { class: 'row' }, h('div', { style: 'font-size:30px;width:40px;text-align:center' }, u.icon), info, h('div', { class: 'btns' }, btn)));
        }
        // Náradie (raz na hráča) a spoločná stavba – ľadovňa
        const buyRow = (icon: string, name: string, desc: string, have: string | null, price: number, rep: number, onclick: () => void, art?: string): void => {
          const btn = have ? h('button', { class: 'btn gray', disabled: 'disabled' }, have) : h('button', { class: 'btn', onclick }, price + '🪙');
          if (!have && (S.coins < price || lvl < rep)) btn.disabled = true;
          body.appendChild(h('div', { class: 'row' }, art ? h('img', { src: art, style: 'width:40px;height:40px' }) : h('div', { style: 'font-size:30px;width:40px;text-align:center' }, icon),
            h('div', { class: 'info' }, h('b', null, `${icon} ${name}`), h('small', null, desc + (rep ? ` · treba ⭐${rep}` : ''))), h('div', { class: 'btns' }, btn)));
        };
        for (const id of keys(D.TOOLS)) {
          const T = D.TOOLS[id];
          buyRow(T.icon, T.name, T.desc, S.inv[id] ? 'Máš' : null, T.price, T.rep, () => { send({ t: 'buyTool', id }); });
        }
        const B = D.ICEHOUSE;
        buyRow(B.icon, B.name, `Spoločná stavba pri domčeku pre ${B.cap} blokov ľadu. Kým je v nej ľad, kvety v sklade vädnú 4× pomalšie (inak 2×). Ľad sa topí, v zime nie.`,
          S.icehouse.built ? 'Stojí' : null, B.price, B.rep, () => { send({ t: 'build', id: 'icehouse' }); });
        const DL = D.DIELNA;
        buyRow(DL.icon, DL.name, `Spoločná stavba vedľa trhu. Kúpiš do nej krosná (${DL.loom.price} 🪙), ktoré zo ${D.BLANKET_SILK} hodvábu utkajú prikrývku na izoláciu ľadovne – bez platenia majstrovi.`,
          S.dielna.built ? 'Stojí' : null, DL.price, DL.rep, () => { send({ t: 'build', id: 'dielna' }); });
        const DK = D.DOCK; // mólo s loďkou (#160)
        buyRow(DK.icon, DK.name, 'Spoločná stavba pri jazierku s loďkou pre dvoch. Loďkou sa dostaneš aj tam, kam z brehu nikto nedočiahne. V zime leží prevrátená na móle.',
          S.dock?.built ? 'Stojí' : null, DK.price, DK.rep, () => { send({ t: 'build', id: 'dock' }); }, Art.icon('dock'));
      } else {
        festivalBanner(body);
        if (!M.news.length) body.appendChild(h('p', null, 'Zatiaľ žiadne správy.'));
        for (const n of M.news) body.appendChild(h('div', { class: 'row' }, h('div', { class: 'info' }, h('small', null, fmtTick(n.tick)), h('span', { style: 'font-size:14px' }, n.text))));
      }
    });
  }

  const refreshModal = (): void => { if (S.modal) S.modal.refresh(); };
  function renderCauldron(body: HTMLElement): void {
    const slots = h('div', { class: 'cauldron-slots' });
    for (let i = 0; i < 3; i++) {
      const id = S.cauldron[i];
      slots.appendChild(h('div', { class: 'cslot', onclick: () => { S.cauldron.splice(i, 1); refreshModal(); } }, id ? img(id) : null));
    }
    if (S.brewed) {
      const p = D.POTIONS[S.brewed];
      body.appendChild(h('div', { class: 'row', style: 'border-color:#9b59d0;background:#f7eeff' }, img('po_' + S.brewed),
        h('div', { class: 'info' }, h('b', null, 'Uvarené: ' + p.name + '!'), h('small', null, p.desc))));
      if (S.brewed === 'sliz' && S.brewHint) body.appendChild(h('p', { class: 'brew-hint', style: 'margin:6px 2px;font-size:14px;font-style:italic;text-align:center;color:#5b3b7a' }, '⚗️ ' + D.brewHintText(S.brewHint)));
    }
    body.appendChild(h('p', { style: 'margin:4px 0;font-size:14px;text-align:center' }, 'Do kotlíka patria vždy tri kvety – no elixír dá len správna trojica. Ostatné skončia ako sliz.'));
    body.appendChild(slots);
    body.appendChild(h('button', { class: 'big', style: 'margin-bottom:12px', onclick: () => { if (S.cauldron.length === 3) send({ t: 'brew', items: S.cauldron.slice() }); } }, S.cauldron.length === 3 ? '🔥 Uvariť!' : `Vyber ešte ${3 - S.cauldron.length}`));
    const grid = h('div', { class: 'grid' });
    const flowers = hotbarIds().filter(id => id.startsWith('fl_'));
    if (!flowers.length) body.appendChild(h('p', null, 'Nemáš žiadne kvety. Najprv nejaké vypestuj. 🌱'));
    for (const id of flowers) {
      const left = (S.inv[id] ?? 0) - S.cauldron.filter(x => x === id).length;
      grid.appendChild(h('div', { class: 'gcell', style: left ? '' : 'opacity:.35', onclick: () => { if (left > 0 && S.cauldron.length < 3) { S.cauldron.push(id); S.brewed = null; refreshModal(); } } }, img(id), h('span', { class: 'n' }, String(left))));
    }
    body.appendChild(grid);
    body.appendChild(h('h3', { style: 'margin:14px 0 6px' }, `📜 Objavené recepty (${S.recipes.length}/${Object.keys(D.RECIPES).length})`));
    if (!S.recipes.length) body.appendChild(h('small', null, 'Zatiaľ žiadne. Babka pozná recepty – vypočuj si jej rady (aj viackrát). Vraj aj studňa niečo našepká. 👵'));
    for (const key of S.recipes) {
      const k = lookup(D.RECIPES, key);
      if (!k) continue;
      const row = h('div', { class: 'row' });
      key.split('+').forEach(sp => { row.appendChild(img('fl_' + sp)); });
      row.appendChild(h('span', null, '→'));
      row.appendChild(img('po_' + k));
      row.appendChild(h('div', { class: 'info' }, h('b', null, D.POTIONS[k].name)));
      body.appendChild(row);
    }
  }

  function renderBabka(body: HTMLElement): void {
    const pc = h('canvas', { width: 80, height: 90 });
    Art.char(ctx2d(pc), 40, 86, 80, { shirt: '#7b4a9e', hair: '#eee' }, 0, 0, { babka: true });
    const hr = curMin() / 60;
    const hello = hr < 10 ? 'Dobré ránko' : hr < 18 ? 'Dobrý deň' : 'Dobrý večer';
    body.appendChild(h('div', { class: 'dlg' }, pc, h('div', { class: 'bubble' }, `${hello}, ${S.name}! Na nástenke pri mojej chalúpke nechávajú ľudia zákazky. Zober si, čo stihneš – termín sa musí dodržať. 💡 ${D.TIPS[S.tipIdx]}`)));
    const me = S.name.toLowerCase();
    const list = S.board;
    const mine = list.filter(c => c.takenBy === me);
    const kindLbl = { short: 'krátka', long: 'na budúce obdobie', big: 'veľká' };
    const card = (c: Contract, actions: Node[]): HTMLElement => {
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
      // odovzdá sa len toľko, koľko zákazke ešte chýba
      const k = Math.min(S.inv[`fl_${c.sp}`] || 0, c.n - c.got);
      const b = h('button', { class: 'btn alt', onclick: () => { send({ t: 'cdeliver', id: c.id }); } }, `Odovzdať (${k})`);
      if (k <= 0) b.disabled = true;
      body.appendChild(card(c, [b]));
    }
    body.appendChild(h('h3', { style: 'margin:14px 0 6px' }, '📌 Nástenka'));
    const open = list.filter(c => !c.takenBy);
    if (!open.length) body.appendChild(h('small', null, 'Nástenka je prázdna. Ráno pribudnú nové zákazky.'));
    for (const c of open) {
      const b = h('button', { class: 'btn', onclick: () => { send({ t: 'ctake', id: c.id }); } }, 'Zarezervovať');
      if (mine.length >= S.maxActive) b.disabled = true;
      body.appendChild(card(c, [b]));
    }
    const others = list.filter(c => c.takenBy && c.takenBy !== me);
    if (others.length) {
      body.appendChild(h('h3', { style: 'margin:14px 0 6px' }, '👥 Zákazky ostatných'));
      for (const c of others) body.appendChild(card(c, [h('small', null, c.takenBy)]));
    }
    body.appendChild(h('button', { class: 'btn gray', style: 'margin-top:10px;width:100%', onclick: () => { S.tipIdx = (S.tipIdx + 1) % D.TIPS.length; refreshModal(); } }, 'Ďalšia rada'));
  }

  function openBook(tab: 'flowers' | 'potions'): void {
    openModal('📖 Herbár', body => {
      body.appendChild(h('div', { class: 'tabs' },
        h('button', { class: tab === 'flowers' ? 'on' : '', onclick: () => { openBook('flowers'); } }, '🌼 Kvety'),
        h('button', { class: tab === 'potions' ? 'on' : '', onclick: () => { openBook('potions'); } }, '🧪 Elixíry')));
      if (tab === 'flowers') {
        for (const k of keys(D.SPECIES)) {
          const sp = D.SPECIES[k];
          const known = !sp.magic || S.seen.includes(k);
          const card = h('div', { class: 'card' + (sp.magic ? ' magic' : '') + (known ? '' : ' locked') });
          if (!known) {
            card.appendChild(h('div', { style: 'width:56px;height:56px;font-size:40px;text-align:center' }, '❔'));
            card.appendChild(h('div', null, h('b', null, '??? – čarovný kvet'), h('p', null, sp.shape === 'fern' ? 'Starí ľudia o ňom rozprávajú len potichu… v noci, pri lese.' : 'Vraj sa zrodil z lásky.')));
          } else {
            card.appendChild(img('fl_' + k));
            card.appendChild(h('div', null, h('b', null, sp.name), h('div', { class: 'latin' }, sp.latin), seasonBadges(sp),
              h('div', { style: 'font-size:12.5px;margin-top:3px' }, `⏱ ${sp.days} dní · ${sp.aqua ? (sp.aqua.zone === 'deep' ? '🌊 hlboká voda' : '🌿 breh') : `${'💧'.repeat(sp.water)} · ${({ sun: '☀️ slnko', shade: '🌳 tieň', any: '⛅ hocikde' })[sp.light]}`}${sp.soil ? ' · ' + ({ sand: '🏖️ piesok', rich: '🟤 výživná pôda', rock: '🪨 len skalka' })[sp.soil] : ''}${sp.perennial ? ' · ♻️ trvalka' : ''} · ✂️ vo váze ${sp.life} ${sp.life === 1 ? 'deň' : sp.life < 5 ? 'dni' : 'dní'}`),
              sp.aqua ? h('div', { style: 'font-size:12.5px;margin-top:3px;color:#2f6f9f' }, '💧 ' + D.aquaHint(sp.aqua)) : null,
              h('p', null, sp.fact)));
          }
          body.appendChild(card);
        }
      } else {
        for (const k of keys(D.POTIONS)) {
          if (k === 'sliz') continue;
          const key = Object.keys(D.RECIPES).find(r => D.RECIPES[r] === k) ?? '';
          const known = S.recipes.includes(key);
          const card = h('div', { class: 'card' + (known ? ' magic' : ' locked') }, img('po_' + k),
            h('div', null, h('b', null, known ? D.POTIONS[k].name : '??? elixír'), h('p', null, known ? D.POTIONS[k].desc + ' Recept: ' + key.split('+').map(s => speciesOf(s)?.name ?? s).join(' + ') : 'Recept zatiaľ nepoznáš. Experimentuj v kotlíku alebo sa pýtaj babky.')));
          body.appendChild(card);
        }
      }
    });
  }

  function renderMenu(body: HTMLElement): void {
    const link = location.origin + location.pathname + '?room=' + S.room;
    body.appendChild(h('div', { class: 'row' }, h('div', { class: 'info' }, h('b', null, 'Záhrada: ' + S.room), h('small', null, 'Hráči: ' + S.names.join(', ')))));
    body.appendChild(h('div', { class: 'row' }, h('div', { class: 'info' }, h('b', null, 'Pozvi kamaráta'), h('small', { style: 'word-break:break-all' }, link)),
      h('button', { class: 'btn', onclick: () => { const nav: { share?: Navigator['share'] } = navigator; (nav.share ? nav.share({ title: 'Čarovná záhrada', url: link }) : navigator.clipboard.writeText(link).then(() => { toast('Odkaz skopírovaný 📋'); })).catch(() => { /* zdieľanie zrušené */ }); } }, 'Zdieľať')));
    // Nastavenia sveta – platia pre všetkých hráčov v tejto záhrade
    body.appendChild(h('h3', { style: 'margin:12px 0 6px' }, '⚙️ Nastavenia sveta'));
    const setBtn = (label: string, on: boolean, patch: { mode: WorldMode }): HTMLButtonElement => h('button', { class: 'btn' + (on ? '' : ' gray'), style: 'flex:1', onclick: () => { send({ t: 'settings', mode: patch.mode }); } }, label);
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
      const r3 = R3;
      const opts = [['none', 'žiadne'], ['medium', 'stredné'], ['real', 'skutočné']] as const;
      const btns = opts.map(([q, l]) => h('button', { class: 'btn' + (r3.waterQuality === q ? '' : ' gray'), style: 'flex:1', onclick: () => {
        r3.setWaterQuality(q); btns.forEach((b, i) => b.classList.toggle('gray', opts[i]?.[0] !== q));
      } }, l));
      body.appendChild(h('div', { class: 'row', style: 'flex-direction:column;align-items:stretch' },
        h('b', null, '🌊 Odrazy vody'), h('div', { style: 'display:flex;gap:6px' }, ...btns),
        h('small', null, 'Platí len na tomto zariadení. Skutočné odrazy ukážu vo vode aj hráčov a kvety, ale viac zaťažia telefón.')));
      const popts = [['low', 'menej'], ['high', 'viac']] as const;
      const pbtns = popts.map(([q, l]) => h('button', { class: 'btn' + (r3.particleQuality === q ? '' : ' gray'), style: 'flex:1', onclick: () => {
        r3.setParticleQuality(q); pbtns.forEach((b, i) => b.classList.toggle('gray', popts[i]?.[0] !== q));
      } }, l));
      body.appendChild(h('div', { class: 'row', style: 'flex-direction:column;align-items:stretch' },
        h('b', null, '✨ Častice (dážď, oheň, lístie, víly)'), h('div', { style: 'display:flex;gap:6px' }, ...pbtns),
        h('small', null, 'Platí len na tomto zariadení. Na slabšom telefóne zvoľ menej.')));
      const fopts = [[false, 'vypnuté'], [true, 'zapnuté']] as const;
      const fbtns = fopts.map(([v, l]) => h('button', { class: 'btn' + (Fps.on === v ? '' : ' gray'), style: 'flex:1', onclick: () => {
        Fps.set(v); fbtns.forEach((b, i) => b.classList.toggle('gray', fopts[i]?.[0] !== v));
      } }, l));
      body.appendChild(h('div', { class: 'row', style: 'flex-direction:column;align-items:stretch' },
        h('b', null, '📊 Počítadlo snímok (FPS)'), h('div', { style: 'display:flex;gap:6px' }, ...fbtns),
        h('small', null, 'Ukáže v rohu, ako rýchlo sa hra na tomto zariadení kreslí. Hodí sa pri hľadaní, čo telefón spomaľuje.')));
    }
    // Projekt na GitHube: zdrojový kód a hlásenie chýb / nápadov
    const REPO = 'https://github.com/marekvasko/magic-flowers';
    const extLink = (label: string, href: string): HTMLAnchorElement => h('a', { class: 'btn gray', style: 'flex:1;text-align:center;text-decoration:none', href, target: '_blank', rel: 'noopener' }, label);
    body.appendChild(h('div', { class: 'row', style: 'flex-direction:column;align-items:stretch' },
      h('b', null, '🐙 Projekt na GitHube'),
      h('div', { style: 'display:flex;gap:6px' }, extLink('💻 GitHub', REPO)),
      h('div', { style: 'display:flex;gap:6px' },
        extLink('🐞 Nahlásiť chybu', REPO + '/issues/new?template=bug.yml'),
        extLink('💡 Navrhnúť nápad', REPO + '/issues/new?template=feature.yml')),
      h('small', null, 'Našiel si chybu alebo máš nápad? Daj nám vedieť.')));
    body.appendChild(h('button', { class: 'big', style: 'margin:6px 0', onclick: () => { openUI('help'); } }, '❓ Ako hrať'));
    body.appendChild(h('button', { class: 'btn gray', style: 'width:100%;padding:12px', onclick: () => { S.joined = false; S.ws?.close(); location.reload(); } }, 'Odísť zo záhrady'));
  }

  // Domček: posteľ (spánok) a spoločný sklad
  function renderHouse(body: HTMLElement): void {
    const ok = D.canSleep(realMin());
    const b = h('button', { class: 'btn', onclick: () => { send({ t: 'sleep', on: true }); closeModal(); } }, '🛏️ Ísť spať');
    if (!ok) b.disabled = true;
    const n = S.sleepTotal || 1;
    const note = !ok ? 'Spať sa dá od 18:00 do 6:00.'
      : n > 1 ? `Noc prebehne, keď pôjdu spať všetci v záhrade (${S.sleepN || 0}/${n} spí).` : 'Noc prebehne rýchlo až do rána.';
    body.appendChild(h('div', { class: 'row' }, h('div', { class: 'info' }, h('b', null, '🛏️ Posteľ'), h('small', null, note)), h('div', { class: 'btns' }, b)));
    renderStorage(body);
  }

  // Ľadovňa: na čo je, koľko ľadu v nej je, ako rýchlo sa topí, vloženie ľadu z batohu a izolácia prikrývkami
  function renderIcehouse(body: HTMLElement): void {
    const B = D.ICEHOUSE, ice = S.icehouse.ice || 0, se = season(), bl = S.icehouse.bl || 0, lvl = D.insulLevel(bl);
    const insul = (l: number): number => B.insul[l] ?? 1;
    const melt = (B.melt[se] ?? 0) * insul(lvl), full = Math.ceil(ice);
    body.appendChild(h('p', { style: 'margin:4px 0 10px;font-size:14px' }, 'Do ľadovne sa dáva len ľad. Kvety ulož do skladu v domčeku – ľad v ľadovni ho chladí, takže v ňom vädnú 4× pomalšie.'));
    body.appendChild(h('div', { class: 'row', style: 'flex-direction:column;align-items:stretch' },
      h('b', null, `🧊 Ľad: ${full}/${B.cap}`),
      h('div', { style: 'height:10px;background:#eee;border-radius:5px;overflow:hidden' }, h('div', { style: `height:100%;width:${ice / B.cap * 100}%;background:#6ec6ff` })),
      h('small', null, ice <= 0 ? 'Ľadovňa je prázdna – sklad chladí len trochu (kvety vädnú 2× pomalšie).'
        : `Sklad je vychladený – kvety v ňom vädnú 4× pomalšie. ` + (melt ? `Ľad sa roztopí asi o ${fmtLeft(ice / melt * D.TICKS_PER_HOUR)}.` : 'V zime sa ľad netopí. ❄️'))));
    const n = S.inv.ice || 0;
    const b = h('button', { class: 'btn', onclick: () => { send({ t: 'icehouse', n }); } }, n ? `Vložiť ľad (${n})` : 'Nemáš ľad');
    if (!n || full >= B.cap) b.disabled = true;
    body.appendChild(h('div', { class: 'row' }, img('ice'), h('div', { class: 'info' }, h('b', null, 'Doplniť ľad'),
      h('small', null, 'Ľad vysekáš krompáčom na ľadovci v horách (chodník na severovýchode záhrady), v zime aj na zamrznutom jazierku.')), h('div', { class: 'btns' }, b)));
    // izolácia z hodvábnych prikrývok
    const max = B.blankets[B.blankets.length - 1] ?? 0, next = B.blankets[lvl + 1];
    body.appendChild(h('div', { class: 'row' }, img('blanket'), h('div', { class: 'info' },
      h('b', null, `🧶 Izolácia: úroveň ${lvl}/${B.blankets.length - 1}`),
      h('small', null, (lvl ? `Ľad sa topí len na ${Math.round(insul(lvl) * 100)} %. ` : 'Bez izolácie sa ľad topí naplno. ')
        + (next ? `Prikrývky: ${bl}/${next} – pri ${next} sa bude ľad topiť len na ${Math.round(insul(lvl + 1) * 100)} %. Ťukni na ľadovňu s prikrývkou v ruke.` : `Všetkých ${max} prikrývok je vnútri – lepšie sa izolovať nedá.`)),
      h('small', null, `Prikrývku zo ${D.BLANKET_SILK} hodvábu utká majster hodvábu pri trhu – chodí na jar a na jeseň (+${D.MASTER.price} 🪙) – alebo krosná v Dielni.`))));
  }

  // Dielňa: krosná (kúpa, tkanie prikrývky, vyzdvihnutie hotovej)
  function renderDielna(body: HTMLElement): void {
    const L = D.DIELNA.loom, lm = S.loom, silk = S.inv.silk || 0;
    body.appendChild(h('p', { style: 'margin:4px 0 10px;font-size:14px' }, 'Spoločná dielňa celej záhrady. Čo sa do nej kúpi, slúži všetkým.'));
    Veh.dielnaRows(body); // fúrik a sane (#158)
    if (!S.dielna.loom) {
      const lvl = D.repLevel(S.rep), btn = h('button', { class: 'btn', onclick: () => { send({ t: 'buyLoom' }); } }, L.price + '🪙');
      if (S.coins < L.price || lvl < L.rep) btn.disabled = true;
      body.appendChild(h('div', { class: 'row' }, h('div', { style: 'font-size:30px;width:40px;text-align:center' }, L.icon),
        h('div', { class: 'info' }, h('b', null, `${L.icon} ${L.name}`), h('small', null, `Utkajú prikrývku zo ${D.BLANKET_SILK} hodvábu bez platenia, len to trvá 2–4 herné hodiny. Pre celú záhradu.` + (L.rep ? ` · treba ⭐${L.rep}` : ''))),
        h('div', { class: 'btns' }, btn)));
      return;
    }
    if (lm.ready) {
      body.appendChild(h('div', { class: 'row' }, img('blanket'), h('div', { class: 'info' }, h('b', null, `Hotové: ${lm.ready}× prikrývka`), h('small', null, 'Krosná ju pre teba dotkali.')),
        h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => { send({ t: 'loomTake' }); } }, 'Vziať'))));
    }
    let note: string, btn: HTMLButtonElement | null = null;
    if (lm.mine != null) note = `Tká sa tvoja prikrývka – hotová bude asi o ${fmtLeft(lm.mine - S.tick)}.`;
    else if (lm.busy) note = 'Krosná práve tkajú prikrývku pre niekoho iného. Skús to neskôr.';
    else {
      note = `Založ ${D.BLANKET_SILK}× hodváb (máš ${silk}). Prikrývka bude hotová o 2–4 herné hodiny a počká tu na teba.`;
      btn = h('button', { class: 'btn', onclick: () => { send({ t: 'loomStart' }); } }, 'Tkať');
      if (silk < D.BLANKET_SILK) btn.disabled = true;
    }
    body.appendChild(h('div', { class: 'row' }, h('div', { style: 'font-size:30px;width:40px;text-align:center' }, L.icon),
      h('div', { class: 'info' }, h('b', null, `${L.icon} ${L.name}`), h('small', null, note)), btn ? h('div', { class: 'btns' }, btn) : null));
  }

  // Majster hodvábu: prikrývka hneď, za hodváb a mince (vzhľad zdieľa 3D postavička, render3d.ts)
  const MASTER_LOOK = D.MASTER_LOOK;
  function renderMaster(body: HTMLElement): void {
    const pc = h('canvas', { width: 80, height: 90 }), silk = S.inv.silk || 0;
    Art.char(ctx2d(pc), 40, 86, 80, MASTER_LOOK, 0, 0, {});
    body.appendChild(h('div', { class: 'dlg' }, pc, h('div', { class: 'bubble' },
      `${masterNow()?.where === 'hut' ? 'Dobrý večer' : 'Dobrý deň'}, ${S.name}! Prines mi ${D.BLANKET_SILK}× pavúčí hodváb z Lesa divov a za ${D.MASTER.price} 🪙 ti z neho hneď utkám hodvábnu prikrývku. S ňou bude ľadovňa držať ľad oveľa dlhšie. 🧵`)));
    const btn = h('button', { class: 'btn', onclick: () => { send({ t: 'masterWeave' }); } }, `${D.MASTER.price}🪙`);
    if (silk < D.BLANKET_SILK || S.coins < D.MASTER.price) btn.disabled = true;
    body.appendChild(h('div', { class: 'row' }, img('blanket'), h('div', { class: 'info' }, h('b', null, D.itemName('blanket')),
      h('small', null, `${D.BLANKET_SILK}× hodváb (máš ${silk}) + ${D.MASTER.price} 🪙 · hneď`)), h('div', { class: 'btns' }, btn)));
  }

  // Prekrytie počas spánku: čakanie na ostatných, potom zrýchlená noc
  function renderSleep(): void {
    const el = $('sleep');
    el.classList.toggle('hidden', !S.asleep);
    if (!S.asleep) return;
    if (S.modal) closeModal();
    $('slTxt').textContent = S.ff ? 'Spíš… noc ubieha 🌙' : `Čakáš, kým pôjdu spať aj ostatní (${S.sleepN ?? 0}/${S.sleepTotal ?? 0}).`;
    $('slWake').classList.toggle('hidden', !!S.ff);
  }
  $('slWake').onclick = () => { send({ t: 'sleep', on: false }); };

  function renderStorage(body: HTMLElement): void {
    body.appendChild(h('p', { style: 'margin:4px 0 10px;font-size:14px' }, 'Sklad je spoločný pre všetkých v záhrade. Peniaze má každý svoje. ' +
      (S.storageRate < D.STORAGE_AGE_RATE ? '🧊 Ľadovňa sklad chladí – kvety v ňom vädnú 4× pomalšie.' : '❄️ V chlade skladu kvety vädnú 2× pomalšie.' + (S.icehouse.built ? ' Doplň ľad do ľadovne a budú vädnúť 4× pomalšie.' : ''))));
    const wl = S.inv.wilted || 0;
    if (wl) {
      const k = Math.floor(wl / D.WILTED_PER_COMPOST);
      const b = h('button', { class: 'btn alt', onclick: () => { send({ t: 'compostWilted' }); } }, k ? `Skompostovať → ${k}× kompost` : `treba ${D.WILTED_PER_COMPOST}`);
      if (!k) b.disabled = true;
      body.appendChild(h('div', { class: 'row' }, img('wilted'), h('div', { class: 'info' }, h('b', null, `Zvädnuté kvety: ${wl}`), h('small', null, `${D.WILTED_PER_COMPOST} zvädnuté = 1 kompost`)), h('div', { class: 'btns' }, b)));
    }
    const section = (title: string, items: Partial<Record<ItemId, number>>, from: 'inv' | 'storage'): void => {
      body.appendChild(h('h3', { style: 'margin:10px 0 6px' }, title));
      const ids = keys(items).filter(id => (items[id] ?? 0) > 0 && !D.isTool(id) && id !== 'ice'); // ľad patrí do ľadovne
      if (!ids.length) body.appendChild(h('small', null, from === 'inv' ? 'Nemáš nič, čo by sa dalo uložiť.' : 'Sklad je prázdny.'));
      for (const id of ids) {
        const n = items[id] ?? 0, t = from === 'inv' ? 'store' : 'unstore';
        const ft = id.startsWith('fl_') ? freshText(id, from !== 'inv') : '';
        body.appendChild(h('div', { class: 'row' }, h('img', { src: Art.icon(id) }), h('div', { class: 'info' }, h('b', null, D.itemName(id)), h('small', null, n + ' ks'), ft ? h('small', null, '🌷 ' + ft) : null),
          h('div', { class: 'btns' },
            h('button', { class: 'btn', onclick: () => { send({ t, id, n: 1 }); } }, from === 'inv' ? 'Uložiť 1' : 'Vziať 1'),
            h('button', { class: 'btn alt', onclick: () => { send({ t, id, n }); } }, 'Všetko'))));
      }
    };
    section('📦 V sklade', S.storage, 'storage');
    section('🎒 V batohu', S.inv, 'inv');
  }

  function renderHelp(body: HTMLElement): void {
    body.appendChild(h('div', { class: 'help', html: `
      <p>🕹️ <b>Pohyb:</b> polož prst kdekoľvek na obrazovku a potiahni – v mieste dotyku sa objaví joystick. Alebo ťukni na miesto, kam chceš ísť. Na počítači šípky/WASD (E alebo Enter = akcia na políčku pred tebou) alebo ťahanie myšou.</p>
      <p>🦘 <b>Skok a plazenie:</b> medzerník = skok, držaný Shift = plazenie. Na mobile tlačidlá ⤴ a 🐛 vpravo dole; počas riadenia joystickom stačí ťuknúť druhým prstom kamkoľvek a skočíš.</p>
      <p>👆 <b>Ťuknutím na objekt</b> (trh, babka, kotlík, studňa, kvet, kamarát) s ním hneď niečo urobíš – ak je ďaleko, postavička k nemu dôjde sama.</p>
      <p>🟡 <b>Práca so zemou:</b> ťukni na políčko vedľa seba – čo sa stane, závisí od vybranej veci v lište. Vzdialené políčko najprv dôjdeš, druhým ťuknutím ho napr. prekopeš.</p>
      <p>⛏️ <b>Motykou</b> prekopeš trávu, piesok, lesnú pôdu alebo skalku. 🌱 Potom zasaď <b>semienka</b> a 💧 <b>polievaj</b> krhlou (načrieš v jazierku alebo studni).</p>
      <p>☀️🌳 Každý kvet má svoje nároky: <b>ročné obdobie, svetlo, pôdu a vodu</b> – nájdeš ich v 📖 Herbári. Spokojná rastlina dá až 3 kvety, kompost pridá ešte jeden.</p>
      <p>🛏️ <b>Spánok:</b> od 18:00 si môžeš ísť ľahnúť do domčeka. Keď spia všetci v záhrade, noc rýchlo prebehne až do 6:00 (ale prídeš o nočné čary).</p>
      <p>🌙 Nový deň začína o 6:00 – vtedy rastliny porastú. Každé obdobie trvá ${D.DAYS_PER_SEASON} dni. V zime prežijú len zimné kvety!</p>
      <p>🪙 <b>Začínaš chudobne:</b> pár semienok a malá krhla. Povolenie na pole je spoločné pre celú záhradu – obrobené políčka všetkých hráčov sa rátajú spolu (najviac 96 políčok); prázdne políčko môže motykou zarovnať ktokoľvek. Väčšiu krhlu a kompostér si kúpiš na trhu (Vylepšiť), väčšie pole tam kúpi ktokoľvek pre všetkých.</p>
      <p>🛒 <b>Trh žije:</b> semienok je obmedzene a v sezóne zdražejú – kupuj ich vopred, keď veľkoobchodník privezie tovar na ďalšie obdobie. Výkupná cena kvetov klesá, keď ich je na trhu veľa, a rastie počas sviatkov (ohlásené 2 dni vopred). Na trhu obchoduje aj záhradník Jano, špekulant Fero a kvetinárka Zuzka – sleduj Správy.</p>
      <p>📋 <b>Zákazky</b> nájdeš na nástenke pri 👵 babke. Zarezervuj si ich, termín platí; odovzdávať môžeš aj po častiach. Za splnenie dostaneš peniaze a ⭐ reputáciu, za nesplnenie reputáciu stratíš. ⚗️ V babkinom <b>kotlíku</b> sa z troch kvetov varia elixíry.</p>
      <p>🥀 <b>Kvety vädnú:</b> odrezaný kvet vydrží len pár dní (mak 2, tulipán 4, chryzantéma 7…) a s vekom klesá jeho výkupná cena. Rozkvitnutá rastlina na poli po čase odkvitne. V chladnom sklade vädnú kvety 2× pomalšie, zvädnuté sa dajú skompostovať.</p>
      <p>📦 V <b>domčeku</b> je spoločný sklad pre celú záhradu – peniaze má každý svoje.</p>
      <p>🏔️ <b>Hory:</b> chodník na severovýchodnom okraji záhrady (za babkinou chalúpkou) vedie do hôr. Na ľadovci pod skalami vysekáš <b>krompáčom</b> ⛏️ ľad – každé ťuknutie zoberie vrchnú vrstvu. Po ľadovci sa dá chodiť: vyjdeš o pol bloku, so skokom o celý blok, a kde stojíš, tam ľad nedorastie. Plazením cez žiadny schod (ľad, skalka…) nezídeš ani nevyjdeš – nespadneš z hrany. Ľadu je málo: ľadovec sám nedorastá, len keď prší alebo sneží, a v teple sa topí od okrajov. Kto ho vykope priveľa, nechá ostatných bez ľadu. V zime vysekáš ľad aj na zamrznutom jazierku (z každého políčka raz za deň). Krhlou vtedy načrieš vodu len cez vysekaný otvor v ľade (do rána zamrzne) – alebo zo studne, tá nezamŕza.</p>
      <p>🧊 Uneseš najviac ${D.ICE_CARRY} kusov ľadu, ťahá ťa dolu (chodíš pomalšie) a do pol dňa sa ti v batohu roztopí – ponáhľaj sa s ním do ľadovne. V lete ho trh dobre vykúpi, v zime takmer vôbec.</p>
      <p>🧊 <b>Ľadovňa</b> pri domčeku (kúpi ju ktokoľvek na trhu v záložke Vylepšiť) drží ${D.ICEHOUSE.cap} blokov ľadu – nič iné sa do nej nedáva, kvety patria do skladu v domčeku. Kým je v nej ľad, kvety v sklade vädnú 4× pomalšie. Ľad sa topí – v lete rýchlo, v zime vôbec – tak ho dopĺňaj.</p>
      <p>🧶 <b>Izolácia ľadovne:</b> zo ${D.BLANKET_SILK} pavúčieho hodvábu sa dá utkať hodvábna prikrývka – u 🧵 majstra hodvábu hneď za ${D.MASTER.price} 🪙 (chodí len na jar a na jeseň: cez deň stojí pri trhu, na noc ide k babke do chalúpky; keď sú v Dielni krosná, už nepríde), alebo zadarmo na krosnách v 🪚 Dielni (stavba vedľa trhu, kúpi ju ktokoľvek na trhu v záložke Vylepšiť), kde sa tká 2–4 herné hodiny. Ťukni s prikrývkou na ľadovňu: po ${D.ICEHOUSE.blankets.slice(1).join(', ').replace(/, (\d+)$/, ' a $1')} prikrývkach sa ľad topí už len na ${D.ICEHOUSE.insul.slice(1).map(v => Math.round(v * 100) + ' %').join(', ')}.</p>
      <p>🛶 <b>Mólo a loďka:</b> jazierko pri domčeku je veľké a siaha až k okraju mapy. Mólo s loďkou kúpi ktokoľvek na trhu (záložka Vylepšiť) za ${D.DOCK.price} 🪙 (treba ⭐${D.DOCK.rep}). Ťukni na loďku na móle alebo z brehu hneď vedľa nej a nastúpiš; prvý vesluje (ovláda ju ako chôdzu), druhý sa vezie – viac ako dvaja sa nezmestia. Z loďky dočiahneš aj na hlbokú vodu ďaleko od brehu. Vystúpiš ťuknutím na mólo alebo breh vedľa loďky; loďka ostane, kde ste ju nechali. V zime leží prevrátená na móle.</p>
      <p>🕸️ <b>Les divov a pavúky:</b> medzi kmeňmi visia pavučiny. Postav sa k nej a ťahaj hodváb (nie s lampášom v ruke – potrebuješ voľnú ruku). Každé potiahnutie dá 1 hodváb, ale pavučina sa zachveje a jej majiteľ to môže zacítiť; tretie potiahnutie ju roztrhne. Do pavučiny nevbehni – prilepíš sa. 🕷️ <b>Vlčiak</b> žije v nore pri chodníku a naháňa ťa len po svojom území. Keď ťa chytí, berie ti hodváb – zdvihni lampáš a pustí ťa aj s hodvábom. V tme sa mu lesknú oči. 🕷️ <b>Stará pradlena</b> stráži najvzdialenejšiu čistinu – lampáš ju len pomaly odtláča, tak sa k nej vyber s kamarátom.</p>
      <p>⚙️ V menu sa dá nastaviť, či svet <b>beží ďalej aj bez hráčov</b>, a ako dlho trvá herný deň.</p>
      <p>🎁 Darovať môžeš čokoľvek – vyber vec a ťukni na kamaráta. 💃 Tancovať a mávať môžeš tlačidlami.</p>
      <p>✨ A v lese… v lese sa vraj dejú čary. Ale to si musíte objaviť sami.</p>` }));
  }

  function renderWish(body: HTMLElement): void {
    body.appendChild(h('p', { style: 'text-align:center' }, 'Kvet papradia sa rozžiaril v tvojich dlaniach. Máš jedno želanie…'));
    const opts: readonly (readonly [WishKind, string, string])[] = [
      ['zlato', '💰 Zlatý dážď', 'Dostaneš 400 mincí a každý ďalší hráč v záhrade 100.'],
      ['jar', '🌸 Večná jar', 'Záhrada sa navždy polieva sama a kvetom nevadí ročné obdobie.'],
      ['poklad', '🎁 Poklad víl', 'Dúhové semienka a semienka plesnivca.']
    ];
    for (const [k, t, d] of opts) body.appendChild(h('button', { class: 'wish', onclick: () => { send({ t: 'wish', kind: k }); closeModal(); } }, h('b', null, t), d));
  }

  // Chat
  const closeChat = (): void => { $('chatbox').classList.remove('open'); $('chatIn').blur(); chatWheel(); };
  function openChat(): void { $('chatbox').classList.add('open'); $('chathist').scrollTop = $('chathist').scrollHeight; chatWheel(); $('chatIn').focus(); }
  $('bChat').onclick = () => { if ($('chatbox').classList.contains('open')) closeChat(); else openChat(); };
  const sendChat = (): void => { const v = $in('chatIn').value.trim(); if (v) send({ t: 'chat', text: v }); $in('chatIn').value = ''; chatCount(); closeChat(); };
  $('chatSend').onclick = sendChat;
  // Limit správy (rovnaký ako na serveri); počítadlo sa ukáže 20 znakov pred koncom
  $in('chatIn').maxLength = D.CHAT_MAX;
  const chatCount = (): void => { const n = $in('chatIn').value.length; $('chatCount').textContent = n >= D.CHAT_MAX - 20 ? `${n}/${D.CHAT_MAX}` : ''; $('chatCount').classList.toggle('full', n >= D.CHAT_MAX); };
  $('chatIn').addEventListener('input', chatCount);
  // Enter/Escape patria len chatu – sendChat/closeChat zruší fokus, takže by ich inak zachytila hra (Enter = akcia)
  $('chatIn').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); sendChat(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeChat(); }
  });

  // ---------- Efekty ----------
  function spawnFx(fm: MsgOf<'fx'>): void {
    const m = { ...fm, x: fm.x ?? 0, y: fm.y ?? 0 };
    const P = (o: Partial<FxParticle> & Pick<FxParticle, 'x' | 'y'>): void => { S.fx.push({ life: 0, max: 1, vx: 0, vy: 0, g: 0, size: 0.06, ...o }); };
    const F = (o: { cx: number; cy: number; a: number; rad: number; max: number; color: string }): void => { S.fx.push({ fairy: true, life: 0, ...o }); };
    const R = (a: number): number => (Math.random() - 0.5) * a;
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
      case 'cobweb': { const a = Math.random() * 6.28; P({ x: m.x, y: m.y - 0.3, vx: Math.cos(a) * 5, vy: Math.sin(a) * 2, text: '🕷️', max: 0.5 }); for (let i = 0; i < 6; i++) P({ x: m.x, y: m.y - 0.4, vx: R(1.5), vy: -Math.random(), g: 3, color: '#e8eef2', max: 0.6, size: 0.05 }); break; }
      case 'wave': P({ x: m.x, y: m.y - 1.2, vy: -0.4, text: '👋', max: 1.2 }); break;
      case 'burp': for (let i = 0; i < 5; i++) P({ x: m.x + R(0.6), y: m.y - 1, vy: -0.5 - Math.random() * 0.5, text: '🫧', max: 1.6 }); break;
      case 'brew': for (let i = 0; i < 20; i++) P({ x: m.x + R(0.5), y: m.y - 0.6, vx: R(0.6), vy: -1 - Math.random() * 1.5, color: m.c, max: 1.4, size: 0.09 }); break;
      case 'glimmer': for (let i = 0; i < 16; i++) P({ x: m.x + R(4), y: m.y + R(4), vy: -0.3, color: '#b9ffdf', max: 1.5, star: true }); break;
      case 'fairies':
        for (let i = 0; i < 9; i++) F({ cx: m.x, cy: m.y, a: i * 0.7, rad: 1 + Math.random() * 1.5, max: 9, color: must(['#ff9cf0', '#9cf0ff', '#fff59c'][i % 3]) });
        for (let i = 0; i < 40; i++) P({ x: m.x + R(5), y: m.y + R(5), vy: -0.4, color: '#fff8b0', max: 2 + Math.random() * 3, star: true });
        break;
      case 'rainbow': S.screenFx.push({ k: 'rainbow', life: 0, max: 10 }); break;
      case 'gold': S.screenFx.push({ k: 'gold', life: 0, max: 4, coins: Array.from({ length: 50 }, () => ({ x: Math.random(), y: -Math.random(), v: 0.3 + Math.random() * 0.4 })) }); break;
    }
  }

  // ---------- Herná slučka ----------
  // Hra zaberá celú obrazovku; prekrytie #cv má rozlíšenie displeja, výrez sveta (D.VIEW_DIAG) nastaví 3D kamera.
  function resize(): void {
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const r = cv.getBoundingClientRect();
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    if (R3) R3.resize();
  }
  addEventListener('resize', resize);
  // Chat aj tlačidlá skoku a plazenia sa držia nad lištou nástrojov, nech je akokoľvek vysoká (mobil / počítač)
  function barH(): void { const app = $('app'), r = $('bottom').getBoundingClientRect(); app.style.setProperty('--bar-h', Math.max(0, Math.round(app.getBoundingClientRect().bottom - r.top)) + 'px'); }
  new ResizeObserver(barH).observe($('bottom'));
  addEventListener('resize', barH);
  addEventListener('resize', () => { chatWheel(); });

  function update(dt: number): void {
    const me = S.me;
    let vx = S.stick.x, vy = S.stick.y;
    if (S.asleep || S.areaFx || Veh.riding()) { vx = vy = 0; S.keys = {}; S.path = null; } // spolujazdca vezie fúrik (#158)
    const seat = mySeat(); // v loďke (#160): veslár (0) ňou ide po vode, spolujazdec (1) sa vezie – polohu mu posiela server
    if (seat > 0) { vx = vy = 0; S.keys = {}; S.path = null; }
    if (S.keys.l) vx -= 1; if (S.keys.r) vx += 1; if (S.keys.u) vy -= 1; if (S.keys.d) vy += 1;
    if (R3 && (vx || vy)) [vx, vy] = R3.screenToWorld(vx, vy); // joystick je vzhľadom na obrazovku, kamera je otočená
    if (vx || vy) stopWalk();
    Veh.walkStep(); // chôdza k fúriku: dorazil (otvorí ho), alebo nová cesta za ním (#158)
    if (S.path) {
      const pa = S.pendingAct;
      if (pa && !pa.onTile && inReach(pa.x, pa.y) && S.path.length <= 1) {
        stopWalk(); face(pa.x + 0.5 - me.x, pa.y + 0.5 - me.y); doAction(pa.x, pa.y);
      } else {
        const wp = must(S.path[0]), dx = wp.x - me.x, dy = wp.y - me.y, d = Math.hypot(dx, dy);
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
    me.crawl = !S.asleep && (S.crawlKey || S.crawlTgl) && !me.jz && seat < 0;
    if (me.jz > 0 || me.jv > 0) { me.jz += me.jv * dt; me.jv -= JUMP_G * dt; if (me.jz <= 0) me.jz = me.jv = 0; }
    if (me.moving) {
      // ťažký ľad v náručí spomaľuje
      // lepkavá pavučina spomaľuje (slowK / slowUntil – správu 'slow' server už neposiela, spomalenie je vo 'webbed')
      const slowK = (performance.now() < S.slowUntil ? S.slowK : 1) * webSpeed(performance.now()) * webDrag();
      const sp = 3.8 * dt * (me.crawl ? CRAWL_SPEED : 1) * Math.max(0.4, 1 - D.ICE_SLOW * (S.inv.ice || 0)) * slowK;
      const ox = me.x, oy = me.y;
      const { rx, ry } = D.BODY;
      // hráč stojí na najvyššom políčku pod sebou – kým celkom nezíde z ľadu, nezasekne sa o jeho hranu
      const corners = (x: number, y: number): [number, number][] => [[x - rx, y - ry], [x + rx, y - ry], [x - rx, y + ry], [x + rx, y + ry]];
      let here = tileAt(Math.floor(me.x), Math.floor(me.y));
      const overlap = new Set<number>();
      for (const [cx, cy] of corners(me.x, me.y)) {
        const t = tileAt(Math.floor(cx), Math.floor(cy));
        overlap.add(Math.floor(cy) * S.W + Math.floor(cx));
        if (D.passable(t) && D.level(t) > D.level(here)) here = t;
      }
      const lift = Math.floor((me.jz || 0) * D.GLACIER_LAYERS);
      // plazenie: meria sa od políčka pod stredom postavy a stred nesmie prejsť na inú výšku
      // (inak by sa dalo vyliezť, keď sa už rohom dotýka vyššieho ľadu)
      const mid = tileAt(Math.floor(me.x), Math.floor(me.y)), from = me.crawl ? mid : here;
      const walkFree = (x: number, y: number): boolean => corners(x, y).every(([cx, cy]) => !solid(cx, cy, from, lift, me.crawl, overlap))
        && (!me.crawl || D.level(tileAt(Math.floor(x), Math.floor(y))) === D.level(mid))
        && !Veh.blocks(x, y); // fúrik, ktorý tlačím, musí tiež prejsť (#158)
      const free = seat === 0 ? (x: number, y: number): boolean => D.boatFits(S.tiles, x, y) : walkFree; // loďka len po vode (#160)
      if (seat === 0) { vx *= D.DOCK.speed; vy *= D.DOCK.speed; }
      const nx = me.x + vx * sp;
      if (free(nx, me.y)) me.x = nx;
      const ny = me.y + vy * sp;
      if (free(me.x, ny)) me.y = ny;
      Veh.moved(ox, oy); // predpoveď fúrika (#158)
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
    const key = me.x.toFixed(2) + ',' + me.y.toFixed(2) + ',' + me.dir + ',' + (me.a != null ? me.a.toFixed(1) : '') + ',' + me.crawl + ',' + (S.sel === 'lamp');
    if (seat <= 0 && key !== S.lastSent && now - S.sentAt > 90 && !Veh.riding()) { send({ t: 'move', x: me.x, y: me.y, dir: me.dir, a: me.a, cr: me.crawl, lp: S.sel === 'lamp', ar: S.areaSeq }); S.lastSent = key; S.sentAt = now; }
    // ostatní hráči
    for (const o of S.others.values()) {
      const dx = o.tx - o.x, dy = o.ty - o.y;
      const k = Math.min(1, dt * 12);
      o.x += dx * k; o.y += dy * k;
      o.phase = Math.hypot(dx, dy) > 0.02 ? o.phase + dt * (o.cr ? 7 : 11) : 0;
      if (o.jz > 0 || o.jv > 0) { o.jz += o.jv * dt; o.jv -= JUMP_G * dt; if (o.jz <= 0) o.jz = o.jv = 0; }
    }
    Veh.update(dt); // fúrik a sane: plynulé polohy, spolujazdci sedia vo fúriku (#158)
    // pavúky
    for (const o of S.spiders.values()) {
      const k = Math.min(1, dt * 12), x0 = o.x, y0 = o.y, z0 = o.z || 0;
      o.x += (o.tx - o.x) * k; o.y += (o.ty - o.y) * k;
      o.z = o.n ? z0 + (o.tz - z0) * k : 0;
      // nohy podľa prejdenej dráhy (aj po kmeni), aby nekĺzali
      o.phase = o.m ? o.phase + SpiderModel.stepPhase(o.k, Math.hypot(o.x - x0, o.y - y0, (o.z || 0) - z0), dt) : 0;
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
  function loop(now: number): void {

    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (S.joined) {
      update(dt);
      if (R3) { const t0 = Fps.on ? performance.now() : 0; R3.frame(now / 1000); if (Fps.on) Fps.tick(now, performance.now() - t0); }
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
