const IMG = 'https://image.tmdb.org/t/p/';
const $ = (s) => document.querySelector(s);
const esc = (s) =>
	String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let users = [];
let isAdmin = false;
let me = '';
let identity = null; // navn bekreftet med PIN av serveren (null = ikke valgt ennå)
let hasPin = [];
let searchTimer;

async function api(path, opts = {}) {
	const res = await fetch(path, {
		...opts,
		headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
	});
	if (res.status === 401 && path !== '/api/login' && path !== '/api/admin/login') {
		showLogin();
		throw new Error('Ikke innlogget');
	}
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error || 'Noe gikk galt');
	return data;
}

const fmtDate = (s) =>
	new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString('nb-NO', { day: 'numeric', month: 'short', year: 'numeric' });
const dice = (n) => `🎲 ${n}`;

/* ---------- Innlogging ---------- */
function showLogin() {
	$('#app').classList.add('hidden');
	$('#login').classList.remove('hidden');
	$('#password').focus();
}

$('#login-form').addEventListener('submit', async (e) => {
	e.preventDefault();
	$('#login-error').classList.add('hidden');
	try {
		await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) });
		$('#password').value = '';
		await start();
	} catch (err) {
		$('#login-error').textContent = err.message;
		$('#login-error').classList.remove('hidden');
	}
});

$('#logout').addEventListener('click', async () => {
	await fetch('/api/logout', { method: 'POST' });
	showLogin();
});

/* ---------- Admin ---------- */
function renderAdmin() {
	$('#admin').textContent = isAdmin ? 'Admin ✓' : 'Admin';
	$('#admin').title = isAdmin ? 'Logg ut som admin' : 'Logg inn som admin';
}

$('#admin').addEventListener('click', async () => {
	try {
		if (isAdmin) {
			await api('/api/admin/logout', { method: 'POST' });
		} else {
			const password = prompt('Admin-passord:');
			if (!password) return;
			await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
		}
		await refreshConfig();
		if (!$('#tab-feed').classList.contains('hidden')) loadFeed();
		if (!$('#tab-library').classList.contains('hidden')) loadLibrary(true);
	} catch (err) {
		alert(err.message);
	}
});

/* ---------- Navn og PIN ---------- */
function renderUser() {
	$('#user').innerHTML =
		`<option value="">Velg navn…</option>` + users.map((u) => `<option ${u === me ? 'selected' : ''}>${esc(u)}</option>`).join('');
	$('#admin-bar').classList.toggle('hidden', !isAdmin);
}

async function refreshConfig() {
	({ users, admin: isAdmin, identity, hasPin } = await api('/api/config'));
	if (isAdmin) {
		if (!users.includes(me)) me = identity || '';
	} else {
		me = identity || '';
	}
	renderAdmin();
	renderUser();
}

function askPin(name) {
	return new Promise((resolve) => {
		const creating = !hasPin.includes(name);
		$('#pin-title').textContent = creating ? `Lag en PIN for ${name}` : `PIN for ${name}`;
		$('#pin-help').textContent = creating
			? 'Velg 4–6 siffer. Du bruker den når du velger dette navnet. Glemmer du den, kan admin nullstille den.'
			: 'Skriv inn PIN-en din.';
		$('#pin2-wrap').classList.toggle('hidden', !creating);
		$('#pin').value = '';
		$('#pin2').value = '';
		$('#pin-error').classList.add('hidden');
		$('#pin-modal').classList.remove('hidden');
		$('#pin').focus();

		const showErr = (msg) => {
			$('#pin-error').textContent = msg;
			$('#pin-error').classList.remove('hidden');
		};
		const done = (ok) => {
			$('#pin-modal').classList.add('hidden');
			$('#pin-form').onsubmit = null;
			$('#pin-cancel').onclick = null;
			resolve(ok);
		};
		$('#pin-cancel').onclick = () => done(false);
		$('#pin-form').onsubmit = async (e) => {
			e.preventDefault();
			const pin = $('#pin').value.trim();
			if (!/^\d{4,6}$/.test(pin)) return showErr('PIN må være 4–6 siffer.');
			if (creating && pin !== $('#pin2').value.trim()) return showErr('PIN-ene er ikke like.');
			try {
				await api('/api/identity', { method: 'POST', body: JSON.stringify({ username: name, pin }) });
				done(true);
			} catch (err) {
				showErr(err.message);
			}
		};
	});
}

$('#user').addEventListener('change', async (e) => {
	const wanted = e.target.value;
	if (isAdmin) {
		me = wanted; // admin kan velge fritt uten PIN
		return;
	}
	if (wanted && (await askPin(wanted))) {
		await refreshConfig();
		return;
	}
	renderUser(); // avbrutt eller feil: tilbake til forrige navn
});

$('#reset-pin').addEventListener('click', async () => {
	if (!me) return alert('Velg et navn først.');
	if (!confirm(`Nullstille PIN for ${me}? Personen må lage en ny PIN og blir logget ut av navnet.`)) return;
	try {
		await api('/api/admin/reset-pin', { method: 'POST', body: JSON.stringify({ username: me }) });
		await refreshConfig();
		alert(`PIN for ${me} er nullstilt.`);
	} catch (err) {
		alert(err.message);
	}
});

