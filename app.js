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
  let people = [];
  let materials = [];
  const state = { q: '', who: '' };

  const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const openDB = () => new Promise((res, rej) => {
    const r = indexedDB.open('obrario', 4);
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
      if (!d.objectStoreNames.contains('people')) d.createObjectStore('people', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('materials')) d.createObjectStore('materials', { keyPath: 'id' });
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
  const asPhoto = p => (typeof p === 'string' ? { src: p, tag: '' } : p);
  const photoTime = p => (typeof p === 'string' ? 0 : p.t || 0);
  const photoLoc = p => (typeof p === 'string' || !p.loc ? null : p.loc);
  const hhmm = t => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const mapsLink = loc => `https://www.google.com/maps/search/?api=1&query=${loc[0]},${loc[1]}`;
  // Ubicación al sacar la foto: sin permiso o sin señal, simplemente se omite.
  const getPos = () => new Promise(res => {
    if (!navigator.geolocation) return res(null);
    const t = setTimeout(() => res(null), 6000);
    navigator.geolocation.getCurrentPosition(
      p => { clearTimeout(t); res([Math.round(p.coords.latitude * 1e5) / 1e5, Math.round(p.coords.longitude * 1e5) / 1e5]); },
      () => { clearTimeout(t); res(null); },
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 60000 });
  });
  const UNITS = ['ud', 'm', 'caja', 'rollo', 'paquete'];
  const fmtMat = m => (m.unit && m.unit !== 'ud' ? `${m.qty} ${esc(m.unit)} de ${esc(m.name)}` : `${m.qty} × ${esc(m.name)}`);
  const matLine = e => (e.materials || []).map(fmtMat).join(' · ');
  const norm = t => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const unitOpts = sel => UNITS.map(u => `<option value="${u}"${u === (sel || 'ud') ? ' selected' : ''}>${u === 'ud' ? 'unidades' : u === 'm' ? 'metros' : u === 'caja' ? 'cajas' : u === 'rollo' ? 'rollos' : 'paquetes'}</option>`).join('');
  /* Catálogo base de material eléctrico: se carga con un botón y no pisa lo que ya tengas */
  const STARTER = [
    ['Abrazaderas de plástico 20 mm', 'paquete'],
    ['Abrazaderas de plástico 25 mm', 'paquete'],
    ['Abrazaderas metálicas 20 mm', 'paquete'],
    ['Abrepuertas eléctrico', 'ud'],
    ['Aplique de pared exterior', 'ud'],
    ['Arandelas', 'paquete'],
    ['Armario rack mural', 'ud'],
    ['Arqueta de tierra', 'ud'],
    ['Bandeja perforada 100 mm', 'm'],
    ['Bandeja rejilla 100 mm', 'm'],
    ['Bandeja rejilla 200 mm', 'm'],
    ['Base TV', 'ud'],
    ['Base de enchufe doble', 'ud'],
    ['Base de enchufe para vehículo eléctrico', 'ud'],
    ['Batería de litio solar', 'ud'],
    ['Bombilla LED E14', 'ud'],
    ['Bombilla LED E27', 'ud'],
    ['Bombilla LED GU10', 'ud'],
    ['Bombilla LED GU5.3 12V', 'ud'],
    ['Borna de carril DIN 16 mm²', 'ud'],
    ['Borna de carril DIN 2,5 mm²', 'ud'],
    ['Borna de carril DIN 6 mm²', 'ud'],
    ['Borna de tierra carril DIN', 'ud'],
    ['Bridas 100 mm', 'paquete'],
    ['Bridas 150 mm', 'paquete'],
    ['Bridas 200 mm', 'paquete'],
    ['Bridas 300 mm', 'paquete'],
    ['Bridas 400 mm', 'paquete'],
    ['Bridas de velcro', 'paquete'],
    ['Cable H07V-K 1,5 mm² (flexible unipolar)', 'm'],
    ['Cable H07V-K 10 mm² (flexible unipolar)', 'm'],
    ['Cable H07V-K 16 mm² (flexible unipolar)', 'm'],
    ['Cable H07V-K 16 mm² amarillo-verde (tierra)', 'm'],
    ['Cable H07V-K 2,5 mm² (flexible unipolar)', 'm'],
    ['Cable H07V-K 2,5 mm² amarillo-verde (tierra)', 'm'],
    ['Cable H07V-K 25 mm² (flexible unipolar)', 'm'],
    ['Cable H07V-K 4 mm² (flexible unipolar)', 'm'],
    ['Cable H07V-K 6 mm² (flexible unipolar)', 'm'],
    ['Cable H07V-K 6 mm² amarillo-verde (tierra)', 'm'],
    ['Cable HDMI instalación', 'm'],
    ['Cable UTP Cat6', 'm'],
    ['Cable coaxial TV', 'm'],
    ['Cable de alarma 4x0,22 mm²', 'm'],
    ['Cable de altavoz 2x1,5 mm²', 'm'],
    ['Cable de cobre desnudo 35 mm² (toma de tierra)', 'm'],
    ['Cable de telefonía', 'm'],
    ['Cable solar 4 mm²', 'm'],
    ['Cable solar 6 mm²', 'm'],
    ['Caja ICP', 'ud'],
    ['Caja de derivación IP55 100x100 mm', 'ud'],
    ['Caja de empalme con tapa', 'ud'],
    ['Caja de mecanismo empotrar 2 módulos', 'ud'],
    ['Caja de mecanismo empotrar universal', 'ud'],
    ['Caja de mecanismo superficie', 'ud'],
    ['Caja de protecciones DC', 'ud'],
    ['Caja de registro 100x100 mm', 'ud'],
    ['Caja de registro 160x100 mm', 'ud'],
    ['Caja de registro 200x200 mm estanca', 'ud'],
    ['Caja estanca IP65 superficie', 'ud'],
    ['Calefactor/radiador eléctrico', 'ud'],
    ['Campana LED industrial 100W', 'ud'],
    ['Campana extractora conexión', 'ud'],
    ['Canal de suelo/rodapié', 'm'],
    ['Canaleta PVC 100x60 mm', 'm'],
    ['Canaleta PVC 16x16 mm', 'm'],
    ['Canaleta PVC 20x12 mm', 'm'],
    ['Canaleta PVC 25x30 mm', 'm'],
    ['Canaleta PVC 40x60 mm', 'm'],
    ['Canaleta PVC 60x60 mm', 'm'],
    ['Cargador vehículo eléctrico (wallbox)', 'ud'],
    ['Carril DIN 35 mm (m)', 'ud'],
    ['Casquillo GU10', 'ud'],
    ['Central de alarma', 'ud'],
    ['Cinta aislante de colores', 'rollo'],
    ['Cinta aislante negra', 'rollo'],
    ['Cinta autosoldable', 'rollo'],
    ['Cinta de doble cara', 'rollo'],
    ['Cinta de teflón', 'rollo'],
    ['Cinta señalizadora cable enterrado', 'm'],
    ['Clavija industrial 16A 3P+T', 'ud'],
    ['Clavos con abrazadera 20 mm', 'paquete'],
    ['Codo tubo rígido 20 mm', 'ud'],
    ['Codo tubo rígido 25 mm', 'ud'],
    ['Conector F coaxial', 'ud'],
    ['Conector RJ45 Cat6', 'ud'],
    ['Conectores MC4 macho/hembra (par)', 'paquete'],
    ['Conmutador 10A', 'ud'],
    ['Conmutador de cruce 10A', 'ud'],
    ['Contactor 2P 25A 230V', 'ud'],
    ['Contactor 4P 25A 230V', 'ud'],
    ['Contactor 4P 40A 230V', 'ud'],
    ['Contador/medidor de energía (Shelly/CT)', 'ud'],
    ['Contratuerca M20', 'ud'],
    ['Contratuerca M25', 'ud'],
    ['Cuadro de protecciones AC fotovoltaica', 'ud'],
    ['Cuadro empotrar 12 módulos', 'ud'],
    ['Cuadro empotrar 24 módulos', 'ud'],
    ['Cuadro empotrar 36 módulos', 'ud'],
    ['Cuadro superficie 12 módulos', 'ud'],
    ['Cuadro superficie 24 módulos', 'ud'],
    ['Cuadro superficie IP65 12 módulos', 'ud'],
    ['Detector de gas', 'ud'],
    ['Detector de humo', 'ud'],
    ['Detector de movimiento', 'ud'],
    ['Detector de presencia techo', 'ud'],
    ['Diferencial 2P 25A 30mA tipo A', 'ud'],
    ['Diferencial 2P 40A 30mA tipo A', 'ud'],
    ['Diferencial 2P 40A 30mA tipo AC', 'ud'],
    ['Diferencial 2P 63A 300mA', 'ud'],
    ['Diferencial 2P 63A 30mA tipo A', 'ud'],
    ['Diferencial 4P 25A 30mA tipo A', 'ud'],
    ['Diferencial 4P 40A 300mA tipo A', 'ud'],
    ['Diferencial 4P 40A 30mA tipo A', 'ud'],
    ['Diferencial 4P 63A 30mA tipo A', 'ud'],
    ['Downlight LED empotrable 12W', 'ud'],
    ['Downlight LED empotrable 7W', 'ud'],
    ['Downlight LED empotrable orientable', 'ud'],
    ['Driver LED regulable', 'ud'],
    ['Empalmes a presión', 'paquete'],
    ['Enchufe 25A (cocina/horno)', 'ud'],
    ['Enchufe industrial 16A 3P+T', 'ud'],
    ['Enchufe industrial 32A 3P+N+T', 'ud'],
    ['Enchufe schuko 16A', 'ud'],
    ['Enchufe schuko 16A con tapa estanca', 'ud'],
    ['Estructura soporte panel (kit)', 'ud'],
    ['Etiquetas de cable', 'paquete'],
    ['Foco proyector LED exterior 100W', 'ud'],
    ['Foco proyector LED exterior 20W', 'ud'],
    ['Foco proyector LED exterior 50W', 'ud'],
    ['Fuente de alimentación 12V DC', 'ud'],
    ['Fusible NH', 'ud'],
    ['Fusible cilíndrico 10x38 mm', 'ud'],
    ['Grapa de pica', 'ud'],
    ['Grapas cable 6 mm', 'paquete'],
    ['Guía pasacables fibra', 'rollo'],
    ['Guía/pasacables de acero', 'ud'],
    ['Hilo guía (pasacables)', 'rollo'],
    ['Interruptor 10A', 'ud'],
    ['Interruptor automático/diferencial 1P+N 16A 30mA (monobloque)', 'ud'],
    ['Interruptor crepuscular', 'ud'],
    ['Interruptor general de corte 2P 40A', 'ud'],
    ['Interruptor general de corte 2P 63A', 'ud'],
    ['Interruptor general de corte 4P 63A', 'ud'],
    ['Interruptor horario', 'ud'],
    ['Interruptor horario DIN', 'ud'],
    ['Interruptor seccionador DC 1000V', 'ud'],
    ['Inversor híbrido', 'ud'],
    ['Inversor monofásico fotovoltaico', 'ud'],
    ['Limitador de potencia ICP 1P+N', 'ud'],
    ['Luminaria de emergencia 200 lm', 'ud'],
    ['Luminaria de emergencia 300 lm', 'ud'],
    ['Luz de emergencia LED empotrable', 'ud'],
    ['Magnetotérmico 1P+N 10A curva C', 'ud'],
    ['Magnetotérmico 1P+N 16A curva C', 'ud'],
    ['Magnetotérmico 1P+N 20A curva C', 'ud'],
    ['Magnetotérmico 1P+N 25A curva C', 'ud'],
    ['Magnetotérmico 1P+N 32A curva C', 'ud'],
    ['Magnetotérmico 1P+N 40A curva C', 'ud'],
    ['Magnetotérmico 1P+N 50A curva C', 'ud'],
    ['Magnetotérmico 1P+N 63A curva C', 'ud'],
    ['Magnetotérmico 1P+N 6A curva C', 'ud'],
    ['Magnetotérmico 2P 16A curva C', 'ud'],
    ['Magnetotérmico 2P 25A curva C', 'ud'],
    ['Magnetotérmico 2P 32A curva C', 'ud'],
    ['Magnetotérmico 2P 40A curva C', 'ud'],
    ['Magnetotérmico 2P 50A curva C', 'ud'],
    ['Magnetotérmico 2P 63A curva C', 'ud'],
    ['Magnetotérmico 3P 16A curva C', 'ud'],
    ['Magnetotérmico 3P 25A curva C', 'ud'],
    ['Magnetotérmico 3P 32A curva C', 'ud'],
    ['Magnetotérmico 3P 40A curva C', 'ud'],
    ['Magnetotérmico 3P 50A curva C', 'ud'],
    ['Magnetotérmico 3P 63A curva C', 'ud'],
    ['Magnetotérmico 4P 16A curva C', 'ud'],
    ['Magnetotérmico 4P 25A curva C', 'ud'],
    ['Magnetotérmico 4P 32A curva C', 'ud'],
    ['Magnetotérmico 4P 40A curva C', 'ud'],
    ['Magnetotérmico 4P 50A curva C', 'ud'],
    ['Magnetotérmico 4P 63A curva C', 'ud'],
    ['Manguera H05VV-F 2x0,75 mm²', 'm'],
    ['Manguera H05VV-F 3G1,5 mm²', 'm'],
    ['Manguera H05VV-F 3G2,5 mm²', 'm'],
    ['Manguera H07RN-F 3G2,5 mm² (goma)', 'm'],
    ['Manguera RZ1-K (AS) 2x1,5 mm²', 'm'],
    ['Manguera RZ1-K (AS) 3G1,5 mm²', 'm'],
    ['Manguera RZ1-K (AS) 3G10 mm²', 'm'],
    ['Manguera RZ1-K (AS) 3G2,5 mm²', 'm'],
    ['Manguera RZ1-K (AS) 3G4 mm²', 'm'],
    ['Manguera RZ1-K (AS) 3G6 mm²', 'm'],
    ['Manguera RZ1-K (AS) 4G10 mm²', 'm'],
    ['Manguera RZ1-K (AS) 4G6 mm²', 'm'],
    ['Manguera RZ1-K (AS) 5G10 mm²', 'm'],
    ['Manguera RZ1-K (AS) 5G16 mm²', 'm'],
    ['Manguera RZ1-K (AS) 5G2,5 mm²', 'm'],
    ['Manguera RZ1-K (AS) 5G4 mm²', 'm'],
    ['Manguera RZ1-K (AS) 5G6 mm²', 'm'],
    ['Manguito unión tubo 20 mm', 'ud'],
    ['Manguito unión tubo 25 mm', 'ud'],
    ['Marco 1 elemento', 'ud'],
    ['Marco 2 elementos', 'ud'],
    ['Marco 3 elementos', 'ud'],
    ['Marco 4 elementos', 'ud'],
    ['Masilla cortafuegos', 'paquete'],
    ['Panel LED 60x60 cm 40W', 'ud'],
    ['Panel LED cuadrado 18W', 'ud'],
    ['Panel LED redondo 18W', 'ud'],
    ['Panel de parcheo 12 puertos', 'ud'],
    ['Panel solar fotovoltaico 450W', 'ud'],
    ['Panel solar fotovoltaico 550W', 'ud'],
    ['Peine monofásico', 'ud'],
    ['Peine trifásico', 'ud'],
    ['Perfil de aluminio para tira LED', 'm'],
    ['Persiana interruptor', 'ud'],
    ['Pica de tierra 1,5 m', 'ud'],
    ['Piloto luminoso cuadro', 'ud'],
    ['Pinza amperimétrica para inversor', 'ud'],
    ['Placa de cocina conexión', 'ud'],
    ['Plafón LED superficie 18W', 'ud'],
    ['Pletina conductora tierra', 'm'],
    ['Portafusibles seccionable 10x38', 'ud'],
    ['Portalámparas E14', 'ud'],
    ['Portalámparas E27', 'ud'],
    ['Portero automático (kit)', 'ud'],
    ['Prensaestopas M16', 'ud'],
    ['Prensaestopas M20', 'ud'],
    ['Prensaestopas M25', 'ud'],
    ['Prensaestopas M32', 'ud'],
    ['Protector sobretensiones DC', 'ud'],
    ['Protector sobretensiones permanentes (rearme)', 'ud'],
    ['Protector sobretensiones transitorias 1P+N tipo 2', 'ud'],
    ['Protector sobretensiones transitorias 3P+N tipo 2', 'ud'],
    ['Puente de comprobación tierra', 'ud'],
    ['Pulsador 10A', 'ud'],
    ['Pulsador con símbolo luz', 'ud'],
    ['Pulsador con símbolo timbre', 'ud'],
    ['Racor tubo-caja 20 mm', 'ud'],
    ['Racor tubo-caja 25 mm', 'ud'],
    ['Regleta LED estanca 120 cm', 'ud'],
    ['Regleta LED estanca 150 cm', 'ud'],
    ['Regleta de conexión palanca 2 vías (tipo Wago)', 'ud'],
    ['Regleta de conexión palanca 3 vías (tipo Wago)', 'ud'],
    ['Regleta de conexión palanca 5 vías (tipo Wago)', 'ud'],
    ['Regleta de conexión palanca 8 vías (tipo Wago)', 'ud'],
    ['Regleta de conexión rápida 2 vías', 'ud'],
    ['Regleta de conexión rápida 3 vías', 'ud'],
    ['Regleta de conexión rápida 5 vías', 'ud'],
    ['Regleta de enchufes rack', 'ud'],
    ['Regleta de tierra/neutro cuadro', 'ud'],
    ['Regulador de luz (dimmer)', 'ud'],
    ['Relé auxiliar', 'ud'],
    ['Repartidor TV 3 salidas', 'ud'],
    ['Rosetas de teléfono', 'ud'],
    ['Seccionador fusible DC (fotovoltaica)', 'ud'],
    ['Sellador/silicona', 'paquete'],
    ['Sensor crepuscular', 'ud'],
    ['Sensor magnético de puerta/ventana', 'ud'],
    ['Sirena exterior', 'ud'],
    ['Tacos plástico 6 mm', 'paquete'],
    ['Tacos plástico 8 mm', 'paquete'],
    ['Tapa ciega', 'ud'],
    ['Tapa ciega cuadro 1 módulo', 'ud'],
    ['Telerruptor 16A', 'ud'],
    ['Terminales de horquilla 2,5 mm²', 'paquete'],
    ['Terminales de ojal 2,5 mm²', 'paquete'],
    ['Terminales de ojal 6 mm²', 'paquete'],
    ['Terminales punteras 1,5 mm²', 'paquete'],
    ['Terminales punteras 10 mm²', 'paquete'],
    ['Terminales punteras 16 mm²', 'paquete'],
    ['Terminales punteras 2,5 mm²', 'paquete'],
    ['Terminales punteras 4 mm²', 'paquete'],
    ['Terminales punteras 6 mm²', 'paquete'],
    ['Termo eléctrico 50 L', 'ud'],
    ['Termo eléctrico 80 L', 'ud'],
    ['Timbre', 'ud'],
    ['Tira LED 12V', 'm'],
    ['Tira LED 24V', 'm'],
    ['Toma RJ45 Cat6', 'ud'],
    ['Toma USB cargador', 'ud'],
    ['Toma de suelo', 'ud'],
    ['Toma de tierra / electrodo', 'ud'],
    ['Toma teléfono', 'ud'],
    ['Tornillos 4,5x50 mm', 'paquete'],
    ['Tornillos 4x40 mm', 'paquete'],
    ['Tornillos para madera 3,5x30 mm', 'paquete'],
    ['Transformador LED 12V 60W', 'ud'],
    ['Transformador LED 24V 100W', 'ud'],
    ['Transformador de timbre 12V', 'ud'],
    ['Tubo LED T8 120 cm', 'ud'],
    ['Tubo LED T8 150 cm', 'ud'],
    ['Tubo corrugado doble pared 110 mm', 'm'],
    ['Tubo corrugado doble pared 50 mm', 'm'],
    ['Tubo corrugado doble pared 63 mm', 'm'],
    ['Tubo corrugado doble pared 90 mm', 'm'],
    ['Tubo corrugado 16 mm', 'm'],
    ['Tubo corrugado 20 mm', 'm'],
    ['Tubo corrugado 25 mm', 'm'],
    ['Tubo corrugado 32 mm', 'm'],
    ['Tubo corrugado 40 mm', 'm'],
    ['Tubo corrugado 50 mm', 'm'],
    ['Tubo corrugado 63 mm', 'm'],
    ['Tubo flexible reforzado 20 mm', 'm'],
    ['Tubo flexible reforzado 25 mm', 'm'],
    ['Tubo flexible reforzado 32 mm', 'm'],
    ['Tubo rígido PVC 16 mm', 'm'],
    ['Tubo rígido PVC 20 mm', 'm'],
    ['Tubo rígido PVC 25 mm', 'm'],
    ['Tubo rígido PVC 32 mm', 'm'],
    ['Tubo rígido PVC 40 mm', 'm'],
    ['Tubo termorretráctil surtido', 'paquete'],
    ['Varilla roscada M8', 'm'],
    ['Ventilador de baño extractor', 'ud'],
    ['Videoportero (kit)', 'ud'],
    ['Zumbador/timbre', 'ud']
  ];
  const sortedMats = () => [...materials].sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
  const findMat = name => materials.find(m => norm(m.name) === norm(name));
  const tracked = m => typeof m.stock === 'number';
  const fmtQty = n => String(Math.round(n * 100) / 100).replace('.', ',');
  const stockLabel = m => (tracked(m) ? `${fmtQty(m.stock)} ${m.unit === 'ud' ? 'ud' : m.unit} en stock` : '');
  const isLow = m => tracked(m) && (m.stock < 0 || (typeof m.min === 'number' && m.stock <= m.min));
  // Inventario: al guardar/borrar una entrada se ajusta el stock de los materiales que llevas controlados.
  async function adjustStock(oldMats, newMats) {
    const delta = new Map();
    (oldMats || []).forEach(x => { const k = norm(x.name); delta.set(k, (delta.get(k) || 0) + (Number(x.qty) || 0)); });
    (newMats || []).forEach(x => { const k = norm(x.name); delta.set(k, (delta.get(k) || 0) - (Number(x.qty) || 0)); });
    for (const [k, d] of delta) {
      if (!d) continue;
      const m = materials.find(x => norm(x.name) === k);
      if (!m || !tracked(m)) continue;
      m.stock = Math.round((m.stock + d) * 100) / 100;
      try { await put('materials', m); } catch (_) { /* sin espacio: se queda en memoria */ }
    }
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
      const tg = photoTag(photos[i]);
      const many = photos.length > 1;
      v.innerHTML = `<img src="${photoSrc(photos[i])}" alt="Foto ${i + 1} de ${photos.length}">
        <button type="button" class="vbtn vclose" aria-label="Cerrar">✕</button>
        ${many ? `<button type="button" class="vbtn vprev" aria-label="Anterior">‹</button><button type="button" class="vbtn vnext" aria-label="Siguiente">›</button>` : ''}
        <div class="vcount">${many ? `${i + 1} / ${photos.length}` : ''}${tg ? `${many ? ' · ' : ''}${tg}` : ''}</div>
        ${photoTime(photos[i]) ? `<div class="vinfo">${shortDate(dateStr(new Date(photoTime(photos[i]))))} · ${hhmm(photoTime(photos[i]))}${photoLoc(photos[i]) ? ` · <a href="${mapsLink(photoLoc(photos[i]))}" target="_blank" rel="noopener">📍 Ver dónde</a>` : ''}</div>` : ''}`;
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

  function reportSiteId() {
    const m = location.hash.match(/^#r\/(.+)$/);
    return m && sites.some(s => s.id === m[1]) ? m[1] : null;
  }

  function render() {
    const rid = reportSiteId();
    if (rid) { renderReport(rid); return; }
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
      <div class="home-tools"><button type="button" class="btn small" id="btnPeople">Colaboradores${people.length ? ` · ${people.length}` : ''}</button><button type="button" class="btn small" id="btnMats">Materiales${materials.length ? ` · ${materials.length}` : ''}</button></div>
      <div class="search"><input id="q" type="search" placeholder="Buscar sitio o dirección" value="${esc(state.q)}" aria-label="Buscar sitio"></div>
      <ul class="sites" id="siteList"></ul>`;
    $('#q').addEventListener('input', e => { state.q = e.target.value; drawSites(); });
    drawSites();
    drawAgenda();
    $('#btnPeople').onclick = peopleSheet;
    $('#btnMats').onclick = materialsSheet;
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
        <span class="meta">${plural(n, 'entrada', 'entradas')}${last ? ` · última ${shortDate(last)}` : ''}${(s.todos || []).some(t => !t.done) ? ` · <span class="pend">${plural((s.todos || []).filter(t => !t.done).length, 'pendiente', 'pendientes')}</span>` : ''}</span>
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
        ${(e.materials || []).length ? `<div class="mats">🔧 ${matLine(e)}</div>` : ''}
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
          ${es.length ? `<a class="btn small" href="#r/${esc(id)}">Informe PDF</a>` : ''}
          ${days.length ? `<button type="button" class="btn small" id="toggleView">${view === 'fechas' ? 'Ver detallado' : 'Ver por fechas'}</button>` : ''}
        </div>
      </div>
      ${todosHTML(s)}
      ${siteAgendaHTML(id)}
      ${body}`;

    $('#editSite').onclick = () => siteSheet(s);
    const tv = $('#toggleView');
    if (tv) tv.onclick = () => { setView(view === 'fechas' ? 'detalle' : 'fechas'); render(); };
    app.querySelectorAll('.daytab').forEach(b => { b.onclick = () => daySheet(id, b.dataset.d); });
    $('#addVisit').onclick = () => visitForm(id);
    bindVisits(app);
    bindTodos(s);
    bindEntries(app, id);
    setDock('+ Nueva entrada', () => entrySheet(id));
  }

  /* ---------- Colaboradores ---------- */
  // Personas a las que asignas pendientes y visitas. Solo para tu control: no usan la app.
  const personName = id => { const p = people.find(x => x.id === id); return p ? p.name : ''; };
  const sortedPeople = () => [...people].sort((a, b) => a.name.localeCompare(b.name, 'es'));
  const peopleOptions = sel => `<option value="">Sin asignar</option>${sortedPeople().map(p => `<option value="${esc(p.id)}"${p.id === sel ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}`;

  function assignedItems(pid) {
    const items = [];
    sites.forEach(s => (s.todos || []).forEach(t => {
      if (!t.done && t.assignee === pid) items.push({ kind: 'pendiente', site: s, text: t.text });
    }));
    visits.forEach(v => {
      const s = sites.find(x => x.id === v.siteId);
      if (s && v.assignee === pid) items.push({ kind: KIND[v.kind].toLowerCase(), site: s, text: v.note || KIND[v.kind], date: v.date });
    });
    return items;
  }

  function materialsSheet() {
    openSheet(`
      <h2>Banco de materiales</h2>
      <input class="field" id="mbq" type="search" placeholder="Buscar material" aria-label="Buscar material" autocomplete="off">
      <div class="chips" id="mbf">
        <button type="button" data-f="all" class="on">Todos</button>
        <button type="button" data-f="stock">Con stock</button>
        <button type="button" data-f="low">Por comprar</button>
      </div>
      <div id="mblist"></div>
      <div class="actions">
        <button type="button" class="btn primary block" id="mbadd">+ Añadir material</button>
        <button type="button" class="btn block" id="mbstart">Cargar materiales básicos de electricidad</button>
        <button type="button" class="btn ghost block" data-close>Cerrar</button>
      </div>
      <p class="hint">Aquí guardas tu catálogo. Al anotar material en una entrada, escribes unas letras, eliges de la lista y pones solo la cantidad.</p>`);
    let filt = 'all';
    const lowCount = materials.filter(isLow).length;
    $('#mbf [data-f=low]').textContent = lowCount ? `Por comprar · ${lowCount}` : 'Por comprar';
    const draw = () => {
      const q = norm($('#mbq').value);
      const list = sortedMats().filter(m => (!q || norm(m.name).includes(q)) && (filt === 'all' || (filt === 'stock' && tracked(m)) || (filt === 'low' && isLow(m))));
      $('#mblist').innerHTML = list.length ? list.map(m => `<button type="button" class="person" data-id="${esc(m.id)}"><strong>${esc(m.name)}</strong><span class="meta${isLow(m) ? ' low' : ''}">${tracked(m) ? `${isLow(m) ? '⚠ ' : ''}${esc(stockLabel(m))}` : (m.unit === 'ud' ? 'Por unidades' : m.unit === 'm' ? 'Por metros' : `Por ${esc(m.unit)}`)}</span></button>`).join('')
        : `<div class="empty"><strong>${filt === 'low' ? 'Nada por comprar' : filt === 'stock' ? 'Sin inventario aún' : materials.length ? 'Nada coincide' : 'Aún no hay materiales'}</strong><span>${filt === 'low' ? 'Aquí salen los materiales con stock en el mínimo o por debajo.' : filt === 'stock' ? 'Entra en un material y pon cuánto tienes para controlarlo.' : materials.length ? 'Prueba con otra palabra o añádelo.' : 'Añade tubos, cables, bridas… con su unidad. También se guardan solos al usarlos en una entrada.'}</span></div>`;
    };
    $('#mbf').addEventListener('click', ev => {
      const b = ev.target.closest('button[data-f]');
      if (!b) return;
      filt = b.dataset.f;
      $('#mbf').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      draw();
    });
    draw();
    $('#mbq').addEventListener('input', draw);
    $('#mblist').addEventListener('click', ev => { const b = ev.target.closest('.person'); if (b) materialSheet(b.dataset.id); });
    $('#mbadd').onclick = () => materialSheet(null, $('#mbq').value.trim());
    $('#mbstart').onclick = async () => {
      const fresh = STARTER.filter(([n]) => !findMat(n));
      if (!fresh.length) { toast('Ya tienes todos los materiales básicos'); return; }
      const b = $('#mbstart');
      if (!b.classList.contains('armed')) {
        b.classList.add('armed');
        b.textContent = `Toca otra vez para añadir ${fresh.length} materiales`;
        return;
      }
      b.disabled = true;
      let n = 0;
      for (const [name, unit] of fresh) {
        const m = { id: uid(), name, unit, created: Date.now() };
        try { await put('materials', m); materials.push(m); n++; } catch (_) { break; }
      }
      render();
      materialsSheet();
      toast(`Añadidos ${n} materiales`);
    };
  }

  function materialSheet(mid, preset) {
    const m = mid ? materials.find(x => x.id === mid) : null;
    openSheet(`
      <h2>${m ? 'Material' : 'Nuevo material'}</h2>
      <label class="lbl" for="mn">Nombre</label>
      <input class="field" id="mn" type="text" placeholder="Ej. Tubo corrugado 20 mm" value="${esc(m ? m.name : preset || '')}" autocomplete="off">
      <label class="lbl" for="mu">Se cuenta por</label>
      <select class="field" id="mu">${unitOpts(m ? m.unit : 'ud')}</select>
      <span class="lbl">Inventario (opcional)</span>
      <div class="stockrow">
        <label>Tengo<input class="field" id="mstock" type="number" inputmode="decimal" step="any" placeholder="Sin control" value="${m && tracked(m) ? m.stock : ''}"></label>
        <label>Avisar si baja de<input class="field" id="mmin" type="number" inputmode="decimal" min="0" step="any" placeholder="—" value="${m && typeof m.min === 'number' ? m.min : ''}"></label>
        <label>Sumar compra<input class="field" id="mbuy" type="number" inputmode="decimal" min="0" step="any" placeholder="0"></label>
      </div>
      <p class="hint">Si pones cuánto tienes, se resta solo al usar el material en una entrada. Déjalo vacío si no quieres controlarlo.</p>
      <div class="actions">
        <button type="button" class="btn primary block" id="mnsave">Guardar</button>
        <button type="button" class="btn ghost block" id="mnback">Volver a la lista</button>
        ${m ? '<button type="button" class="btn danger block" id="mndel">Eliminar del banco</button>' : ''}
      </div>
      ${m ? '<p class="hint">Cambiar o borrar un material no modifica las entradas ya guardadas.</p>' : ''}`);
    if (!m) $('#mn').focus();
    $('#mnback').onclick = materialsSheet;
    $('#mnsave').onclick = async () => {
      const name = $('#mn').value.trim();
      if (!name) { toast('Escribe el nombre'); return; }
      const dup = findMat(name);
      if (dup && (!m || dup.id !== m.id)) { toast('Ese material ya está en el banco'); return; }
      const num = id => { const v = $(id).value.trim().replace(',', '.'); return v === '' || isNaN(Number(v)) ? null : Number(v); };
      const buy = num('#mbuy');
      let stock = num('#mstock');
      if (buy) stock = (stock || 0) + buy;
      const min = num('#mmin');
      const obj = { ...(m || { id: uid(), created: Date.now() }), name, unit: $('#mu').value };
      if (stock === null) delete obj.stock; else obj.stock = Math.round(stock * 100) / 100;
      if (min === null) delete obj.min; else obj.min = min;
      await put('materials', obj);
      if (m) materials[materials.findIndex(x => x.id === obj.id)] = obj; else materials.push(obj);
      render();
      materialsSheet();
      toast('Guardado');
    };
    if (m) {
      const d = $('#mndel');
      d.onclick = async () => {
        if (!d.classList.contains('armed')) { d.classList.add('armed'); d.textContent = 'Toca otra vez para confirmar'; return; }
        await del('materials', m.id);
        materials = materials.filter(x => x.id !== m.id);
        render();
        materialsSheet();
        toast('Eliminado');
      };
    }
  }

  function peopleSheet() {
    const list = sortedPeople();
    openSheet(`
      <h2>Colaboradores</h2>
      ${list.length ? list.map(p => {
        const n = assignedItems(p.id).length;
        return `<button type="button" class="person" data-p="${esc(p.id)}"><strong>${esc(p.name)}</strong><span class="meta">${esc([p.note, n ? plural(n, 'tarea asignada', 'tareas asignadas') : ''].filter(Boolean).join(' · ') || 'Sin tareas asignadas')}</span></button>`;
      }).join('') : '<div class="empty"><strong>Aún no hay colaboradores</strong><span>Añade a las personas con las que trabajas para poder asignarles pendientes y visitas.</span></div>'}
      <div class="actions">
        <button type="button" class="btn primary block" id="padd">+ Añadir colaborador</button>
        <button type="button" class="btn ghost block" data-close>Cerrar</button>
      </div>`);
    $('#sheet').querySelectorAll('.person').forEach(b => { b.onclick = () => personSheet(b.dataset.p); });
    $('#padd').onclick = () => personSheet();
  }

  function personSheet(pid) {
    const p = pid ? people.find(x => x.id === pid) : null;
    const items = p ? assignedItems(p.id) : [];
    const tel = p && p.phone ? p.phone.replace(/[^+\d]/g, '') : '';
    openSheet(`
      <h2>${p ? 'Colaborador' : 'Nuevo colaborador'}</h2>
      <label class="lbl" for="pname">Nombre</label>
      <input class="field" id="pname" type="text" value="${esc(p ? p.name : '')}" autocomplete="off">
      <label class="lbl" for="pphone">Teléfono (opcional)</label>
      <input class="field" id="pphone" type="tel" inputmode="tel" value="${esc(p ? p.phone || '' : '')}" autocomplete="off">
      <label class="lbl" for="pnote">Nota (opcional)</label>
      <input class="field" id="pnote" type="text" placeholder="Ej. ayudante, fontanería" value="${esc(p ? p.note || '' : '')}" autocomplete="off">
      ${tel ? `<a class="btn block" href="tel:${esc(tel)}">Llamar</a>` : ''}
      ${p ? (items.length
        ? `<span class="lbl">Tiene asignado</span>${items.map(i => `<a class="assigned" href="#s/${esc(i.site.id)}" data-close><strong>${esc(i.site.name)}</strong><span class="meta">${esc(i.kind)}${i.date ? ` · ${esc(shortDate(i.date))}` : ''} · ${esc(i.text.split('\n')[0])}</span></a>`).join('')}`
        : '<p class="hint">No tiene nada asignado ahora.</p>') : ''}
      <div class="actions">
        <button type="button" class="btn primary block" id="psave">Guardar</button>
        <button type="button" class="btn ghost block" id="pback">Volver a la lista</button>
        ${p ? '<button type="button" class="btn danger block" id="pdel">Eliminar colaborador</button>' : ''}
      </div>`);
    if (!p) $('#pname').focus();
    $('#pback').onclick = peopleSheet;
    $('#psave').onclick = async () => {
      const name = $('#pname').value.trim();
      if (!name) { toast('Escribe un nombre'); return; }
      const obj = { ...(p || { id: uid(), created: Date.now() }), name, phone: $('#pphone').value.trim(), note: $('#pnote').value.trim() };
      await put('people', obj);
      if (p) people[people.findIndex(x => x.id === obj.id)] = obj; else people.push(obj);
      render();
      peopleSheet();
      toast('Guardado');
    };
    if (p) {
      const d = $('#pdel');
      d.onclick = async () => {
        if (!d.classList.contains('armed')) {
          d.classList.add('armed');
          d.textContent = items.length ? `Toca otra vez: sus ${plural(items.length, 'tarea quedará', 'tareas quedarán')} sin asignar` : 'Toca otra vez para confirmar';
          return;
        }
        for (const s of sites) {
          if ((s.todos || []).some(t => t.assignee === p.id)) {
            s.todos.forEach(t => { if (t.assignee === p.id) delete t.assignee; });
            await put('sites', s);
          }
        }
        for (const v of visits) {
          if (v.assignee === p.id) { delete v.assignee; await put('visits', v); }
        }
        await del('people', p.id);
        people = people.filter(x => x.id !== p.id);
        render();
        peopleSheet();
        toast('Colaborador eliminado');
      };
    }
  }

  /* ---------- Pendientes ---------- */
  // Se guardan dentro del propio sitio (site.todos), así viajan en la copia de seguridad sin cambiar la base de datos.
  const todoRow = x => `
    <div class="todo${x.done ? ' done' : ''}">
      <button type="button" class="tick" data-t="${esc(x.id)}" role="checkbox" aria-checked="${!!x.done}" aria-label="${x.done ? 'Volver a pendiente' : 'Marcar como hecho'}">${x.done ? '✓' : ''}</button>
      <button type="button" class="ttext" data-te="${esc(x.id)}">${esc(x.text)}${x.assignee && personName(x.assignee) ? `<span class="who">${esc(personName(x.assignee))}</span>` : ''}</button>
    </div>`;

  function todosHTML(s) {
    const all = s.todos || [];
    const open = all.filter(x => !x.done);
    const done = all.filter(x => x.done);
    return `
      <section class="todos">
        <h3>Pendientes${open.length ? ` · ${open.length}` : ''}</h3>
        <form class="todo-add${people.length ? ' with-who' : ''}" id="todoForm">
          <input class="field" id="todoText" type="text" placeholder="Ej. Pedir magnetotérmico de 25 A" autocomplete="off" aria-label="Nuevo pendiente">
          ${people.length ? `<select class="field" id="todoWho" aria-label="Responsable">${peopleOptions(state.who)}</select>` : ''}
          <button type="submit" class="btn primary">Añadir</button>
        </form>
        ${open.map(todoRow).join('')}
        ${done.length ? `<h3 class="done-h"><span>Hechos · ${done.length}</span><button type="button" class="linkbtn" id="todoClear">Borrar hechos</button></h3>${done.map(todoRow).join('')}` : ''}
      </section>`;
  }

  function bindTodos(s) {
    const save = async () => {
      await put('sites', s);
      render();
    };
    $('#todoForm').addEventListener('submit', async ev => {
      ev.preventDefault();
      const v = $('#todoText').value.trim();
      if (!v) return;
      const sel = $('#todoWho');
      state.who = sel ? sel.value : '';
      const t = { id: uid(), text: v, done: false, created: Date.now() };
      if (state.who) t.assignee = state.who;
      s.todos = [...(s.todos || []), t];
      await save();
      const f = $('#todoText');
      if (f) f.focus(); // sigue listo para anotar otro seguido
    });
    app.querySelectorAll('.tick').forEach(b => {
      b.onclick = async () => {
        const t = (s.todos || []).find(x => x.id === b.dataset.t);
        if (!t) return;
        t.done = !t.done;
        t.doneAt = t.done ? Date.now() : null;
        await save();
      };
    });
    app.querySelectorAll('.ttext').forEach(b => { b.onclick = () => todoSheet(s, b.dataset.te); });
    const clr = $('#todoClear');
    if (clr) {
      clr.onclick = async () => {
        if (!clr.classList.contains('armed')) {
          clr.classList.add('armed');
          clr.textContent = 'Toca otra vez para confirmar';
          return;
        }
        s.todos = (s.todos || []).filter(x => !x.done);
        await save();
        toast('Pendientes hechos borrados');
      };
    }
  }

  function todoSheet(s, tid) {
    const t = (s.todos || []).find(x => x.id === tid);
    if (!t) return;
    openSheet(`
      <h2>Editar pendiente</h2>
      <label class="lbl" for="ttext2">Qué falta</label>
      <textarea id="ttext2">${esc(t.text)}</textarea>
      ${people.length ? `<label class="lbl" for="twho">Responsable (opcional)</label><select class="field" id="twho">${peopleOptions(t.assignee || '')}</select>` : ''}
      <div class="actions">
        <button type="button" class="btn primary block" id="tsave">Guardar</button>
        <button type="button" class="btn ghost block" data-close>Cancelar</button>
        <button type="button" class="btn danger block" id="tdel">Eliminar</button>
      </div>`);
    $('#tsave').onclick = async () => {
      const v = $('#ttext2').value.trim();
      if (!v) { toast('Escribe qué falta'); return; }
      t.text = v;
      const w = $('#twho');
      if (w) { if (w.value) t.assignee = w.value; else delete t.assignee; }
      await put('sites', s);
      closeSheet();
      render();
      toast('Guardado');
    };
    const d = $('#tdel');
    d.onclick = async () => {
      if (!d.classList.contains('armed')) {
        d.classList.add('armed');
        d.textContent = 'Toca otra vez para confirmar';
        return;
      }
      s.todos = s.todos.filter(x => x.id !== tid);
      await put('sites', s);
      closeSheet();
      render();
      toast('Pendiente eliminado');
    };
  }

  /* ---------- Informe en PDF ---------- */
  // El PDF sale del cuadro de impresión del navegador ("Guardar como PDF"): funciona sin conexión y sin librerías.
  // skip guarda las fotos que el usuario quita del informe, con la clave "idEntrada:posición".
  const rpt = { from: '', to: '', agenda: true, skip: new Set() };
  const getIssuer = () => { try { return localStorage.getItem('obrario.issuer') || ''; } catch (_) { return ''; } };
  const setIssuer = v => { try { localStorage.setItem('obrario.issuer', v); } catch (_) { /* sin almacenamiento */ } };

  const reportEntries = s => siteEntries(s.id)
    .filter(e => (!rpt.from || e.date >= rpt.from) && (!rpt.to || e.date <= rpt.to))
    .sort((a, b) => a.date.localeCompare(b.date) || a.created - b.created);

  function reportHTML(s) {
    const issuer = getIssuer().trim();
    const es = reportEntries(s);
    const hasGps = s.lat != null && s.lng != null;
    const where = s.address || (hasGps ? `Ubicación GPS (${Number(s.lat).toFixed(5)}, ${Number(s.lng).toFixed(5)})` : '');
    const period = rpt.from || rpt.to
      ? `${rpt.from ? shortDate(rpt.from) : 'el inicio'} a ${rpt.to ? shortDate(rpt.to) : 'hoy'}`
      : 'Todo el historial';

    const days = [];
    es.forEach(e => {
      let g = days[days.length - 1];
      if (!g || g.date !== e.date) { g = { date: e.date, items: [] }; days.push(g); }
      g.items.push(e);
    });

    const body = days.map(g => `
      <section class="rday">
        <h2>${longDate(g.date)}</h2>
        ${g.items.map(e => {
          const ph = (e.photos || []).map((p, i) => ({ p, i })).filter(x => !rpt.skip.has(`${e.id}:${x.i}`));
          const note = e.note ? `<p class="rnote">${esc(e.note)}</p>` : (ph.length ? '' : '<p class="rnote rnone">Sin nota</p>');
          const pics = ph.length ? `<div class="rphotos">${ph.map(x => `<figure><img src="${photoSrc(x.p)}" alt="">${photoTag(x.p) || photoTime(x.p) ? `<figcaption>${esc(photoTag(x.p))}${photoTime(x.p) ? `<span class="ftime">${photoTag(x.p) ? ' · ' : ''}${hhmm(photoTime(x.p))}${photoLoc(x.p) ? ' · GPS' : ''}</span>` : ''}</figcaption>` : ''}</figure>`).join('')}</div>` : '';
          const mats = (e.materials || []).length ? `<p class="rmats"><strong>Material:</strong> ${matLine(e)}</p>` : '';
          return `<div class="rentry">${note}${mats}${pics}</div>`;
        }).join('')}
      </section>`).join('');

    const tot = new Map();
    es.forEach(e => (e.materials || []).forEach(m => {
      const k = norm(m.name) + '|' + (m.unit || 'ud');
      const o = tot.get(k) || { name: m.name.trim(), unit: m.unit || 'ud', qty: 0 };
      o.qty += Number(m.qty) || 0; tot.set(k, o);
    }));
    const totals = tot.size ? `
      <section class="rday">
        <h2>Material utilizado</h2>
        <ul class="rlist">${[...tot.values()].map(o => `<li>${fmtMat(o)}</li>`).join('')}</ul>
      </section>` : '';
    const openTodos = rpt.agenda ? (s.todos || []).filter(t => !t.done) : [];
    const todos = openTodos.length ? `
      <section class="rday">
        <h2>Pendiente por hacer</h2>
        <ul class="rlist">${openTodos.map(t => `<li>${esc(t.text)}${t.assignee && personName(t.assignee) ? ` (${esc(personName(t.assignee))})` : ''}</li>`).join('')}</ul>
      </section>` : '';
    const upcoming = rpt.agenda ? siteVisits(s.id) : [];
    const agenda = upcoming.length ? `
      <section class="rday">
        <h2>Pendiente de realizar</h2>
        <ul class="rlist">${upcoming.map(v => `<li><strong>${longDate(v.date)}${v.time ? `, ${esc(v.time)}` : ''}</strong> · ${KIND[v.kind]}${v.kind === 'mantenimiento' ? ` (${repeatLabel(v)})` : ''}${v.note ? `: ${esc(v.note)}` : ''}${v.assignee && personName(v.assignee) ? ` (${esc(personName(v.assignee))})` : ''}</li>`).join('')}</ul>
      </section>` : '';

    return `
      <header class="rhead">
        ${issuer ? `<p class="rissuer">${esc(issuer)}</p>` : ''}
        <h1>Informe de trabajos</h1>
        <p class="rsite">${esc(s.name)}</p>
        ${where ? `<p>${esc(where)}</p>` : ''}
        <p class="rmeta">Periodo: ${period} · ${plural(es.length, 'entrada', 'entradas')} · Emitido el ${longDate(todayStr())}</p>
      </header>
      ${body || '<p class="rnote rnone">No hay entradas en este periodo.</p>'}
      ${totals}
      ${todos}
      ${agenda}`;
  }

  function renderReport(id) {
    const s = sites.find(x => x.id === id);
    setDock(null);
    rpt.skip.clear(); // las posiciones de las fotos pueden haber cambiado desde la última vez
    app.innerHTML = `
      <a class="back no-print" href="#s/${esc(id)}">‹ Volver al sitio</a>
      <div class="report-tools no-print">
        <h2>Informe en PDF</h2>
        <div class="two">
          <div><label class="lbl" for="rfrom">Desde</label><input class="field" id="rfrom" type="date" value="${rpt.from}"></div>
          <div><label class="lbl" for="rto">Hasta</label><input class="field" id="rto" type="date" value="${rpt.to}"></div>
        </div>
        <label class="lbl" for="rissuer">Tu nombre o empresa (opcional)</label>
        <input class="field" id="rissuer" type="text" value="${esc(getIssuer())}" placeholder="Sale arriba del informe" autocomplete="off">
        <span class="lbl">Fotos del informe</span>
        <div class="chips">
          <button type="button" id="rall">Todas</button>
          <button type="button" id="rnone">Ninguna</button>
          <span class="meta" id="rcount"></span>
        </div>
        <div class="pick" id="rpick"></div>
        <label class="check"><input type="checkbox" id="ragenda" ${rpt.agenda ? 'checked' : ''}> Incluir pendientes y visitas agendadas</label>
        <button type="button" class="btn primary block" id="rprint">Guardar como PDF</button>
        <p class="hint">Se abre el cuadro de impresión. Elige "Guardar como PDF" como destino y pulsa Guardar.</p>
      </div>
      <article class="report" id="rdoc"></article>`;
    const draw = () => { $('#rdoc').innerHTML = reportHTML(s); };
    const photoItems = () => {
      const items = [];
      reportEntries(s).forEach(e => (e.photos || []).forEach((p, i) => items.push({ key: `${e.id}:${i}`, p, e })));
      return items;
    };
    const drawPick = () => {
      const items = photoItems();
      const on = items.filter(x => !rpt.skip.has(x.key)).length;
      $('#rcount').textContent = items.length ? `${on} de ${items.length}` : 'No hay fotos en este periodo';
      $('#rpick').innerHTML = items.map(x => {
        const sel = !rpt.skip.has(x.key);
        const label = `${shortDate(x.e.date)}${photoTag(x.p) ? ` · ${photoTag(x.p)}` : ''}`;
        return `<button type="button" class="pk${sel ? ' on' : ''}" data-k="${esc(x.key)}" aria-pressed="${sel}" aria-label="Foto del ${esc(label)}"><img src="${photoSrc(x.p)}" alt="" loading="lazy"><span class="ck">${sel ? '✓' : ''}</span><small>${esc(label)}</small></button>`;
      }).join('');
    };
    const redraw = () => { drawPick(); draw(); };
    $('#rfrom').addEventListener('change', e => { rpt.from = e.target.value; redraw(); });
    $('#rto').addEventListener('change', e => { rpt.to = e.target.value; redraw(); });
    $('#rissuer').addEventListener('input', e => { setIssuer(e.target.value); draw(); });
    $('#rall').onclick = () => { rpt.skip.clear(); redraw(); };
    $('#rnone').onclick = () => { photoItems().forEach(x => rpt.skip.add(x.key)); redraw(); };
    $('#rpick').addEventListener('click', e => {
      const b = e.target.closest('.pk');
      if (!b) return;
      const k = b.dataset.k;
      if (rpt.skip.has(k)) rpt.skip.delete(k); else rpt.skip.add(k);
      redraw();
    });
    $('#ragenda').addEventListener('change', e => { rpt.agenda = e.target.checked; draw(); });
    $('#rprint').onclick = () => window.print();
    redraw();
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
        for (const e of siteEntries(site.id)) { await del('entries', e.id); await adjustStock(e.materials, []); }
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
    let mats = entry && entry.materials ? entry.materials.map(m => ({ ...m })) : [];
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
      <p class="hint">Toca la etiqueta bajo cada foto para marcarla: antes, durante o después. Las fotos de la cámara guardan hora y ubicación.</p>
      <span class="lbl">Material usado</span>
      <div class="mlist" id="mlist"></div>
      <div class="madd">
        <input id="mname" class="mfull" type="text" placeholder="Buscar o escribir material (ej. tubo 20)" aria-label="Material" autocomplete="off">
        <div class="msug mfull" id="msug"></div>
        <input id="mqty" type="number" inputmode="decimal" min="0" step="any" value="1" aria-label="Cantidad">
        <select id="munit" aria-label="Unidad">${unitOpts('ud')}</select>
        <button type="button" class="btn" id="madd">Añadir</button>
      </div>
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
        photos[i] = { ...asPhoto(photos[i]), tag: next };
        drawThumbs();
      }
    });
    drawThumbs();

    const drawMats = () => {
      $('#mlist').innerHTML = mats.map((m, i) => `<div class="mrow"><span>${fmtMat(m)}</span><button type="button" class="x2" data-i="${i}" aria-label="Quitar ${esc(m.name)}">✕</button></div>`).join('');
    };
    drawMats();
    const drawSug = () => {
      const q = norm($('#mname').value);
      const hits = q ? sortedMats().filter(m => norm(m.name).includes(q)).slice(0, 6) : [];
      $('#msug').innerHTML = hits.map(m => `<button type="button" class="sug" data-id="${esc(m.id)}">${esc(m.name)} <small>${tracked(m) ? `${fmtQty(m.stock)} en stock` : esc(m.unit === 'ud' ? 'unidades' : m.unit)}</small></button>`).join('');
    };
    $('#mname').addEventListener('input', drawSug);
    $('#msug').addEventListener('click', ev => {
      const b = ev.target.closest('.sug');
      if (!b) return;
      const m = materials.find(x => x.id === b.dataset.id);
      $('#mname').value = m.name; $('#munit').value = m.unit || 'ud';
      $('#msug').innerHTML = '';
      $('#mqty').focus(); $('#mqty').select();
    });
    const addMat = async () => {
      const name = $('#mname').value.trim();
      if (!name) { toast('Escribe el material'); return; }
      const qty = Number($('#mqty').value.replace(',', '.'));
      const known = findMat(name);
      const unit = known ? (known.unit || 'ud') : $('#munit').value;
      mats.push({ name: known ? known.name : name, unit, qty: qty > 0 ? qty : 1 });
      if (!known) {
        const m = { id: uid(), name, unit, created: Date.now() };
        try { await put('materials', m); materials.push(m); } catch (_) { /* el material queda en la entrada igualmente */ }
      }
      $('#mname').value = ''; $('#mqty').value = '1'; $('#munit').value = 'ud'; $('#msug').innerHTML = '';
      drawMats();
      $('#mname').focus();
    };
    $('#madd').onclick = addMat;
    $('#mname').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); addMat(); } });
    $('#mlist').addEventListener('click', ev => {
      const x = ev.target.closest('.x2');
      if (x) { mats.splice(Number(x.dataset.i), 1); drawMats(); }
    });

    const addFiles = async e => {
      const files = [...e.target.files];
      const fromCam = e.target.id === 'ecam';
      e.target.value = '';
      if (!files.length) return;
      const st = $('#phstatus');
      st.textContent = 'Procesando fotos…';
      st.hidden = false;
      let fail = 0;
      const pos = fromCam ? getPos() : Promise.resolve(null);
      for (const f of files) {
        try {
          const ph = { src: await compress(f), tag: '', t: fromCam ? Date.now() : (f.lastModified || Date.now()) };
          const loc = await pos;
          if (loc) ph.loc = loc;
          photos.push(ph);
        } catch (_) { fail++; }
      }
      st.hidden = true;
      drawThumbs();
      if (fail) toast(`No se pudieron leer ${plural(fail, 'foto', 'fotos')}`);
    };
    $('#efiles').addEventListener('change', addFiles);
    $('#ecam').addEventListener('change', addFiles);

    $('#esave').onclick = async () => {
      const note = $('#enote').value.trim();
      if (!note && !photos.length && !mats.length) { toast('Añade una nota, una foto o material'); return; }
      const now = Date.now();
      const obj = isNew
        ? { id: uid(), siteId, date, note, photos, materials: mats, created: now, updated: now }
        : { ...entry, date, note, photos, materials: mats, updated: now };
      try {
        await put('entries', obj);
      } catch (_) {
        toast('No se pudo guardar. Puede que no quede espacio en el móvil');
        return;
      }
      await adjustStock(entry ? entry.materials : [], mats);
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
        await adjustStock(entry.materials, []);
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
    const who = v.assignee ? personName(v.assignee) : '';
    const detail = [showSite ? KIND[v.kind] : '', v.kind === 'mantenimiento' ? repeatLabel(v) : '', who ? `con ${who}` : '', first].filter(Boolean).join(' · ');
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
      ${v.assignee && personName(v.assignee) ? `<p class="meta">Responsable: ${esc(personName(v.assignee))}</p>` : ''}
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
      ${people.length ? `<label class="lbl" for="vwho">Responsable (opcional)</label><select class="field" id="vwho">${peopleOptions(visit ? visit.assignee || '' : '')}</select>` : ''}
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
      const w = $('#vwho');
      if (w) { if (w.value) obj.assignee = w.value; else delete obj.assignee; }
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
        <span><b>${people.length}</b> colaboradores</span>
        <span><b>${materials.length}</b> materiales</span>
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
    const data = { app: 'obrario', version: 4, exported: new Date().toISOString(), sites, entries, visits, people, materials };
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
      const ps = Array.isArray(data.people) ? data.people : [];
      for (const x of ps) await put('people', x);
      const ms = Array.isArray(data.materials) ? data.materials : [];
      for (const x of ms) await put('materials', x);
      sites = await getAll('sites');
      entries = await getAll('entries');
      visits = await getAll('visits');
      people = await getAll('people');
      materials = await getAll('materials');
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
      people = await getAll('people');
      materials = await getAll('materials');
    } catch (_) {
      app.innerHTML = '<div class="empty"><strong>No se pudo abrir el almacenamiento</strong><span>Abre Obrario en una pestaña normal, no en modo privado, y vuelve a intentarlo.</span></div>';
      return;
    }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    route();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  })();
})();
