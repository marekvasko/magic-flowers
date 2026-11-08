// Ostatní hráči na klientovi podľa správy pl (polohy hráčov 10× za sekundu). Zdieľané hrou a testami.
//  - syncOthers(others, list, myId, update): doplní a uprace mapu ostatných hráčov (id → postavička);
//    vlastná postavička medzi nimi nikdy nie je – ani keď pl prišiel skôr ako welcome a vlastné id sme ešte nepoznali (#125).
(function (root) {
  // update(o, p) prepíše údaje postavičky o z položky zoznamu p (cieľ pohybu, vzhľad, skok…);
  // vráti vlastnú položku zo zoznamu (emócia, hľadanie) alebo null
  function syncOthers(others, list, myId, update) {
    const seen = new Set();
    let me = null;
    for (const p of list) {
      if (p.id === myId) { me = p; continue; } // vlastné id nie je v seen – záznam z čias pred welcome nižšie zmizne
      seen.add(p.id);
      let o = others.get(p.id);
      if (!o) { o = { x: p.x, y: p.y, phase: 0, jz: 0, jv: 0, j: p.j }; others.set(p.id, o); }
      if (update) update(o, p);
    }
    for (const id of [...others.keys()]) if (!seen.has(id)) others.delete(id);
    return me;
  }

  const api = { syncOthers };
  root.Players = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