/* ---------- Oppstart ---------- */
async function start() {
	try {
		await refreshConfig();
	} catch {
		return; // showLogin() er allerede kalt ved 401
	}
	$('#login').classList.add('hidden');
	$('#app').classList.remove('hidden');
	setTab('search');
}

/* ---------- Bibliotek (CLZ) ---------- */
const FORMAT_FILTERS = ['4K UHD', 'Blu-ray', 'DVD', 'Digital'];
const lib = { q: '', format: '', review: false, sort: 'title', decade: 0, director: '', facets: null, lastKey: null, offset: 0, total: 0, timer: null };
const firstDirector = (d) => String(d ?? '').split('|')[0].trim();

function libBadge(formats) {
	const list = [...new Set(String(formats ?? '').split('|').map((f) => f.trim()).filter(Boolean))];
	if (!list.length) return '';
	return `<div class="mt-2"><span class="inline-block rounded-full bg-emerald-900/60 text-emerald-300 text-xs px-2 py-1">📀 I biblioteket: ${list.map(esc).join(' · ')}</span></div>`;
}

function renderFormatChips() {
	const chip = (f, label, on) =>
		`<button data-f="${esc(f)}" class="rounded-full px-3 py-1 text-xs ${on ? 'bg-amber-400 text-slate-900' : 'bg-slate-800 text-slate-300'}">${label}</button>`;
	$('#lib-formats').innerHTML =
		['', ...FORMAT_FILTERS].map((f) => chip(f, f || 'Alle', !lib.review && lib.format === f)).join('') +
		(isAdmin ? chip('__review', '⚠ Å sjekke', lib.review) : '');
}

function renderDecades() {
	const chip = (d, label) =>
		`<button data-d="${d}" class="rounded-full px-3 py-1 text-xs ${lib.decade === d ? 'bg-amber-400 text-slate-900' : 'bg-slate-800 text-slate-300'}">${label}</button>`;
	$('#lib-decades').innerHTML = lib.facets
		? chip(0, 'Alle tiår') + lib.facets.map((f) => chip(f.decade, `${f.decade}-tallet`)).join('')
		: '';
}

function renderDirChip() {
	$('#lib-dir').innerHTML = lib.director
		? `<button id="lib-dir-clear" class="rounded-full bg-amber-400 text-slate-900 text-xs px-3 py-1">Regissør: ${esc(lib.director)} ✕</button>`
		: '';
}

function groupHeading(m) {
	let key = null;
	if (lib.sort === 'year_desc' || lib.sort === 'year_asc') key = m.year ? String(m.year) : 'Ukjent år';
	else if (lib.sort === 'director') key = firstDirector(m.director) || 'Ukjent regissør';
	if (key === null || key === lib.lastKey) return '';
	lib.lastKey = key;
	return `<h3 class="col-span-full text-sm font-semibold text-amber-300 mt-3 first:mt-0">${esc(key)}</h3>`;
}

async function loadLibrary(reset) {
	$('#lib-add').classList.toggle('hidden', !isAdmin);
	if (reset) {
		lib.offset = 0;
		lib.lastKey = null;
		$('#lib-list').innerHTML = '';
		renderFormatChips();
		renderDirChip();
		if (!lib.facets) {
			api('/api/library/facets')
				.then(({ decades }) => {
					lib.facets = decades;
					renderDecades();
				})
				.catch(() => {});
		}
		renderDecades();
	}
	$('#lib-status').textContent = 'Henter…';
	try {
		const params = new URLSearchParams({ limit: '60', offset: String(lib.offset) });
		if (lib.q) params.set('q', lib.q);
		if (lib.format) params.set('format', lib.format);
		if (lib.review && isAdmin) params.set('review', '1');
		if (lib.sort !== 'title') params.set('sort', lib.sort);
		if (lib.decade) params.set('decade', String(lib.decade));
		if (lib.director) params.set('director', lib.director);
		const { results, total } = await api('/api/library?' + params);
		lib.total = total;
		lib.offset += results.length;
		$('#lib-status').textContent = total ? `${total} filmer` : 'Ingen filmer i biblioteket ennå.';
		$('#lib-list').insertAdjacentHTML(
			'beforeend',
			results
				.map(
					(m) => groupHeading(m) + `
			<div class="relative">
			<button ${m.tmdb_id ? `data-movie='${esc(JSON.stringify({ id: m.tmdb_id, media_type: m.media_type, title: m.title, year: m.year || null, poster_path: m.poster_path }))}'` : 'disabled'}
				class="lib-item w-full text-left bg-slate-800 rounded-xl overflow-hidden ${m.tmdb_id ? 'hover:ring-2 hover:ring-amber-400' : 'opacity-70'}">
				<div class="aspect-[2/3] bg-slate-700">${posterTag(m.poster_path, m.title)}</div>
				<div class="p-2">
					<div class="text-sm font-medium leading-tight">${esc(m.title)}</div>
					<div class="text-xs text-slate-400">${m.year || ''}${m.media_type === 'tv' ? ' · TV' : ''} · ${esc(m.formats.split('|').join(' · '))}</div>
					${m.director ? `<span data-dir="${esc(firstDirector(m.director))}" class="inline-block text-xs text-slate-400 hover:text-amber-300 hover:underline">${esc(firstDirector(m.director))}</span>` : ''}
					${m.match === 'fuzzy' ? '<div class="text-xs text-amber-400">usikker match</div>' : ''}${m.tmdb_id ? '' : '<div class="text-xs text-slate-500">ikke funnet i TMDB</div>'}
				</div>
			</button>
			${isAdmin ? `<button data-fix='${esc(JSON.stringify({ id: m.id, title: m.title, year: m.year }))}' class="fix-btn absolute top-2 right-2 rounded bg-slate-900/90 text-xs px-2 py-1 hover:bg-amber-400 hover:text-slate-900">Rett</button>` : ''}
			</div>`,
				)
				.join(''),
		);
		$('#lib-more').classList.toggle('hidden', lib.offset >= total);
	} catch (err) {
		$('#lib-status').textContent = err.message;
	}
}

