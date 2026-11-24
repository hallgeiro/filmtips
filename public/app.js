const IMG = 'https://image.tmdb.org/t/p/';
const $ = (s) => document.querySelector(s);
// Enkelt øye-ikon (strek, arver tekstfargen) i stedet for emoji
const EYE =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="inline-block h-4 w-4 align-[-2px]" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
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
	if (res.status === 401 && path !== '/api/pin-login' && path !== '/api/admin/login') {
		showLogin();
		throw new Error('Ikke innlogget');
	}
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error || 'Noe gikk galt');
	return data;
}

const fmtDate = (s) =>
	new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString('nb-NO', { day: 'numeric', month: 'short', year: 'numeric' });
const dice = (n) => `⭐ ${n}/10`;

/* ---------- Innlogging ---------- */
let pinUsers = [];
const selectedLoginUser = () => $('#login-user').value;

function updateLoginMode() {
	const creating = !pinUsers.includes(selectedLoginUser());
	$('#login-pin2').classList.toggle('hidden', !creating);
	$('#login-btn').textContent = creating ? 'Lag PIN og logg inn' : 'Logg inn';
	$('#login-help').textContent = creating
		? 'Dette navnet har ingen PIN ennå. Velg 6 siffer og skriv dem to ganger. Glemmer du den, kan admin nullstille den.'
		: 'Skriv inn PIN-en din (6 siffer).';
	$('#login-pin').value = '';
	$('#login-pin2').value = '';
	$('#pin-login-error').classList.add('hidden');
	$('#login-pin').focus();
}

async function showLogin() {
	$('#app').classList.add('hidden');
	$('#login').classList.remove('hidden');
	let loginUsers = [];
	try {
		({ users: loginUsers, pinUsers } = await (await fetch('/api/login-info')).json());
	} catch {
		pinUsers = [];
	}
	let last = '';
	try {
		last = localStorage.getItem('filmtips_login_user') || '';
	} catch {}
	$('#login-user').innerHTML = loginUsers.map((u) => `<option ${u === last ? 'selected' : ''}>${esc(u)}</option>`).join('');
	updateLoginMode();
}

$('#login-user').addEventListener('change', () => {
	try {
		localStorage.setItem('filmtips_login_user', selectedLoginUser());
	} catch {}
	updateLoginMode();
});

