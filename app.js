(function () {
  'use strict';

  const SCRIPT_URL = ((window.APP_CONFIG && window.APP_CONFIG.SCRIPT_URL) || '').trim();
  const PHOTO_SLOTS = ['Garage front', 'Display board', 'Shelf / stock'];
  const MAX_PHOTO_SIDE = 1280;
  const MAX_SENT_KEPT = 50;
  const GPS_GOOD_ACCURACY = 25;
  const GPS_STALE_MS = 5 * 60 * 1000;
  const RETRY_MS = 60 * 1000;
  const SEND_TIMEOUT_MS = 120 * 1000;
  const DRAFT_KEY = 'pts.draft';
  const PROMOTER_KEY = 'pts.promoter';

  const $ = (id) => document.getElementById(id);
  const form = $('visitForm');

  /* ---------- Local storage (per-device conveniences) ---------- */

  function readStore(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function writeStore(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) { /* storage unavailable: the form still works */ }
  }

  /* ---------- IndexedDB queue ---------- */

  let dbPromise;
  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('promoter-track-sheet', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('visits', { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }
  async function dbRun(mode, run) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('visits', mode);
      const req = run(tx.objectStore('visits'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  const putVisit = (visit) => dbRun('readwrite', (s) => s.put(visit));
  const deleteVisit = (id) => dbRun('readwrite', (s) => s.delete(id));
  const allVisits = () => dbRun('readonly', (s) => s.getAll());

  /* ---------- GPS ---------- */

  let fix = null;
  let watchId = null;
  let gpsTimer = null;

  function stopGps() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    clearTimeout(gpsTimer);
  }

  function setGps(state, title, detail) {
    $('gpsBox').dataset.state = state;
    $('gpsTitle').textContent = title;
    $('gpsDetail').textContent = detail;
    const map = $('gpsMap');
    map.hidden = !fix;
    if (fix) map.href = mapUrl(fix.lat, fix.lng);
  }

  function mapUrl(lat, lng) {
    return 'https://www.google.com/maps?q=' + lat + ',' + lng;
  }

  function renderFix() {
    const quality = fix.accuracy <= GPS_GOOD_ACCURACY ? '' : ' Move outside for better accuracy.';
    setGps('ok', 'Location captured',
      fix.lat.toFixed(6) + ', ' + fix.lng.toFixed(6) + ' (±' + Math.round(fix.accuracy) + ' m).' + quality);
  }

  function startGps() {
    if (!navigator.geolocation) {
      setGps('error', 'Location not available', 'This browser cannot share location.');
      return;
    }
    stopGps();
    fix = null;
    setGps('searching', 'Finding your location…', 'Stand outside if possible.');
    watchId = navigator.geolocation.watchPosition((pos) => {
      if (!fix || pos.coords.accuracy <= fix.accuracy) {
        fix = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          at: pos.timestamp
        };
        renderFix();
      }
      if (pos.coords.accuracy <= GPS_GOOD_ACCURACY) stopGps();
    }, (err) => {
      if (err.code === err.PERMISSION_DENIED) {
        stopGps();
        setGps('denied', 'Location is blocked',
          'Allow location for this site in your browser settings, then tap Refresh location.');
      } else if (!fix) {
        setGps('error', 'Could not get location',
          'Turn on GPS, move outside, then tap Refresh location.');
      }
    }, { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 });
    gpsTimer = setTimeout(stopGps, 60000);
  }

  /* ---------- Photos ---------- */

  const slots = PHOTO_SLOTS.map((label) => ({ label: label, canvas: null, takenAt: null, el: null }));

  const CAMERA_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
    '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/>' +
    '<circle cx="12" cy="13.5" r="3.5"/></svg>';

  function renderSlot(slot) {
    const el = slot.el;
    el.textContent = '';
    el.classList.toggle('has-photo', !!slot.canvas);

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.setAttribute('capture', 'environment');
    input.setAttribute('aria-label', 'Take photo: ' + slot.label);
    input.addEventListener('change', () => {
      if (input.files[0]) loadPhoto(slot, input.files[0]);
    });
    el.appendChild(input);

    if (slot.canvas) {
      el.appendChild(slot.canvas);
      const caption = document.createElement('span');
      caption.className = 'photo-label';
      caption.textContent = slot.label;
      el.appendChild(caption);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'photo-remove';
      remove.setAttribute('aria-label', 'Remove photo: ' + slot.label);
      remove.textContent = '×';
      remove.addEventListener('click', (e) => {
        e.preventDefault();
        slot.canvas = null;
        slot.takenAt = null;
        renderSlot(slot);
      });
      el.appendChild(remove);
    } else {
      el.insertAdjacentHTML('beforeend', CAMERA_ICON);
      const caption = document.createElement('span');
      caption.textContent = slot.label;
      el.appendChild(caption);
    }
  }

  async function loadPhoto(slot, file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      slot.canvas = canvas;
      slot.takenAt = new Date();
      renderSlot(slot);
    } catch (e) {
      showToast('Could not read that photo. Please take it again.');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function formatWhen(date) {
    return new Date(date).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit'
    });
  }

  function stampedPhoto(slot, garageName) {
    const out = document.createElement('canvas');
    out.width = slot.canvas.width;
    out.height = slot.canvas.height;
    const ctx = out.getContext('2d');
    ctx.drawImage(slot.canvas, 0, 0);

    const size = Math.max(14, Math.round(out.width / 42));
    const pad = Math.round(size * 0.6);
    const lines = [
      garageName + ' · ' + slot.label,
      formatWhen(slot.takenAt) + (fix
        ? ' · ' + fix.lat.toFixed(6) + ', ' + fix.lng.toFixed(6) + ' (±' + Math.round(fix.accuracy) + ' m)'
        : ' · GPS not captured')
    ];
    const barHeight = lines.length * size * 1.35 + pad * 2;
    ctx.fillStyle = 'rgba(0, 0, 0, .68)';
    ctx.fillRect(0, out.height - barHeight, out.width, barHeight);
    ctx.fillStyle = '#fff';
    ctx.font = '600 ' + size + 'px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => {
      ctx.fillText(line, pad, out.height - barHeight + pad + i * size * 1.35, out.width - pad * 2);
    });

    let dataUrl = out.toDataURL('image/jpeg', 0.72);
    if (dataUrl.length > 1200000) dataUrl = out.toDataURL('image/jpeg', 0.55);
    return { label: slot.label, takenAt: slot.takenAt.toISOString(), dataUrl: dataUrl };
  }

  /* ---------- Form ---------- */

  function checked(name) {
    return Array.from(form.querySelectorAll('input[name="' + name + '"]:checked')).map((i) => i.value);
  }

  function collect() {
    const suppliers = checked('suppliers');
    const other = form.suppliersOther.value.trim();
    const typeChoice = checked('garageType')[0] || '';
    return {
      promoterName: form.promoterName.value.trim(),
      garageName: form.garageName.value.trim(),
      garageType: typeChoice,
      garageTypeOther: typeChoice === 'Other' ? form.garageTypeOther.value.trim() : '',
      mobile: form.mobile.value.trim(),
      address: form.address.value.trim(),
      monthlySales: form.monthlySales.value.trim(),
      suppliers: suppliers.filter((s) => s !== 'Other').concat(suppliers.includes('Other') && other ? [other] : []).join(', '),
      topGrades: form.topGrades.value.trim(),
      displayBoard: form.displayBoard.value.trim(),
      servoAvailable: checked('servoAvailable')[0] || '',
      needBoard: checked('needBoard')[0] || ''
    };
  }

  function validate(v) {
    const errors = {};
    const need = 'This is required.';
    if (!v.promoterName) errors.promoterName = need;
    if (!v.garageName) errors.garageName = need;
    if (!v.garageType) errors.garageType = 'Please choose one.';
    else if (v.garageType === 'Other' && !v.garageTypeOther) errors.garageType = 'Please type the garage type.';
    if (v.mobile && !/^(\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}$/.test(v.mobile)) {
      errors.mobile = 'Enter a valid 10-digit mobile number.';
    }
    if (!v.address) errors.address = need;
    if (!v.monthlySales) errors.monthlySales = need;
    if (!v.suppliers) {
      errors.suppliers = checked('suppliers').includes('Other')
        ? 'Please type the company name.' : 'Please choose at least one.';
    }
    if (!v.topGrades) errors.topGrades = need;
    if (!v.servoAvailable) errors.servoAvailable = 'Please choose one.';
    if (!v.needBoard) errors.needBoard = 'Please choose one.';
    return errors;
  }

  function showErrors(errors) {
    let first = null;
    form.querySelectorAll('[data-field]').forEach((field) => {
      const message = errors[field.dataset.field];
      field.classList.toggle('has-error', !!message);
      field.querySelector('.error').textContent = message || '';
      if (message && !first) first = field;
    });
    if (first) {
      first.scrollIntoView({ block: 'center' });
      const input = first.querySelector('input:not([type=radio]):not([type=checkbox]), textarea');
      if (input) input.focus({ preventScroll: true });
    }
    return !first;
  }

  function syncReveals() {
    form.garageTypeOther.hidden = checked('garageType')[0] !== 'Other';
    form.suppliersOther.hidden = !checked('suppliers').includes('Other');
  }

  function saveDraft() {
    const draft = {};
    Array.from(form.elements).forEach((el) => {
      if (!el.name || el.name === 'promoterName') return;
      if (el.type === 'radio' || el.type === 'checkbox') {
        if (el.checked) (draft[el.name] = draft[el.name] || []).push(el.value);
      } else if (el.value) {
        draft[el.name] = el.value;
      }
    });
    writeStore(DRAFT_KEY, JSON.stringify(draft));
    writeStore(PROMOTER_KEY, form.promoterName.value.trim());
  }

  function restoreDraft() {
    form.promoterName.value = readStore(PROMOTER_KEY) || '';
    let draft = {};
    try { draft = JSON.parse(readStore(DRAFT_KEY)) || {}; } catch (e) { /* ignore a bad draft */ }
    Array.from(form.elements).forEach((el) => {
      const saved = draft[el.name];
      if (!el.name || saved === undefined) return;
      if (el.type === 'radio' || el.type === 'checkbox') el.checked = saved.includes(el.value);
      else el.value = saved;
    });
    syncReveals();
  }

  function confirmDialog(title, body) {
    return new Promise((resolve) => {
      const dialog = $('confirmDialog');
      $('confirmTitle').textContent = title;
      $('confirmBody').textContent = body;
      dialog.returnValue = 'cancel';
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
      dialog.showModal();
    });
  }

  function newId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  function resetForm() {
    const promoter = form.promoterName.value;
    form.reset();
    form.promoterName.value = promoter;
    slots.forEach((slot) => {
      slot.canvas = null;
      slot.takenAt = null;
      renderSlot(slot);
    });
    syncReveals();
    showErrors({});
    writeStore(DRAFT_KEY, null);
    window.scrollTo(0, 0);
    startGps();
  }

  async function onSubmit(e) {
    e.preventDefault();
    const data = collect();
    if (!showErrors(validate(data))) return;

    const photoSlots = slots.filter((s) => s.canvas);
    const missing = [];
    if (!fix) missing.push('location');
    if (!photoSlots.length) missing.push('photos');
    if (missing.length) {
      const what = missing.join(' or ');
      const ok = await confirmDialog('No ' + what + ' captured', 'This visit will be saved without ' + what + '.');
      if (!ok) return;
    }

    const btn = $('saveBtn');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const visit = Object.assign(data, {
        id: newId(),
        createdAt: new Date().toISOString(),
        lat: fix ? fix.lat : null,
        lng: fix ? fix.lng : null,
        accuracy: fix ? Math.round(fix.accuracy) : null,
        locatedAt: fix ? new Date(fix.at).toISOString() : null,
        photos: photoSlots.map((s) => stampedPhoto(s, data.garageName)),
        status: 'pending'
      });
      visit.photoCount = visit.photos.length;
      await putVisit(visit);
      resetForm();
      showTab('visits');
      showToast(navigator.onLine && SCRIPT_URL ? 'Visit saved. Sending…' : 'Visit saved on this phone.');
      await renderVisits();
      syncQueue();
    } catch (err) {
      showToast('Could not save on this phone. Your entries are still in the form.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save visit';
    }
  }

  /* ---------- Sync ---------- */

  let syncing = false;

  async function sendVisit(visit) {
    const body = Object.assign({}, visit);
    delete body.status;
    delete body.lastError;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      // text/plain keeps this a simple request, which Apps Script can answer without a CORS preflight.
      const res = await fetch(SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function pruneSent(visits) {
    const sent = visits.filter((v) => v.status === 'sent').sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    await Promise.all(sent.slice(MAX_SENT_KEPT).map((v) => deleteVisit(v.id)));
  }

  async function syncQueue() {
    if (syncing || !SCRIPT_URL || !navigator.onLine) return;
    syncing = true;
    try {
      const visits = await allVisits();
      const pending = visits.filter((v) => v.status !== 'sent').sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      for (const visit of pending) {
        try {
          const result = await sendVisit(visit);
          if (result && result.ok) {
            visit.status = 'sent';
            delete visit.photos;
            delete visit.lastError;
          } else {
            visit.lastError = (result && result.error) || 'The server rejected this visit.';
          }
          await putVisit(visit);
          await renderVisits();
        } catch (err) {
          // Network trouble affects the whole queue, so leave the rest for the next retry.
          visit.lastError = 'Could not reach the server. Will retry.';
          await putVisit(visit);
          await renderVisits();
          break;
        }
      }
      await pruneSent(await allVisits());
    } catch (err) {
      /* storage error: the next retry starts again from what is saved */
    } finally {
      syncing = false;
      renderVisits();
    }
  }

  /* ---------- Visits view ---------- */

  async function renderVisits() {
    let visits = [];
    try { visits = await allVisits(); } catch (e) { /* storage unavailable: show an empty list */ }
    visits.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

    const today = new Date().toDateString();
    const todayCount = visits.filter((v) => new Date(v.createdAt).toDateString() === today).length;
    const waiting = visits.filter((v) => v.status !== 'sent').length;

    $('visitCount').textContent = todayCount;
    $('visitsSummary').textContent = todayCount + ' today' + (waiting ? ' · ' + waiting + ' waiting to send' : '');
    $('syncBtn').hidden = !waiting || !SCRIPT_URL;
    $('visitsEmpty').hidden = visits.length > 0;

    const list = $('visitList');
    list.textContent = '';
    visits.forEach((v) => {
      const li = document.createElement('li');
      li.className = 'visit';

      const top = document.createElement('div');
      top.className = 'visit-top';
      const name = document.createElement('p');
      name.className = 'visit-name';
      name.textContent = v.garageName;
      const pill = document.createElement('span');
      pill.className = 'pill' + (v.status === 'sent' ? ' is-sent' : '');
      pill.textContent = v.status === 'sent' ? 'Sent' : 'Waiting';
      top.append(name, pill);

      const meta = document.createElement('p');
      meta.className = 'visit-meta';
      const photoText = v.photoCount === 1 ? '1 photo' : v.photoCount + ' photos';
      meta.textContent = formatWhen(v.createdAt) + ' · ' + (v.garageTypeOther || v.garageType) + ' · ' + photoText;
      li.append(top, meta);

      if (v.lat !== null) {
        const link = document.createElement('a');
        link.className = 'visit-link';
        link.href = mapUrl(v.lat, v.lng);
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'View on map';
        li.appendChild(link);
      } else {
        const noGps = document.createElement('p');
        noGps.className = 'visit-meta';
        noGps.textContent = 'No location captured';
        li.appendChild(noGps);
      }

      if (v.lastError && v.status !== 'sent') {
        const err = document.createElement('p');
        err.className = 'visit-error';
        err.textContent = v.lastError;
        li.appendChild(err);
      }
      list.appendChild(li);
    });
  }

  /* ---------- Shell ---------- */

  let toastTimer;
  function showToast(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 3500);
  }

  function showTab(name) {
    form.hidden = name !== 'new';
    $('visitsView').hidden = name !== 'visits';
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.classList.toggle('is-active', tab.dataset.tab === name);
    });
    window.scrollTo(0, 0);
    if (name === 'visits') renderVisits();
  }

  function renderNetwork() {
    const net = $('netStatus');
    net.textContent = navigator.onLine ? 'Online' : 'Offline';
    net.classList.toggle('is-off', !navigator.onLine);
  }

  function init() {
    $('setupBanner').hidden = !!SCRIPT_URL;

    slots.forEach((slot) => {
      slot.el = document.createElement('label');
      slot.el.className = 'photo';
      $('photos').appendChild(slot.el);
      renderSlot(slot);
    });

    restoreDraft();
    form.addEventListener('submit', onSubmit);
    form.addEventListener('input', saveDraft);
    form.addEventListener('change', () => { syncReveals(); saveDraft(); });
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => showTab(tab.dataset.tab));
    });
    $('gpsRetry').addEventListener('click', startGps);
    $('syncBtn').addEventListener('click', () => {
      if (!navigator.onLine) showToast('You are offline. Visits will send when you are back online.');
      syncQueue();
    });

    window.addEventListener('online', () => { renderNetwork(); syncQueue(); });
    window.addEventListener('offline', renderNetwork);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (fix && Date.now() - fix.at > GPS_STALE_MS) startGps();
      syncQueue();
    });

    renderNetwork();
    renderVisits();
    startGps();
    syncQueue();
    setInterval(syncQueue, RETRY_MS);

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* the site still works online */ });
    }
  }

  init();
})();