$('#lib-q').addEventListener('input', (e) => {
	clearTimeout(lib.timer);
	lib.timer = setTimeout(() => {
		lib.q = e.target.value.trim();
		loadLibrary(true);
	}, 300);
});
$('#lib-formats').addEventListener('click', (e) => {
	const b = e.target.closest('button');
	if (!b) return;
	lib.review = b.dataset.f === '__review';
	lib.format = lib.review ? '' : b.dataset.f;
	loadLibrary(true);
});
$('#lib-more').addEventListener('click', () => loadLibrary(false));
$('#lib-sort').addEventListener('change', (e) => {
	lib.sort = e.target.value;
	loadLibrary(true);
});
$('#lib-decades').addEventListener('click', (e) => {
	const b = e.target.closest('button');
	if (!b) return;
	lib.decade = Number(b.dataset.d);
	loadLibrary(true);
});
$('#lib-dir').addEventListener('click', (e) => {
	if (!e.target.closest('#lib-dir-clear')) return;
	lib.director = '';
	loadLibrary(true);
});
$('#lib-list').addEventListener('click', (e) => {
	const fix = e.target.closest('.fix-btn');
	if (fix) return openFix(JSON.parse(fix.dataset.fix));
	const dir = e.target.closest('[data-dir]');
	if (dir) {
		lib.director = dir.dataset.dir;
		loadLibrary(true);
		return;
	}
	const b = e.target.closest('.lib-item[data-movie]');
	if (b) openMovie(JSON.parse(b.dataset.movie));
});

/* ---------- Legg til film med strekkode (admin) ---------- */
let scanner = null;
let addSel = null;
let addFormats = new Set();
let addTimer;

function loadScript(src) {
	return new Promise((resolve, reject) => {
		const el = document.createElement('script');
		el.src = src;
		el.onload = resolve;
		el.onerror = () => reject(new Error('Kunne ikke laste skanneren. Skriv inn strekkoden manuelt.'));
		document.head.appendChild(el);
	});
}

function addError(msg) {
	$('#add-error').textContent = msg || '';
	$('#add-error').classList.toggle('hidden', !msg);
}

async function stopScan() {
	if (scanner) {
		try {
			await scanner.stop();
			scanner.clear();
		} catch {}
		scanner = null;
	}
	$('#scan-box').classList.add('hidden');
}

async function startScan() {
	addError('');
	try {
		if (!window.Html5Qrcode) await loadScript('https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js');
		$('#scan-box').classList.remove('hidden');
		const F = window.Html5QrcodeSupportedFormats;
		scanner = new window.Html5Qrcode('scan-reader', { formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E], verbose: false });
		await scanner.start(
			{ facingMode: 'environment' },
			{ fps: 10, qrbox: { width: 280, height: 120 } },
			(text) => {
				if (!/^\d{8,14}$/.test(text)) return;
				stopScan();
				$('#add-code').value = text;
				lookupBarcode(text);
			},
			() => {},
		);
	} catch (err) {
		await stopScan();
		addError(err.message?.includes('Permission') ? 'Kameratilgang ble avslått. Skriv inn strekkoden manuelt.' : 'Kunne ikke starte kameraet: ' + (err.message || err));
	}
}

function resetAddPick() {
	addSel = null;
	addFormats = new Set();
	$('#add-pick').classList.add('hidden');
}

function renderAddResults(results) {
	$('#add-results').innerHTML = results
		.map(
			(m) => `
		<button data-add='${esc(JSON.stringify({ id: m.id, media_type: m.media_type, title: m.title, year: m.year, poster_path: m.poster_path }))}'
			class="add-pick w-full flex gap-3 text-left bg-slate-900 rounded-lg p-2 hover:ring-2 hover:ring-amber-400">
			<div class="w-12 shrink-0 aspect-[2/3] bg-slate-700 rounded overflow-hidden">${posterTag(m.poster_path, m.title, 'w92')}</div>
			<div class="min-w-0">
				<div class="text-sm font-medium">${esc(m.title)} <span class="text-slate-400">${esc(m.year ?? '')}${m.media_type === 'tv' ? ' · TV' : ''}</span></div>
				${m.original_title && m.original_title !== m.title ? `<div class="text-xs text-slate-500">${esc(m.original_title)}</div>` : ''}
				<div class="text-xs text-slate-400 line-clamp-2">${esc(m.overview ?? '')}</div>
			</div>
		</button>`,
		)
		.join('');
}