$('#pin-login-form').addEventListener('submit', async (e) => {
	e.preventDefault();
	const showErr = (msg) => {
		$('#pin-login-error').textContent = msg;
		$('#pin-login-error').classList.remove('hidden');
	};
	$('#pin-login-error').classList.add('hidden');
	const name = selectedLoginUser();
	const pin = $('#login-pin').value.trim();
	const creating = !pinUsers.includes(name);
	if (!/^\d{6}$/.test(pin)) return showErr('PIN må være 6 siffer.');
	if (creating && pin !== $('#login-pin2').value.trim()) return showErr('PIN-ene er ikke like.');
	try {
		await api('/api/pin-login', { method: 'POST', body: JSON.stringify({ username: name, pin, create: creating }) });
		$('#login-pin').value = '';
		$('#login-pin2').value = '';
		await start();
	} catch (err) {
		showErr(err.message);
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
		if (!$('#tab-nights').classList.contains('hidden')) loadNights();
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
			? 'Velg 6 siffer. Du bruker den når du velger dette navnet. Glemmer du den, kan admin nullstille den.'
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
			if (!(creating ? /^\d{6}$/ : /^\d{4,6}$/).test(pin)) return showErr(creating ? 'PIN må være 6 siffer.' : 'PIN må være 4–6 siffer.');
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
		// Mangler navnet PIN, kan admin velge å lage den nå (trengs for å logge inn med navn + PIN)
		if (wanted && !hasPin.includes(wanted) && confirm(`${wanted} har ingen PIN. Lage en PIN nå? (Avbryt = fortsett som admin uten PIN)`)) {
			if (await askPin(wanted)) await refreshConfig();
		}
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
		const name = me;
		await api('/api/admin/reset-pin', { method: 'POST', body: JSON.stringify({ username: name }) });
		me = ''; // velg navnet på nytt for å lage ny PIN
		await refreshConfig();
		alert(`PIN for ${name} er nullstilt. Velg navnet i listen på nytt for å lage en ny PIN (6 siffer).`);
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
const lib = { view: 'grid', kind: 'physical', q: '', format: '', review: false, sort: 'title', decade: 0, director: '', facets: null, lastKey: null, offset: 0, total: 0, timer: null };
const firstDirector = (d) => String(d ?? '').split('|')[0].trim();

const fmtLabel = (f) => (f === 'Digital' ? 'Fil' : f);

function libBadge(formats) {
	const list = [...new Set(String(formats ?? '').split('|').map((f) => f.trim()).filter(Boolean))];
	const physical = list.filter((f) => f !== 'Digital');
	const files = list.includes('Digital');
	if (!physical.length && !files) return '';
	const pill = (txt) => `<span class="inline-block rounded-full bg-emerald-900/60 text-emerald-300 text-xs px-2 py-1">${txt}</span>`;
	return `<div class="mt-2 flex flex-wrap gap-1">${physical.length ? pill(`📀 I biblioteket: ${physical.map(esc).join(' · ')}`) : ''}${files ? pill('💾 I filsamlingen') : ''}</div>`;
}

function renderKinds() {
	const kinds = [['physical', '📀 Fysisk bibliotek'], ['files', '💾 Filsamling'], ['', 'Alle']];
	$('#lib-kinds').innerHTML = kinds
		.map(([k, label]) => `<button data-k="${k}" class="flex-1 rounded-lg py-2 text-sm ${lib.kind === k ? 'bg-emerald-600 text-white font-semibold' : 'bg-slate-800 text-slate-300'}">${label}</button>`)
		.join('');
}

function renderFormatChips() {
	const chip = (f, label, on) =>
		`<button data-f="${esc(f)}" class="rounded-full px-3 py-1 text-xs ${on ? 'bg-amber-400 text-slate-900' : 'bg-slate-800 text-slate-300'}">${label}</button>`;
	const formats = lib.kind === 'files' ? [] : lib.kind === 'physical' ? FORMAT_FILTERS.filter((f) => f !== 'Digital') : FORMAT_FILTERS;
	$('#lib-formats').innerHTML =
		[...(formats.length ? [''] : []), ...formats].map((f) => chip(f, f ? fmtLabel(f) : 'Alle', !lib.review && lib.format === f)).join('') +
		(isAdmin ? chip('__review', '⚠ Å sjekke', lib.review) : '');
}

function loadLibView() {
	try {
		lib.view = localStorage.getItem('filmtips_lib_view') === 'list' ? 'list' : 'grid';
	} catch {}
}

function applyLibView() {
	const list = lib.view === 'list';
	const cls = list ? 'flex flex-col gap-2 mt-3' : 'grid grid-cols-2 sm:grid-cols-3 gap-3 mt-3';
	$('#lib-list').className = cls;
	$('#results').className = cls;
	for (const id of ['#lib-view', '#search-view']) {
		$(id).textContent = list ? '▦' : '☰';
		$(id).title = list ? 'Vis som bildegalleri' : 'Vis som liste';
	}
}

function toggleView() {
	lib.view = lib.view === 'list' ? 'grid' : 'list';
	try {
		localStorage.setItem('filmtips_lib_view', lib.view);
	} catch {}
	applyLibView();
}

function renderDecades() {
	const sel = $('#lib-decades');
	sel.classList.toggle('hidden', !lib.facets);
	if (!lib.facets) return;
	sel.innerHTML =
		`<option value="0">Alle tiår</option>` +
		lib.facets.map((f) => `<option value="${f.decade}">${f.decade}-tallet</option>`).join('');
	sel.value = String(lib.decade);
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

function libItemHtml(m) {
	const list = lib.view === 'list';
	const movieAttr = m.tmdb_id
		? `data-movie='${esc(JSON.stringify({ id: m.tmdb_id, media_type: m.media_type, title: m.title, year: m.year || null, poster_path: m.poster_path }))}'`
		: 'disabled';
	const hover = m.tmdb_id ? 'hover:ring-2 hover:ring-amber-400' : 'opacity-70';
	const dirTag = m.director
		? `<span data-dir="${esc(firstDirector(m.director))}" class="inline-block text-xs text-slate-400 hover:text-amber-300 hover:underline">${esc(firstDirector(m.director))}</span>`
		: '';
	const notes = `${m.match === 'fuzzy' ? '<div class="text-xs text-amber-400">usikker match</div>' : ''}${m.tmdb_id ? '' : m.collection ? '<div class="text-xs text-sky-400">Samling</div>' : '<div class="text-xs text-slate-500">ikke funnet i TMDB</div>'}`;
	const meta = `${m.year || ''}${m.media_type === 'tv' ? ' · TV' : ''} · ${esc(m.formats.split('|').map(fmtLabel).join(' · '))}`;
	const fix = isAdmin
		? `<button data-fix='${esc(JSON.stringify({ id: m.id, title: m.title, year: m.year }))}' class="fix-btn absolute ${list ? 'top-1/2 -translate-y-1/2 right-2' : 'top-2 right-2'} rounded bg-slate-900/90 text-xs px-2 py-1 hover:bg-amber-400 hover:text-slate-900">Rett</button>`
		: '';
	if (list) {
		return `
			<div class="relative">
			<button ${movieAttr} class="lib-item w-full text-left bg-slate-800 rounded-xl overflow-hidden flex items-center gap-3 p-2 ${isAdmin ? 'pr-16' : ''} ${hover}">
				<div class="w-10 shrink-0 aspect-[2/3] bg-slate-700 rounded overflow-hidden">${posterTag(m.poster_path, '', 'w92')}</div>
				<div class="min-w-0 flex-1">
					<div class="text-sm font-medium leading-tight">${esc(m.title)}</div>
					<div class="text-xs text-slate-400">${meta}</div>
					${dirTag}${notes}
				</div>
			</button>
			${fix}
			</div>`;
	}
	return `
			<div class="relative">
			<button ${movieAttr}
				class="lib-item w-full text-left bg-slate-800 rounded-xl overflow-hidden ${hover}">
				<div class="aspect-[2/3] bg-slate-700">${posterTag(m.poster_path, m.title)}</div>
				<div class="p-2">
					<div class="text-sm font-medium leading-tight">${esc(m.title)}</div>
					<div class="text-xs text-slate-400">${meta}</div>
					${dirTag}${notes}
				</div>
			</button>
			${fix}
			</div>`;
}

async function loadLibrary(reset) {
	$('#lib-add').classList.toggle('hidden', !isAdmin);
	if (reset) {
		lib.offset = 0;
		lib.lastKey = null;
		$('#lib-list').innerHTML = '';
		renderKinds();
		renderFormatChips();
		renderDirChip();
		if (!lib.facets) {
			api('/api/library/facets?kind=' + lib.kind)
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
		if (lib.kind) params.set('kind', lib.kind);
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
				.map((m) => groupHeading(m) + libItemHtml(m))
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
$('#lib-kinds').addEventListener('click', (e) => {
	const b = e.target.closest('button');
	if (!b) return;
	lib.kind = b.dataset.k;
	lib.format = '';
	lib.review = false;
	lib.decade = 0;
	lib.facets = null;
	loadLibrary(true);
});
$('#lib-formats').addEventListener('click', (e) => {
	const b = e.target.closest('button');
	if (!b) return;
	lib.review = b.dataset.f === '__review';
	lib.format = lib.review ? '' : b.dataset.f;
	loadLibrary(true);
});
$('#lib-more').addEventListener('click', () => loadLibrary(false));
$('#lib-view').addEventListener('click', () => {
	toggleView();
	loadLibrary(true);
});
$('#search-view').addEventListener('click', () => {
	toggleView();
	renderSearchResults();
});
loadLibView();
applyLibView();
$('#lib-sort').addEventListener('change', (e) => {
	lib.sort = e.target.value;
	loadLibrary(true);
});
$('#lib-decades').addEventListener('change', (e) => {
	lib.decade = Number(e.target.value);
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
			`<button data-fmt="${esc(f)}" class="rounded-full px-3 py-2 text-sm ${addFormats.has(f) ? 'bg-amber-400 text-slate-900 font-semibold' : 'bg-slate-900 border border-slate-700 text-slate-300'}">${f === 'Digital' ? '💾 Fil (digital)' : f}</button>`,
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
	addFormats = new Set(lib.kind === 'files' ? ['Digital'] : []); // forhåndsvalgt i filsamlingen
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
	if (!confirm('Kryssjekke titler uten treff og usikre treff (regissør, alternative titler, OMDb og Wikidata)? Det tar flere minutter. Ikke lukk siden underveis.')) return;
	const status = $('#import-status');
	const tot = { exact: 0, fuzzy: 0, tv: 0, collection: 0, none: 0 };
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
		alert(`Ferdig: ${done} sjekket.\nBekreftet eller nye treff: ${tot.exact}\nNye usikre treff: ${tot.fuzzy}\nMerket som samling: ${tot.collection}\nUendret: ${tot.none}`);
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
	$('#tab-nights').classList.toggle('hidden', tab !== 'nights');
	$('#tab-lists').classList.toggle('hidden', tab !== 'lists');
	if (tab === 'lists') applyListsSub();
	if (tab === 'nights') loadNights();
	if (tab === 'feed') loadFeed();
	if (tab === 'library') loadLibrary(true);
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

/* ---------- Søk ---------- */
$('#q').addEventListener('input', (e) => {
	clearTimeout(searchTimer);
	const q = e.target.value.trim();
	if (q.length < 2) {
		lastSearchResults = [];
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

let lastSearchResults = [];

function searchItemHtml(m) {
	const data = esc(JSON.stringify({ id: m.id, media_type: m.media_type, title: m.title, year: m.year, poster_path: m.poster_path, overview: m.overview }));
	const meta = `${esc(m.year ?? '')}${m.media_type === 'tv' ? ' · TV' : ''}`;
	if (lib.view === 'list') {
		return `
			<button data-movie='${data}' class="movie w-full text-left bg-slate-800 rounded-xl overflow-hidden flex items-center gap-3 p-2 hover:ring-2 hover:ring-amber-400">
				<div class="w-10 shrink-0 aspect-[2/3] bg-slate-700 rounded overflow-hidden">${posterTag(m.poster_path, '', 'w92')}</div>
				<div class="min-w-0 flex-1">
					<div class="text-sm font-medium leading-tight">${esc(m.title)}</div>
					<div class="text-xs text-slate-400">${meta}</div>
				</div>
			</button>`;
	}
	return `
			<button data-movie='${data}'
				class="movie text-left bg-slate-800 rounded-xl overflow-hidden hover:ring-2 hover:ring-amber-400">
				<div class="aspect-[2/3] bg-slate-700">${posterTag(m.poster_path, m.title)}</div>
				<div class="p-2">
					<div class="text-sm font-medium leading-tight">${esc(m.title)}</div>
					<div class="text-xs text-slate-400">${meta}</div>
				</div>
			</button>`;
}

function renderSearchResults() {
	$('#results').innerHTML = lastSearchResults.map(searchItemHtml).join('');
}

async function search(q) {
	$('#search-status').textContent = 'Søker…';
	try {
		const { results } = await api('/api/search?q=' + encodeURIComponent(q));
		$('#search-status').textContent = results.length ? '' : 'Ingen treff.';
		lastSearchResults = results;
		renderSearchResults();
	} catch (err) {
		$('#search-status').textContent = err.message;
	}
}

$('#results').addEventListener('click', (e) => {
	const btn = e.target.closest('.movie');
	if (btn) openMovie(JSON.parse(btn.dataset.movie));
});

/* ---------- Kommentarer på anbefalinger ---------- */
function commentStrip(r) {
	const n = Number(r.comment_count) || 0;
	return `<div class="mt-1 px-1">
		<button data-thread-toggle="${r.id}" class="text-xs text-slate-400 hover:text-amber-300">${commentLabel(n)}</button>
		<div data-thread="${r.id}" class="hidden mt-2 space-y-2"></div>
	</div>`;
}

const commentLabel = (n) => (n ? `💬 ${n} ${n === 1 ? 'kommentar' : 'kommentarer'}` : '💬 Kommenter');

async function loadThread(recId, box) {
	box.innerHTML = '<div class="text-xs text-slate-500">Henter…</div>';
	try {
		const { results } = await api(`/api/recommendations/${recId}/comments`);
		box.innerHTML =
			results
				.map(
					(cm) => `<div class="bg-slate-900 rounded-lg px-3 py-2 text-sm">
						<div class="text-xs text-slate-400">${esc(cm.username)} · ${fmtDate(cm.created_at)}${cm.username === me || isAdmin ? ` <button data-cm-del="${cm.id}" class="ml-2 text-red-400 hover:underline">Slett</button>` : ''}</div>
						<p class="text-slate-200 break-words whitespace-pre-line">${esc(cm.body)}</p>
					</div>`,
				)
				.join('') +
			`<form data-cm-form="${recId}" class="flex gap-2">
				<input maxlength="500" placeholder="Skriv en kommentar…" autocomplete="off"
					class="flex-1 min-w-0 rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400" />
				<button class="rounded-lg bg-amber-400 text-slate-900 text-sm font-semibold px-3">Send</button>
			</form>`;
		for (const t of document.querySelectorAll(`[data-thread-toggle="${recId}"]`)) t.textContent = commentLabel(results.length);
	} catch (err) {
		box.innerHTML = `<div class="text-xs text-red-400">${esc(err.message)}</div>`;
	}
}

// Klikk på åpne/lukk og slett. Returnerer true hvis klikket var for kommentarer.
async function threadClick(e) {
	const tog = e.target.closest('[data-thread-toggle]');
	if (tog) {
		const box = tog.parentElement.querySelector('[data-thread]');
		const hiddenNow = box.classList.toggle('hidden');
		if (!hiddenNow) await loadThread(tog.dataset.threadToggle, box);
		return true;
	}
	const del = e.target.closest('[data-cm-del]');
	if (del) {
		if (!confirm('Slette kommentaren?')) return true;
		const box = del.closest('[data-thread]');
		try {
			await api(`/api/comments/${del.dataset.cmDel}`, { method: 'DELETE' });
			await loadThread(box.dataset.thread, box);
		} catch (err) {
			alert(err.message);
		}
		return true;
	}
	return false;
}

async function threadSubmit(e) {
	const form = e.target.closest('[data-cm-form]');
	if (!form) return;
	e.preventDefault();
	const box = form.closest('[data-thread]');
	const input = form.querySelector('input');
	const body = input.value.trim();
	if (!body) return;
	if (!me) return alert('Velg navnet ditt først.');
	try {
		await api(`/api/recommendations/${form.dataset.cmForm}/comments`, { method: 'POST', body: JSON.stringify({ username: me, body }) });
		await loadThread(box.dataset.thread, box);
	} catch (err) {
		alert(err.message);
	}
}

/* ---------- Filmlister ---------- */
let listId = null;
let listsSub = 'lists'; // «Lister» eller «Sett» i fanen Lister

const seenVisible = () => !$('#tab-lists').classList.contains('hidden') && !$('#tab-seen').classList.contains('hidden');

function applyListsSub() {
	const seen = listsSub === 'seen';
	$('#lists-main').classList.toggle('hidden', seen);
	$('#tab-seen').classList.toggle('hidden', !seen);
	if (seen) loadSeen();
	else loadLists();
}
$('#seen-back').addEventListener('click', () => {
	listsSub = 'lists';
	applyListsSub();
});
let currentList = null;
let listKeys = new Set(); // "media_type:tmdb_id" for filmer som allerede er i åpen liste
let listTimer;
const INPUT_CLS = 'w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-amber-400';

function listFormHtml(v = {}) {
	return `<form data-list-form="${v.id ?? ''}" class="bg-slate-800 rounded-xl p-3 space-y-2">
		<input name="title" maxlength="100" value="${esc(v.title ?? '')}" placeholder="Navn, f.eks. Favorittfilmer eller Film noir" autocomplete="off" class="${INPUT_CLS}" />
		<input name="description" maxlength="500" value="${esc(v.description ?? '')}" placeholder="Beskrivelse (valgfri)" autocomplete="off" class="${INPUT_CLS}" />
		<label class="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" name="ranked" ${v.ranked ? 'checked' : ''} /> Rangert liste (nummerert, du bestemmer rekkefølgen)</label>
		<p data-list-err class="text-red-400 text-sm hidden"></p>
		<div class="flex gap-2">
			<button class="flex-1 rounded-lg bg-amber-400 text-slate-900 font-semibold py-2">Lagre</button>
			<button type="button" data-list-cancel class="flex-1 rounded-lg bg-slate-900 border border-slate-700 py-2 text-sm">Avbryt</button>
		</div>
	</form>`;
}

async function loadLists() {
	if (listId) return openList(listId);
	$('#lists-view').classList.remove('hidden');
	$('#list-detail').classList.add('hidden');
	$('#lists-status').textContent = 'Henter…';
	try {
		const seenUsers = [...(users.includes(me) ? [me] : []), ...users.filter((u) => u !== me)]
		const [{ results }, ...seenAll] = await Promise.all([
			api('/api/lists'),
			...seenUsers.map((u) => api(`/api/films/${encodeURIComponent(u)}`).then((r) => r.results).catch(() => [])),
		])
		$('#lists-status').textContent = results.length ? '' : 'Ingen lister ennå. Lag den første!'
		const seenCard = seenUsers
			.map((u, i) => {
				const mineSeen = seenAll[i]
				const ratedSeen = mineSeen.filter((m) => m.rating)
				const avgSeen = ratedSeen.length ? Math.round((ratedSeen.reduce((a, m) => a + m.rating, 0) / ratedSeen.length) * 10) / 10 : null
				const seenPosters = mineSeen.filter((m) => m.poster_path).slice(0, 3).map((m) => m.poster_path)
				return `
			<button data-list-seen="${esc(u)}" class="w-full text-left bg-slate-800 rounded-xl p-3 hover:ring-2 hover:ring-amber-400 flex gap-3 ring-1 ring-slate-700">
				<div class="flex -space-x-3 shrink-0 items-center w-24 ${seenPosters.length ? '' : 'justify-center text-slate-300'}">
					${seenPosters.length ? seenPosters.map((pp) => `<img src="${IMG}w92${esc(pp)}" alt="" loading="lazy" class="w-10 aspect-[2/3] object-cover rounded border border-slate-800" />`).join('') : EYE.replace('h-4 w-4', 'h-8 w-8')}
				</div>
				<div class="min-w-0">
					<div class="font-semibold">${EYE} Sett – ${esc(u)}</div>
					<div class="text-sm text-slate-400">${mineSeen.length} ${mineSeen.length === 1 ? 'film' : 'filmer'}${ratedSeen.length ? ` · ${ratedSeen.length} med karakter` : ''}${avgSeen ? ` · snitt ${avgSeen}/10` : ''}</div>
				</div>
			</button>`
			})
			.join('')
		$('#lists-list').innerHTML = results
			.map(
				(l) => `
			<button data-list="${l.id}" class="w-full text-left bg-slate-800 rounded-xl p-3 hover:ring-2 hover:ring-amber-400 flex gap-3">
				<div class="flex -space-x-3 shrink-0 items-center w-24 ${l.posters.length ? '' : 'justify-center text-3xl'}">
					${l.posters.length ? l.posters.slice(0, 3).map((pp) => `<img src="${IMG}w92${esc(pp)}" alt="" loading="lazy" class="w-10 aspect-[2/3] object-cover rounded border border-slate-800" />`).join('') : '📋'}
				</div>
				<div class="min-w-0">
					<div class="font-semibold">${esc(l.title)}</div>
					<div class="text-sm text-slate-400">av ${esc(l.username)} · ${l.item_count} ${l.item_count === 1 ? 'film' : 'filmer'}${l.ranked ? ' · rangert' : ''}</div>
					${l.description ? `<p class="text-sm text-slate-300 mt-1 break-words">${esc(l.description)}</p>` : ''}
				</div>
			</button>`,
			)
			.join('') + seenCard;
	} catch (err) {
		$('#lists-status').textContent = err.message;
	}
}

$('#list-new').addEventListener('click', () => {
	if (!me) return alert('Velg navnet ditt først.');
	const box = $('#list-create');
	box.innerHTML = listFormHtml();
	box.classList.remove('hidden');
	box.querySelector('[name=title]').focus();
});

$('#lists-list').addEventListener('click', (e) => {
	const sb = e.target.closest('[data-list-seen]');
	if (sb) {
		seenState.user = sb.dataset.listSeen;
		listsSub = 'seen';
		applyListsSub();
		return;
	}
	const b = e.target.closest('[data-list]');
	if (b) openList(Number(b.dataset.list));
});

$('#list-back').addEventListener('click', () => {
	listId = null;
	$('#list-results').innerHTML = '';
	$('#list-q').value = '';
	loadLists();
});

async function openList(id) {
	listId = id;
	$('#lists-view').classList.add('hidden');
	$('#list-detail').classList.remove('hidden');
	try {
		const { list, items, can_edit } = await api(`/api/lists/${id}`);
		currentList = list;
		listKeys = new Set(items.map((i) => `${i.media_type}:${i.tmdb_id}`));
		$('#list-head').innerHTML = `
			<h2 class="text-xl font-bold break-words">${esc(list.title)}</h2>
			<div class="text-sm text-slate-400">av ${esc(list.username)} · ${items.length} ${items.length === 1 ? 'film' : 'filmer'}${list.ranked ? ' · rangert' : ''}</div>
			${list.description ? `<p class="text-sm text-slate-300 mt-1 break-words">${esc(list.description)}</p>` : ''}
			${can_edit ? `<div class="mt-2 flex gap-4 text-sm"><button data-list-edit class="underline text-slate-300 hover:text-white">Rediger</button><button data-list-delete class="underline text-red-400">Slett liste</button></div>` : ''}`;
		$('#list-add').classList.toggle('hidden', !can_edit);
		$('#list-items').innerHTML = items.length
			? items
					.map(
						(m, i) => `
			<div class="flex items-center gap-2 bg-slate-800 rounded-xl p-2">
				${list.ranked ? `<div class="w-7 shrink-0 text-center text-amber-300 font-semibold">${i + 1}</div>` : ''}
				<button data-movie='${esc(JSON.stringify({ id: m.tmdb_id, media_type: m.media_type, title: m.title, year: m.year, poster_path: m.poster_path }))}' class="list-movie flex items-center gap-3 flex-1 min-w-0 text-left">
					<div class="w-10 shrink-0 aspect-[2/3] bg-slate-700 rounded overflow-hidden">${posterTag(m.poster_path, m.title, 'w92')}</div>
					<div class="min-w-0">
						<div class="text-sm font-medium leading-tight">${esc(m.title)}</div>
						<div class="text-xs text-slate-400">${esc(m.year ?? '')}${m.media_type === 'tv' ? ' · TV' : ''}</div>
						${libBadge(m.library_formats)}
					</div>
				</button>
				${can_edit ? `<div class="flex shrink-0 items-center gap-1">
					${list.ranked ? `<button data-item-move="${m.id}" data-dir="up" ${i === 0 ? 'disabled' : ''} class="px-2 py-1 text-slate-300 disabled:opacity-25" aria-label="Flytt opp">▲</button><button data-item-move="${m.id}" data-dir="down" ${i === items.length - 1 ? 'disabled' : ''} class="px-2 py-1 text-slate-300 disabled:opacity-25" aria-label="Flytt ned">▼</button>` : ''}
					<button data-item-del="${m.id}" class="px-2 py-1 text-red-400" aria-label="Fjern fra listen">✕</button>
				</div>` : ''}
			</div>`,
					)
					.join('')
			: `<p class="text-sm text-slate-400">${can_edit ? 'Ingen filmer ennå. Søk over for å legge til.' : 'Ingen filmer i listen ennå.'}</p>`;
	} catch (err) {
		listId = null;
		alert(err.message);
		loadLists();
	}
}

// Skjema: opprett, rediger, avbryt
$('#tab-lists').addEventListener('submit', async (e) => {
	const form = e.target.closest('[data-list-form]');
	if (!form) return;
	e.preventDefault();
	const errEl = form.querySelector('[data-list-err]');
	errEl.classList.add('hidden');
	const f = form.elements; // merk: form.title er attributtet «title», ikke feltet
	const body = { title: f.title.value, description: f.description.value, ranked: f.ranked.checked };
	try {
		if (form.dataset.listForm) {
			await api(`/api/lists/${form.dataset.listForm}`, { method: 'PATCH', body: JSON.stringify(body) });
			$('#list-edit').classList.add('hidden');
			openList(Number(form.dataset.listForm));
		} else {
			const r = await api('/api/lists', { method: 'POST', body: JSON.stringify({ ...body, username: me }) });
			$('#list-create').classList.add('hidden');
			openList(r.id);
		}
	} catch (err) {
		errEl.textContent = err.message;
		errEl.classList.remove('hidden');
	}
});

$('#tab-lists').addEventListener('click', async (e) => {
	if (e.target.closest('[data-list-cancel]')) {
		$('#list-create').classList.add('hidden');
		$('#list-edit').classList.add('hidden');
		return;
	}
	if (e.target.closest('[data-list-edit]')) {
		$('#list-edit').innerHTML = listFormHtml(currentList);
		$('#list-edit').classList.remove('hidden');
		return;
	}
	if (e.target.closest('[data-list-delete]')) {
		if (!confirm(`Slette listen «${currentList.title}»?`)) return;
		try {
			await api(`/api/lists/${listId}`, { method: 'DELETE' });
			listId = null;
			loadLists();
		} catch (err) {
			alert(err.message);
		}
		return;
	}
	const del = e.target.closest('[data-item-del]');
	if (del) {
		try {
			await api(`/api/lists/${listId}/items/${del.dataset.itemDel}`, { method: 'DELETE' });
			openList(listId);
		} catch (err) {
			alert(err.message);
		}
		return;
	}
	const mv = e.target.closest('[data-item-move]');
	if (mv) {
		try {
			await api(`/api/lists/${listId}/items/${mv.dataset.itemMove}/move`, { method: 'POST', body: JSON.stringify({ direction: mv.dataset.dir }) });
			openList(listId);
		} catch (err) {
			alert(err.message);
		}
		return;
	}
	const add = e.target.closest('[data-list-add]');
	if (add) {
		add.disabled = true;
		try {
			await api(`/api/lists/${listId}/items`, { method: 'POST', body: add.dataset.listAdd });
			add.textContent = '✓ Lagt til';
			openList(listId);
		} catch (err) {
			add.disabled = false;
			alert(err.message);
		}
		return;
	}
	const mov = e.target.closest('.list-movie');
	if (mov) openMovie(JSON.parse(mov.dataset.movie));
});

// Søk i både biblioteket og TMDB når man legger til filmer
function listResultRow(m, source) {
	const key = `${m.media_type}:${m.tmdb_id}`;
	const already = listKeys.has(key);
	const data = esc(JSON.stringify({ tmdb_id: m.tmdb_id, media_type: m.media_type, title: m.title, year: m.year || null, poster_path: m.poster_path }));
	const action = !m.tmdb_id
		? '<span class="shrink-0 text-xs text-slate-500">ikke i TMDB</span>'
		: already
			? '<span class="shrink-0 text-xs text-emerald-300">✓ I listen</span>'
			: `<button data-list-add='${data}' class="shrink-0 rounded-full bg-amber-400 text-slate-900 text-sm font-semibold px-3 py-1">＋ Legg til</button>`;
	const extra = source === 'lib' ? `<div class="text-xs text-emerald-300">📀 ${esc(String(m.formats || '').split('|').map(fmtLabel).join(' · '))}</div>` : '';
	return `<div class="flex items-center gap-3 bg-slate-800 rounded-xl p-2">
		<div class="w-10 shrink-0 aspect-[2/3] bg-slate-700 rounded overflow-hidden">${posterTag(m.poster_path, m.title, 'w92')}</div>
		<div class="min-w-0 flex-1">
			<div class="text-sm font-medium leading-tight">${esc(m.title)}</div>
			<div class="text-xs text-slate-400">${esc(m.year ?? '')}${m.media_type === 'tv' ? ' · TV' : ''}</div>
			${extra}
		</div>
		${action}
	</div>`;
}

$('#list-q').addEventListener('input', (e) => {
	clearTimeout(listTimer);
	const q = e.target.value.trim();
	if (q.length < 2) {
		$('#list-results').innerHTML = '';
		return;
	}
	listTimer = setTimeout(async () => {
		$('#list-results').innerHTML = '<p class="text-sm text-slate-400">Søker…</p>';
		const [lib, tmdb] = await Promise.allSettled([
			api('/api/library?limit=8&q=' + encodeURIComponent(q)),
			api('/api/search?type=multi&q=' + encodeURIComponent(q)),
		]);
		const libRows = lib.status === 'fulfilled' ? lib.value.results.map((m) => ({ ...m, title: m.tmdb_title || m.title })) : [];
		const tmdbRows = tmdb.status === 'fulfilled' ? tmdb.value.results.map((m) => ({ ...m, tmdb_id: m.id })) : [];
		const section = (title, rows, source, empty) =>
			`<h4 class="text-xs font-semibold text-slate-400 mt-2">${title}</h4>` +
			(rows.length ? rows.map((m) => listResultRow(m, source)).join('') : `<p class="text-sm text-slate-500">${empty}</p>`);
		$('#list-results').innerHTML =
			section('📀 Fra biblioteket', libRows, 'lib', lib.status === 'fulfilled' ? 'Ingen treff i biblioteket.' : 'Kunne ikke søke i biblioteket.') +
			section('🌐 Fra TMDB', tmdbRows, 'tmdb', tmdb.status === 'fulfilled' ? 'Ingen treff i TMDB.' : 'Kunne ikke søke i TMDB.');
	}, 350);
});

/* ---------- Hvordan og når en film ble sett ---------- */
const SEEN_HOW = [['kino', 'Kino'], ['streaming', 'Streaming'], ['bluray', 'Blu-ray'], ['4k', '4K UHD'], ['dvd', 'DVD'], ['fil', 'Fil / digital kopi'], ['tv', 'TV-sending'], ['annet', 'Annet']];
const howLabel = (v) => SEEN_HOW.find(([k]) => k === v)?.[1] ?? '';
const fmtDay = (d) => (d ? new Date(d + 'T12:00:00').toLocaleDateString('nb-NO', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

/* ---------- Sett og karakterer per bruker ---------- */
const seenState = { user: '', filter: 'all', how: '', sort: 'recent', q: '', rows: [] };

async function loadSeen() {
	$('#seen-user').innerHTML = users.map((u) => `<option>${esc(u)}</option>`).join('');
	if (!users.includes(seenState.user)) seenState.user = users.includes(me) ? me : users[0] || '';
	$('#seen-user').value = seenState.user;
	$('#seen-sort').value = seenState.sort;
	$('#seen-how-filter').innerHTML = '<option value="">Alle visninger</option>' + SEEN_HOW.map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
	$('#seen-how-filter').value = seenState.how;
	if (!seenState.user) return;
	$('#seen-status').textContent = 'Henter…';
	try {
		const { results } = await api(`/api/films/${encodeURIComponent(seenState.user)}`);
		seenState.rows = results;
		renderSeen();
	} catch (err) {
		$('#seen-status').textContent = err.message;
	}
}

function renderSeen() {
	const all = seenState.rows;
	const rated = all.filter((r) => r.rating);
	const unrated = all.length - rated.length;
	const avg = rated.length ? Math.round((rated.reduce((a, r) => a + r.rating, 0) / rated.length) * 10) / 10 : null;
	const chip = (k, label) =>
		`<button data-seen-filter="${k}" class="rounded-full px-3 py-1 text-xs ${seenState.filter === k ? 'bg-amber-400 text-slate-900' : 'bg-slate-800 text-slate-300'}">${label}</button>`;
	$('#seen-filters').innerHTML = chip('all', `Alle (${all.length})`) + chip('rated', `Med karakter (${rated.length})`) + chip('unrated', `Uten karakter (${unrated})`);

	const q = seenState.q.toLowerCase();
	let rows = all.filter(
		(r) =>
			(seenState.filter === 'rated' ? r.rating : seenState.filter === 'unrated' ? !r.rating : true) &&
			(!seenState.how || r.viewings.some((v) => v.how === seenState.how)) &&
			(!q || r.title.toLowerCase().includes(q)),
	);
	const byTitle = (a, b) => a.title.localeCompare(b.title, 'nb');
	if (seenState.sort === 'title') rows = [...rows].sort(byTitle);
	else if (seenState.sort === 'rating') rows = [...rows].sort((a, b) => (b.rating || 0) - (a.rating || 0) || byTitle(a, b));
	else if (seenState.sort === 'rating_asc') rows = [...rows].sort((a, b) => (a.rating || 99) - (b.rating || 99) || byTitle(a, b));

	$('#seen-status').textContent = all.length
		? `${seenState.user}: ${all.length} sette · ${rated.length} med karakter${avg ? ` · snitt ${avg}/10` : ''}`
		: `${seenState.user} har ikke sett eller gitt karakter på noen filmer ennå.`;
	$('#seen-list').innerHTML = rows
		.map(
			(m) => `
		<button data-movie='${esc(JSON.stringify({ id: m.tmdb_id, media_type: m.media_type, title: m.title, year: m.year, poster_path: m.poster_path }))}' class="seen-movie flex w-full items-center gap-3 rounded-xl bg-slate-800 p-2 text-left hover:ring-2 hover:ring-amber-400">
			<div class="w-10 shrink-0 aspect-[2/3] overflow-hidden rounded bg-slate-700">${posterTag(m.poster_path, m.title, 'w92')}</div>
			<div class="min-w-0 flex-1">
				<div class="text-sm font-medium leading-tight">${esc(m.title)}</div>
				<div class="text-xs text-slate-400">${[esc(m.year ?? ''), m.media_type === 'tv' ? 'TV' : '', esc(howLabel(m.viewings[0]?.how)), m.viewings[0]?.seen_on ? fmtDay(m.viewings[0].seen_on) : '', m.viewings.length > 1 ? `${m.viewings.length} visninger` : ''].filter(Boolean).join(' · ')}</div>
			</div>
			<div class="shrink-0 text-sm ${m.rating ? 'font-semibold text-amber-300' : 'text-slate-400'}">${m.rating ? `⭐ ${m.rating}/10` : `${EYE} Sett`}</div>
		</button>`,
		)
		.join('');
}

$('#seen-user').addEventListener('change', (e) => {
	seenState.user = e.target.value;
	loadSeen();
});
$('#seen-sort').addEventListener('change', (e) => {
	seenState.sort = e.target.value;
	renderSeen();
});
$('#seen-how-filter').addEventListener('change', (e) => {
	seenState.how = e.target.value;
	renderSeen();
});
$('#seen-q').addEventListener('input', (e) => {
	seenState.q = e.target.value.trim();
	renderSeen();
});
$('#seen-filters').addEventListener('click', (e) => {
	const b = e.target.closest('[data-seen-filter]');
	if (!b) return;
	seenState.filter = b.dataset.seenFilter;
	renderSeen();
});
$('#seen-list').addEventListener('click', (e) => {
	const b = e.target.closest('.seen-movie');
	if (b) openMovie(JSON.parse(b.dataset.movie));
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
				${commentStrip(r)}
				${r.username === me || isAdmin ? `<button data-feed-del="${r.id}" class="absolute top-3 right-3 text-xs text-red-400 hover:underline">Slett</button>` : ''}
			</div>`,
			)
			.join('');
	} catch (err) {
		$('#feed-status').textContent = err.message;
	}
}

$('#feed').addEventListener('submit', threadSubmit);
$('#feed').addEventListener('click', async (e) => {
	if (await threadClick(e)) return;
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

// «Mine lister» i filmvinduet: nedtrekksmeny med alle egne lister. Kryss av for å legge filmen til, fjern krysset for å ta den bort.
async function initModalLists(movie, mt, message = '', keepOpen = false) {
	const box = $('#modal-lists');
	if (!box) return;
	if (!me) {
		box.textContent = 'Velg navnet ditt først for å bruke lister.';
		return;
	}
	let mine = [];
	let allLists = [];
	try {
		const { results } = await api(`/api/lists?tmdb_id=${movie.id}&media_type=${mt}`);
		allLists = results;
		mine = results.filter((l) => l.username === me);
	} catch (err) {
		box.textContent = err.message;
		return;
	}
	const others = allLists.filter((l) => l.username !== me && l.has_item);
	const picked = mine.filter((l) => l.has_item);
	const summary = mine.length ? (picked.length ? picked.map((l) => esc(l.title)).join(', ') : 'Ingen valgt') : 'Du har ingen lister ennå';
	box.innerHTML = `
		${
			mine.length
				? `<details id="ml-details" ${keepOpen ? 'open' : ''} class="rounded-lg bg-slate-900 border border-slate-700">
			<summary class="flex items-center justify-between gap-3 px-3 py-2 text-sm cursor-pointer select-none">
				<span class="min-w-0 truncate"><span class="text-slate-400">Velg lister:</span> <span class="text-slate-100">${summary}</span></span>
				<span class="shrink-0 text-xs text-slate-400">${picked.length} av ${mine.length}</span>
			</summary>
			<div class="border-t border-slate-700 divide-y divide-slate-800">
				${mine
					.map(
						(l) => `<div class="flex items-center">
					<label class="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-sm cursor-pointer">
						<input type="checkbox" data-ml="${l.id}" data-item="${l.item_id ?? ''}" ${l.has_item ? 'checked' : ''} class="h-5 w-5 shrink-0 accent-amber-400" />
						<span class="min-w-0 flex-1 break-words text-slate-100">${esc(l.title)}</span>
						<span class="shrink-0 text-xs text-slate-500">${l.item_count}</span>
					</label>
					<button type="button" data-ml-open="${l.id}" class="shrink-0 px-3 py-3 text-sm font-semibold text-amber-300 hover:text-amber-200" aria-label="Åpne listen ${esc(l.title)}">Åpne →</button>
				</div>`,
					)
					.join('')}
			</div>
		</details>`
				: '<p class="text-slate-400">Du har ingen lister ennå.</p>'
		}
		<button id="ml-new-toggle" class="mt-2 w-full rounded-lg bg-slate-900 border border-slate-700 hover:border-amber-400 py-2 text-sm font-semibold">➕ Opprett ny liste med denne filmen</button>
		<div id="ml-new" class="hidden mt-2 space-y-2">
			<input id="ml-title" maxlength="100" autocomplete="off" placeholder="Navn på ny liste, f.eks. Film noir" class="${INPUT_CLS}" />
			<label class="flex items-center gap-2 text-sm text-slate-300"><input id="ml-ranked" type="checkbox" /> Rangert liste (nummerert)</label>
			<button id="ml-create" class="w-full rounded-lg bg-amber-400 text-slate-900 font-semibold py-2 text-sm">Opprett og legg til</button>
		</div>
		<p id="ml-msg" class="text-sm mt-2 ${message ? 'text-emerald-300' : 'hidden'}">${esc(message)}</p>
		${
			others.length
				? `<h4 class="mt-4 mb-1 text-xs font-semibold text-slate-400">På andres lister</h4>
		<div class="space-y-1">${others
			.map(
				(l) => `<button type="button" data-ml-open="${l.id}" class="flex w-full items-center justify-between gap-3 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-left text-sm hover:border-amber-400">
			<span class="min-w-0 break-words"><span class="text-slate-100">${esc(l.title)}</span> <span class="text-slate-400">· ${esc(l.username)}${l.ranked ? ` · nr. ${l.item_rank}` : ''}</span></span>
			<span class="shrink-0 font-semibold text-amber-300">Åpne →</span>
		</button>`,
			)
			.join('')}</div>`
				: ''
		}`;

	const item = { tmdb_id: movie.id, media_type: mt, title: movie.title, year: movie.year || null, poster_path: movie.poster_path || null };
	const fail = (t) => {
		const msg = $('#ml-msg');
		msg.textContent = t;
		msg.className = 'text-sm mt-2 text-red-400';
	};
	const refresh = (text) => {
		initModalLists(movie, mt, text, true);
		if (!$('#tab-lists').classList.contains('hidden')) loadLists();
	};

	// «Åpne →»: gå rett til listen i Lister-fanen
	box.onclick = (e) => {
		const open = e.target.closest('[data-ml-open]');
		if (!open) return;
		listId = Number(open.dataset.mlOpen);
		listsSub = 'lists';
		closeModal();
		setTab('lists');
	};

	// Kryss av/på: legg til eller fjern filmen med en gang
	$('#ml-details')?.addEventListener('change', async (e) => {
		const cb = e.target.closest('[data-ml]');
		if (!cb) return;
		const id = Number(cb.dataset.ml);
		const name = mine.find((l) => l.id === id)?.title ?? '';
		cb.disabled = true;
		try {
			if (cb.checked) {
				await api(`/api/lists/${id}/items`, { method: 'POST', body: JSON.stringify(item) });
				refresh(`✓ Lagt til i «${name}»`);
			} else {
				await api(`/api/lists/${id}/items/${cb.dataset.item}`, { method: 'DELETE' });
				refresh(`Fjernet fra «${name}»`);
			}
		} catch (err) {
			cb.checked = !cb.checked;
			cb.disabled = false;
			fail(err.message);
		}
	});

	$('#ml-new-toggle').addEventListener('click', () => {
		$('#ml-new').classList.toggle('hidden');
		if (!$('#ml-new').classList.contains('hidden')) $('#ml-title').focus();
	});

	$('#ml-create').addEventListener('click', async () => {
		const name = $('#ml-title').value.trim();
		if (!name) return fail('Gi den nye listen et navn.');
		$('#ml-create').disabled = true;
		try {
			const r = await api('/api/lists', { method: 'POST', body: JSON.stringify({ username: me, title: name, ranked: $('#ml-ranked').checked }) });
			await api(`/api/lists/${r.id}/items`, { method: 'POST', body: JSON.stringify(item) });
			refresh(`✓ Lagt til i «${name}»`);
		} catch (err) {
			$('#ml-create').disabled = false;
			fail(err.message);
		}
	});
}

// «Karakter» i filmvinduet: snitt, hvem som har gitt hva, og din egen karakter (1–10) som lagres med ett trykk
async function initRatings(movie, mt, onMine, askHow = false) {
	const box = $('#ratings');
	if (!box) return;
	let data;
	try {
		data = await api(`/api/ratings?tmdb_id=${movie.id}&media_type=${mt}`);
	} catch (err) {
		box.textContent = err.message;
		return;
	}
	const mine = data.results.find((r) => r.username === me)?.rating ?? 0;
	const iSeen = !!mine || data.seen.includes(me);
	const myViews = data.viewings.filter((v) => v.username === me);
	if (onMine) onMine(mine);
	box.innerHTML = `
		${
			me
				? `<label class="mb-3 flex items-center gap-3 text-sm text-slate-200 ${mine ? '' : 'cursor-pointer'}">
			<input id="seen-cb" type="checkbox" ${iSeen ? 'checked' : ''} ${mine ? 'disabled' : ''} class="h-5 w-5 shrink-0 accent-amber-400" />
			<span>${EYE} Jeg har sett denne${mine ? ' <span class="text-xs text-slate-500">(har karakter, regnes som sett)</span>' : ''}</span>
		</label>`
				: ''
		}
		${
			me && iSeen
				? `<div id="viewings" class="mb-3 -mt-1 space-y-2">
			${
				askHow && !myViews.length
					? `<div class="rounded-lg border border-slate-700 bg-slate-900 p-3">
				<div class="text-sm text-slate-200">Hvordan så du den? <span class="text-xs text-slate-500">(valgfritt)</span></div>
				<div class="mt-2 flex flex-wrap gap-2">${SEEN_HOW.map(([k, l]) => `<button type="button" data-ask-how="${k}" class="rounded-full border border-slate-700 px-3 py-1 text-sm hover:border-amber-400">${l}</button>`).join('')}</div>
				<button type="button" data-ask-skip class="mt-2 text-xs text-slate-400 underline">Hopp over</button>
			</div>`
					: ''
			}
			<div class="text-xs font-semibold text-slate-400">Visninger</div>
			${myViews
				.map(
					(v) => `<div data-view="${v.id}" class="flex flex-wrap items-center gap-2">
				<select data-view-how class="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm" title="Hvordan så du den?">
					<option value="">Hvordan?</option>${SEEN_HOW.map(([k, l]) => `<option value="${k}" ${v.how === k ? 'selected' : ''}>${l}</option>`).join('')}
				</select>
				<input data-view-on type="date" value="${esc(v.seen_on ?? '')}" class="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm" title="Dato (valgfritt)" />
				<button type="button" data-view-date class="text-xs text-slate-300 underline">${v.seen_on ? 'Tøm dato' : 'I dag'}</button>
				<button type="button" data-view-del class="px-2 py-1 text-red-400" aria-label="Fjern visning">✕</button>
			</div>`,
				)
				.join('')}
			<div class="flex items-center gap-3">
				<button id="view-add" type="button" class="text-sm text-amber-300 underline">＋ Legg til visning</button>
				<span id="seen-saved" class="text-xs"></span>
			</div>
		</div>`
				: ''
		}
		<div class="text-slate-300">${data.count ? `<span class="text-amber-300 font-semibold">⭐ ${data.avg}/10</span> snitt · ${data.count} ${data.count === 1 ? 'karakter' : 'karakterer'}` : 'Ingen har gitt karakter ennå.'}</div>
		${data.seen.length ? `<div class="mt-1 text-xs text-slate-400">Sett av ${data.seen
			.map((n) => {
				const hs = [...new Set(data.viewings.filter((v) => v.username === n && v.how).map((v) => howLabel(v.how)))];
				return esc(n) + (hs.length ? ` (${hs.map(esc).join(', ')})` : '');
			})
			.join(', ')}</div>` : ''}
		${data.count ? `<div class="flex flex-wrap gap-2 mt-2">${data.results.map((r) => `<span class="rounded-full bg-slate-900 px-2 py-1 text-xs text-slate-300">${esc(r.username)} <b class="text-amber-300">${r.rating}</b></span>`).join('')}</div>` : ''}
		${
			me
				? `<div class="mt-3 text-slate-400">Din karakter${mine ? `: <b class="text-amber-300">${mine}</b>` : ''}</div>
		<div id="rate-grid" class="grid grid-cols-5 sm:grid-cols-10 gap-2 mt-1">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
			.map((n) => `<button type="button" data-rate="${n}" aria-label="Karakter ${n} av 10" class="rounded-lg py-2 text-lg font-bold ${n === mine ? 'bg-amber-400 text-slate-900' : 'bg-slate-900 border border-slate-700 hover:border-amber-400'}">${n}</button>`)
			.join('')}</div>
		<p id="rate-msg" class="text-xs text-red-400 mt-1 hidden"></p>
		${mine ? '<p class="text-xs text-slate-500 mt-1">Trykk på din karakter igjen for å fjerne den.</p>' : ''}`
				: '<p class="mt-2 text-xs text-slate-500">Velg navnet ditt for å gi karakter.</p>'
		}`;
	$('#rate-grid')?.addEventListener('click', async (e) => {
		const b = e.target.closest('[data-rate]');
		if (!b) return;
		const n = Number(b.dataset.rate);
		try {
			await api('/api/ratings', {
				method: 'POST',
				body: JSON.stringify({ tmdb_id: movie.id, media_type: mt, title: movie.title, year: movie.year || null, poster_path: movie.poster_path || null, username: me, rating: n === mine ? null : n }),
			});
			initRatings(movie, mt, onMine, n !== mine); // etter ny karakter: spør (valgfritt) om hvordan du så den
			if (seenVisible()) loadSeen();
		} catch (err) {
			const m = $('#rate-msg');
			m.textContent = err.message;
			m.classList.remove('hidden');
		}
	});

	// «Jeg har sett denne»: lagres med en gang, uten karakter
	$('#seen-cb')?.addEventListener('change', async (e) => {
		const cb = e.target;
		cb.disabled = true;
		try {
			await api('/api/seen', {
				method: 'POST',
				body: JSON.stringify({ tmdb_id: movie.id, media_type: mt, title: movie.title, year: movie.year || null, poster_path: movie.poster_path || null, username: me, seen: cb.checked }),
			});
			initRatings(movie, mt, onMine);
			if (seenVisible()) loadSeen();
		} catch (err) {
			cb.checked = !cb.checked;
			cb.disabled = false;
			const m = $('#rate-msg');
			m.textContent = err.message;
			m.classList.remove('hidden');
		}
	});

	// Visninger: hver med egen måte og dato. Endringer lagres med en gang.
	const viewingBase = { tmdb_id: movie.id, media_type: mt, title: movie.title, year: movie.year || null, poster_path: movie.poster_path || null, username: me };
	const refreshAfter = () => {
		initRatings(movie, mt, onMine);
		if (seenVisible()) loadSeen();
	};
	const saved = (text, ok = true) => {
		const el = $('#seen-saved');
		if (!el) return;
		el.className = `text-xs ${ok ? 'text-emerald-300' : 'text-red-400'}`;
		el.textContent = text;
	};
	$('#viewings')?.addEventListener('change', async (e) => {
		const row = e.target.closest('[data-view]');
		if (!row) return;
		try {
			await api(`/api/viewings/${row.dataset.view}`, {
				method: 'PATCH',
				body: JSON.stringify({ how: row.querySelector('[data-view-how]').value || null, seen_on: row.querySelector('[data-view-on]').value || null }),
			});
			saved('✓ Lagret');
			if (seenVisible()) loadSeen();
			if (e.target.matches('[data-view-on]')) initRatings(movie, mt, onMine); // oppdater «I dag» / «Tøm dato»
		} catch (err) {
			saved(err.message, false);
		}
	});
	$('#viewings')?.addEventListener('click', async (e) => {
		const ask = e.target.closest('[data-ask-how]');
		if (ask) {
			try {
				await api('/api/viewings', { method: 'POST', body: JSON.stringify({ ...viewingBase, how: ask.dataset.askHow }) });
				refreshAfter();
			} catch (err) {
				saved(err.message, false);
			}
			return;
		}
		if (e.target.closest('[data-ask-skip]')) return initRatings(movie, mt, onMine);
		const dateBtn = e.target.closest('[data-view-date]');
		if (dateBtn) {
			const row = dateBtn.closest('[data-view]');
			const input = row.querySelector('[data-view-on]');
			input.value = input.value ? '' : new Date().toLocaleDateString('sv-SE'); // i dag (YYYY-MM-DD, lokal tid) eller tom
			try {
				await api(`/api/viewings/${row.dataset.view}`, {
					method: 'PATCH',
					body: JSON.stringify({ how: row.querySelector('[data-view-how]').value || null, seen_on: input.value || null }),
				});
				refreshAfter();
			} catch (err) {
				saved(err.message, false);
			}
			return;
		}
		const del = e.target.closest('[data-view-del]');
		if (del) {
			try {
				await api(`/api/viewings/${del.closest('[data-view]').dataset.view}`, { method: 'DELETE' });
				refreshAfter();
			} catch (err) {
				saved(err.message, false);
			}
			return;
		}
		if (e.target.closest('#view-add')) {
			try {
				await api('/api/viewings', { method: 'POST', body: JSON.stringify(viewingBase) }); // tom visning: måte og dato er valgfrie
				refreshAfter();
			} catch (err) {
				saved(err.message, false);
			}
		}
	});
}

async function openMovie(movie) {
	const mt = movie.media_type === 'tv' ? 'tv' : 'movie';
	const isTv = mt === 'tv';
	$('#modal').classList.remove('hidden');
	document.body.classList.add('overflow-hidden');
	$('#modal-body').parentElement.scrollTop = 0; // alltid start øverst, ikke der forrige film ble scrollet til
	$('#modal-body').innerHTML = `
		<div class="flex gap-4 pr-6">
			<div class="w-28 shrink-0 aspect-[2/3] bg-slate-700 rounded-lg overflow-hidden">${posterTag(movie.poster_path, movie.title, 'w342')}</div>
			<div class="min-w-0">
				<h2 class="text-xl font-bold leading-tight pr-10">${esc(movie.title)}</h2>
				<div class="text-slate-400 text-sm">${esc(movie.year ?? '')}</div>
				<div id="lib-badge"></div>
				${movie.overview ? `<p class="text-sm text-slate-300 mt-2 line-clamp-6">${esc(movie.overview)}</p>` : ''}
			</div>
		</div>

		<h3 class="font-semibold mt-5 mb-2">Hvor kan du se den i Norge?</h3>
		<div id="providers" class="text-sm text-slate-400">Henter…</div>

		<h3 class="font-semibold mt-5 mb-2">Karakter</h3>
		<div id="ratings" class="text-sm text-slate-400">Henter…</div>

		<h3 class="font-semibold mt-5 mb-2">Mine lister</h3>
		<div id="modal-lists" class="text-sm text-slate-400">Henter…</div>

		${
			isTv
				? '<p class="text-xs text-slate-500 mt-5">TV-serie: anbefalinger gjelder bare filmer.</p>'
				: '<h3 class="font-semibold mt-5 mb-2">Anbefalinger</h3><div id="recs" class="space-y-2 text-sm text-slate-400">Henter…</div>'
		}

		${isTv ? '' : `<form id="rec-form" class="mt-5 border-t border-slate-700 pt-4 space-y-3">
			<h3 id="rec-title" class="font-semibold">Anbefal denne filmen</h3>
			<p id="rec-help" class="text-xs text-slate-500">Anbefalingen vises under «Anbefalinger» for de andre. Karakteren din følger med, og kommentar er valgfritt.</p>
			<p id="rec-rating" class="text-sm text-slate-400"></p>
			<textarea id="comment" rows="3" maxlength="1000" placeholder="Kommentar (valgfritt)"
				class="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-400"></textarea>
			<p id="rec-error" class="text-red-400 text-sm hidden"></p>
			<button id="rec-btn" class="w-full rounded-lg bg-amber-400 text-slate-900 font-semibold py-3 hover:bg-amber-300">⭐ Anbefal denne filmen</button>
		</form>`}`;

	initModalLists(movie, mt);

	// Karakteren settes i «Karakter» over. Anbefalingen bruker den samme karakteren.
	let rating = 0;
	const showRecRating = () => {
		const el = $('#rec-rating');
		if (el) el.innerHTML = rating ? `Din karakter: <b class="text-amber-300">⭐ ${rating}/10</b> (endres under «Karakter» over)` : 'Gi en karakter under «Karakter» over først.';
	};
	showRecRating();
	initRatings(movie, mt, (r) => {
		rating = r;
		showRecRating();
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
							${commentStrip(r)}
						</div>`,
					)
					.join('')
			: 'Ingen har anbefalt denne ennå.';
		const mine = list.find((r) => r.username === me);
		if (mine) {
			rating = mine.rating;
			$('#comment').value = mine.comment ?? '';
			showRecRating();
			$('#rec-title').textContent = 'Din anbefaling ✓';
			$('#rec-btn').textContent = 'Oppdater anbefalingen';
		}
	} else if (!isTv) {
		$('#recs').textContent = 'Kunne ikke hente anbefalinger.';
	}

	$('#recs')?.addEventListener('submit', threadSubmit);
	$('#recs')?.addEventListener('click', async (e) => {
		if (await threadClick(e)) return;
		const id = e.target.dataset.del;
		if (!id || !confirm('Slette denne anbefalingen?')) return;
		await api(`/api/recommendations/${id}?username=${encodeURIComponent(me)}`, { method: 'DELETE' });
		openMovie(movie);
		if (!$('#tab-feed').classList.contains('hidden')) loadFeed();
		if (!$('#tab-nights').classList.contains('hidden')) loadNights();
	});

	$('#rec-form')?.addEventListener('submit', async (e) => {
		e.preventDefault();
		const err = $('#rec-error');
		err.classList.add('hidden');
		if (!me) return showErr('Velg navnet ditt øverst først.');
		if (!rating) return showErr('Gi filmen en karakter først, under «Karakter» lenger opp.');
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

/* ---------- Filmkveld ---------- */
const RSVP_VALG = [
	['yes', '✅ Kommer'],
	['maybe', '🤔 Kanskje'],
	['no', '❌ Kan ikke'],
];
const RSVP_GRUPPER = [
	['yes', 'Kommer'],
	['maybe', 'Kanskje'],
	['no', 'Kan ikke'],
];
let nightId = null;
let nightTimer;
const nightDate = (d) => {
	const s = new Date(d + 'T12:00:00').toLocaleDateString('nb-NO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
	return s.charAt(0).toUpperCase() + s.slice(1);
};

// «i dag», «i morgen», «om 3 dager» eller «for 2 dager siden» ut fra datoen (YYYY-MM-DD)
const nightWhen = (d) => {
	const dager = Math.round((new Date(d + 'T12:00:00') - new Date(new Date().toDateString() + ' 12:00:00')) / 86400000);
	if (dager === 0) return 'i dag';
	if (dager === 1) return 'i morgen';
	if (dager > 1) return `om ${dager} dager`;
	return dager === -1 ? 'i går' : `for ${-dager} dager siden`;
};

// Påmelding: tre knapper for ditt svar, og hvem som har svart hva (inkludert de som ikke har svart)
function rsvpHtml(rsvps, users) {
	const mine = rsvps.find((r) => r.username === me)?.status ?? null;
	const knapper = RSVP_VALG.map(
		([v, tekst]) =>
			`<button data-rsvp="${v}" aria-pressed="${mine === v}" class="min-h-[44px] rounded-xl text-sm px-2 ${mine === v ? 'bg-amber-400 text-slate-900 font-semibold' : 'bg-slate-700'}">${tekst}</button>`,
	).join('');
	const gruppe = ([v, navn]) => {
		const liste = rsvps.filter((r) => r.status === v).map((r) => esc(r.username));
		return liste.length ? `<div><span class="text-slate-400">${navn} (${liste.length}):</span> ${liste.join(', ')}</div>` : '';
	};
	const svart = new Set(rsvps.map((r) => r.username));
	const ikkeSvart = users.filter((u) => !svart.has(u)).map(esc);
	return `
		<div class="mt-3 rounded-xl bg-slate-800 p-3">
			<div class="text-sm font-semibold mb-2">Kommer du?</div>
			${me ? `<div class="grid grid-cols-3 gap-2">${knapper}</div>` : '<p class="text-sm text-slate-400">Velg navnet ditt øverst for å svare.</p>'}
			<div class="mt-3 space-y-1 text-sm">
				${RSVP_GRUPPER.map(gruppe).join('')}
				${ikkeSvart.length ? `<div><span class="text-slate-400">Ikke svart (${ikkeSvart.length}):</span> <span class="text-slate-400">${ikkeSvart.join(', ')}</span></div>` : ''}
			</div>
		</div>`;
}

async function loadNights() {
	$('#night-form').classList.toggle('hidden', !isAdmin);
	if (nightId) return openNight(nightId);
	$('#nights-list-view').classList.remove('hidden');
	$('#night-view').classList.add('hidden');
	$('#nights-status').textContent = 'Henter…';
	try {
		const { results } = await api('/api/nights');
		$('#nights-status').textContent = results.length ? '' : isAdmin ? 'Ingen filmkvelder ennå. Opprett den første over.' : 'Ingen filmkvelder ennå.';
		$('#nights-list').innerHTML = results
			.map(
				(n) => `
			<button data-night="${n.id}" class="w-full text-left bg-slate-800 rounded-xl p-3 flex gap-3 items-center hover:ring-2 hover:ring-amber-400 ${n.status === 'open' ? '' : 'opacity-80'}">
				${n.winner_poster ? `<div class="w-12 shrink-0 aspect-[2/3] bg-slate-700 rounded overflow-hidden">${posterTag(n.winner_poster, n.winner_title, 'w92')}</div>` : ''}
				<div class="min-w-0 flex-1">
					<div class="font-semibold leading-tight break-words">${esc(n.title)}</div>
					<div class="text-sm text-slate-400">${esc(nightDate(n.date))} · ${nightWhen(n.date)}</div>
					<div class="text-xs mt-1 ${n.status === 'open' ? 'text-emerald-300' : 'text-amber-300'}">
						${n.status === 'open' ? `Åpen · ${n.wish_count} ønske${n.wish_count === 1 ? '' : 'r'}` : `🏆 ${esc(n.winner_title || 'Avsluttet')}`}
						${n.yes_count ? ` · ✅ ${n.yes_count} kommer` : ''}
					</div>
				</div>
			</button>`,
			)
			.join('');
	} catch (err) {
		$('#nights-status').textContent = err.message;
	}
}

$('#nights-list').addEventListener('click', (e) => {
	const b = e.target.closest('[data-night]');
	if (b) openNight(Number(b.dataset.night));
});

$('#night-form').addEventListener('submit', async (e) => {
	e.preventDefault();
	try {
		const r = await api('/api/admin/nights', {
			method: 'POST',
			body: JSON.stringify({ title: $('#night-title').value, date: $('#night-date').value, note: $('#night-note').value }),
		});
		$('#night-title').value = '';
		$('#night-note').value = '';
		openNight(r.id);
	} catch (err) {
		alert(err.message);
	}
});

$('#night-back').addEventListener('click', () => {
	nightId = null;
	loadNights();
});

async function openNight(id) {
	nightId = id;
	$('#nights-list-view').classList.add('hidden');
	$('#night-view').classList.remove('hidden');
	try {
		const { night, wishes, max_wishes, rsvps, users } = await api(`/api/nights/${id}`);
		const open = night.status === 'open';
		const winner = wishes.find((w) => w.id === night.winner_wish_id);
		$('#night-head').innerHTML = `
			<h2 class="text-xl font-bold">${esc(night.title)}</h2>
			<div class="text-slate-400 text-sm">${esc(nightDate(night.date))} · ${nightWhen(night.date)}</div>
			${night.note ? `<p class="text-sm text-slate-300 mt-1 break-words">${esc(night.note)}</p>` : ''}
			${
				winner
					? `<div class="mt-3 rounded-xl bg-amber-400/15 p-3 flex gap-3 items-center">
				<button data-movie='${esc(JSON.stringify({ id: winner.tmdb_id, title: winner.title, year: winner.year, poster_path: winner.poster_path }))}' class="night-movie w-20 shrink-0 aspect-[2/3] bg-slate-700 rounded overflow-hidden">${posterTag(winner.poster_path, winner.title, 'w185')}</button>
				<div class="min-w-0 text-amber-300"><div class="text-xs uppercase tracking-wide">🏆 Vi ser</div><div class="text-lg font-bold leading-tight break-words">${esc(winner.title)}</div><div class="text-sm">${winner.year || ''}</div></div>
			</div>`
					: ''
			}
			${rsvpHtml(rsvps, users)}
			${!open && !winner ? '<div class="mt-3 text-sm text-slate-400">Kvelden er avsluttet.</div>' : ''}
			${isAdmin ? `<div class="mt-2 flex gap-3 text-xs">${!open ? '<button data-night-reopen class="underline text-slate-300">Åpne igjen</button>' : ''}<button data-night-del class="underline text-red-400">Slett kveld</button></div>` : ''}`;
		$('#night-add').classList.toggle('hidden', !open);
		const mineCount = wishes.filter((w) => w.username === me).length;
		$('#night-q').placeholder = me ? `Søk etter film… (${mineCount}/${max_wishes} ønsker)` : 'Velg navnet ditt øverst for å legge inn ønsker';
		$('#night-wishes').innerHTML = wishes.length
			? wishes
					.map((w) => {
						const voted = w.voters.includes(me);
						const isWinner = w.id === night.winner_wish_id;
						return `
			<div class="bg-slate-800 rounded-xl p-3 flex gap-3 ${isWinner ? 'ring-2 ring-amber-400' : ''}">
				<button data-movie='${esc(JSON.stringify({ id: w.tmdb_id, title: w.title, year: w.year, poster_path: w.poster_path }))}' class="night-movie w-20 shrink-0 aspect-[2/3] bg-slate-700 rounded overflow-hidden">${posterTag(w.poster_path, w.title, 'w185')}</button>
				<div class="min-w-0 flex-1">
					<div class="font-semibold leading-tight">${esc(w.title)} <span class="text-slate-400 font-normal text-sm">${w.year || ''}</span></div>
					<div class="text-xs text-slate-400">Ønsket av ${esc(w.username)}${w.voters.length ? ` · 👍 ${w.voters.map(esc).join(', ')}` : ''}</div>
					${w.comment ? `<p class="text-sm text-slate-300 mt-1 break-words">${esc(w.comment)}</p>` : ''}
					${libBadge(w.library_formats)}
					<div class="mt-2 flex items-center gap-3 text-sm">
						${open ? `<button data-vote="${w.id}" class="rounded-full px-4 min-h-[40px] ${voted ? 'bg-amber-400 text-slate-900 font-semibold' : 'bg-slate-700'}">👍 ${w.voters.length}</button>` : `<span class="text-slate-400">👍 ${w.voters.length}</span>`}
						${isAdmin && open ? `<button data-pick-winner="${w.id}" class="text-amber-300 underline text-xs">Velg som vinner</button>` : ''}
						${open && (isAdmin || w.username === me) ? `<button data-wish-del="${w.id}" class="text-red-400 underline text-xs ml-auto">Slett</button>` : ''}
					</div>
				</div>
			</div>`;
					})
					.join('')
			: '<p class="text-sm text-slate-400">Ingen ønsker ennå. Søk opp en film over og bli den første!</p>';
	} catch (err) {
		alert(err.message);
		nightId = null;
		loadNights();
	}
}

$('#night-head').addEventListener('click', async (e) => {
	const movie = e.target.closest('.night-movie');
	if (movie) return openMovie(JSON.parse(movie.dataset.movie));
	try {
		const rsvp = e.target.closest('[data-rsvp]');
		if (rsvp) {
			if (!me) return alert('Velg navnet ditt først.');
			const status = rsvp.getAttribute('aria-pressed') === 'true' ? null : rsvp.dataset.rsvp; // trykk igjen for å ta svaret tilbake
			await api(`/api/nights/${nightId}/rsvp`, { method: 'POST', body: JSON.stringify({ username: me, status }) });
			return openNight(nightId);
		}
		if (e.target.closest('[data-night-del]')) {
			if (!confirm('Slette hele filmkvelden med alle ønsker og stemmer?')) return;
			await api(`/api/admin/nights/${nightId}`, { method: 'DELETE' });
			nightId = null;
			loadNights();
		} else if (e.target.closest('[data-night-reopen]')) {
			await api(`/api/admin/nights/${nightId}`, { method: 'PATCH', body: JSON.stringify({ winner_wish_id: null }) });
			openNight(nightId);
		}
	} catch (err) {
		alert(err.message);
	}
});

$('#night-wishes').addEventListener('click', async (e) => {
	const movie = e.target.closest('.night-movie');
	if (movie) return openMovie(JSON.parse(movie.dataset.movie));
	try {
		const vote = e.target.closest('[data-vote]');
		const pick = e.target.closest('[data-pick-winner]');
		const del = e.target.closest('[data-wish-del]');
		if (vote) {
			if (!me) return alert('Velg navnet ditt først.');
			await api(`/api/wishes/${vote.dataset.vote}/vote`, { method: 'POST', body: JSON.stringify({ username: me }) });
		} else if (pick) {
			if (!confirm('Velge denne filmen som vinner og avslutte avstemningen?')) return;
			await api(`/api/admin/nights/${nightId}`, { method: 'PATCH', body: JSON.stringify({ winner_wish_id: Number(pick.dataset.pickWinner) }) });
		} else if (del) {
			if (!confirm('Slette dette ønsket?')) return;
			await api(`/api/wishes/${del.dataset.wishDel}`, { method: 'DELETE' });
		} else return;
		openNight(nightId);
	} catch (err) {
		alert(err.message);
	}
});

$('#night-q').addEventListener('input', (e) => {
	clearTimeout(nightTimer);
	const q = e.target.value.trim();
	if (q.length < 2) {
		$('#night-results').innerHTML = '';
		return;
	}
	nightTimer = setTimeout(async () => {
		try {
			const { results } = await api('/api/search?q=' + encodeURIComponent(q));
			$('#night-results').innerHTML = results.length
				? results
						.slice(0, 8)
						.map(
							(m) => `
				<div class="flex items-center gap-3 bg-slate-800 rounded-xl p-2">
					<div class="w-10 shrink-0 aspect-[2/3] bg-slate-700 rounded overflow-hidden">${posterTag(m.poster_path, m.title, 'w92')}</div>
					<div class="min-w-0 flex-1"><div class="text-sm font-medium leading-tight">${esc(m.title)}</div><div class="text-xs text-slate-400">${esc(m.year ?? '')}</div></div>
					<button data-wish='${esc(JSON.stringify({ tmdb_id: m.id, title: m.title, year: m.year, poster_path: m.poster_path }))}' class="shrink-0 rounded-full bg-amber-400 text-slate-900 text-sm font-semibold px-3 py-1">＋ Ønsk</button>
				</div>`,
						)
						.join('')
				: '<p class="text-sm text-slate-400">Ingen treff.</p>';
		} catch (err) {
			$('#night-results').innerHTML = `<p class="text-sm text-red-400">${esc(err.message)}</p>`;
		}
	}, 350);
});

$('#night-results').addEventListener('click', async (e) => {
	const b = e.target.closest('[data-wish]');
	if (!b) return;
	if (!me) return alert('Velg navnet ditt først.');
	b.disabled = true;
	try {
		await api(`/api/nights/${nightId}/wishes`, { method: 'POST', body: JSON.stringify({ ...JSON.parse(b.dataset.wish), username: me }) });
		$('#night-q').value = '';
		$('#night-results').innerHTML = '';
		openNight(nightId);
	} catch (err) {
		b.disabled = false;
		alert(err.message);
	}
});
