(() => {
  'use strict';

  /* ---------- Utilidades ---------- */
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const pad = n => String(n).padStart(2, '0');
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

  // Fechas siempre en hora local (YYYY-MM-DD), nunca en UTC.
  const dateStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayStr = () => dateStr(new Date());
  const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return dateStr(new Date(y, m - 1, d + n)); };
  const longDate = s => { const [y, m, d] = s.split('-').map(Number); return `${d} de ${MESES[m - 1]} de ${y} (${DIAS[new Date(y, m - 1, d).getDay()]})`; };
  const shortDate = s => { const [y, m, d] = s.split('-').map(Number); return `${d} ${MESES[m - 1].slice(0, 3)} ${y}`; };
  const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;

  /* ---------- Base de datos local (IndexedDB) ---------- */
  let db;
  let sites = [];
  let entries = [];
  const state = { q: '' };

  const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const openDB = () => new Promise((res, rej) => {
    const r = indexedDB.open('obrario', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('sites', { keyPath: 'id' });
      const e = d.createObjectStore('entries', { keyPath: 'id' });
      e.createIndex('siteId', 'siteId');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const store = (n, m = 'readonly') => db.transaction(n, m).objectStore(n);
  const getAll = n => reqP(store(n).getAll());
  const put = (n, o) => reqP(store(n, 'readwrite').put(o));
  const del = (n, id) => reqP(store(n, 'readwrite').delete(id));

  /* ---------- Fotos: se reducen al guardar ---------- */
  const PHOTO_MAX = 1280;      // lado largo en píxeles
  const PHOTO_QUALITY = 0.72;  // calidad JPEG

  function compress(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, PHOTO_MAX / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.round(img.naturalWidth * k);
        const h = Math.round(img.naturalHeight * k);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        res(c.toDataURL('image/jpeg', PHOTO_QUALITY));
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('No se pudo leer la foto')); };
      img.src = url;
    });
  }

  /* ---------- Avisos y hojas ---------- */
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  function openSheet(html) {
    const s = $('#sheet');
    s.innerHTML = `<div class="sheet-back" data-close></div><div class="sheet-panel" role="dialog" aria-modal="true">${html}</div>`;
    s.hidden = false;
    document.body.classList.add('lock');
    return s;
  }
  function closeSheet() {
    $('#sheet').hidden = true;
    $('#sheet').innerHTML = '';
    document.body.classList.remove('lock');
  }
  $('#sheet').addEventListener('click', e => { if (e.target.closest('[data-close]')) closeSheet(); });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('#viewer').hidden) closeViewer(); else if (!$('#sheet').hidden) closeSheet();
  });

  /* ---------- Visor de fotos ---------- */
  function openViewer(photos, idx) {
    const v = $('#viewer');
    let i = idx;
    const draw = () => {
      v.innerHTML = `<img src="${photos[i]}" alt="Foto ${i + 1} de ${photos.length}">
        <button type="button" class="vbtn vclose" aria-label="Cerrar">✕</button>
        ${photos.length > 1 ? `<button type="button" class="vbtn vprev" aria-label="Anterior">‹</button><button type="button" class="vbtn vnext" aria-label="Siguiente">›</button><div class="vcount">${i + 1} / ${photos.length}</div>` : ''}`;
      $('.vclose', v).onclick = closeViewer;
      if (photos.length > 1) {
        $('.vprev', v).onclick = () => { i = (i - 1 + photos.length) % photos.length; draw(); };
        $('.vnext', v).onclick = () => { i = (i + 1) % photos.length; draw(); };
      }
    };
    draw();
    v.hidden = false;
    document.body.classList.add('lock');
  }
  function closeViewer() {
    $('#viewer').hidden = true;
    $('#viewer').innerHTML = '';
    if ($('#sheet').hidden) document.body.classList.remove('lock');
  }

  /* ---------- Vistas ---------- */
  const app = $('#app');
  const dock = $('#dock');

  function setDock(label, handler) {
    if (!label) { dock.hidden = true; dock.innerHTML = ''; return; }
    dock.innerHTML = `<button type="button" class="btn primary">${esc(label)}</button>`;
    $('button', dock).onclick = handler;
    dock.hidden = false;
  }

  const siteEntries = id => entries.filter(e => e.siteId === id);
  const lastDate = id => siteEntries(id).reduce((m, e) => (e.date > m ? e.date : m), '');

  function currentSiteId() {
    const m = location.hash.match(/^#s\/(.+)$/);
    return m && sites.some(s => s.id === m[1]) ? m[1] : null;
  }

  function render() {
    const id = currentSiteId();
    if (id) renderSite(id); else renderList();
  }
  function route() { render(); window.scrollTo(0, 0); }

  function renderList() {
    app.innerHTML = `
      <div class="search"><input id="q" type="search" placeholder="Buscar sitio o dirección" value="${esc(state.q)}" aria-label="Buscar sitio"></div>
      <ul class="sites" id="siteList"></ul>`;
    $('#q').addEventListener('input', e => { state.q = e.target.value; drawSites(); });
    drawSites();
    setDock('+ Nuevo sitio', () => siteSheet());
  }

  function drawSites() {
    const q = state.q.trim().toLowerCase();
    const list = sites
      .filter(s => !q || s.name.toLowerCase().includes(q) || (s.address || '').toLowerCase().includes(q))
      .map(s => ({ s, n: siteEntries(s.id).length, last: lastDate(s.id) }))
      .sort((a, b) => (b.last || b.s.created).localeCompare(a.last || a.s.created));
    const ul = $('#siteList');
    if (!sites.length) {
      ul.outerHTML = `<div class="empty" id="siteList"><strong>Todavía no hay sitios</strong><span>Crea uno por cada obra o aviso, por ejemplo "Casa de Juan". Dentro irás guardando notas y fotos por fecha.</span></div>`;
      return;
    }
    if (!list.length) {
      ul.outerHTML = `<div class="empty" id="siteList"><strong>Sin resultados</strong><span>Ningún sitio coincide con la búsqueda.</span></div>`;
      return;
    }
    const html = list.map(({ s, n, last }) => `
      <li><a class="site-card" href="#s/${esc(s.id)}">
        <strong>${esc(s.name)}</strong>
        ${s.address ? `<span class="addr">${esc(s.address)}</span>` : ''}
        <span class="meta">${plural(n, 'entrada', 'entradas')}${last ? ` · última ${shortDate(last)}` : ''}</span>
      </a></li>`).join('');
    const holder = $('#siteList');
    if (holder.tagName === 'UL') holder.innerHTML = html;
    else { holder.outerHTML = `<ul class="sites" id="siteList">${html}</ul>`; }
  }

  function renderSite(id) {
    const s = sites.find(x => x.id === id);
    const es = siteEntries(id).sort((a, b) => b.date.localeCompare(a.date) || b.created - a.created);
    const days = [];
    es.forEach(e => {
      let g = days[days.length - 1];
      if (!g || g.date !== e.date) { g = { date: e.date, items: [] }; days.push(g); }
      g.items.push(e);
    });
    const maps = s.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.address)}` : '';
    app.innerHTML = `
      <a class="back" href="#/">‹ Todos los sitios</a>
      <div class="site-head">
        <h1>${esc(s.name)}</h1>
        ${s.address ? `<p class="addr">${esc(s.address)}</p>` : ''}
        <p class="meta">${plural(es.length, 'entrada', 'entradas')}</p>
        <div class="row">
          <button type="button" class="btn small" id="editSite">Editar sitio</button>
          ${maps ? `<a class="btn small" href="${maps}" target="_blank" rel="noopener">Ver en el mapa</a>` : ''}
        </div>
      </div>
      ${days.length ? days.map(g => `
        <section class="day">
          <h3>${longDate(g.date)}</h3>
          ${g.items.map(e => `
            <div class="entry" role="button" tabindex="0" data-e="${esc(e.id)}" aria-label="Editar entrada">
              ${e.note ? `<div class="note">${esc(e.note)}</div>` : `<div class="note none">Solo fotos</div>`}
              ${e.photos && e.photos.length ? `<div class="grid">${e.photos.map((p, i) => `<button type="button" data-e="${esc(e.id)}" data-p="${i}" aria-label="Abrir foto ${i + 1}"><img src="${p}" alt="" loading="lazy"></button>`).join('')}</div>` : ''}
            </div>`).join('')}
        </section>`).join('') : `<div class="empty"><strong>Este sitio aún no tiene entradas</strong><span>Toca "Nueva entrada" para anotar lo que hiciste y añadir fotos.</span></div>`}`;

    $('#editSite').onclick = () => siteSheet(s);
    app.querySelectorAll('.entry').forEach(el => {
      const open = () => entrySheet(id, entries.find(x => x.id === el.dataset.e));
      el.addEventListener('click', ev => {
        const pb = ev.target.closest('button[data-p]');
        if (pb) {
          const en = entries.find(x => x.id === pb.dataset.e);
          openViewer(en.photos, Number(pb.dataset.p));
          return;
        }
        open();
      });
      el.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } });
    });
    setDock('+ Nueva entrada', () => entrySheet(id));
  }

  /* ---------- Formulario de sitio ---------- */
  function siteSheet(site) {
    const isNew = !site;
    openSheet(`
      <h2>${isNew ? 'Nuevo sitio' : 'Editar sitio'}</h2>
      <label class="lbl" for="sname">Nombre</label>
      <input class="field" id="sname" type="text" placeholder="Casa de Juan" value="${esc(site ? site.name : '')}" autocomplete="off">
      <label class="lbl" for="saddr">Dirección</label>
      <input class="field" id="saddr" type="text" placeholder="Calle, número, ciudad" value="${esc(site ? site.address || '' : '')}" autocomplete="off">
      <div class="actions">
        <button type="button" class="btn primary block" id="ssave">Guardar</button>
        <button type="button" class="btn ghost block" data-close>Cancelar</button>
        ${isNew ? '' : '<button type="button" class="btn danger block" id="sdel">Eliminar sitio</button>'}
      </div>`);
    $('#sname').focus();
    $('#ssave').onclick = async () => {
      const name = $('#sname').value.trim();
      if (!name) { toast('Escribe un nombre para el sitio'); return; }
      const obj = isNew
        ? { id: uid(), name, address: $('#saddr').value.trim(), created: Date.now() }
        : { ...site, name, address: $('#saddr').value.trim() };
      await put('sites', obj);
      if (isNew) sites.push(obj); else sites[sites.findIndex(x => x.id === obj.id)] = obj;
      closeSheet();
      if (isNew) { location.hash = `#s/${obj.id}`; } else render();
      toast('Guardado');
    };
    if (!isNew) {
      const n = siteEntries(site.id).length;
      const b = $('#sdel');
      b.onclick = async () => {
        if (!b.classList.contains('armed')) {
          b.classList.add('armed');
          b.textContent = n ? `Toca otra vez: se borran también ${plural(n, 'entrada', 'entradas')}` : 'Toca otra vez para confirmar';
          return;
        }
        for (const e of siteEntries(site.id)) await del('entries', e.id);
        await del('sites', site.id);
        entries = entries.filter(e => e.siteId !== site.id);
        sites = sites.filter(x => x.id !== site.id);
        closeSheet();
        location.hash = '#/';
        toast('Sitio eliminado');
      };
    }
  }

  /* ---------- Formulario de entrada ---------- */
  function entrySheet(siteId, entry) {
    const isNew = !entry;
    let photos = entry && entry.photos ? [...entry.photos] : [];
    let date = entry ? entry.date : todayStr();
    openSheet(`
      <h2>${isNew ? 'Nueva entrada' : 'Editar entrada'}</h2>
      <span class="lbl">Fecha</span>
      <div class="chips" id="dchips">
        <button type="button" data-d="0">Hoy</button>
        <button type="button" data-d="-1">Ayer</button>
        <button type="button" data-d="-2">Hace 2 días</button>
        <input type="date" id="edate" aria-label="Elegir fecha" value="${date}">
      </div>
      <label class="lbl" for="enote">Nota</label>
      <textarea id="enote" placeholder="Qué hiciste, qué mediste, qué falta por hacer">${esc(entry ? entry.note || '' : '')}</textarea>
      <span class="lbl">Fotos</span>
      <div class="thumbs" id="thumbs"></div>
      <label class="btn block" for="efiles" id="addph">+ Añadir fotos</label>
      <input id="efiles" type="file" accept="image/*" multiple hidden>
      <div class="actions">
        <button type="button" class="btn primary block" id="esave">Guardar</button>
        <button type="button" class="btn ghost block" data-close>Cancelar</button>
        ${isNew ? '' : '<button type="button" class="btn danger block" id="edel">Eliminar entrada</button>'}
      </div>`);

    const syncChips = () => {
      const t = todayStr();
      $('#dchips').querySelectorAll('button').forEach(b => b.classList.toggle('on', addDays(t, Number(b.dataset.d)) === date));
      $('#edate').value = date;
    };
    $('#dchips').addEventListener('click', e => {
      const b = e.target.closest('button[data-d]');
      if (!b) return;
      date = addDays(todayStr(), Number(b.dataset.d));
      syncChips();
    });
    $('#edate').addEventListener('change', e => { if (e.target.value) { date = e.target.value; syncChips(); } });
    syncChips();

    const drawThumbs = () => {
      $('#thumbs').innerHTML = photos.map((p, i) => `<div class="t"><img src="${p}" alt="Foto ${i + 1}"><button type="button" class="x" data-i="${i}" aria-label="Quitar foto ${i + 1}">✕</button></div>`).join('');
    };
    $('#thumbs').addEventListener('click', e => {
      const x = e.target.closest('.x');
      if (!x) return;
      photos.splice(Number(x.dataset.i), 1);
      drawThumbs();
    });
    drawThumbs();

    $('#efiles').addEventListener('change', async e => {
      const files = [...e.target.files];
      e.target.value = '';
      if (!files.length) return;
      const lbl = $('#addph');
      lbl.textContent = 'Procesando fotos…';
      let fail = 0;
      for (const f of files) {
        try { photos.push(await compress(f)); } catch (_) { fail++; }
      }
      lbl.textContent = '+ Añadir fotos';
      drawThumbs();
      if (fail) toast(`No se pudieron leer ${plural(fail, 'foto', 'fotos')}`);
    });

    $('#esave').onclick = async () => {
      const note = $('#enote').value.trim();
      if (!note && !photos.length) { toast('Añade una nota o una foto'); return; }
      const now = Date.now();
      const obj = isNew
        ? { id: uid(), siteId, date, note, photos, created: now, updated: now }
        : { ...entry, date, note, photos, updated: now };
      try {
        await put('entries', obj);
      } catch (_) {
        toast('No se pudo guardar. Puede que no quede espacio en el móvil');
        return;
      }
      if (isNew) entries.push(obj); else entries[entries.findIndex(x => x.id === obj.id)] = obj;
      closeSheet();
      render();
      toast('Guardado');
    };

    if (!isNew) {
      const b = $('#edel');
      b.onclick = async () => {
        if (!b.classList.contains('armed')) {
          b.classList.add('armed');
          b.textContent = 'Toca otra vez para confirmar';
          return;
        }
        await del('entries', entry.id);
        entries = entries.filter(x => x.id !== entry.id);
        closeSheet();
        render();
        toast('Entrada eliminada');
      };
    }
  }

  /* ---------- Copia de seguridad ---------- */
  function backupSheet() {
    const photoCount = entries.reduce((n, e) => n + (e.photos ? e.photos.length : 0), 0);
    const bytes = entries.reduce((n, e) => n + (e.photos || []).reduce((m, p) => m + p.length * 0.75, 0), 0);
    openSheet(`
      <h2>Copia de seguridad</h2>
      <div class="stats">
        <span><b>${sites.length}</b> sitios</span>
        <span><b>${entries.length}</b> entradas</span>
        <span><b>${photoCount}</b> fotos</span>
        <span><b>${(bytes / 1048576).toFixed(1)}</b> MB</span>
      </div>
      <p class="hint">Todo se guarda solo en este móvil. Exporta un archivo de vez en cuando y guárdalo en tu OneDrive. Para pasarlo a otro dispositivo, impórtalo allí.</p>
      <div class="actions">
        <button type="button" class="btn primary block" id="bexp">Exportar copia</button>
        <label class="btn block" for="bimp">Importar copia</label>
        <input id="bimp" type="file" accept="application/json,.json" hidden>
        <button type="button" class="btn ghost block" data-close>Cerrar</button>
      </div>
      <p class="hint">Al importar, lo del archivo se suma a lo que ya tienes. Si algo existe en los dos sitios, se queda la versión del archivo.</p>`);
    $('#bexp').onclick = exportBackup;
    $('#bimp').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) importBackup(f); });
  }

  async function exportBackup() {
    const data = { app: 'obrario', version: 1, exported: new Date().toISOString(), sites, entries };
    const name = `obrario-${todayStr()}.json`;
    const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
        toast('Copia lista');
        return;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Copia descargada');
  }

  async function importBackup(file) {
    try {
      const data = JSON.parse(await file.text());
      if (!data || data.app !== 'obrario' || !Array.isArray(data.sites) || !Array.isArray(data.entries)) throw new Error('formato');
      for (const s of data.sites) await put('sites', s);
      for (const e of data.entries) await put('entries', e);
      sites = await getAll('sites');
      entries = await getAll('entries');
      closeSheet();
      render();
      toast(`Importado: ${plural(data.sites.length, 'sitio', 'sitios')} y ${plural(data.entries.length, 'entrada', 'entradas')}`);
    } catch (_) {
      toast('Ese archivo no es una copia de Obrario');
    }
  }

  /* ---------- Arranque ---------- */
  $('#btnBackup').addEventListener('click', backupSheet);
  window.addEventListener('hashchange', route);

  (async () => {
    try {
      db = await openDB();
      sites = await getAll('sites');
      entries = await getAll('entries');
    } catch (_) {
      app.innerHTML = '<div class="empty"><strong>No se pudo abrir el almacenamiento</strong><span>Abre Obrario en una pestaña normal, no en modo privado, y vuelve a intentarlo.</span></div>';
      return;
    }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    route();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  })();
})();
