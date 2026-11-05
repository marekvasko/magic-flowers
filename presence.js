// Prítomnosť hráčov: rýchle znovupripojenie, „kým si bol(a) preč“ a kontrola živých spojení (ping/pong).

// Koľko celých herných dní ubehlo od posledného odchodu (lastTick). Bez záznamu 0.
function awayDays(lastTick, tick, tpd) {
  if (lastTick == null) return 0;
  return Math.max(0, Math.floor((tick - lastTick) / tpd));
}

// Odchody s odkladom: hlásenie „odišiel(a)“ sa pošle až po graceMs. Ak sa hráč medzitým vráti,
// back() hlásenie zruší a vráti true – ide o rýchle znovupripojenie.
function createLeaving(graceMs, timers) {
  const t = timers || { setTimeout, clearTimeout };
  const pending = new Map();
  return {
    leave(key, fn) {
      if (pending.has(key)) t.clearTimeout(pending.get(key));
      pending.set(key, t.setTimeout(() => { pending.delete(key); fn(); }, graceMs));
    },
    back(key) {
      if (!pending.has(key)) return false;
      t.clearTimeout(pending.get(key));
      pending.delete(key);
      return true;
    },
    has(key) { return pending.has(key); }
  };
}

// Jedno kolo kontroly spojení: kto neodpovedal na minulý ping, toho odpojíme; ostatným pošleme nový.
// Polootvorené spojenie (vypadnutá wifi, mobil) by inak na serveri viselo bez konca.
function heartbeat(clients) {
  for (const ws of clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* spojenie sa práve zatvára */ }
  }
}
function watch(ws) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
}

module.exports = { awayDays, createLeaving, heartbeat, watch };
