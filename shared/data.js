// Zdieľané herné dáta – používa server (Node) aj klient (prehliadač).
(function (root) {
  const W = 20, H = 34;
  // Koľko sveta vidí hráč: hra zaberá celú obrazovku a mierka je taká, že uhlopriečka obrazovky
  // má vždy presne VIEW_DIAG blokov – na mobile na výšku aj na počítači na šírku, hráč je v strede.
  // Rozmery výrezu v blokoch pre obrazovku pxW × pxH vráti viewSize (3D kamera).
  const VIEW_DIAG = 22;
  // diag = iná uhlopriečka (napr. bližší pohľad v Lese divov), inak VIEW_DIAG
  function viewSize(pxW, pxH, diag) {
    const d = Math.hypot(pxW, pxH) || 1, v = diag || VIEW_DIAG;
    return { w: v * pxW / d, h: v * pxH / d };
  }
  const DAYS_PER_SEASON = 4;
  // Diskrétny čas: deň má vždy presne TICKS_PER_DAY krokov, jeden krok = MIN_PER_TICK herných minút.
  // 11 520 krokov za deň = 9,6 kroku za sekundu pri 20-minútovom dni (1 krok = 7,5 hernej sekundy): dosť jemné na pohyb
  // ako stav sveta. Do verzie uloženia 8 bolo 288 krokov za deň (5 minút); migrácia násobí uložené kroky 40×.
  const TICKS_PER_DAY = 11520, MIN_PER_TICK = 1440 / TICKS_PER_DAY;
  const TICKS_PER_HOUR = TICKS_PER_DAY / 24;
  const DAWN_TICK = 6 * TICKS_PER_HOUR; // 6:00
  // Základná dĺžka herného dňa v reálnych sekundách (napevno; DAY_SECONDS v prostredí len na testovanie)
  const BASE_DAY_SECONDS = 1200;
  const SEASONS = ['Jar', 'Leto', 'Jeseň', 'Zima'];
  const SEASON_ICONS = ['🌱', '☀️', '🍂', '❄️'];

  // Kvety, ktoré sa dajú pestovať na Slovensku, v Česku a v strednej Európe.
  // seasons: 0 jar, 1 leto, 2 jeseň, 3 zima
  // water: 1 = znesie sucho, 2 = bežná zálievka, 3 = smädná
  // light: 'sun' | 'shade' | 'any'
  // soil: preferovaná pôda ('sand' | 'rich' | 'rock'), strict = inde nerastie
  const SPECIES = {
    snezienka: {
      name: 'Snežienka jarná', latin: 'Galanthus nivalis', seasons: [3, 0], days: 3, water: 2,
      light: 'shade', soil: null, seed: 12, sell: 22, color: '#ffffff', center: '#9ccc65', shape: 'bell',
      fact: 'Kvitne už vo februári, často priamo cez sneh. Na Slovensku aj v Česku je chránená – v prírode ju netrhaj!'
    },
    cemerica: {
      name: 'Čemerica čierna', latin: 'Helleborus niger', seasons: [3], days: 4, water: 1,
      light: 'shade', soil: 'rich', seed: 25, sell: 50, color: '#f6e7ee', center: '#e6c84a', shape: 'hell',
      fact: 'Volajú ju aj „vianočná ruža“ – kvitne uprostred zimy. Pochádza z Álp, je jedovatá.'
    },
    safran: {
      name: 'Šafran Heuffelov', latin: 'Crocus heuffelianus', seasons: [0], days: 3, water: 2,
      light: 'sun', soil: null, seed: 10, sell: 19, color: '#9b59d0', center: '#f5b800', shape: 'cup',
      fact: 'Fialový krókus horských lúk Karpát. Na Slovensku zafarbí lúky hneď po roztopení snehu.'
    },
    tulipan: {
      name: 'Tulipán', latin: 'Tulipa gesneriana', seasons: [0], days: 4, water: 2,
      light: 'sun', soil: null, seed: 15, sell: 28, color: '#e53935', center: '#3b2a1a', shape: 'cup',
      fact: 'Pochádza zo Strednej Ázie. Do Európy sa dostal v 16. storočí a v Holandsku kvôli nemu vypukla „tulipánová horúčka“.'
    },
    narcis: {
      name: 'Narcis žltý', latin: 'Narcissus pseudonarcissus', seasons: [0], days: 4, water: 2,
      light: 'any', soil: null, seed: 14, sell: 26, color: '#ffe14d', center: '#ff9a1f', shape: 'star',
      fact: 'Divoký narcis rastie na vlhkých lúkach západnej Európy. Cibuľky sú jedovaté, preto ich hlodavce nechávajú na pokoji.'
    },
    konvalinka: {
      name: 'Konvalinka voňavá', latin: 'Convallaria majalis', seasons: [0], days: 4, water: 2,
      light: 'shade', soil: null, seed: 18, sell: 34, color: '#ffffff', center: '#7cb342', shape: 'bell',
      fact: 'Májová kráska listnatých lesov. Nádherne vonia, ale celá rastlina je prudko jedovatá.'
    },
    harmancek: {
      name: 'Rumanček kamilkový', latin: 'Matricaria chamomilla', seasons: [0, 1], days: 3, water: 1,
      light: 'sun', soil: null, seed: 8, sell: 15, color: '#ffffff', center: '#ffcf1f', shape: 'daisy',
      fact: 'Ľudovo „harmanček“. Slovensko patrí k najväčším pestovateľom v Európe – čaj z neho upokojuje a lieči.'
    },
    mak: {
      name: 'Mak vlčí', latin: 'Papaver rhoeas', seasons: [1], days: 3, water: 1,
      light: 'sun', soil: 'sand', seed: 10, sell: 21, color: '#e8261f', center: '#1a1a1a', shape: 'cup',
      fact: 'Červený mak z obilných polí. Má rád chudobnú, piesočnatú pôdu a jeho semená vydržia v zemi aj desiatky rokov.'
    },
    nevadza: {
      name: 'Nevädza poľná', latin: 'Centaurea cyanus', seasons: [1], days: 3, water: 1,
      light: 'sun', soil: null, seed: 10, sell: 21, color: '#3f6fd8', center: '#2a3f8f', shape: 'spiky',
      fact: 'Modrý poľný kvet, kedysi bežný v obilí. Je národným kvetom Estónska.'
    },
    slnecnica: {
      name: 'Slnečnica ročná', latin: 'Helianthus annuus', seasons: [1], days: 6, water: 3,
      light: 'sun', soil: null, seed: 25, sell: 58, color: '#ffc107', center: '#6d4c41', shape: 'sun',
      fact: 'Na južnom Slovensku sú ňou zaliate celé polia. Mladé kvety sa otáčajú za slnkom.'
    },
    levandula: {
      name: 'Levanduľa úzkolistá', latin: 'Lavandula angustifolia', seasons: [1], days: 5, water: 1,
      light: 'sun', soil: 'sand', seed: 30, sell: 46, color: '#8e7cc3', center: '#6a5aa8', shape: 'spike', perennial: true,
      fact: 'Stredomorská bylinka, ktorá u nás dobre prezimuje. Miluje slnko a suchý, piesočnatý alebo kamenistý terén.'
    },
    ruza: {
      name: 'Ruža šípová', latin: 'Rosa canina', seasons: [1], days: 6, water: 2,
      light: 'sun', soil: 'rich', seed: 35, sell: 70, color: '#ec5c8d', center: '#ffd54f', shape: 'rose', perennial: true,
      fact: 'Divoká ruža z našich medzí. Z jej plodov – šípok – sa robí čaj plný vitamínu C.'
    },
    astra: {
      name: 'Astra novobelgická', latin: 'Symphyotrichum novi-belgii', seasons: [2], days: 4, water: 2,
      light: 'sun', soil: null, seed: 15, sell: 30, color: '#8a63d2', center: '#ffcc33', shape: 'daisy',
      fact: 'Jesenná astra kvitne až do mrazov. Pre včely a motýle je to posledná hostina pred zimou.'
    },
    jesienka: {
      name: 'Jesienka obyčajná', latin: 'Colchicum autumnale', seasons: [2], days: 3, water: 2,
      light: 'any', soil: null, seed: 12, sell: 25, color: '#d58cd6', center: '#f3e37c', shape: 'cup',
      fact: 'Kvitne na jesenných lúkach bez listov – tie vyrastú až na jar. Je veľmi jedovatá!'
    },
    chryzantema: {
      name: 'Chryzantéma', latin: 'Chrysanthemum × morifolium', seasons: [2], days: 5, water: 2,
      light: 'sun', soil: 'rich', seed: 22, sell: 46, color: '#ff9330', center: '#e0661a', shape: 'pom',
      fact: 'Na Slovensku a v Česku typický kvet Dušičiek. V Japonsku je symbolom cisára.'
    },
    plesnivec: {
      name: 'Plesnivec alpínsky', latin: 'Leontopodium nivale subsp. alpinum', seasons: [1], days: 7, water: 1,
      light: 'sun', soil: 'rock', strict: true, seed: 80, sell: 210, color: '#f4f3e8', center: '#d9d4a0', shape: 'edel',
      fact: 'Symbol hôr. Na Slovensku rastie divo len v Belianskych Tatrách a Pieninách a je prísne chránený.'
    },
    // ---- Čarovné kvety ----
    papradie: {
      name: 'Papraďový kvet', latin: 'Flos filicis (legenda)', seasons: [0, 1, 2], days: 3, water: 2,
      light: 'shade', soil: null, seed: 0, sell: 0, color: '#ff6ae6', center: '#fff4a8', shape: 'fern', magic: true,
      fact: 'Podľa slovanskej legendy papraď rozkvitne len na jedinú noc. Kto jej kvet nájde, tomu sa splní želanie. Zberá sa iba v noci.'
    },
    duhova: {
      name: 'Dúhová ruža', latin: 'Rosa iridis (čarovná)', seasons: [0, 1, 2, 3], days: 4, water: 2,
      light: 'any', soil: null, seed: 0, sell: 260, color: '#ff0000', center: '#fff', shape: 'rainbow', magic: true,
      fact: 'Ruža, ktorá mení farby ako dúha. Rastie v každom ročnom období a vraj sa zrodila z lásky.'
    }
  };

  // Životnosť odrezaného kvetu (dni vo váze) – približne podľa skutočnosti. Rovnako dlho kvitne aj na poli.
  const LIFE = {
    snezienka: 3, cemerica: 6, safran: 2, tulipan: 4, narcis: 4, konvalinka: 3, harmancek: 4, mak: 2, nevadza: 4,
    slnecnica: 5, levandula: 8, ruza: 4, astra: 5, jesienka: 3, chryzantema: 7, plesnivec: 12, papradie: 1, duhova: 6
  };
  for (const k in LIFE) SPECIES[k].life = LIFE[k];
  const STORAGE_AGE_RATE = 0.5; // v chladnom sklade kvety starnú 2× pomalšie

  // ---- Ľad ----
  // Krompáč (náradie, kúpi sa na trhu) vyseká ľad na ľadovci v horách a v zime na zamrznutej vode.
  // Ľadovňa je spoločná stavba v záhrade: drží ľad, ktorý sa topí, a kým v nej nejaký je, sklad chladí viac.
  const TOOLS = {
    pick: { name: 'Krompáč', icon: '⛏️', price: 60, rep: 0, desc: 'Vysekáš ním ľad na ľadovci v horách a v zime na zamrznutom jazierku.' },
    lamp: { name: 'Lampáš', icon: '🏮', price: 80, rep: 0, desc: 'Keď ho držíš v ruke, svieti ti v tme na cestu. Jeho svetlo vidia aj ostatní.' }
  };
  const ICEHOUSE = {
    name: 'Ľadovňa', icon: '🧊', price: 400, rep: 1, cap: 12,
    rate: 0.25,                        // s ľadom v ľadovni kvety v sklade starnú 4× pomalšie
    melt: [1 / 12, 1 / 6, 1 / 12, 0],  // koľko blokov ľadu sa roztopí za hernú hodinu v jari, lete, jeseni, zime
    lot: { x0: 0, y0: 30, x1: 1, y1: 31 } // stavebný pozemok vedľa domčeka (2×2)
  };
  // Ľadovec je z minikociek po 1/4 bloku. Stúpa v úrovniach: okraj má pol bloku (2 vrstvy), každé políčko
  // ďalej od okraja o pol bloku viac, stred najviac 2 bloky (8 vrstiev). Krompáč zoberie vrchnú vrstvu = 1 ľad,
  // každé ráno na každom políčku 1 vrstva dorastie, najviac do pôvodnej výšky.
  const GLACIER_LAYERS = 4, GLACIER_TOP = 8;
  // Ľadu je málo: ľadovec sám nedorastá – len v daždivý a snežný deň (aj dážď privolaný kúzlom), od skál nadol.
  // Inak sa topí od okrajov (vrstiev za deň v jari, lete, jeseni, zime). Pri veľkom kopaní sa môže minúť.
  const GLACIER_MELT = [4, 12, 4, 0];
  const GLACIER_GROW = { rain: 14, snow: 20 };
  // Ľad v batohu: najviac ICE_CARRY kusov, každý spomalí chôdzu o ICE_SLOW a do pol dňa sa roztopí.
  const ICE_CARRY = 6, ICE_SLOW = 0.06, ICE_LIFE = TICKS_PER_DAY / 2;
  const ICE_PRICE = [5, 12, 5, 1]; // výkupná cena ľadu na trhu podľa obdobia
  const isTool = id => id === 'hoe' || id === 'can' || id === 'pick' || id === 'lamp';
  const WILTED_PER_COMPOST = 4;

  const POTIONS = {
    rast: { name: 'Elixír rastu', color: '#7ed957', sell: 60, desc: 'Rastliny okolo cieľa (3×3) narastú o deň a sú poliate.' },
    dazd: { name: 'Dažďový odvar', color: '#4fc3f7', sell: 50, desc: 'Privolá dážď – celá záhrada je poliata.' },
    jar: { name: 'Elixír večnej jari', color: '#f48fb1', sell: 80, desc: 'Rastliny okolo cieľa (3×3) prestanú dbať na ročné obdobie.' },
    hojnost: { name: 'Elixír hojnosti', color: '#ffd54f', sell: 120, desc: 'Rastliny okolo cieľa (5×5) získajú najvyššiu kvalitu a pohnojenú pôdu.' },
    vily: { name: 'Elixír víl', color: '#b388ff', sell: 90, desc: 'Na jeden deň uvidíš svet očami víl… a ony uvidia teba.' },
    laska: { name: 'Elixír lásky', color: '#ff5c8a', sell: 100, desc: 'Daruj ho inému hráčovi. 💕' },
    duha: { name: 'Dúhový elixír', color: '#ffffff', sell: 500, desc: 'Nikto nevie, čo robí. Ešte nikto ho neuvaril.' },
    sliz: { name: 'Čudný sliz', color: '#8d8d5a', sell: 2, desc: 'Bublá. Smrdí. Nič nerobí. Asi.' }
  };

  // Recepty kotlíka – kľúč sú zoradené id troch kvetov.
  const RECIPES = {
    'harmancek+levandula+slnecnica': 'rast',
    'konvalinka+nevadza+snezienka': 'dazd',
    'narcis+safran+tulipan': 'jar',
    'levandula+mak+plesnivec': 'hojnost',
    'astra+chryzantema+jesienka': 'vily',
    'ruza+ruza+tulipan': 'laska',
    'duhova+duhova+duhova': 'duha'
  };

  const TIPS = [
    'Snežienky a čemerice zvládnu aj zimu. Ostatné kvety mráz spáli.',
    'Levanduľa a mak majú radi piesok – nájdeš ho pri jazierku.',
    'Plesnivec rastie len na skalke, presne ako v Belianskych Tatrách.',
    'Keď nemáš ani groš, prehľadaj trávu – stačí ťuknúť na neprekopanú zem, keď nedržíš motyku. Ráno v rose a na okraji lesa sa divé semienka nájdu najľahšie.',
    'Divé semienka vraj vedia, čo sa na trhu práve dobre predáva. Ktovie, čo z nich vyrastie…',
    'Konvalinky, snežienky a čemerice chcú tieň – skús okraj lesa.',
    'Ruže, čemerice a chryzantémy potrebujú výživnú pôdu. Kompost kúpiš na trhu.',
    'Slnečnica je smädná – polievaj ju každý deň!',
    'Keď je rastlina spokojná (svetlo, pôda, voda), dá ti až 3 kvety.',
    'V kotlíku miešaj vždy tri kvety. Harmanček, levanduľa a slnečnica vraj urýchlia rast…',
    'Tulipán, narcis a šafran… jarná trojica, ktorá zastaví čas.',
    'Dve ruže a tulipán – to je recept na lásku.',
    'Astra, chryzantéma a jesienka – jesenný odvar ti otvorí oči pre víly.',
    'Mak, levanduľa a plesnivec – hojnosť z hôr aj polí.',
    'Snežienka, konvalinka a nevädza privolajú dážď.',
    'Keď sa zotmie, v lese pri kruhu z húb tancujú víly. Vraj sa pridajú, keď tancujú dvaja.',
    'Hovorí sa, že papraď kvitne len v noci. Kto jej kvet nájde, tomu sa splní želanie.',
    'Tri dúhové ruže v jednom kotlíku? To som ešte nevidela…'
  ];

  // ---- Ekonomika ----
  // Reputácia: hranice úrovní. Úroveň odomyká vylepšenia, viac súbežných zákaziek a veľké zákazky.
  const REP_LEVELS = [0, 20, 60, 140, 300];
  function repLevel(rep) { let l = 0; for (let i = 0; i < REP_LEVELS.length; i++) if (rep >= REP_LEVELS[i]) l = i; return l; }
  const UPGRADES = {
    can: { name: 'Krhla', icon: '💧', unit: 'polievaní', levels: [{ v: 5 }, { v: 12, price: 80, rep: 0 }, { v: 25, price: 300, rep: 1 }, { v: 50, price: 900, rep: 2 }] },
    // Povolenie na pole je spoločné pre celú záhradu (ako ľadovňa): kúpi ho ktokoľvek, platí pre všetkých
    // a do limitu sa rátajú obrobené políčka všetkých hráčov. Najviac 96 políčok.
    plots: { name: 'Povolenie na pole', icon: '🟫', unit: 'políčok', shared: true, levels: [{ v: 8 }, { v: 16, price: 100, rep: 0 }, { v: 28, price: 350, rep: 1 }, { v: 48, price: 1000, rep: 2 }, { v: 96, price: 2500, rep: 3 }] },
    composter: { name: 'Kompostér', icon: '♻️', unit: 'kompost denne', levels: [{ v: 0 }, { v: 1, price: 450, rep: 1 }, { v: 2, price: 1200, rep: 3 }] }
  };
  const FESTIVALS = [
    { id: 'matky', name: 'Deň matiek', icon: '💐', season: 0, day: 3, len: 1, mult: { tulipan: 2.2, konvalinka: 2, narcis: 1.6 } },
    { id: 'svadby', name: 'Svadobná sezóna', icon: '💒', season: 1, day: 2, len: 2, mult: { ruza: 2.2, levandula: 1.7, slnecnica: 1.4 } },
    { id: 'dusicky', name: 'Dušičky', icon: '🕯️', season: 2, day: 2, len: 1, mult: { chryzantema: 2.6, astra: 1.6 } },
    { id: 'vianoce', name: 'Vianoce', icon: '🎄', season: 3, day: 3, len: 2, mult: { cemerica: 2.6, snezienka: 1.6 } }
  ];
  const GIVERS = { babka: 'Babka bylinkárka', zuzka: 'Kvetinárka Zuzka', farar: 'Pán farár', starosta: 'Pán starosta', jano: 'Záhradník Jano' };
  const MIN_SEED_REP = { plesnivec: 2 }; // vzácne semienka predá veľkoobchodník len skúseným

  const SHOP = ['compost'].concat(Object.keys(SPECIES).filter(k => !SPECIES[k].magic).map(k => 'seed_' + k));
  const PRICES = { compost: 15 };
  for (const k in SPECIES) if (!SPECIES[k].magic) PRICES['seed_' + k] = SPECIES[k].seed;

  function sellPrice(id) {
    if (id.startsWith('fl_')) return (SPECIES[id.slice(3)] || {}).sell || 0;
    if (id.startsWith('po_')) return (POTIONS[id.slice(3)] || {}).sell || 0;
    if (id.startsWith('seed_')) { const s = SPECIES[id.slice(5)]; return s ? Math.floor((s.magic ? 60 : s.seed) / 2) : 0; }
    if (id === 'compost') return 7;
    if (id === 'wilted') return 1;
    return 0;
  }

  // Hľadanie divých semienok v neprekopanej tráve (s prázdnou rukou alebo s predmetom, ktorý tam nič nerobí). Má to byť pomalé a neisté – záchrana, keď nemáš nič.
  // Hľadá sa priestorom: server si každú hernú hodinu tajne vylosuje, v ktorých políčkach trávy semienka sú
  // (hustota = density × okolie × denná hodina × obdobie). Hráč chodí z políčka na políčko; klient nevie nič.
  const SCAVENGE = {
    ticks: TICKS_PER_DAY / 288, // výsledok príde o 5 herných minút (≈ 4 s), len ak hráč v tom kroku stále hľadá
    window: TICKS_PER_HOUR,     // po koľkých krokoch sa semienka v tráve premiestnia (herná hodina)
    density: 0.07,      // podiel políčok so semienkom cez deň na jar, ďaleko od lesa a ciest
    find: 0.75,         // šanca, že ho na správnom políčku aj nájdeš
    edge: 0.15,         // + za každého lesného suseda (najviac 4) – na okraji lesa sa semienka sypú viac
    trampled: 0.6,      // × pri ceste a pri budovách – udupaná tráva
    // [od hodiny, do hodiny, násobok] – ráno v rose sa hľadá najlepšie, v noci takmer nič nevidno
    hours: [[0, 4, 0.15], [4, 6, 0.6], [6, 10, 1.4], [10, 18, 1], [18, 21, 0.6], [21, 24, 0.15]],
    seasons: [1, 1.2, 1.2, 0.4], // jar, leto, jeseň, zima
    priceExp: 2         // divé semienko „pozná trh“: váha druhu = výkupná cena kvetu v čase sadenia ^ priceExp
  };
  const isWild = id => /^wild_[0-3]$/.test(id);

  function itemName(id) {
    if (isWild(id)) return 'Divé semienko (' + SEASONS[+id.slice(5)].toLowerCase() + ')';
    if (id === 'hoe') return 'Motyka';
    if (id === 'can') return 'Krhla';
    if (id === 'pick') return 'Krompáč';
    if (id === 'lamp') return 'Lampáš';
    if (id === 'ice') return 'Ľad';
    if (id === 'compost') return 'Kompost';
    if (id === 'wilted') return 'Zvädnuté kvety';
    if (id.startsWith('seed_')) return 'Semienka: ' + ((SPECIES[id.slice(5)] || {}).name || '?');
    if (id.startsWith('fl_')) return (SPECIES[id.slice(3)] || {}).name || '?';
    if (id.startsWith('po_')) return (POTIONS[id.slice(3)] || {}).name || '?';
    return id;
  }

  // ---- Mapa ----
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  const RING = { x0: 2, y0: 2, x1: 4, y1: 4 };
  // ---- Plochy a prechody medzi nimi ----
  // Každá plocha má vlastnú veľkosť (políčka w × h). Hráč je vždy na jednej ploche.
  const AREAS = ['garden', 'hory', 'pomedzie', 'les'];
  // Les divov je dvakrát väčší ako záhrada v každom smere
  const LES_W = 2 * W, LES_H = 2 * H;
  const AREA_SIZE = { garden: { w: W, h: H }, hory: { w: W, h: H }, pomedzie: { w: W, h: H }, les: { w: LES_W, h: LES_H } };
  function areaSize(area) { return AREA_SIZE[area] || AREA_SIZE.garden; }
  const AREA_NAMES = { garden: 'Záhrada', hory: 'Hory', pomedzie: 'Les na pomedzí', les: 'Les divov' };
  const AREA_IN = { garden: 'v záhrade', hory: 'v horách', pomedzie: 'v Lese na pomedzí', les: 'v Lese divov' };
  // prechod medzi plochami (stmavnutie s menom): ikona, farba žiary na okrajoch a ozdoby po okrajoch – nová plocha pridá záznam
  const AREA_FX = {
    garden: { icon: '🌸', glow: '#7fa86a', deco: ['🌸', '🌼', '🌷', '🌿', '🦋', '🍃'] },
    hory: { icon: '🏔️', glow: '#9bb4c8', deco: ['❄️', '🌲', '⛰️', '🪨', '🦅', '❄️'] },
    pomedzie: { icon: '🌳', glow: '#5f8a4a', deco: ['🌳', '🌾', '🦋', '🍃', '🌲', '🌿'] },
    les: { icon: '🌲', glow: '#2f4a3a', deco: ['🌲', '🍄', '🌿', '🦉', '🪵', '🍂'] },
  };
  // Prechody: políčka 'gate' na okraji plochy, každé vedie do svojej cieľovej plochy (to).
  // Záhrada: na severe hory, na východe Les na pomedzí. Z Lesa na pomedzí na severe vedie chodník do Lesa divov.
  const POMEDZIE_NORTH = [9, 10]; // stĺpce chodníka na severnom okraji Lesa na pomedzí (prechod do Lesa divov)
  const LES_SOUTH = [19, 20];     // stĺpce prechodu na južnom okraji Lesa divov (späť do Lesa na pomedzí)
  const GATES = {
    garden: [{ x: 16, y: 0, to: 'hory' }, { x: 17, y: 0, to: 'hory' }, { x: W - 1, y: 25, to: 'pomedzie' }, { x: W - 1, y: 26, to: 'pomedzie' }],
    hory: [{ x: 9, y: H - 1, to: 'garden' }, { x: 10, y: H - 1, to: 'garden' }],
    pomedzie: [{ x: 0, y: 25, to: 'garden' }, { x: 0, y: 26, to: 'garden' }, ...POMEDZIE_NORTH.map(x => ({ x, y: 0, to: 'les' }))],
    les: LES_SOUTH.map(x => ({ x, y: LES_H - 1, to: 'pomedzie' }))
  };
  // Príchodové miesto pre každý prechod (odkiaľ > kam): voľné políčko hneď vedľa prechodu v cieľovej ploche
  const ARRIVE = {
    'garden>hory': { x: 10, y: H - 2.4 }, 'hory>garden': { x: 17, y: 1.6 },
    'garden>pomedzie': { x: 1.6, y: 26 }, 'pomedzie>garden': { x: W - 1.6, y: 26 },
    'pomedzie>les': { x: LES_SOUTH[1], y: LES_H - 2.4 }, 'les>pomedzie': { x: POMEDZIE_NORTH[1], y: 1.6 }
  };
  function arrival(from, to) { return ARRIVE[from + '>' + to] || null; }
  // Telo hráča pri chôdzi: polovičná šírka a hĺbka (políčka) – postava sa pohne, len keď celé telo stojí na priechodnej zemi
  const BODY = { rx: 0.26, ry: 0.16 };
  // Indexy políčok plochy area, na ktorých stojí telo hráča na niektorom príchodovom mieste – generátor na ne nič nepostaví
  function arrivalTiles(area) {
    const { w } = areaSize(area), out = new Set();
    for (const [k, a] of Object.entries(ARRIVE)) {
      if (k.split('>')[1] !== area) continue;
      for (const dy of [-BODY.ry, BODY.ry]) for (const dx of [-BODY.rx, BODY.rx]) out.add(Math.floor(a.y + dy) * w + Math.floor(a.x + dx));
    }
    return out;
  }
  // Prechod na políčku (x, y) plochy area, alebo null
  function gateAt(area, x, y) { return (GATES[area] || []).find(g => g.x === x && g.y === y) || null; }
  // Na ktorú stranu plochy prechod vedie (podľa okraja, na ktorom leží): 'n', 's', 'w', 'e'
  function gateSide(area, g) { const { w, h } = areaSize(area); return g.y === 0 ? 'n' : g.y === h - 1 ? 's' : g.x === 0 ? 'w' : g.x === w - 1 ? 'e' : 'n'; }
  // Les na pomedzí sa smerom na sever stmieva: koľko svetla (okolie aj slnko) ubudne na riadku y (0 = nič, max = najviac).
  // Zdieľa to klient (shader, sprity, obloha) – svetlo lampášov sa nestmieva.
  const GLOOM = { pomedzie: { from: 23, max: 0.8, pow: 1.4 } };
  function gloomAt(area, y) {
    const g = GLOOM[area];
    if (!g) return 0;
    const t = Math.max(0, Math.min(1, (g.from - y) / g.from));
    return g.max * Math.pow(t, g.pow);
  }
  // Pôvodná výška ľadu (vo vrstvách) na každom políčku: 2 × vzdialenosť od okraja ľadovca, najviac GLACIER_TOP
  function glacierLevels(g) {
    const dist = new Array(W * H).fill(0), q = [];
    for (let i = 0; i < g.length; i++) {
      if (g[i] !== 'glacier') continue;
      const x = i % W, y = (i / W) | 0;
      const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => { const nx = x + dx, ny = y + dy; return nx < 0 || ny < 0 || nx >= W || ny >= H || g[ny * W + nx] !== 'glacier'; });
      if (edge) { dist[i] = 1; q.push(i); }
    }
    for (let k = 0; k < q.length; k++) {
      const i = q[k], x = i % W, y = (i / W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, n = ny * W + nx;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || g[n] !== 'glacier' || dist[n]) continue;
        dist[n] = dist[i] + 1; q.push(n);
      }
    }
    return dist.map(d => Math.min(GLACIER_TOP, 2 * d));
  }
  // seed: Les na pomedzí a Les divov majú rozloženie podľa semienka sveta (pre záhradu a hory sa ignoruje)
  function buildArea(area, seed) { return area === 'hory' ? buildMountains() : area === 'pomedzie' ? buildPomedzie(seed) : area === 'les' ? buildLes(seed) : buildMap(); }
  const SPAWN = { x: 10.5, y: 30.5 };
  const BABKA = { x: 15, y: 5 };

  function buildMap() {
    const g = new Array(W * H).fill('grass');
    const set = (x, y, v) => { if (x >= 0 && y >= 0 && x < W && y < H) g[y * W + x] = v; };
    const rnd = mulberry32(1337);
    // Les na severe
    for (let y = 0; y < 8; y++) for (let x = 0; x < W; x++) {
      const p = y < 2 ? 0.75 : y < 5 ? 0.4 : 0.18;
      set(x, y, rnd() < p ? 'tree' : 'forest');
    }
    // Čistinka s kruhom húb
    for (let y = 0; y <= 6; y++) for (let x = 0; x <= 6; x++) if (!(y === 0 && (x === 0 || x === 6))) set(x, y, 'forest');
    for (let y = 1; y <= 5; y++) for (let x = 1; x <= 5; x++) {
      const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3)) === 2;
      set(x, y, ring ? 'shroom' : 'ring');
    }
    set(1, 1, 'forest'); set(5, 1, 'forest'); set(1, 5, 'forest'); set(5, 5, 'forest');
    // Lesný pruh pre tieňomilné kvety
    for (let y = 6; y <= 7; y++) for (let x = 0; x <= 12; x++) set(x, y, 'forest');
    for (let y = 3; y <= 7; y++) for (let x = 8; x <= 11; x++) set(x, y, 'forest');
    // Čistinka babky bylinkárky
    for (let y = 1; y <= 7; y++) for (let x = 13; x < W; x++) set(x, y, 'grass');
    for (let y = 2; y <= 3; y++) for (let x = 14; x <= 16; x++) set(x, y, 'hut');
    set(BABKA.x, BABKA.y, 'babka');
    set(17, 5, 'cauldron');
    set(18, 2, 'tree'); set(19, 4, 'tree'); set(13, 1, 'tree');
    // Horský chodník: na severovýchodnom okraji mapy sa ide do hôr
    for (const gt of GATES.garden) if (gt.to === 'hory') { set(gt.x, gt.y, 'gate'); set(gt.x, gt.y + 1, 'path'); }
    // Cesty
    for (let y = 4; y < H; y++) set(10, y, 'path');
    for (let x = 10; x <= 15; x++) set(x, 6, 'path');
    set(15, 4, 'path');
    for (let x = 3; x <= 18; x++) set(x, 26, 'path');
    // na východnom okraji cesta do Lesa na pomedzí
    set(W - 2, 25, 'path');
    for (const gt of GATES.garden) if (gt.to === 'pomedzie') set(gt.x, gt.y, 'gate');
    // Jazierko s pieskom
    for (let y = 10; y <= 18; y++) for (let x = 0; x <= 7; x++) {
      const dx = (x - 3) / 2.6, dy = (y - 14) / 2.6;
      const d = dx * dx + dy * dy;
      if (d < 1) set(x, y, 'water');
      else if (d < 2.3) set(x, y, 'sand');
    }
    // Skalka
    for (let y = 17; y <= 23; y++) for (let x = 14; x < W; x++) set(x, y, 'rock');
    set(15, 18, 'boulder'); set(18, 19, 'boulder'); set(16, 22, 'boulder'); set(19, 23, 'boulder');
    // Dedinka
    for (let x = 11; x <= 13; x++) set(x, 28, 'stall');
    set(7, 28, 'well');
    for (let y = 27; y <= 28; y++) for (let x = 2; x <= 4; x++) set(x, y, 'house');
    for (let x = 3; x <= 9; x++) set(x, 29, 'path');
    set(3, 29, 'path');
    // Pozemok pre ľadovňu (kým sa nepostaví)
    const L = ICEHOUSE.lot;
    for (let y = L.y0; y <= L.y1; y++) for (let x = L.x0; x <= L.x1; x++) set(x, y, 'lot');
    return g;
  }

  // ---- Hory: druhá hracia plocha (rovnaká veľkosť ako záhrada) ----
  // Hore skalné steny a ľadovec, v strede sutina s plesom, dole horská lúka so smrekmi a chodník do záhrady.
  function buildMountains() {
    const g = new Array(W * H).fill('alp');
    const set = (x, y, v) => { if (x >= 0 && y >= 0 && x < W && y < H) g[y * W + x] = v; };
    const rnd = mulberry32(4242);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (y < 13) set(x, y, 'snow');
      else if (y < 21) set(x, y, rnd() < 0.08 ? 'boulder' : 'scree');
      else if ((x < 3 || x > 16) && rnd() < 0.55) set(x, y, 'spruce');
      else if (rnd() < 0.05) set(x, y, 'spruce');
    }
    // Skalné steny na severe a po bokoch
    for (let x = 0; x < W; x++) { set(x, 0, 'cliff'); if (rnd() < 0.6) set(x, 1, 'cliff'); }
    for (let y = 0; y < 16; y++) {
      const l = 1 + Math.floor(rnd() * 2) + (y < 8 ? 1 : 0), r = 1 + Math.floor(rnd() * 2) + (y < 8 ? 1 : 0);
      for (let x = 0; x < l; x++) set(x, y, 'cliff');
      for (let x = 0; x < r; x++) set(W - 1 - x, y, 'cliff');
    }
    // Ľadovec – jazyk ľadu pod stenami
    for (let y = 1; y <= 10; y++) for (let x = 2; x < W - 2; x++) {
      const dx = (x - 9.5) / 4.6, dy = (y - 4) / 2.9;
      if (dx * dx + dy * dy < 1) set(x, y, 'glacier');
    }
    // Pleso
    for (let y = 13; y <= 19; y++) for (let x = 2; x <= 9; x++) {
      const dx = (x - 5.5) / 2.4, dy = (y - 16) / 2.1;
      if (dx * dx + dy * dy < 1) set(x, y, 'water');
    }
    // Chodník z dolného okraja k ľadovcu
    let px = 10;
    for (let y = H - 1; y >= 11; y--) {
      for (const x of [px - 1, px]) if (g[y * W + x] !== 'water') set(x, y, 'path');
      if (y % 5 === 0) px += (y % 10 === 0 ? 1 : -1);
    }
    for (const gt of GATES.hory) set(gt.x, gt.y, 'gate');
    // pod chodníkom nesmie byť strom ani balvan (aby sa dalo prejsť)
    for (let y = 11; y < H; y++) for (let x = 0; x < W; x++) if (g[y * W + x] === 'path') for (const dx of [-1, 1]) {
      const n = g[y * W + x + dx];
      if (n === 'spruce' || n === 'boulder') set(x + dx, y, y < 13 ? 'snow' : y < 21 ? 'scree' : 'alp');
    }
    return g;
  }

  // ---- Les na pomedzí: plocha medzi záhradou a Lesom divov (rovnaká veľkosť ako záhrada) ----
  // Na juhu lúka s poľnými kvetmi a pár stromami, v strede mierny les s krami, papraďou a chodníčkami,
  // smerom na sever les hustne, až na severe ostane len chodník k okraju (tam je prechod do Lesa divov).
  // Rozloženie je podľa semienka sveta: každý svet má svoj les, ale stále ten istý.
  const MEADOW_Y = 24;            // od tohto riadku na juh je lúka
  function buildPomedzie(seed) {
    const { w, h } = AREA_SIZE.pomedzie;
    const g = new Array(w * h).fill('forest');
    const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h;
    const set = (x, y, v) => { if (inside(x, y)) g[y * w + x] = v; };
    const at = (x, y) => inside(x, y) ? g[y * w + x] : null;
    const rnd = mulberry32(((seed >>> 0) ^ 0x9e3779b9) >>> 0);
    const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
    // hustota stromov podľa riadku: lúka riedko, les smerom na sever čoraz hustejšie
    const edge = MEADOW_Y - 3;
    const treeP = y => y >= MEADOW_Y ? 0.05 : y >= edge ? 0.14 : 0.16 + 0.72 * Math.pow((edge - y) / edge, 1.5);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const meadow = y >= MEADOW_Y || (y >= edge && rnd() < (y - edge + 1) / 4); // okraj lúky je zubatý
      const r = rnd(), p = treeP(y);
      if (r < p) set(x, y, 'tree');
      else if (r < p + (meadow ? 0.03 : 0.07)) set(x, y, 'bush');
      else set(x, y, meadow ? 'meadow' : rnd() < 0.25 ? 'fern' : 'forest');
    }
    // Chodník: krok po kroku (vždy susedné políčka), vodorovne smerom k cieľu
    const path = (x, y) => { if (at(x, y) !== 'gate') set(x, y, 'path'); };
    const walkTo = (x, y, gx, maxStep) => { let k = 0; while (x !== gx && k++ < maxStep) { x += Math.sign(gx - x); path(x, y); } return x; };
    // Hlavný chodník: od prechodu na západe kúsok po lúke na východ a potom kľukato na sever
    const gy = GATES.pomedzie[1].y;
    let x = 1, y = gy;
    path(1, gy - 1); path(1, gy);
    x = walkTo(x, y, ri(4, 7), w);
    let goal = x;
    const trail = [];
    while (y > 0) {
      y--; path(x, y);
      if (y > 6 && y % 3 === 0) goal = Math.max(3, Math.min(w - 4, x + ri(-4, 4)));
      if (y <= 6) goal = POMEDZIE_NORTH[0];
      x = walkTo(x, y, goal, 2);
      trail.push({ x, y });
    }
    for (const nx of POMEDZIE_NORTH) { path(nx, 0); path(nx, 1); }
    // Bočné chodníčky: z hlavného chodníka do strany k malej čistinke
    for (const [y0, y1] of [[8, 13], [15, 20]]) {
      const from = trail.find(t => t.y === ri(y0, y1));
      if (!from) continue;
      const dir = from.x < w / 2 ? 1 : -1, len = ri(4, 7);
      let cx = from.x, cy = from.y;
      for (let i = 0; i < len; i++) {
        cx += dir; if (cx < 1 || cx > w - 2) { cx -= dir; break; }
        path(cx, cy);
        if (rnd() < 0.35 && cy > 4 && cy < MEADOW_Y - 1) { cy += rnd() < 0.5 ? -1 : 1; path(cx, cy); }
      }
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (at(cx + dx, cy + dy) && at(cx + dx, cy + dy) !== 'path') set(cx + dx, cy + dy, (dx + dy) % 2 ? 'fern' : 'forest');
    }
    // Chodníček po lúke od prechodu na juhovýchod
    let mx = 2, my = gy;
    while (my < h - 2) { my++; path(mx, my); mx = walkTo(mx, my, Math.min(w - 3, mx + ri(1, 3)), 3); }
    // Pri prechode do záhrady voľná lúka
    for (let yy = gy - 2; yy <= gy + 1; yy++) for (let xx = 0; xx <= 2; xx++) if (at(xx, yy) !== 'path') set(xx, yy, 'meadow');
    // Na severe už len stromy a chodník
    for (let yy = 0; yy <= 2; yy++) for (let xx = 0; xx < w; xx++) if (at(xx, yy) !== 'path') set(xx, yy, 'tree');
    for (const gt of GATES.pomedzie) set(gt.x, gt.y, 'gate');
    // Pod telom hráča na príchodovom mieste nič nerastie
    for (const i of arrivalTiles('pomedzie')) if (BLOCK[g[i]]) g[i] = 'path';
    // Každé priechodné políčko musí byť dosiahnuteľné od prechodu – uzavreté kúty zarastú
    const seen = new Uint8Array(w * h), q = [gy * w];
    seen[gy * w] = 1;
    for (let k = 0; k < q.length; k++) {
      const i = q[k], qx = i % w, qy = (i / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = qx + dx, ny = qy + dy, n = ny * w + nx;
        if (!inside(nx, ny) || seen[n] || BLOCK[g[n]]) continue;
        seen[n] = 1; q.push(n);
      }
    }
    for (let i = 0; i < g.length; i++) if (!seen[i] && !BLOCK[g[i]]) g[i] = ((i / w) | 0) >= MEADOW_Y ? 'bush' : 'tree';
    return g;
  }

  // ---- Les divov: veľký temný les severne od Lesa na pomedzí (2× záhrada v každom smere) ----
  // Bludisko úzkych chodníkov (1–2 políčka) medzi obrovskými stromami (kmeň na 2 × 2 políčkach: 'giant' v ľavom hornom
  // rohu, 'trunk' na ostatných troch), medzi nimi menšie stromy, kry a spadnuté kmene, zopár čistín ('glade').
  // Zem: tmavý mach, korene, paprade a huby (len ozdoba). Každé priechodné políčko je dosiahnuteľné od vstupu na juhu.
  // Rozloženie je podľa semienka sveta; uloží sa so svetom (areas.js), takže ho nezmení ani neskoršia úprava generátora.
  const LES_CELL = 4;  // bunka bludiska (políčka): v každej je uzol chodníka, chodníky spájajú uzly susedných buniek
  const LES_GLADES = 6; // počet čistín
  const LES_GIANT = 0.25; // podiel voľných štvorcov 2 × 2, na ktorých rastie obor (inak bežné stromy)
  const LES_DECOR = ['moss', 'fern', 'roots', 'fungi']; // priechodná zem medzi stromami
  // Srdce lesa: v strede plochy veľká čistina (polosi rx × ry políčok), okolo nej riedky les, ktorý smerom von hustne
  // (do vzdialenosti ring × polosi; v nej menej stromov a široké chodníky ostanú široké)
  // sun = o koľko políčok za okraj čistiny ešte dopadá slnko (inde v Lese divov je zem bez slnka, mapa tieňov len tu)
  const LES_HEART = { rx: 6, ry: 8, ring: 2.2, sun: 4 };
  // Kde v ploche svieti slnko (svetové súradnice: stred cx, cz a polosi rx, rz elipsy), null = všade
  function sunZone(area) {
    if (area !== 'les') return null;
    const { w, h } = AREA_SIZE.les;
    return { cx: w / 2, cz: h / 2, rx: LES_HEART.rx + LES_HEART.sun, rz: LES_HEART.ry + LES_HEART.sun };
  }
  function buildLes(seed) {
    const w = LES_W, h = LES_H;
    const g = new Array(w * h).fill(null); // null = zatiaľ hustý les
    const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h;
    const at = (x, y) => inside(x, y) ? g[y * w + x] : 'edge';
    const rnd = mulberry32(((seed >>> 0) ^ 0x6d2b79f5) >>> 0);
    const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
    const glade = new Uint8Array(w * h); // políčka čistín (aj tie, na ktorých neskôr rastie papraď či huby)
    const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    // chodník sa nikdy nedotkne okraja plochy (okrem prechodu)
    // lane = druhý pruh širokého chodníka (neprepíše stred iného chodníka)
    const main = new Uint8Array(w * h);
    const carve = (x, y, v, lane) => {
      if (x < 1 || y < 1 || x > w - 2 || y > h - 2) return;
      const i = y * w + x;
      if (!lane) main[i] = 1;
      if (g[i] !== 'glade' && !(lane && main[i])) g[i] = v || 'path';
    };
    const cw = Math.floor(w / LES_CELL), chh = Math.floor(h / LES_CELL);
    const node = [];
    for (let cy = 0; cy < chh; cy++) for (let cx = 0; cx < cw; cx++) node.push({ x: cx * LES_CELL + 1 + ri(0, 1), y: cy * LES_CELL + 1 + ri(0, 1) });
    // chodník medzi dvoma uzlami: najprv vodorovne, potom zvisle (alebo naopak); niekde široký 2 políčka
    const link = (a, b, narrow) => {
      const wide = !narrow && rnd() < 0.3, lane = rnd() < 0.5 ? 'path' : 'moss';
      let x = a.x, y = a.y;
      const step = (dx, dy) => { x += dx; y += dy; carve(x, y); if (wide) carve(x + (dy ? 1 : 0), y + (dx ? 1 : 0), lane, true); };
      carve(x, y);
      if (rnd() < 0.5) { while (x !== b.x) step(Math.sign(b.x - x), 0); while (y !== b.y) step(0, Math.sign(b.y - y)); }
      else { while (y !== b.y) step(0, Math.sign(b.y - y)); while (x !== b.x) step(Math.sign(b.x - x), 0); }
    };
    // Bludisko: náhodná prehľadávacia kostra buniek od vstupu (všetko je spojené), k tomu pár slučiek
    const start = (chh - 1) * cw + Math.floor(LES_SOUTH[1] / LES_CELL);
    const seen = new Uint8Array(cw * chh), linked = new Set(), stack = [start];
    const nbs = c => [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => [c % cw + dx, ((c / cw) | 0) + dy]).filter(([x, y]) => x >= 0 && y >= 0 && x < cw && y < chh).map(([x, y]) => y * cw + x);
    const key = (a, b) => Math.min(a, b) + ':' + Math.max(a, b);
    seen[start] = 1;
    while (stack.length) {
      const c = stack[stack.length - 1], open = shuffle(nbs(c).filter(n => !seen[n]));
      if (!open.length) { stack.pop(); continue; }
      const n = open[0];
      seen[n] = 1; linked.add(key(c, n)); link(node[c], node[n]); stack.push(n);
    }
    for (let c = 0; c < cw * chh; c++) for (const n of nbs(c)) if (n > c && !linked.has(key(c, n)) && rnd() < 0.1) { linked.add(key(c, n)); link(node[c], node[n]); }
    // Vstup: od prechodu na juhu rovno k uzlu prvej bunky, pri príchode trochu voľného miesta
    for (let y = h - 2; y >= h - 4; y--) for (const x of LES_SOUTH) carve(x, y, 'path', x !== LES_SOUTH[1]);
    link({ x: LES_SOUTH[1], y: h - 4 }, node[start], true);
    // Čistiny: ďaleko od vstupu aj od seba, okrúhle, okolo uzla bunky
    const glades = [];
    for (let k = 0; k < 400 && glades.length < LES_GLADES; k++) {
      const c = ri(0, cw * chh - 1), cx = c % cw, cy = (c / cw) | 0;
      if (cy >= chh - 3 || Math.hypot((cx * LES_CELL + 2 - (w - 1) / 2) / LES_HEART.rx, (cy * LES_CELL + 2 - (h - 1) / 2) / LES_HEART.ry) < LES_HEART.ring + 0.3 || glades.some(o => Math.hypot(o.cx - cx, o.cy - cy) < 4)) continue;
      glades.push({ cx, cy });
      const n = node[c], rx = ri(2, 3) + 0.4, ry = ri(2, 3) + 0.4;
      for (let y = n.y - 4; y <= n.y + 4; y++) for (let x = n.x - 4; x <= n.x + 4; x++) {
        const d = ((x - n.x) / rx) ** 2 + ((y - n.y) / ry) ** 2;
        if (d <= 1 + (rnd() - 0.5) * 0.4 && x >= 1 && y >= 1 && x <= w - 2 && y <= h - 2) { g[y * w + x] = 'glade'; glade[y * w + x] = 1; }
      }
    }
    // Srdce lesa v strede: veľká čistina, okolo nej riedky les (sparse 0–1: ako veľmi je les ešte riedky)
    const hx = (w - 1) / 2, hy = (h - 1) / 2, sparse = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, d = Math.hypot((x - hx) / LES_HEART.rx, (y - hy) / LES_HEART.ry) + (rnd() - 0.5) * 0.15;
      if (d <= 1) { g[i] = 'glade'; glade[i] = 1; }
      else if (d < LES_HEART.ring) sparse[i] = 1 - (d - 1) / (LES_HEART.ring - 1);
    }
    // Obrovské stromy: na voľnom štvorci 2 × 2 v hustom lese zhruba každý druhý raz obor, inak tam rastú bežné stromy (sem-tam ker)
    const spots = [];
    for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) spots.push(y * w + x);
    for (const i of shuffle(spots)) {
      const x = i % w, y = (i / w) | 0;
      if (at(x, y) || at(x + 1, y) || at(x, y + 1) || at(x + 1, y + 1)) continue;
      if (rnd() < sparse[i] * 0.8) continue; // v riedkom lese okolo srdca menej stromov
      if (rnd() < LES_GIANT) { g[i] = 'giant'; g[i + 1] = g[i + w] = g[i + w + 1] = 'trunk'; }
      else for (const j of [i, i + 1, i + w, i + w + 1]) g[j] = rnd() < 0.15 ? 'bush' : 'tree';
    }
    // Zvyšok hustého lesa: menšie stromy, kry, spadnuté kmene, inde priechodná zem (mach, papraď, korene, huby)
    for (let i = 0; i < g.length; i++) {
      if (g[i] === 'path') { const r = rnd(); if (r < 0.1) g[i] = 'roots'; else if (r < 0.18) g[i] = 'moss'; continue; }
      if (g[i] === 'glade') { const r = rnd(); if (r < 0.14) g[i] = 'fern'; else if (r < 0.2) g[i] = 'fungi'; continue; }
      if (g[i]) continue;
      const r = rnd() + sparse[i] * 0.5; // v riedkom lese viac priechodnej zeme
      g[i] = r < 0.42 ? 'tree' : r < 0.6 ? 'bush' : r < 0.68 ? 'log' : LES_DECOR[ri(0, LES_DECOR.length - 1)];
    }
    for (const gt of GATES.les) g[gt.y * w + gt.x] = 'gate';
    // Chodníky ostanú úzke (1–2 políčka): kde je mimo čistiny voľné miesto 3 × 3, jeho stred zarastie krom.
    // Nič sa tým neodreže – okolo stredu ostane voľný kruh ôsmich políčok. Políčka pod telom hráča na príchodovom mieste ostanú voľné.
    const arrive = arrivalTiles('les');
    for (const i of arrive) if (BLOCK[g[i]]) g[i] = 'path';
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      if (arrive.has(y * w + x)) continue;
      let all = true, gl = false;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const i = (y + dy) * w + x + dx; all = all && !BLOCK[g[i]]; gl = gl || glade[i]; }
      if (all && !gl && rnd() >= sparse[y * w + x] * 1.5) g[y * w + x] = 'bush';
    }
    // Každé priechodné políčko musí byť dosiahnuteľné od vstupu – uzavreté kúty zarastú stromami
    const reach = new Uint8Array(w * h), q = [GATES.les[0].y * w + GATES.les[0].x];
    reach[q[0]] = 1;
    for (let k = 0; k < q.length; k++) {
      const i = q[k], qx = i % w, qy = (i / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = qx + dx, ny = qy + dy, n = ny * w + nx;
        if (!inside(nx, ny) || reach[n] || BLOCK[g[n]]) continue;
        reach[n] = 1; q.push(n);
      }
    }
    for (let i = 0; i < g.length; i++) if (!reach[i] && !BLOCK[g[i]]) g[i] = 'tree';
    return g;
  }

  // Uloženie rozloženia Lesa divov: jeden znak na políčko (areas.js saveLes/loadLes, ladiaca stránka)
  const LES_CODE = { path: '.', moss: ',', fern: 'f', roots: 'r', fungi: 'h', glade: 'o', giant: 'G', trunk: 'g', tree: 'T', bush: 'b', log: 'l', gate: '#' };
  const LES_TYPE = Object.fromEntries(Object.entries(LES_CODE).map(([k, v]) => [v, k]));
  // Uložený reťazec → typy políčok, alebo null, ak uloženie nesedí (zlá dĺžka, neznámy znak)
  function decodeLes(saved) {
    const { w, h } = AREA_SIZE.les;
    if (typeof saved !== 'string' || saved.length !== w * h) return null;
    const out = [];
    for (const c of saved) { const t = LES_TYPE[c]; if (!t) return null; out.push(t); }
    return out;
  }

  // Temné plochy: vidno len kúsok okolo seba (sight políčok, s lampášom v ruke lamp), objekty sa za hráčom nezoslabujú
  // ani nezvýrazňujú a lampáš svieti aj cez deň. Svetlo lampášov (aj cudzích) presvetlí tmu okolo nich.
  // lampR = dosah svetla lampáša v tme (políčka, inde render3d LAMP_R), lampK = jeho sila (1 = ako v záhrade v noci)
  // viewDiag = uhlopriečka výrezu v blokoch (pohľad bližšie na hráča, inak VIEW_DIAG)
  const DARK = { les: { sight: 3, lamp: 3.5, lampR: 3.5, lampK: 0.6, viewDiag: 17.5 } };
  // Uhlopriečka výrezu na ploche area, keď hráč stojí na riadku y: v Lese divov bližšie, cestou k nemu postupne
  function viewDiagAt(area, y) { return VIEW_DIAG + (DARK.les.viewDiag - VIEW_DIAG) * darkAt(area, y); }

  function isDark(area) { return !!DARK[area]; }
  // Postupný prechod do tmy Lesa divov: v Lese na pomedzí sa od riadku from (0) po riadok to (1) pridáva svetlo a dohľad
  // Lesa divov, takže pri prechode na severnom okraji vyzerá les rovnako ako Les divov. V Lese divov všade 1.
  const DARK_RAMP = { pomedzie: { from: 10, to: 2 } };
  function darkAt(area, y) {
    if (DARK[area]) return 1;
    const r = DARK_RAMP[area];
    return r ? Math.max(0, Math.min(1, (r.from - y) / (r.from - r.to))) : 0;
  }

  const BLOCK = { tree: 1, water: 1, hut: 1, babka: 1, cauldron: 1, stall: 1, well: 1, boulder: 1, house: 1, cliff: 1, glacier: 1, spruce: 1, icehouse: 1, bush: 1, giant: 1, trunk: 1, log: 1 };
  // Výška terénu v podkockách (pol bloku) podľa typu zeme – zdieľa ju 3D svet (world3d.js) aj chôdza
  // (hory: sutina a sneh vyššie, ľadovec ešte vyššie, skalné steny najvyššie; v záhrade skalka nad trávou).
  const TERRAIN_H = { water: 1, rock: 3, boulder: 3, scree: 3, snow: 3, glacier: 3, cliff: 8 };
  function terrainH(g) { return TERRAIN_H[g] || 2; }
  // Výška povrchu políčka vo vrstvách (1/4 bloku): terén a na ľadovci aj ľad.
  // Chodí sa hore najviac GLACIER_STEP vrstiev (pol bloku), dolu hocikoľko.
  // lift = o koľko vrstiev vyššie je hráč vo výskoku (skokom sa vylezie aj o blok). Plazením sa výškový rozdiel neprejde ani hore, ani dolu.
  const GLACIER_STEP = 2;
  function level(t) { return t ? terrainH(t.g) * GLACIER_LAYERS / 2 + (t.g === 'glacier' ? t.ice || 0 : 0) : 0; }
  function passable(t) { return !!t && (!BLOCK[t.g] || t.g === 'glacier'); }
  function canStep(from, to, lift, crawl) {
    if (!passable(to)) return false;
    const up = level(to) - level(from);
    return crawl ? up === 0 : up <= GLACIER_STEP + (lift || 0);
  }
  const TILLABLE = { grass: 'normal', forest: 'forest', sand: 'sand', rock: 'rock' };
  // Prázdne obrobené políčko môže motykou zarovnať ktokoľvek zo záhrady, nielen ten, kto ho prekopal (spoločné pole)
  const canLevel = t => !!(t && t.s && !t.s.p);

  function isShade(tiles, x, y) {
    const t = tiles[y * W + x];
    if (!t) return false;
    if (t.g === 'forest' || t.g === 'ring') return true;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = tiles[ny * W + nx];
      if (n.g === 'tree' || n.g === 'hut' || n.g === 'house') return true;
    }
    return false;
  }

  // Čerstvosť kvetu podľa veku (v krokoch): prvých 40 % životnosti je čerstvý (1.0), potom klesá na 0.5.
  function freshness(sp, ageTicks) {
    const x = ageTicks / (SPECIES[sp].life * TICKS_PER_DAY);
    if (x <= 0.4) return 1;
    if (x >= 1) return 0.5;
    return 1 - (x - 0.4) / 0.6 * 0.5;
  }
  function batchAge(b, tick, rate) { return b.a + (tick - b.at) * rate; }
  function dayOfTick(tick) { return Math.floor(tick / TICKS_PER_DAY) + 1; }
  function minOfTick(tick) { return (tick % TICKS_PER_DAY) * MIN_PER_TICK; }
  function seasonOf(day) { return Math.floor((day - 1) / DAYS_PER_SEASON) % 4; }
  function isNight(min) { const h = min / 60; return h >= 21 || h < 4; }
  // Spať sa dá večer a v noci (18:00 – 6:00); keď spia všetci hráči, noc prebehne až do rána.
  const SLEEP_FROM_MIN = 18 * 60;
  function canSleep(min) { return min >= SLEEP_FROM_MIN || min < DAWN_TICK * MIN_PER_TICK; }
  function stageOf(p) {
    const sp = SPECIES[p.sp];
    if (!sp) return p.prog > 0 ? 1 : 0; // divá rastlina, ktorej druh klient ešte nepozná
    if (p.prog >= sp.days) return 3;
    if (p.prog >= sp.days * 0.5) return 2;
    if (p.prog > 0) return 1;
    return 0;
  }

  // Chat: najdlhšia správa (pole na písanie aj server); server navyše vyhodí < > a medzery na krajoch
  const CHAT_MAX = 120;
  function chatText(raw) { return String(raw || '').replace(/[<>]/g, '').trim().slice(0, CHAT_MAX).trim(); }

  const api = {
    CHAT_MAX, chatText,
    W, H, VIEW_DIAG, viewSize, DAYS_PER_SEASON, TICKS_PER_DAY, TICKS_PER_HOUR, MIN_PER_TICK, DAWN_TICK, BASE_DAY_SECONDS, dayOfTick, minOfTick,
    REP_LEVELS, repLevel, STORAGE_AGE_RATE, WILTED_PER_COMPOST, freshness, batchAge, UPGRADES, FESTIVALS, GIVERS, MIN_SEED_REP, SEASONS, SEASON_ICONS, SPECIES, POTIONS, RECIPES, TIPS, SHOP, PRICES,
    RING, SPAWN, BABKA, BLOCK, GLACIER_STEP, TERRAIN_H, terrainH, level, passable, canStep, TILLABLE, canLevel, SCAVENGE, isWild, TOOLS, ICEHOUSE, GLACIER_LAYERS, GLACIER_TOP, GLACIER_MELT, GLACIER_GROW, ICE_CARRY, ICE_SLOW, ICE_LIFE, ICE_PRICE, glacierLevels, isTool, AREAS, AREA_SIZE, areaSize, AREA_NAMES, AREA_IN, AREA_FX, GATES, ARRIVE, arrival, BODY, arrivalTiles, gateAt, gateSide, GLOOM, gloomAt, POMEDZIE_NORTH, MEADOW_Y, LES_W, LES_H, LES_SOUTH, LES_CELL, LES_DECOR, LES_HEART, sunZone, LES_CODE, decodeLes, DARK, isDark, DARK_RAMP, darkAt, viewDiagAt,
    sellPrice, itemName, buildMap, buildMountains, buildPomedzie, buildLes, buildArea, isShade, seasonOf, isNight, canSleep, SLEEP_FROM_MIN, stageOf, mulberry32
  };
  root.GameData = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