function renderAddFormats() {
	$('#add-formats').innerHTML = FORMAT_FILTERS.map(
		(f) =>
			`<button data-fmt="${esc(f)}" class="rounded-full px-3 py-2 text-sm ${addFormats.has(f) ? 'bg-amber-400 text-slate-900 font-semibold' : 'bg-slate-900 border border-slate-700 text-slate-300'}">${f}</button>`,
	).join('');
}

async function lookupBarcode(code) {
	code = String(code).replace(/\D/g, '');
	addError('');
	resetAddPick();
	$('#add-results').innerHTML = '';
	if (code.length < 8 || code.length > 14) return addError('Strekkoden må være 8–14 siffer.');
	$('#add-status').textContent = 'Slår opp…';
	try {
		const r = await api('/api/admin/barcode/' + code);
		if (r.own) {
			$('#add-status').textContent = `Allerede i biblioteket: ${r.own.title}${r.own.year ? ` (${r.own.year})` : ''} – ${r.own.formats.split('|').join(' · ')}. Søk på tittel for å legge til et annet format.`;
			return;
		}
		if (r.product_title) {
			$('#add-status').textContent = `Strekkoden gir: «${r.product_title}». Velg riktig film:`;
			$('#add-q').value = r.clean_title || '';
			renderAddResults(r.results);
			if (!r.results.length) $('#add-status').textContent += ' (ingen treff i TMDB, prøv å søke selv)';
		} else {
			$('#add-status').textContent = r.note || 'Ingen treff. Søk på tittel i stedet.';
			$('#add-q').focus();
		}
	} catch (err) {
		$('#add-status').textContent = '';
		addError(err.message);
	}
}

async function searchAdd() {
	const q = $('#add-q').value.trim();
	if (q.length < 2) return;
	$('#add-status').textContent = 'Søker…';
	try {
		const { results } = await api('/api/search?type=multi&q=' + encodeURIComponent(q));
		$('#add-status').textContent = results.length ? 'Velg riktig film:' : 'Ingen treff.';
		renderAddResults(results);
	} catch (err) {
		$('#add-status').textContent = '';
		addError(err.message);
	}
}

function openAdd() {
	addError('');
	$('#add-code').value = '';
	$('#add-q').value = '';
	$('#add-status').textContent = '';
	$('#add-results').innerHTML = '';
	resetAddPick();
	$('#add-modal').classList.remove('hidden');
}

async function closeAdd() {
	await stopScan();
	$('#add-modal').classList.add('hidden');
}

