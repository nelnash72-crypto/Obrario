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
  const dayNum = s => { const [y, m, d] = s.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };
  const daysUntil = s => dayNum(s) - dayNum(todayStr());
  const dayShort = s => { const [y, m, d] = s.split('-').map(Number); return `${DIAS[new Date(y, m - 1, d).getDay()]} ${d} ${MESES[m - 1].slice(0, 3)}`; };
  // Suma meses sin pasarse de fin de mes (31 ene + 1 mes = 28 feb).
  function addMonths(s, n) {
    const [y, m, d] = s.split('-').map(Number);
    const t = m - 1 + n;
    const yy = y + Math.floor(t / 12);
    const mm = ((t % 12) + 12) % 12;
    const last = new Date(yy, mm + 1, 0).getDate();
    return dateStr(new Date(yy, mm, Math.min(d, last)));
  }

  /* ---------- Base de datos local (IndexedDB) ---------- */
  let db;
  let sites = [];
  let entries = [];
  let visits = [];
  const state = { q: '' };

  const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const openDB = () => new Promise((res, rej) => {
    const r = indexedDB.open('obrario', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('sites')) d.createObjectStore('sites', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('entries')) {
        const e = d.createObjectStore('entries', { keyPath: 'id' });
        e.createIndex('siteId', 'siteId');
      }
      if (!d.objectStoreNames.contains('visits')) {
        const v = d.createObjectStore('visits', { keyPath: 'id' });
        v.createIndex('siteId', 'siteId');
      }
    };
    r.onblocked = () => {
      const a = document.getElementById('app');
      if (a) a.innerHTML = '<div class="empty"><strong>Cierra Obrario en otras ventanas</strong><span>Hay otra copia abierta que impide actualizar los datos. Ciérrala y recarga esta.</span></div>';
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

  // Una foto es un texto (versión 1) o un objeto { src, tag }. Se leen las dos formas.
  const TAGS = ['', 'antes', 'durante', 'después'];
  const photoSrc = p => (typeof p === 'string' ? p : p.src);
  const photoTag = p => (typeof p === 'string' ? '' : p.tag || '');

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
      const tg = photoTag(photos[i]);
      const many = photos.length > 1;
      v.innerHTML = `<img src="${photoSrc(photos[i])}" alt="Foto ${i + 1} de ${photos.length}">
        <button type="button" class="vbtn vclose" aria-label="Cerrar">✕</button>
        ${many ? `<button type="button" class="vbtn vprev" aria-label="Anterior">‹</button><button type="button" class="vbtn vnext" aria-label="Siguiente">›</button>` : ''}
        <div class="vcount">${many ? `${i + 1} / ${photos.length}` : ''}${tg ? `${many ? ' · ' : ''}${tg}` : ''}</div>`;
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
  function route() {
    try { render(); } catch (err) {
      app.innerHTML = `<div class="empty"><strong>Algo falló al mostrar esta pantalla</strong><span>Tus datos están a salvo. Recarga la página; si sigue igual, cuéntame este texto: ${esc(err && err.message)}</span><a class="btn" href="#/">Volver al inicio</a></div>`;
    }
    window.scrollTo(0, 0);
  }

  function renderList() {
    app.innerHTML = `
      <div id="agenda"></div>
      <div class="search"><input id="q" type="search" placeholder="Buscar sitio o dirección" value="${esc(state.q)}" aria-label="Buscar sitio"></div>
      <ul class="sites" id="siteList"></ul>`;
    $('#q').addEventListener('input', e => { state.q = e.target.value; drawSites(); });
    drawSites();
    drawAgenda();
    setDock('+ Nuevo sitio', () => siteSheet());
  }

  // Orden de la lista: lo último que usaste arriba. Un sitio sin entradas cuenta por su fecha de creación.
  const recency = x => (x.last ? dayNum(x.last) * 86400000 : Number(x.s.created) || 0);

  function drawSites() {
    const q = state.q.trim().toLowerCase();
    const list = sites
      .filter(s => !q || s.name.toLowerCase().includes(q) || (s.address || '').toLowerCase().includes(q))
      .map(s => ({ s, n: siteEntries(s.id).length, last: lastDate(s.id) }))
      .sort((a, b) => recency(b) - recency(a));
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

  const getView = () => { try { return localStorage.getItem('obrario.view') === 'fechas' ? 'fechas' : 'detalle'; } catch (_) { return 'detalle'; } };
  const setView = v => { try { localStorage.setItem('obrario.view', v); } catch (_) { /* sin almacenamiento */ } };

  function entryHTML(e) {
    const ph = e.photos || [];
    return `
      <div class="entry" role="button" tabindex="0" data-e="${esc(e.id)}" aria-label="Editar entrada">
        ${e.note ? `<div class="note">${esc(e.note)}</div>` : `<div class="note none">Solo fotos</div>`}
        ${ph.length ? `<div class="grid">${ph.map((p, i) => `<button type="button" data-e="${esc(e.id)}" data-p="${i}" aria-label="Abrir foto ${i + 1}"><img src="${photoSrc(p)}" alt="" loading="lazy">${photoTag(p) ? `<span class="tag t-${TAGS.indexOf(photoTag(p))}">${photoTag(p)}</span>` : ''}</button>`).join('')}</div>` : ''}
      </div>`;
  }

  function bindEntries(root, siteId) {
    root.querySelectorAll('.entry').forEach(el => {
      const open = () => entrySheet(siteId, entries.find(x => x.id === el.dataset.e));
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
  }

  function daySheet(siteId, date) {
    const es = siteEntries(siteId).filter(e => e.date === date).sort((a, b) => b.created - a.created);
    openSheet(`
      <h2>${longDate(date)}</h2>
      ${es.map(entryHTML).join('')}
      <div class="actions">
        <button type="button" class="btn primary block" id="dnew">+ Nueva entrada este día</button>
        <button type="button" class="btn ghost block" data-close>Cerrar</button>
      </div>`);
    bindEntries($('#sheet'), siteId);
    $('#dnew').onclick = () => entrySheet(siteId, null, date);
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
    const view = getView();
    const hasGps = s.lat != null && s.lng != null;
    const mapQuery = hasGps ? `${s.lat},${s.lng}` : s.address;
    const maps = mapQuery ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}` : '';
    const where = s.address || (hasGps ? `Ubicación GPS (${Number(s.lat).toFixed(5)}, ${Number(s.lng).toFixed(5)})` : '');

    let body;
    if (!days.length) {
      body = `<div class="empty"><strong>Este sitio aún no tiene entradas</strong><span>Toca "Nueva entrada" para anotar lo que hiciste y añadir fotos.</span></div>`;
    } else if (view === 'fechas') {
      body = `<div class="daylist">${days.map(g => {
        const n = g.items.reduce((t, e) => t + (e.photos ? e.photos.length : 0), 0);
        return `<button type="button" class="daytab" data-d="${g.date}"><strong>${longDate(g.date)}</strong><span class="meta">${plural(g.items.length, 'entrada', 'entradas')}${n ? ` · ${plural(n, 'foto', 'fotos')}` : ''}</span></button>`;
      }).join('')}</div>`;
    } else {
      body = days.map(g => `
        <section class="day">
          <h3>${longDate(g.date)}</h3>
          ${g.items.map(entryHTML).join('')}
        </section>`).join('');
    }

    app.innerHTML = `
      <a class="back" href="#/">‹ Todos los sitios</a>
      <div class="site-head">
        <h1>${esc(s.name)}</h1>
        ${where ? `<p class="addr">${esc(where)}</p>` : ''}
        <p class="meta">${plural(es.length, 'entrada', 'entradas')}</p>
        <div class="row">
          <button type="button" class="btn small" id="editSite">Editar sitio</button>
          ${maps ? `<a class="btn small" href="${maps}" target="_blank" rel="noopener">Ver en el mapa</a>` : ''}
          <button type="button" class="btn small" id="addVisit">Agendar</button>
          ${days.length ? `<button type="button" class="btn small" id="toggleView">${view === 'fechas' ? 'Ver detallado' : 'Ver por fechas'}</button>` : ''}
        </div>
      </div>
      ${siteAgendaHTML(id)}
      ${body}`;

    $('#editSite').onclick = () => siteSheet(s);
    const tv = $('#toggleView');
    if (tv) tv.onclick = () => { setView(view === 'fechas' ? 'detalle' : 'fechas'); render(); };
    app.querySelectorAll('.daytab').forEach(b => { b.onclick = () => daySheet(id, b.dataset.d); });
    $('#addVisit').onclick = () => visitForm(id);
    bindVisits(app);
    bindEntries(app, id);
    setDock('+ Nueva entrada', () => entrySheet(id));
  }

  /* ---------- Formulario de sitio ---------- */
  function siteSheet(site) {
    const isNew = !site;
    let coords = site && site.lat != null ? { lat: site.lat, lng: site.lng } : null;
    openSheet(`
      <h2>${isNew ? 'Nuevo sitio' : 'Editar sitio'}</h2>
      <label class="lbl" for="sname">Nombre</label>
      <input class="field" id="sname" type="text" placeholder="Casa de Juan" value="${esc(site ? site.name : '')}" autocomplete="off">
      <label class="lbl" for="saddr">Dirección</label>
      <input class="field" id="saddr" type="text" placeholder="Calle, número, ciudad" value="${esc(site ? site.address || '' : '')}" autocomplete="off">
      <button type="button" class="btn block" id="sloc">Usar mi ubicación actual</button>
      <p class="hint" id="slocmsg" ${coords ? '' : 'hidden'}>${coords ? 'Ubicación GPS guardada. Si cambias la dirección a mano, se descarta.' : ''}</p>
      <div class="actions">
        <button type="button" class="btn primary block" id="ssave">Guardar</button>
        <button type="button" class="btn ghost block" data-close>Cancelar</button>
        ${isNew ? '' : '<button type="button" class="btn danger block" id="sdel">Eliminar sitio</button>'}
      </div>`);
    $('#sname').focus();

    // Si escribes la dirección a mano, las coordenadas viejas dejan de valer.
    $('#saddr').addEventListener('input', () => { coords = null; $('#slocmsg').hidden = true; });

    $('#sloc').onclick = async () => {
      const b = $('#sloc');
      const msg = $('#slocmsg');
      if (!navigator.geolocation) { toast('Este navegador no da la ubicación'); return; }
      b.disabled = true;
      b.textContent = 'Buscando ubicación…';
      try {
        const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }));
        coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        msg.hidden = false;
        try {
          const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=es&lat=${coords.lat}&lon=${coords.lng}`);
          if (!r.ok) throw new Error('http');
          const d = await r.json();
          const a = d.address || {};
          const street = [a.road, a.house_number].filter(Boolean).join(' ');
          const city = a.city || a.town || a.village || a.municipality || '';
          const text = [street, city].filter(Boolean).join(', ') || d.display_name || '';
          if (text) $('#saddr').value = text; // asignar por código no dispara "input"
          msg.textContent = text
            ? 'Dirección rellenada con tu ubicación. Revísala antes de guardar.'
            : 'Ubicación guardada, pero no se encontró una dirección.';
        } catch (_) {
          msg.textContent = 'Ubicación guardada. Sin conexión no se pudo sacar la dirección, pero el botón del mapa funcionará.';
        }
      } catch (err) {
        toast(err && err.code === 1 ? 'Permiso de ubicación denegado' : 'No se pudo obtener la ubicación');
      }
      b.disabled = false;
      b.textContent = 'Usar mi ubicación actual';
    };

    $('#ssave').onclick = async () => {
      const name = $('#sname').value.trim();
      if (!name) { toast('Escribe un nombre para el sitio'); return; }
      const base = { name, address: $('#saddr').value.trim() };
      const obj = isNew ? { id: uid(), ...base, created: Date.now() } : { ...site, ...base };
      if (coords) { obj.lat = coords.lat; obj.lng = coords.lng; } else { delete obj.lat; delete obj.lng; }
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
        for (const v of visits.filter(x => x.siteId === site.id)) await del('visits', v.id);
        await del('sites', site.id);
        entries = entries.filter(e => e.siteId !== site.id);
        visits = visits.filter(v => v.siteId !== site.id);
        sites = sites.filter(x => x.id !== site.id);
        closeSheet();
        location.hash = '#/';
        toast('Sitio eliminado');
      };
    }
  }

  /* ---------- Formulario de entrada ---------- */
  function entrySheet(siteId, entry, presetDate, prefill) {
    const isNew = !entry;
    let photos = entry && entry.photos ? [...entry.photos] : [];
    let date = entry ? entry.date : (presetDate || todayStr());
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
      <textarea id="enote" placeholder="Qué hiciste, qué mediste, qué falta por hacer">${esc(entry ? entry.note || '' : (prefill && prefill.note) || '')}</textarea>
      <span class="lbl">Fotos</span>
      <div class="thumbs" id="thumbs"></div>
      <p class="hint" id="phstatus" hidden></p>
      <div class="btnrow">
        <label class="btn" for="ecam">Tomar foto</label>
        <label class="btn" for="efiles">Desde galería</label>
      </div>
      <input id="ecam" type="file" accept="image/*" capture="environment" hidden>
      <input id="efiles" type="file" accept="image/*" multiple hidden>
      <p class="hint">Toca la etiqueta bajo cada foto para marcarla: antes, durante o después.</p>
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
      $('#thumbs').innerHTML = photos.map((p, i) => `<div class="t"><img src="${photoSrc(p)}" alt="Foto ${i + 1}"><button type="button" class="x" data-i="${i}" aria-label="Quitar foto ${i + 1}">✕</button><button type="button" class="tagbtn t-${TAGS.indexOf(photoTag(p))}" data-i="${i}">${photoTag(p) || 'Sin etiqueta'}</button></div>`).join('');
    };
    $('#thumbs').addEventListener('click', e => {
      const x = e.target.closest('.x');
      if (x) { photos.splice(Number(x.dataset.i), 1); drawThumbs(); return; }
      const tb = e.target.closest('.tagbtn');
      if (tb) {
        const i = Number(tb.dataset.i);
        const next = TAGS[(TAGS.indexOf(photoTag(photos[i])) + 1) % TAGS.length];
        photos[i] = { src: photoSrc(photos[i]), tag: next };
        drawThumbs();
      }
    });
    drawThumbs();

    const addFiles = async e => {
      const files = [...e.target.files];
      e.target.value = '';
      if (!files.length) return;
      const st = $('#phstatus');
      st.textContent = 'Procesando fotos…';
      st.hidden = false;
      let fail = 0;
      for (const f of files) {
        try { photos.push({ src: await compress(f), tag: '' }); } catch (_) { fail++; }
      }
      st.hidden = true;
      drawThumbs();
      if (fail) toast(`No se pudieron leer ${plural(fail, 'foto', 'fotos')}`);
    };
    $('#efiles').addEventListener('change', addFiles);
    $('#ecam').addEventListener('change', addFiles);

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
      let msg = 'Guardado';
      if (isNew && prefill && prefill.after) {
        try { msg = (await prefill.after(date)) || msg; } catch (_) { msg = 'Guardado, pero no se pudo actualizar la agenda'; }
      }
      closeSheet();
      render();
      toast(msg);
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

  /* ---------- Visitas y mantenimientos ---------- */
  const KIND = { visita: 'Visita', mantenimiento: 'Mantenimiento' };
  const visitOrder = (a, b) => (a.date + (a.time || '99:99')).localeCompare(b.date + (b.time || '99:99'));
  const siteVisits = id => visits.filter(v => v.siteId === id).sort(visitOrder);
  const nextDate = (s, v) => addMonths(s, v.every * (v.unit === 'años' ? 12 : 1));
  const repeatLabel = v => (v.every === 1 ? (v.unit === 'años' ? 'cada año' : 'cada mes') : `cada ${v.every} ${v.unit}`);

  function visitRow(v, showSite) {
    const n = daysUntil(v.date);
    const site = sites.find(s => s.id === v.siteId);
    const late = n < 0;
    const when = late ? `Atrasada ${plural(-n, 'día', 'días')}` : n === 0 ? 'Hoy' : n === 1 ? 'Mañana' : dayShort(v.date);
    const first = (v.note || '').split('\n')[0];
    const detail = [showSite ? KIND[v.kind] : '', v.kind === 'mantenimiento' ? repeatLabel(v) : '', first].filter(Boolean).join(' · ');
    return `<button type="button" class="visit${late ? ' late' : ''}" data-v="${esc(v.id)}">
      <span class="vwhen">${esc(when)}${v.time ? ` · ${esc(v.time)}` : ''}</span>
      <strong>${esc(showSite && site ? site.name : KIND[v.kind])}</strong>
      ${detail ? `<span class="meta">${esc(detail)}</span>` : ''}
    </button>`;
  }

  function bindVisits(root) {
    root.querySelectorAll('.visit').forEach(b => { b.onclick = () => visitSheet(b.dataset.v); });
  }

  function siteAgendaHTML(id) {
    const list = siteVisits(id);
    if (!list.length) return '';
    return `<section class="agenda"><h3>Agendado</h3>${list.map(v => visitRow(v, false)).join('')}</section>`;
  }

  function agendaGroups(list) {
    const groups = [['Atrasadas', []], ['Hoy', []], ['Próximos 7 días', []], ['Resto del mes', []], ['Más adelante', []]];
    const month = todayStr().slice(0, 7);
    [...list].sort(visitOrder).forEach(v => {
      const n = daysUntil(v.date);
      const g = n < 0 ? 0 : n === 0 ? 1 : n <= 7 ? 2 : v.date.slice(0, 7) === month ? 3 : 4;
      groups[g][1].push(v);
    });
    return groups.filter(g => g[1].length);
  }

  function drawAgenda() {
    const box = $('#agenda');
    if (!box) return;
    const known = new Set(sites.map(s => s.id));
    const groups = agendaGroups(visits.filter(v => known.has(v.siteId)));
    if (!groups.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<section class="agenda"><h2>Agenda</h2>${groups.map(([title, list]) => {
      const shown = title === 'Más adelante' ? list.slice(0, 5) : list;
      const extra = list.length - shown.length;
      return `<h3 class="${title === 'Atrasadas' ? 'late-h' : ''}">${title}</h3>${shown.map(v => visitRow(v, true)).join('')}${extra ? `<p class="meta">y ${plural(extra, 'más', 'más')} dentro de cada sitio</p>` : ''}`;
    }).join('')}</section>`;
    bindVisits(box);
  }

  function visitSheet(id) {
    const v = visits.find(x => x.id === id);
    if (!v) return;
    const site = sites.find(s => s.id === v.siteId);
    const n = daysUntil(v.date);
    const left = n < 0 ? `Atrasada ${plural(-n, 'día', 'días')}` : n === 0 ? 'Es hoy' : `Faltan ${plural(n, 'día', 'días')}`;
    openSheet(`
      <h2>${KIND[v.kind]}${site ? ` · ${esc(site.name)}` : ''}</h2>
      <p><strong>${longDate(v.date)}</strong>${v.time ? ` · ${esc(v.time)}` : ''}</p>
      <p class="meta${n < 0 ? ' late-txt' : ''}">${left}${v.kind === 'mantenimiento' ? ` · se repite ${repeatLabel(v)}` : ''}</p>
      ${v.note ? `<div class="note">${esc(v.note)}</div>` : ''}
      <div class="actions">
        <button type="button" class="btn primary block" id="vdone">Marcar como hecha</button>
        ${site ? `<a class="btn block" href="#s/${esc(site.id)}" data-close>Ir al sitio</a>` : ''}
        <button type="button" class="btn block" id="vedit">Editar</button>
        <button type="button" class="btn danger block" id="vdel">Eliminar</button>
        <button type="button" class="btn ghost block" data-close>Cerrar</button>
      </div>`);

    // "Hecha" abre una entrada del historial con la nota ya puesta; al guardarla se cierra la visita
    // o, si es un mantenimiento, se programa el siguiente contando desde el día elegido.
    $('#vdone').onclick = () => entrySheet(v.siteId, null, todayStr(), {
      note: `${KIND[v.kind]}${v.note ? `: ${v.note}` : ''}`,
      after: async doneDate => {
        if (v.kind === 'mantenimiento') {
          const nv = { ...v, date: nextDate(doneDate, v) };
          await put('visits', nv);
          visits[visits.findIndex(x => x.id === v.id)] = nv;
          return `Guardado. Próximo mantenimiento: ${shortDate(nv.date)}`;
        }
        await del('visits', v.id);
        visits = visits.filter(x => x.id !== v.id);
        return 'Guardado. La visita pasó al historial';
      }
    });
    $('#vedit').onclick = () => visitForm(v.siteId, v);
    const b = $('#vdel');
    b.onclick = async () => {
      if (!b.classList.contains('armed')) {
        b.classList.add('armed');
        b.textContent = 'Toca otra vez para confirmar';
        return;
      }
      await del('visits', v.id);
      visits = visits.filter(x => x.id !== v.id);
      closeSheet();
      render();
      toast('Eliminada de la agenda');
    };
  }

  function visitForm(siteId, visit) {
    const isNew = !visit;
    let kind = visit ? visit.kind : 'visita';
    let date = visit ? visit.date : addDays(todayStr(), 1);
    openSheet(`
      <h2>${isNew ? 'Agendar' : 'Editar agenda'}</h2>
      <span class="lbl">Tipo</span>
      <div class="chips" id="vkind">
        <button type="button" data-k="visita">Visita</button>
        <button type="button" data-k="mantenimiento">Mantenimiento</button>
      </div>
      <span class="lbl">Fecha</span>
      <div class="chips" id="vchips">
        <button type="button" data-d="0">Hoy</button>
        <button type="button" data-d="1">Mañana</button>
        <button type="button" data-d="7">En 1 semana</button>
        <input type="date" id="vdate" aria-label="Elegir fecha" value="${date}">
      </div>
      <label class="lbl" for="vtime">Hora (opcional)</label>
      <input class="field" id="vtime" type="time" value="${esc(visit ? visit.time || '' : '')}">
      <label class="lbl" for="vnote">Qué hay que hacer</label>
      <textarea id="vnote" placeholder="Ej. Revisar el cuadro y apretar bornes">${esc(visit ? visit.note || '' : '')}</textarea>
      <div id="vrep" hidden>
        <span class="lbl">Se repite cada</span>
        <div class="chips">
          <input class="field short" id="vevery" type="number" min="1" max="60" inputmode="numeric" value="${visit && visit.every ? visit.every : 6}" aria-label="Cada cuánto">
          <select class="field short" id="vunit" aria-label="Unidad">
            <option value="meses">meses</option>
            <option value="años">años</option>
          </select>
        </div>
        <p class="hint">El siguiente se cuenta desde el día en que marques el mantenimiento como hecho.</p>
      </div>
      <div class="actions">
        <button type="button" class="btn primary block" id="vsave">Guardar</button>
        <button type="button" class="btn ghost block" data-close>Cancelar</button>
      </div>`);
    $('#vunit').value = visit && visit.unit ? visit.unit : 'meses';

    const sync = () => {
      $('#vkind').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.k === kind));
      $('#vrep').hidden = kind !== 'mantenimiento';
      const t = todayStr();
      $('#vchips').querySelectorAll('button').forEach(b => b.classList.toggle('on', addDays(t, Number(b.dataset.d)) === date));
      $('#vdate').value = date;
    };
    $('#vkind').addEventListener('click', e => { const b = e.target.closest('button[data-k]'); if (b) { kind = b.dataset.k; sync(); } });
    $('#vchips').addEventListener('click', e => { const b = e.target.closest('button[data-d]'); if (b) { date = addDays(todayStr(), Number(b.dataset.d)); sync(); } });
    $('#vdate').addEventListener('change', e => { if (e.target.value) { date = e.target.value; sync(); } });
    sync();

    $('#vsave').onclick = async () => {
      const every = parseInt($('#vevery').value, 10);
      if (kind === 'mantenimiento' && !(every >= 1)) { toast('Indica cada cuánto se repite'); return; }
      const obj = { ...(visit || { id: uid(), siteId, created: Date.now() }), kind, date, time: $('#vtime').value, note: $('#vnote').value.trim() };
      if (kind === 'mantenimiento') { obj.every = every; obj.unit = $('#vunit').value; } else { delete obj.every; delete obj.unit; }
      await put('visits', obj);
      if (isNew) visits.push(obj); else visits[visits.findIndex(x => x.id === obj.id)] = obj;
      closeSheet();
      render();
      toast('Agendado');
    };
  }

  /* ---------- Copia de seguridad ---------- */
  function backupSheet() {
    const photoCount = entries.reduce((n, e) => n + (e.photos ? e.photos.length : 0), 0);
    const bytes = entries.reduce((n, e) => n + (e.photos || []).reduce((m, p) => m + photoSrc(p).length * 0.75, 0), 0);
    openSheet(`
      <h2>Copia de seguridad</h2>
      <div class="stats">
        <span><b>${sites.length}</b> sitios</span>
        <span><b>${entries.length}</b> entradas</span>
        <span><b>${visits.length}</b> en agenda</span>
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
    const data = { app: 'obrario', version: 2, exported: new Date().toISOString(), sites, entries, visits };
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
      const vs = Array.isArray(data.visits) ? data.visits : [];
      for (const v of vs) await put('visits', v);
      sites = await getAll('sites');
      entries = await getAll('entries');
      visits = await getAll('visits');
      closeSheet();
      render();
      toast(`Importado: ${plural(data.sites.length, 'sitio', 'sitios')}, ${plural(data.entries.length, 'entrada', 'entradas')} y ${plural(vs.length, 'cita', 'citas')} de agenda`);
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
      db.onversionchange = () => db.close();
      sites = await getAll('sites');
      entries = await getAll('entries');
      visits = await getAll('visits');
    } catch (_) {
      app.innerHTML = '<div class="empty"><strong>No se pudo abrir el almacenamiento</strong><span>Abre Obrario en una pestaña normal, no en modo privado, y vuelve a intentarlo.</span></div>';
      return;
    }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    route();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  })();
})();
