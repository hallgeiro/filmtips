const IMG = 'https://image.tmdb.org/t/p/';
const $ = (s) => document.querySelector(s);
const esc = (s) =>
	String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let users = [];
let isAdmin = false;
let me = '';
let identity = null; // navn låst av serveren (null = ikke valgt ennå)
let searchTimer;

async function api(path, opts = {}) {
	const res = await fetch(path, {
		...opts,
		headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
	});
	if (res.status === 401 && path !== '/api/login') {
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
	} catch (err) {
		alert(err.message);
	}
});

/* ---------- Navn ---------- */
function renderUser() {
	$('#user').innerHTML =
		`<option value="">Velg navn…</option>` + users.map((u) => `<option ${u === me ? 'selected' : ''}>${esc(u)}</option>`).join('');
	const locked = !!identity && !isAdmin;
	$('#user').disabled = locked;
	$('#user').title = locked ? 'Navnet er låst. Be admin om å endre det.' : '';
}

async function refreshConfig() {
	({ users, admin: isAdmin, identity } = await api('/api/config'));
	if (identity && !isAdmin) me = identity;
	else if (!users.includes(me)) me = identity || '';
	renderAdmin();
	renderUser();
}

$('#user').addEventListener('change', async (e) => {
	const wanted = e.target.value;
	if (!wanted) {
		me = '';
		return;
	}
	try {
		await api('/api/identity', { method: 'POST', body: JSON.stringify({ username: wanted }) });
		me = identity = wanted;
	} catch (err) {
		alert(err.message);
		e.target.value = me;
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
	if (tab === 'feed') loadFeed();
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
			<button data-movie='${esc(JSON.stringify({ id: m.id, title: m.title, year: m.year, poster_path: m.poster_path, overview: m.overview }))}'
				class="movie text-left bg-slate-800 rounded-xl overflow-hidden hover:ring-2 hover:ring-amber-400">
				<div class="aspect-[2/3] bg-slate-700">${posterTag(m.poster_path, m.title)}</div>
				<div class="p-2">
					<div class="text-sm font-medium leading-tight">${esc(m.title)}</div>
					<div class="text-xs text-slate-400">${esc(m.year ?? '')}</div>
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
	$('#modal').classList.remove('hidden');
	document.body.classList.add('overflow-hidden');
	$('#modal-body').innerHTML = `
		<div class="flex gap-4 pr-6">
			<div class="w-28 shrink-0 aspect-[2/3] bg-slate-700 rounded-lg overflow-hidden">${posterTag(movie.poster_path, movie.title, 'w342')}</div>
			<div class="min-w-0">
				<h2 class="text-xl font-bold leading-tight">${esc(movie.title)}</h2>
				<div class="text-slate-400 text-sm">${esc(movie.year ?? '')}</div>
				${movie.overview ? `<p class="text-sm text-slate-300 mt-2 line-clamp-6">${esc(movie.overview)}</p>` : ''}
			</div>
		</div>

		<h3 class="font-semibold mt-5 mb-2">Hvor kan du se den i Norge?</h3>
		<div id="providers" class="text-sm text-slate-400">Henter…</div>

		<h3 class="font-semibold mt-5 mb-2">Anbefalinger</h3>
		<div id="recs" class="space-y-2 text-sm text-slate-400">Henter…</div>

		<form id="rec-form" class="mt-5 border-t border-slate-700 pt-4 space-y-3">
			<h3 class="font-semibold">Din anbefaling</h3>
			<div id="dice" class="flex gap-2"></div>
			<textarea id="comment" rows="3" maxlength="1000" placeholder="Kommentar (valgfritt)"
				class="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-400"></textarea>
			<p id="rec-error" class="text-red-400 text-sm hidden"></p>
			<button class="w-full rounded-lg bg-amber-400 text-slate-900 font-semibold py-3 hover:bg-amber-300">Lagre anbefaling</button>
		</form>`;

	let rating = 0;
	const renderDice = () => {
		$('#dice').innerHTML = [1, 2, 3, 4, 5, 6]
			.map(
				(n) => `<button type="button" data-n="${n}" aria-label="Terningkast ${n}"
					class="flex-1 rounded-lg py-2 text-lg font-bold ${n === rating ? 'bg-amber-400 text-slate-900' : 'bg-slate-900 border border-slate-700 hover:border-amber-400'}">${n}</button>`,
			)
			.join('');
	};
	renderDice();
	$('#dice').addEventListener('click', (e) => {
		const b = e.target.closest('button');
		if (b) {
			rating = Number(b.dataset.n);
			renderDice();
		}
	});

	// Strømmetjenester + eksisterende anbefalinger parallelt
	const [prov, recs] = await Promise.allSettled([
		api(`/api/movie/${movie.id}/providers`),
		api(`/api/recommendations?tmdb_id=${movie.id}`),
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

	if (recs.status === 'fulfilled') {
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
	} else {
		$('#recs').textContent = 'Kunne ikke hente anbefalinger.';
	}

	$('#recs').addEventListener('click', async (e) => {
		const id = e.target.dataset.del;
		if (!id || !confirm('Slette denne anbefalingen?')) return;
		await api(`/api/recommendations/${id}?username=${encodeURIComponent(me)}`, { method: 'DELETE' });
		openMovie(movie);
		if (!$('#tab-feed').classList.contains('hidden')) loadFeed();
	});

	$('#rec-form').addEventListener('submit', async (e) => {
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