$('#lib-add').addEventListener('click', openAdd);
$('#add-close').addEventListener('click', closeAdd);
$('#add-modal').addEventListener('click', (e) => e.target.id === 'add-modal' && closeAdd());
$('#add-scan').addEventListener('click', startScan);
$('#scan-stop').addEventListener('click', stopScan);
$('#add-lookup').addEventListener('click', () => lookupBarcode($('#add-code').value));
$('#add-code').addEventListener('keydown', (e) => e.key === 'Enter' && lookupBarcode($('#add-code').value));
$('#add-q').addEventListener('input', () => {
	clearTimeout(addTimer);
	addTimer = setTimeout(searchAdd, 400);
});
$('#add-results').addEventListener('click', (e) => {
	const b = e.target.closest('.add-pick');
	if (!b) return;
	addSel = JSON.parse(b.dataset.add);
	addFormats = new Set();
	$('#add-picked').textContent = `${addSel.title}${addSel.year ? ` (${addSel.year})` : ''}`;
	renderAddFormats();
	$('#add-pick').classList.remove('hidden');
	$('#add-pick').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
$('#add-formats').addEventListener('click', (e) => {
	const b = e.target.closest('button');
	if (!b) return;
	addFormats.has(b.dataset.fmt) ? addFormats.delete(b.dataset.fmt) : addFormats.add(b.dataset.fmt);
	renderAddFormats();
});
$('#add-save').addEventListener('click', async () => {
	if (!addSel) return;
	if (!addFormats.size) return addError('Velg minst ett format.');
	addError('');
	try {
		const r = await api('/api/admin/library/add', {
			method: 'POST',
			body: JSON.stringify({ tmdb_id: addSel.id, media_type: addSel.media_type, formats: [...addFormats], barcode: $('#add-code').value }),
		});
		$('#add-status').textContent = `✓ ${r.existed ? 'Oppdatert' : 'Lagt til'}: ${r.title}${r.year ? ` (${r.year})` : ''} – ${r.formats.split('|').join(' · ')}. Klar for neste film.`;
		$('#add-code').value = '';
		$('#add-q').value = '';
		$('#add-results').innerHTML = '';
		resetAddPick();
		if (!$('#tab-library').classList.contains('hidden')) loadLibrary(true);
	} catch (err) {
		addError(err.message);
	}
});

/* ---------- Rett match (admin) ---------- */
let fixTarget = null;
let fixTimer;

function closeFix() {
	$('#fix-modal').classList.add('hidden');
	fixTarget = null;
}

function openFix(item) {
	fixTarget = item;
	$('#fix-title').textContent = `CLZ: ${item.title}${item.year ? ` (${item.year})` : ''}`;
	$('#fix-q').value = item.title;
	$('#fix-id').value = '';
	$('#fix-error').classList.add('hidden');
	$('#fix-modal').classList.remove('hidden');
	searchFix();
}

async function searchFix() {
	const q = $('#fix-q').value.trim();
	if (q.length < 2) {
		$('#fix-results').innerHTML = '';
		return;
	}
	$('#fix-results').innerHTML = '<p class="text-sm text-slate-400">Søker…</p>';
	try {
		const { results } = await api('/api/search?type=multi&q=' + encodeURIComponent(q));
		$('#fix-results').innerHTML = results.length
			? results
					.map(
						(m) => `
			<button data-pick="${m.id}" data-mt="${m.media_type}" class="fix-pick w-full flex gap-3 text-left bg-slate-900 rounded-lg p-2 hover:ring-2 hover:ring-amber-400">
				<div class="w-12 shrink-0 aspect-[2/3] bg-slate-700 rounded overflow-hidden">${posterTag(m.poster_path, m.title, 'w92')}</div>
				<div class="min-w-0">
					<div class="text-sm font-medium">${esc(m.title)} <span class="text-slate-400">${esc(m.year ?? '')}${m.media_type === 'tv' ? ' · TV' : ''}</span></div>
					${m.original_title && m.original_title !== m.title ? `<div class="text-xs text-slate-500">${esc(m.original_title)}</div>` : ''}
					<div class="text-xs text-slate-400 line-clamp-2">${esc(m.overview)}</div>
				</div>
			</button>`,
					)
					.join('')
			: '<p class="text-sm text-slate-400">Ingen treff. Prøv en annen tittel, eller lim inn TMDB-lenken.</p>';
	} catch (err) {
		$('#fix-results').innerHTML = `<p class="text-sm text-red-400">${esc(err.message)}</p>`;
	}
}

async function applyFix(tmdbId, mt = 'movie') {
	if (!fixTarget) return;
	try {
		await api(`/api/admin/library/${fixTarget.id}`, { method: 'PATCH', body: JSON.stringify({ tmdb_id: tmdbId, media_type: mt }) });
		closeFix();
		loadLibrary(true);
	} catch (err) {
		$('#fix-error').textContent = err.message;
		$('#fix-error').classList.remove('hidden');
	}
}

$('#fix-q').addEventListener('input', () => {
	clearTimeout(fixTimer);
	fixTimer = setTimeout(searchFix, 350);
});
$('#fix-results').addEventListener('click', (e) => {
	const b = e.target.closest('.fix-pick');
	if (b) applyFix(Number(b.dataset.pick), b.dataset.mt);
});
$('#fix-use-id').addEventListener('click', () => {
	const v = $('#fix-id').value.trim();
	if (/tt\d{6,10}/i.test(v)) {
		// IMDb-kode eller -lenke: søk den opp og velg fra listen
		$('#fix-q').value = v.match(/tt\d{6,10}/i)[0];
		$('#fix-id').value = '';
		return searchFix();
	}
	const m = v.match(/(movie|tv)\/(\d+)/) || v.match(/^()(\d+)$/);
	if (!m) {
		$('#fix-error').textContent = 'Fant ikke en TMDB-id. Lim inn en lenke som themoviedb.org/movie/123 eller themoviedb.org/tv/123, en IMDb-kode (tt1234567), eller bare tallet.';
		$('#fix-error').classList.remove('hidden');
		return;
	}
	applyFix(Number(m[2]), m[1] || 'movie');
});
$('#fix-clear').addEventListener('click', () => {
	if (confirm('Fjerne TMDB-matchen for denne filmen? Den vises da uten plakat.')) applyFix(null);
});
$('#fix-cancel').addEventListener('click', closeFix);
$('#fix-modal').addEventListener('click', (e) => e.target.id === 'fix-modal' && closeFix());

/* ---------- Match på nytt (admin) ---------- */
$('#rematch').addEventListener('click', async () => {
	if (!confirm('Prøve å matche alle filmer uten treff på nytt, også mot TV-serier? Det tar noen minutter. Ikke lukk siden underveis.')) return;
	const status = $('#import-status');
	const tot = { exact: 0, fuzzy: 0, tv: 0, none: 0 };
	let after = 0;
	let done = 0;
	try {
		for (;;) {
			let r;
			try {
				r = await api('/api/admin/library/rematch', { method: 'POST', body: JSON.stringify({ after_id: after }) });
			} catch {
				r = await api('/api/admin/library/rematch', { method: 'POST', body: JSON.stringify({ after_id: after }) }); // ett nytt forsøk
			}
			if (!r.processed) break;
			for (const k of Object.keys(tot)) tot[k] += r[k];
			done += r.processed;
			after = r.last_id;
			status.textContent = `Matcher på nytt… ${done} sjekket, ${r.remaining} igjen`;
			if (!r.remaining) break;
		}
		status.textContent = '';
		alert(`Ferdig: ${done} sjekket.\nNye treff: ${tot.exact + tot.fuzzy} (TV-serier: ${tot.tv}, usikre: ${tot.fuzzy})\nFortsatt uten treff: ${tot.none}`);
		if (!$('#tab-library').classList.contains('hidden')) loadLibrary(true);
	} catch (err) {
		status.textContent = '';
		alert('Matching feilet: ' + err.message);
	}
});

/* ---------- Import fra CLZ (admin) ---------- */
function parseCSV(text) {
	const rows = [];
	let row = [], field = '', q = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (q) {
			if (ch === '"') {
				if (text[i + 1] === '"') (field += '"', i++);
				else q = false;
			} else field += ch;
		} else if (ch === '"') q = true;
		else if (ch === ',') (row.push(field), (field = ''));
		else if (ch === '\n' || ch === '\r') {
			if (ch === '\r' && text[i + 1] === '\n') i++;
			row.push(field);
			field = '';
			if (row.some((x) => x !== '')) rows.push(row);
			row = [];
		} else field += ch;
	}
	if (field !== '' || row.length) (row.push(field), rows.push(row));
	return rows;
}

const FORMAT_MAP = { 'blu-ray disc': 'Blu-ray', '4k uhd': '4K UHD', dvd: 'DVD' };
const normFormat = (f) => FORMAT_MAP[f.trim().toLowerCase()] || (/^files?\b/i.test(f.trim()) ? 'Digital' : f.trim());

function groupClz(rows) {
	const head = rows[0].map((h) => h.trim());
	const col = (n) => head.indexOf(n);
	const c = { t: col('Title'), y: col('Release Date'), g: col('Genres'), r: col('Runtime'), d: col('Director'), f: col('Format'), s: col('Distributor'), a: col('Added Date') };
	if (c.t < 0 || c.f < 0) throw new Error('Fant ikke kolonnene Title og Format. Er dette en CLZ-eksport?');
	const map = new Map();
	for (const r of rows.slice(1)) {
		const title = (r[c.t] ?? '').trim();
		if (!title) continue;
		const year = Number(((r[c.y] ?? '').match(/\d{4}/) || [0])[0]) || 0;
		const key = `${title}\u0000${year}`;
		const item = map.get(key) || { title, year, formats: new Set(), genres: r[c.g], runtime: r[c.r], director: r[c.d], dist: new Set(), added_date: r[c.a] };
		for (const f of (r[c.f] ?? '').split('|')) if (f.trim()) item.formats.add(normFormat(f));
		if ((r[c.s] ?? '').trim()) item.dist.add(r[c.s].trim());
		map.set(key, item);
	}
	return [...map.values()]
		.filter((i) => i.formats.size)
		.map((i) => ({ title: i.title, year: i.year, formats: [...i.formats].sort().join('|'), genres: i.genres, runtime: i.runtime, director: i.director, distributor: [...i.dist].join(' / '), added_date: i.added_date }));
}

$('#import-clz').addEventListener('click', () => $('#clz-file').click());
$('#clz-file').addEventListener('change', async (e) => {
	const file = e.target.files[0];
	e.target.value = '';
	if (!file) return;
	const status = $('#import-status');
	try {
		const items = groupClz(parseCSV((await file.text()).replace(/^﻿/, '')));
		if (!confirm(`Importere ${items.length} filmer fra ${file.name}? Dette tar noen minutter. Ikke lukk siden underveis.`)) return;
		const tot = { exact: 0, fuzzy: 0, none: 0, skipped: 0 };
		for (let i = 0; i < items.length; i += 8) {
			status.textContent = `Importerer ${Math.min(i + 8, items.length)} / ${items.length}…`;
			const batch = items.slice(i, i + 8);
			let res;
			try {
				res = await api('/api/admin/library/import', { method: 'POST', body: JSON.stringify({ items: batch }) });
			} catch {
				res = await api('/api/admin/library/import', { method: 'POST', body: JSON.stringify({ items: batch }) }); // ett nytt forsøk
			}
			for (const k of Object.keys(tot)) tot[k] += res[k];
		}
		status.textContent = '';
		alert(`Ferdig: ${items.length} filmer.\nMatchet: ${tot.exact}\nUsikre treff: ${tot.fuzzy}\nIkke funnet i TMDB: ${tot.none}\nAllerede matchet (hoppet over): ${tot.skipped}`);
		if (!$('#tab-library').classList.contains('hidden')) loadLibrary(true);
	} catch (err) {
		status.textContent = '';
		alert('Import feilet: ' + err.message);
	}
});

/* ---------- Faner ---------- */
function setTab(tab) {
	document.querySelectorAll('.tab').forEach((b) => {
		const on = b.dataset.tab === tab;
		b.classList.toggle('bg-amber-400', on);
		b.classList.toggle('text-slate-900', on);
		b.classList.toggle('bg-slate-800', !on);
	});
	$('#tab-search').classList.toggle('hidden', tab !== 'search');
	$('#tab-feed').classList.toggle('hidden', tab !== 'feed');
	$('#tab-library').classList.toggle('hidden', tab !== 'library');
	if (tab === 'feed') loadFeed();
	if (tab === 'library') loadLibrary(true);
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

/* ---------- Søk ---------- */
$('#q').addEventListener('input', (e) => {
	clearTimeout(searchTimer);
	const q = e.target.value.trim();
	if (q.length < 2) {
		$('#results').innerHTML = '';
		$('#search-status').textContent = '';
		return;
	}
	searchTimer = setTimeout(() => search(q), 350);
});

function posterTag(path, title, size = 'w342') {
	return path
		? `<img src="${IMG}${size}${esc(path)}" alt="${esc(title)}" loading="lazy" class="w-full h-full object-cover" />`
		: `<div class="w-full h-full flex items-center justify-center text-slate-500 text-xs p-2 text-center">${esc(title)}</div>`;
}

async function search(q) {
	$('#search-status').textContent = 'Søker…';
	try {
		const { results } = await api('/api/search?q=' + encodeURIComponent(q));
		$('#search-status').textContent = results.length ? '' : 'Ingen treff.';
		$('#results').innerHTML = results
			.map(
				(m) => `
			<button data-movie='${esc(JSON.stringify({ id: m.id, media_type: m.media_type, title: m.title, year: m.year, poster_path: m.poster_path, overview: m.overview }))}'
				class="movie text-left bg-slate-800 rounded-xl overflow-hidden hover:ring-2 hover:ring-amber-400">
				<div class="aspect-[2/3] bg-slate-700">${posterTag(m.poster_path, m.title)}</div>
				<div class="p-2">
					<div class="text-sm font-medium leading-tight">${esc(m.title)}</div>
					<div class="text-xs text-slate-400">${esc(m.year ?? '')}${m.media_type === 'tv' ? ' · TV' : ''}</div>
				</div>
			</button>`,
			)
			.join('');
	} catch (err) {
		$('#search-status').textContent = err.message;
	}
}

$('#results').addEventListener('click', (e) => {
	const btn = e.target.closest('.movie');
	if (btn) openMovie(JSON.parse(btn.dataset.movie));
});

/* ---------- Feed ---------- */
async function loadFeed() {
	$('#feed-status').textContent = 'Henter…';
	try {
		const { results } = await api('/api/recommendations?limit=100');
		$('#feed-status').textContent = results.length ? '' : 'Ingen anbefalinger ennå. Søk opp en film og bli den første!';
		$('#feed').innerHTML = results
			.map(
				(r) => `
			<div class="relative">
				<button data-movie='${esc(JSON.stringify({ id: r.tmdb_id, title: r.title, poster_path: r.poster_path }))}'
					class="movie-feed w-full flex gap-3 text-left bg-slate-800 rounded-xl p-3 hover:ring-2 hover:ring-amber-400">
					<div class="w-16 shrink-0 aspect-[2/3] bg-slate-700 rounded overflow-hidden">${posterTag(r.poster_path, r.title, 'w154')}</div>
					<div class="min-w-0 pr-12">
						<div class="font-semibold">${esc(r.title)}</div>
						<div class="text-sm text-amber-300">${dice(r.rating)} <span class="text-slate-400">· ${esc(r.username)} · ${fmtDate(r.created_at)}</span></div>
						${r.comment ? `<p class="text-sm text-slate-300 mt-1 break-words">${esc(r.comment)}</p>` : ''}
						${libBadge(r.library_formats)}
					</div>
				</button>
				${r.username === me || isAdmin ? `<button data-feed-del="${r.id}" class="absolute top-3 right-3 text-xs text-red-400 hover:underline">Slett</button>` : ''}
			</div>`,
			)
			.join('');
	} catch (err) {
		$('#feed-status').textContent = err.message;
	}
}

$('#feed').addEventListener('click', async (e) => {
	const del = e.target.closest('[data-feed-del]');
	if (del) {
		if (!confirm('Slette denne anbefalingen?')) return;
		try {
			await api(`/api/recommendations/${del.dataset.feedDel}?username=${encodeURIComponent(me)}`, { method: 'DELETE' });
			loadFeed();
		} catch (err) {
			alert(err.message);
		}
		return;
	}
	const btn = e.target.closest('.movie-feed');
	if (btn) openMovie(JSON.parse(btn.dataset.movie));
});

/* ---------- Detaljark ---------- */
function closeModal() {
	$('#modal').classList.add('hidden');
	document.body.classList.remove('overflow-hidden');
}
$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => e.target.id === 'modal' && closeModal());
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeModal());

function providerRow(label, list) {
	if (!list?.length) return '';
	return `
		<div class="mb-2">
			<div class="text-xs uppercase tracking-wide text-slate-400 mb-1">${label}</div>
			<div class="flex flex-wrap gap-2">
				${list
					.map(
						(p) => `<img src="${IMG}w92${esc(p.logo_path)}" alt="${esc(p.name)}" title="${esc(p.name)}" class="w-10 h-10 rounded-lg" />`,
					)
					.join('')}
			</div>
		</div>`;
}

async function openMovie(movie) {
	const mt = movie.media_type === 'tv' ? 'tv' : 'movie';
	const isTv = mt === 'tv';
	$('#modal').classList.remove('hidden');
	document.body.classList.add('overflow-hidden');
	$('#modal-body').innerHTML = `
		<div class="flex gap-4 pr-6">
			<div class="w-28 shrink-0 aspect-[2/3] bg-slate-700 rounded-lg overflow-hidden">${posterTag(movie.poster_path, movie.title, 'w342')}</div>
			<div class="min-w-0">
				<h2 class="text-xl font-bold leading-tight">${esc(movie.title)}</h2>
				<div class="text-slate-400 text-sm">${esc(movie.year ?? '')}</div>
				<div id="lib-badge"></div>
				${movie.overview ? `<p class="text-sm text-slate-300 mt-2 line-clamp-6">${esc(movie.overview)}</p>` : ''}
			</div>
		</div>

		<h3 class="font-semibold mt-5 mb-2">Hvor kan du se den i Norge?</h3>
		<div id="providers" class="text-sm text-slate-400">Henter…</div>

		${
			isTv
				? '<p class="text-xs text-slate-500 mt-5">TV-serie: anbefalinger gjelder bare filmer.</p>'
				: '<h3 class="font-semibold mt-5 mb-2">Anbefalinger</h3><div id="recs" class="space-y-2 text-sm text-slate-400">Henter…</div>'
		}

		${isTv ? '' : `<form id="rec-form" class="mt-5 border-t border-slate-700 pt-4 space-y-3">
			<h3 class="font-semibold">Din anbefaling</h3>
			<div id="dice" class="flex gap-2"></div>
			<textarea id="comment" rows="3" maxlength="1000" placeholder="Kommentar (valgfritt)"
				class="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-400"></textarea>
			<p id="rec-error" class="text-red-400 text-sm hidden"></p>
			<button class="w-full rounded-lg bg-amber-400 text-slate-900 font-semibold py-3 hover:bg-amber-300">Lagre anbefaling</button>
		</form>`}`;

	let rating = 0;
	const renderDice = () => {
		if (!$('#dice')) return;
		$('#dice').innerHTML = [1, 2, 3, 4, 5, 6]
			.map(
				(n) => `<button type="button" data-n="${n}" aria-label="Terningkast ${n}"
					class="flex-1 rounded-lg py-2 text-lg font-bold ${n === rating ? 'bg-amber-400 text-slate-900' : 'bg-slate-900 border border-slate-700 hover:border-amber-400'}">${n}</button>`,
			)
			.join('');
	};
	renderDice();
	$('#dice')?.addEventListener('click', (e) => {
		const b = e.target.closest('button');
		if (b) {
			rating = Number(b.dataset.n);
			renderDice();
		}
	});

	// Strømmetjenester + eksisterende anbefalinger + bibliotek parallelt
	api(`/api/library?tmdb_id=${movie.id}&media_type=${mt}`)
		.then(({ results }) => {
			const el = $('#lib-badge');
			if (el) el.innerHTML = libBadge(results.map((r) => r.formats).join('|'));
		})
		.catch(() => {});
	const [prov, recs] = await Promise.allSettled([
		api(`/api/${mt}/${movie.id}/providers`),
		isTv ? Promise.resolve({ results: [] }) : api(`/api/recommendations?tmdb_id=${movie.id}`),
	]);

	if (prov.status === 'fulfilled') {
		const p = prov.value;
		const html =
			providerRow('Strøm', p.flatrate) +
			providerRow('Gratis', p.free) +
			providerRow('Med reklame', p.ads) +
			providerRow('Leie', p.rent) +
			providerRow('Kjøp', p.buy);
		$('#providers').innerHTML = html
			? html + (p.link ? `<a href="${esc(p.link)}" target="_blank" rel="noopener" class="text-xs underline text-slate-400">Se på JustWatch</a>` : '')
			: 'Ikke tilgjengelig hos norske tjenester akkurat nå.';
	} else {
		$('#providers').textContent = 'Kunne ikke hente strømmetjenester.';
	}

	if (!isTv && recs.status === 'fulfilled') {
		const list = recs.value.results;
		$('#recs').innerHTML = list.length
			? list
					.map(
						(r) => `<div class="bg-slate-900 rounded-lg p-3">
							<div class="text-amber-300">${dice(r.rating)} <span class="text-slate-400">· ${esc(r.username)} · ${fmtDate(r.created_at)}</span>
								${r.username === me || isAdmin ? `<button data-del="${r.id}" class="float-right text-xs text-red-400 hover:underline">Slett</button>` : ''}</div>
							${r.comment ? `<p class="text-slate-300 mt-1 break-words">${esc(r.comment)}</p>` : ''}
						</div>`,
					)
					.join('')
			: 'Ingen har anbefalt denne ennå.';
		const mine = list.find((r) => r.username === me);
		if (mine) {
			rating = mine.rating;
			$('#comment').value = mine.comment ?? '';
			renderDice();
		}
	} else if (!isTv) {
		$('#recs').textContent = 'Kunne ikke hente anbefalinger.';
	}

	$('#recs')?.addEventListener('click', async (e) => {
		const id = e.target.dataset.del;
		if (!id || !confirm('Slette denne anbefalingen?')) return;
		await api(`/api/recommendations/${id}?username=${encodeURIComponent(me)}`, { method: 'DELETE' });
		openMovie(movie);
		if (!$('#tab-feed').classList.contains('hidden')) loadFeed();
	});

	$('#rec-form')?.addEventListener('submit', async (e) => {
		e.preventDefault();
		const err = $('#rec-error');
		err.classList.add('hidden');
		if (!me) return showErr('Velg navnet ditt øverst først.');
		if (!rating) return showErr('Velg terningkast 1–6.');
		try {
			await api('/api/recommendations', {
				method: 'POST',
				body: JSON.stringify({
					tmdb_id: movie.id,
					title: movie.title,
					poster_path: movie.poster_path,
					username: me,
					rating,
					comment: $('#comment').value,
				}),
			});
			closeModal();
			setTab('feed');
		} catch (ex) {
			showErr(ex.message);
		}
		function showErr(msg) {
			err.textContent = msg;
			err.classList.remove('hidden');
		}
	});
}

start();
