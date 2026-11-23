import { Hono, type Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'

type Bindings = {
	DB: D1Database
	ASSETS: Fetcher
	APP_PASSWORD: string
	ADMIN_PASSWORD?: string
	TMDB_API_KEY: string
	OMDB_API_KEY?: string
	USERS: string
}
type Ctx = Context<{ Bindings: Bindings }>

const app = new Hono<{ Bindings: Bindings }>()

const COOKIE = 'filmtips_session'
const ADMIN_COOKIE = 'filmtips_admin'
const IDENTITY_COOKIE = 'filmtips_user'
const COOKIE_MAX_AGE = 60 * 60 * 24 * 90 // 90 dager
const enc = new TextEncoder()

/* ---------- Passord / økt ---------- */

async function sha256(s: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest('SHA-256', enc.encode(s))
}

async function safeEqual(a: string, b: string): Promise<boolean> {
	const [ha, hb] = await Promise.all([sha256(a), sha256(b)])
	return crypto.subtle.timingSafeEqual(ha, hb)
}

// Økt-token = HMAC(passord, fast streng). Bytter du passord, logges alle ut.
async function sessionToken(password: string, label = 'filmtips-session-v1'): Promise<string> {
	const key = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
	const sig = await crypto.subtle.sign('HMAC', key, enc.encode(label))
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

app.post('/api/login', async (c) => {
	const body = await c.req.json<{ password?: string }>().catch(() => ({} as { password?: string }))
	const password = String(body.password ?? '')
	if (!c.env.APP_PASSWORD) {
		return c.json({ error: 'Serverfeil: secret APP_PASSWORD er ikke satt på denne Workeren' }, 500)
	}
	if (!(await safeEqual(password, c.env.APP_PASSWORD))) {
		return c.json({ error: 'Feil passord' }, 401)
	}
	setCookie(c, COOKIE, await sessionToken(c.env.APP_PASSWORD), {
		httpOnly: true,
		secure: new URL(c.req.url).protocol === 'https:',
		sameSite: 'Lax',
		path: '/',
		maxAge: COOKIE_MAX_AGE,
	})
	return c.json({ ok: true })
})

app.post('/api/logout', (c) => {
	deleteCookie(c, COOKIE, { path: '/' })
	return c.json({ ok: true })
})

// Alt under her krever innlogging
app.use('/api/*', async (c, next) => {
	const cookie = getCookie(c, COOKIE)
	if (!c.env.APP_PASSWORD || !cookie || !(await safeEqual(cookie, await sessionToken(c.env.APP_PASSWORD)))) {
		return c.json({ error: 'Ikke innlogget' }, 401)
	}
	await next()
})

const getUsers = (env: Bindings) =>
	(env.USERS ?? '').split(',').map((s) => s.trim()).filter(Boolean)

// Admin: eget passord (secret ADMIN_PASSWORD). Gir lov til å slette andres anbefalinger.
async function isAdmin(c: Ctx): Promise<boolean> {
	const pw = c.env.ADMIN_PASSWORD
	const cookie = getCookie(c, ADMIN_COOKIE)
	if (!pw || !cookie) return false
	return safeEqual(cookie, await sessionToken(pw, 'filmtips-admin-v1'))
}

// ---------- PIN og identitet ----------
const PIN_RE = /^\d{4,6}$/
const MAX_ATTEMPTS = 5
const LOCK_MINUTES = 15

const toHex = (buf: ArrayBuffer | Uint8Array) => [...new Uint8Array(buf as ArrayBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('')

async function hashPin(pin: string, saltHex: string): Promise<string> {
	const salt = Uint8Array.from((saltHex.match(/../g) ?? []).map((h) => parseInt(h, 16)))
	const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits'])
	const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256)
	return toHex(bits)
}

type PinRow = { pin_hash: string; salt: string; failed_attempts: number; locked: number }
const getPinRow = (c: Ctx, name: string) =>
	c.env.DB.prepare(
		`SELECT pin_hash, salt, failed_attempts, (locked_until IS NOT NULL AND locked_until > datetime('now')) AS locked
		 FROM user_pins WHERE username = ?`,
	)
		.bind(name)
		.first<PinRow>()

// Cookie = navn.signatur. Signaturen avhenger av PIN-hashen, så en nullstilt PIN ugyldiggjør gamle cookies.
const identitySig = (c: Ctx, name: string, pinHash: string) => sessionToken(c.env.APP_PASSWORD, `filmtips-user-v2:${name}:${pinHash}`)

async function getIdentity(c: Ctx): Promise<string | null> {
	const raw = getCookie(c, IDENTITY_COOKIE)
	if (!raw) return null
	const i = raw.lastIndexOf('.')
	if (i < 1) return null
	const name = raw.slice(0, i)
	if (!getUsers(c.env).includes(name)) return null
	const row = await getPinRow(c, name)
	if (!row) return null
	return (await safeEqual(raw.slice(i + 1), await identitySig(c, name, row.pin_hash))) ? name : null
}

app.get('/api/config', async (c) => {
	const { results } = await c.env.DB.prepare(`SELECT username FROM user_pins`).all<{ username: string }>()
	return c.json({
		users: getUsers(c.env),
		admin: await isAdmin(c),
		identity: await getIdentity(c),
		hasPin: results.map((r) => r.username),
	})
})

// Velg navn med PIN. Finnes ingen PIN for navnet ennå, opprettes den (første som velger navnet får det).
app.post('/api/identity', async (c) => {
	const body = await c.req.json<{ username?: string; pin?: string }>().catch(() => ({} as { username?: string; pin?: string }))
	const name = String(body.username ?? '').trim()
	const pin = String(body.pin ?? '').trim()
	if (!getUsers(c.env).includes(name)) return c.json({ error: 'Ukjent navn' }, 400)
	if (!PIN_RE.test(pin)) return c.json({ error: 'PIN må være 4–6 siffer' }, 400)

	let row = await getPinRow(c, name)
	if (!row) {
		const salt = toHex(crypto.getRandomValues(new Uint8Array(16)))
		const pinHash = await hashPin(pin, salt)
		await c.env.DB.prepare(`INSERT OR IGNORE INTO user_pins (username, pin_hash, salt) VALUES (?, ?, ?)`).bind(name, pinHash, salt).run()
		row = await getPinRow(c, name)
		if (!row || row.pin_hash !== pinHash) return c.json({ error: 'Navnet ble tatt av noen andre akkurat nå. Prøv igjen.' }, 409)
	} else {
		if (row.locked) return c.json({ error: `For mange feil forsøk. Prøv igjen om ${LOCK_MINUTES} minutter.` }, 429)
		const ok = await safeEqual(await hashPin(pin, row.salt), row.pin_hash)
		if (!ok) {
			const failed = row.failed_attempts + 1
			if (failed >= MAX_ATTEMPTS) {
				await c.env.DB.prepare(`UPDATE user_pins SET failed_attempts = 0, locked_until = datetime('now', ?) WHERE username = ?`)
					.bind(`+${LOCK_MINUTES} minutes`, name)
					.run()
				return c.json({ error: `For mange feil forsøk. Låst i ${LOCK_MINUTES} minutter.` }, 429)
			}
			await c.env.DB.prepare(`UPDATE user_pins SET failed_attempts = ? WHERE username = ?`).bind(failed, name).run()
			return c.json({ error: `Feil PIN (${MAX_ATTEMPTS - failed} forsøk igjen)` }, 403)
		}
		if (row.failed_attempts > 0) {
			await c.env.DB.prepare(`UPDATE user_pins SET failed_attempts = 0, locked_until = NULL WHERE username = ?`).bind(name).run()
		}
	}

	setCookie(c, IDENTITY_COOKIE, `${name}.${await identitySig(c, name, row.pin_hash)}`, {
		httpOnly: true,
		secure: new URL(c.req.url).protocol === 'https:',
		sameSite: 'Lax',
		path: '/',
		maxAge: 60 * 60 * 24 * 365,
	})
	return c.json({ ok: true, identity: name })
})

// Admin: fjern PIN slik at personen kan lage en ny (ugyldiggjør også gamle innlogginger for navnet)
app.post('/api/admin/reset-pin', async (c) => {
	if (!(await isAdmin(c))) return c.json({ error: 'Krever admin' }, 403)
	const body = await c.req.json<{ username?: string }>().catch(() => ({} as { username?: string }))
	const name = String(body.username ?? '').trim()
	if (!getUsers(c.env).includes(name)) return c.json({ error: 'Ukjent navn' }, 400)
	await c.env.DB.prepare(`DELETE FROM user_pins WHERE username = ?`).bind(name).run()
	return c.json({ ok: true })
})

app.post('/api/admin/login', async (c) => {
	if (!c.env.ADMIN_PASSWORD) return c.json({ error: 'Serverfeil: secret ADMIN_PASSWORD er ikke satt på denne Workeren' }, 500)
	const body = await c.req.json<{ password?: string }>().catch(() => ({} as { password?: string }))
	if (!(await safeEqual(String(body.password ?? ''), c.env.ADMIN_PASSWORD))) return c.json({ error: 'Feil admin-passord' }, 401)
	setCookie(c, ADMIN_COOKIE, await sessionToken(c.env.ADMIN_PASSWORD, 'filmtips-admin-v1'), {
		httpOnly: true,
		secure: new URL(c.req.url).protocol === 'https:',
		sameSite: 'Lax',
		path: '/',
		maxAge: COOKIE_MAX_AGE,
	})
	return c.json({ ok: true })
})

app.post('/api/admin/logout', (c) => {
	deleteCookie(c, ADMIN_COOKIE, { path: '/' })
	return c.json({ ok: true })
})

/* ---------- TMDB ---------- */

async function tmdb(c: Ctx, path: string, params: Record<string, string> = {}) {
	const url = new URL('https://api.themoviedb.org/3' + path)
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
	const headers: Record<string, string> = { accept: 'application/json' }
	const key = c.env.TMDB_API_KEY ?? ''
	// v4 Read Access Token er en lang JWT; v3-nøkkel er 32 tegn
	if (key.length > 40) headers.authorization = `Bearer ${key}`
	else url.searchParams.set('api_key', key)

	const res = await fetch(url.toString(), { headers, cf: { cacheTtl: 3600, cacheEverything: true } })
	if (!res.ok) throw new Error(`TMDB ${res.status}`)
	return res.json<any>()
}

type Hit = { id: number; media_type: 'movie' | 'tv'; title: string; original_title: string | null; year: string | null; poster_path: string | null; overview: string }

const hitFrom = (r: any, type: 'movie' | 'tv'): Hit => ({
	id: r.id,
	media_type: type,
	title: (type === 'tv' ? r.name : r.title) ?? '',
	original_title: (type === 'tv' ? r.original_name : r.original_title) ?? null,
	year: ((type === 'tv' ? r.first_air_date : r.release_date) ?? '').slice(0, 4) || null,
	poster_path: r.poster_path ?? null,
	overview: String(r.overview ?? '').slice(0, 300),
})

const IMDB_RE = /tt\d{6,10}/i

// Søk i TMDB. En IMDb-kode (tt1234567) eller IMDb-lenke slås opp direkte. mode 'multi' tar med TV-serier.
async function searchTmdb(c: Ctx, q: string, mode: 'movie' | 'multi', page = '1'): Promise<Hit[]> {
	const imdb = q.match(IMDB_RE)
	if (imdb) {
		const data = await tmdb(c, `/find/${imdb[0].toLowerCase()}`, { external_source: 'imdb_id', language: 'nb-NO' })
		return [...(data.movie_results ?? []).map((r: any) => hitFrom(r, 'movie')), ...(data.tv_results ?? []).map((r: any) => hitFrom(r, 'tv'))]
	}
	if (mode === 'movie') {
		const data = await tmdb(c, '/search/movie', { query: q, language: 'nb-NO', include_adult: 'false', page })
		return (data.results ?? []).slice(0, 20).map((r: any) => hitFrom(r, 'movie'))
	}
	const data = await tmdb(c, '/search/multi', { query: q, language: 'nb-NO', include_adult: 'false', page })
	return (data.results ?? [])
		.filter((r: any) => r.media_type === 'movie' || r.media_type === 'tv')
		.slice(0, 20)
		.map((r: any) => hitFrom(r, r.media_type))
}

app.get('/api/search', async (c) => {
	const q = (c.req.query('q') ?? '').trim()
	if (q.length < 2) return c.json({ results: [] })
	try {
		return c.json({ results: await searchTmdb(c, q, c.req.query('type') === 'multi' ? 'multi' : 'movie', c.req.query('page') ?? '1') })
	} catch {
		return c.json({ error: 'Søket mot TMDB feilet' }, 502)
	}
})

// Strømmetjenester i Norge (data fra JustWatch via TMDB), for film og TV
async function providers(c: Ctx, kind: 'movie' | 'tv') {
	const id = Number(c.req.param('id'))
	if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Ugyldig id' }, 400)
	try {
		const data = await tmdb(c, `/${kind}/${id}/watch/providers`)
		const no = data.results?.NO ?? {}
		const pick = (arr: any[] | undefined) => (arr ?? []).map((p) => ({ id: p.provider_id, name: p.provider_name, logo_path: p.logo_path }))
		return c.json({
			link: no.link ?? null,
			flatrate: pick(no.flatrate),
			free: pick(no.free),
			ads: pick(no.ads),
			rent: pick(no.rent),
			buy: pick(no.buy),
		})
	} catch {
		return c.json({ error: 'Kunne ikke hente strømmetjenester' }, 502)
	}
}
app.get('/api/movie/:id/providers', (c) => providers(c, 'movie'))
app.get('/api/tv/:id/providers', (c) => providers(c, 'tv'))

/* ---------- Anbefalinger (D1) ---------- */

app.get('/api/recommendations', async (c) => {
	const tmdbId = c.req.query('tmdb_id')
	const limit = Math.min(Math.max(Number(c.req.query('limit')) || 100, 1), 200)
	const offset = Math.max(Number(c.req.query('offset')) || 0, 0)

	const select = `SELECT r.*, (SELECT group_concat(l.formats, '|') FROM library l WHERE l.tmdb_id = r.tmdb_id AND l.media_type = 'movie') AS library_formats FROM recommendations r`
	const stmt = tmdbId
		? c.env.DB.prepare(`${select} WHERE r.tmdb_id = ? ORDER BY r.created_at DESC LIMIT ? OFFSET ?`).bind(Number(tmdbId), limit, offset)
		: c.env.DB.prepare(`${select} ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`).bind(limit, offset)
	const { results } = await stmt.all()
	return c.json({ results })
})

app.post('/api/recommendations', async (c) => {
	const b = await c.req.json<any>().catch(() => null)
	if (!b) return c.json({ error: 'Ugyldig JSON' }, 400)

	const tmdb_id = Number(b.tmdb_id)
	const title = String(b.title ?? '').trim()
	const username = String(b.username ?? '').trim()
	const rating = Number(b.rating)
	const comment = String(b.comment ?? '').trim()
	const poster_path = typeof b.poster_path === 'string' && /^\/[\w.-]+$/.test(b.poster_path) ? b.poster_path : null

	if (!Number.isInteger(tmdb_id) || tmdb_id <= 0) return c.json({ error: 'Ugyldig film' }, 400)
	if (!title || title.length > 200) return c.json({ error: 'Ugyldig tittel' }, 400)
	if (!getUsers(c.env).includes(username)) return c.json({ error: 'Ukjent navn' }, 400)
	// Uten admin kan man bare anbefale som seg selv
	if (!(await isAdmin(c))) {
		const me = await getIdentity(c)
		if (!me) return c.json({ error: 'Velg navnet ditt først' }, 403)
		if (username !== me) return c.json({ error: `Du kan bare anbefale som ${me}` }, 403)
	}
	if (!Number.isInteger(rating) || rating < 1 || rating > 6) return c.json({ error: 'Terningkast må være 1–6' }, 400)
	if (comment.length > 1000) return c.json({ error: 'Kommentaren er for lang (maks 1000 tegn)' }, 400)

	await c.env.DB.prepare(
		`INSERT INTO recommendations (tmdb_id, title, poster_path, username, rating, comment)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (tmdb_id, username) DO UPDATE SET
       title = excluded.title,
       poster_path = excluded.poster_path,
       rating = excluded.rating,
       comment = excluded.comment,
       created_at = datetime('now')`,
	)
		.bind(tmdb_id, title, poster_path, username, rating, comment || null)
		.run()

	return c.json({ ok: true }, 201)
})

app.delete('/api/recommendations/:id', async (c) => {
	const id = Number(c.req.param('id'))
	if (!Number.isInteger(id)) return c.json({ error: 'Ugyldig forespørsel' }, 400)
	// Admin kan slette alle. Andre kan bare slette egne (tillitsbasert på navn).
	if (await isAdmin(c)) {
		const res = await c.env.DB.prepare(`DELETE FROM recommendations WHERE id = ?`).bind(id).run()
		return c.json({ ok: true, deleted: res.meta.changes })
	}
	const username = await getIdentity(c)
	if (!username) return c.json({ error: 'Velg navnet ditt først' }, 403)
	const res = await c.env.DB.prepare(`DELETE FROM recommendations WHERE id = ? AND username = ?`).bind(id, username).run()
	return c.json({ ok: true, deleted: res.meta.changes })
})

/* ---------- Bibliotek (importert fra CLZ Movies) ---------- */

const norm = (s: string) =>
	s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()

// Første regissør som 'Etternavn, Fornavn' (siste ord regnes som etternavn)
function directorSortKey(d: string | null | undefined): string | null {
	const first = (d ?? '').split('|')[0].trim()
	if (!first) return null
	const i = first.lastIndexOf(' ')
	return i < 0 ? first : `${first.slice(i + 1)}, ${first.slice(0, i).trim()}`
}

type Match = {
	tmdb_id: number | null
	tmdb_title: string | null
	poster_path: string | null
	media_type: 'movie' | 'tv'
	match: 'exact' | 'fuzzy' | 'none'
}

const SEASON_RE =
	/^(.+?)\s*[:\-–]\s*(?:the\s+)?(?:complete\s+)?(?:(?:series|collection|seasons?)\b|(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th))\s+season\b).*$/i
const EDITION_RE =
	/\s*[-–:(\[]?\s*(?:the\s+)?(?:extended|unrated|uncut|theatrical|final cut|restored|remastered|director'?s?\s+cut|directors'?\s+cut|black and white|special edition|collector'?s edition|criterion collection|limited edition|ultimate edition|anniversary edition|international (?:cut|version)|redux)\b[^)\]]*[)\]]?\s*$/i

// Tittelvarianter til oppslag: uten utgave-tillegg, uten ': Season 4', og undertittel
function titleVariants(title: string): { variants: string[]; series: boolean } {
	const orig = title.trim()
	let t = orig
	let series = false
	const sm = t.match(SEASON_RE)
	if (sm && sm[1].trim().length >= 2) {
		series = true
		t = sm[1].trim()
	}
	for (let i = 0; i < 3; i++) {
		const stripped = t.replace(EDITION_RE, '').trim()
		if (stripped === t || stripped.length < 3) break
		t = stripped
	}
	const out = [t]
	if (orig !== t && !series) out.push(orig)
	const parts = t.split(/\s*[:–]\s+|\s+-\s+/).map((p) => p.trim())
	if (parts.length > 1) {
		const last = parts[parts.length - 1]
		if (last.length >= 6) out.push(last)
	}
	return { variants: [...new Set(out)].slice(0, 3), series }
}

// Finn film eller TV-serie i TMDB ut fra tittel + år. Maks 5 oppslag per tittel.
// Reserve: spør OMDb (IMDb-basert) om tittelen, og slå opp IMDb-koden i TMDB. Maks 3 oppslag. Treff merkes «fuzzy» så de kan sjekkes.
async function omdbMatch(c: Ctx, variants: string[], year: number): Promise<Match | null> {
	const key = c.env.OMDB_API_KEY
	if (!key) return null
	const ask = async (title: string, withYear: boolean): Promise<string | null> => {
		const u = new URL('https://www.omdbapi.com/')
		u.searchParams.set('apikey', key)
		u.searchParams.set('t', title)
		if (withYear && year) u.searchParams.set('y', String(year))
		const res = await fetch(u, { cf: { cacheTtl: 2592000, cacheEverything: true } })
		if (!res.ok) return null
		const d = await res.json<any>()
		return d?.Response === 'True' && /^tt\d{6,10}$/.test(d.imdbID ?? '') ? d.imdbID : null
	}
	let imdb = await ask(variants[0], true)
	if (!imdb && year) imdb = await ask(variants[0], false)
	if (!imdb) return null
	const f = await tmdb(c, `/find/${imdb}`, { external_source: 'imdb_id', language: 'en-US' })
	const mv = f.movie_results?.[0]
	if (mv) return { tmdb_id: mv.id, tmdb_title: mv.title ?? null, poster_path: mv.poster_path ?? null, media_type: 'movie', match: 'fuzzy' }
	const tv = f.tv_results?.[0]
	if (tv) return { tmdb_id: tv.id, tmdb_title: tv.name ?? null, poster_path: tv.poster_path ?? null, media_type: 'tv', match: 'fuzzy' }
	return null
}

async function matchTitle(c: Ctx, rawTitle: string, year: number, useOmdb = false): Promise<Match> {
	const none: Match = { tmdb_id: null, tmdb_title: null, poster_path: null, media_type: 'movie', match: 'none' }
	try {
		const { variants, series } = titleVariants(rawTitle)
		const v0 = variants[0]
		const base = { language: 'en-US', include_adult: 'false' }
		const get = async (path: string, params: Record<string, string>): Promise<any[]> => (await tmdb(c, path, params)).results ?? []
		const nameOf = (r: any, t: 'movie' | 'tv') => (t === 'tv' ? r.name : r.title) ?? ''
		const origOf = (r: any, t: 'movie' | 'tv') => (t === 'tv' ? r.original_name : r.original_title) ?? ''
		const eq = (r: any, t: 'movie' | 'tv', x: string) => norm(nameOf(r, t)) === x || norm(origOf(r, t)) === x
		const mk = (r: any, t: 'movie' | 'tv', m: 'exact' | 'fuzzy'): Match => ({
			tmdb_id: r.id,
			tmdb_title: nameOf(r, t) || null,
			poster_path: r.poster_path ?? null,
			media_type: t,
			match: m,
		})
		const ry = (r: any) => Number((r.release_date ?? '').slice(0, 4)) || 0
		const tvExact = async () => {
			const hit = (await get('/search/tv', { ...base, query: v0 })).find((r) => eq(r, 'tv', norm(v0)))
			return hit ? mk(hit, 'tv', 'exact') : null
		}

		if (series) {
			const m = await tvExact()
			if (m) return m
		}

		let first: any[] = []
		for (let i = 0; i < variants.length; i++) {
			const v = variants[i]
			if (!year && i > 0) break
			const list = year ? await get('/search/movie', { ...base, query: v, primary_release_year: String(year) }) : []
			if (i === 0) first = list
			const hit = list.find((r) => eq(r, 'movie', norm(v)))
			if (hit) return mk(hit, 'movie', 'exact')
			if (i === 0) {
				const any = await get('/search/movie', { ...base, query: v })
				const near = any.find((r) => eq(r, 'movie', norm(v)) && (!year || Math.abs(ry(r) - year) <= 1))
				if (near) return mk(near, 'movie', 'exact')
			}
		}

		if (!series) {
			const m = await tvExact()
			if (m) return m
		}

		// Usikkert treff: samme år, og tittelen ligner (del av tittel)
		const bn = norm(v0.split(/[:(]/)[0])
		const fuzzy = first.find((r) => {
			const t = norm(r.title ?? '')
			return eq(r, 'movie', bn) || (bn.length >= 4 && (t.includes(bn) || bn.includes(t)))
		})
		if (fuzzy) return mk(fuzzy, 'movie', 'fuzzy')
		if (useOmdb) return (await omdbMatch(c, variants, year)) ?? none
		return none
	} catch {
		return none
	}
}

const LIB_SORTS: Record<string, string> = {
	title: 'title COLLATE NOCASE',
	year_desc: '(year = 0), year DESC, title COLLATE NOCASE',
	year_asc: '(year = 0), year ASC, title COLLATE NOCASE',
	director: "(director_sort IS NULL OR director_sort = ''), director_sort COLLATE NOCASE, year, title COLLATE NOCASE",
}

app.get('/api/library', async (c) => {
	const q = (c.req.query('q') ?? '').trim()
	const format = (c.req.query('format') ?? '').trim()
	const director = (c.req.query('director') ?? '').trim()
	const decade = Math.trunc(Number(c.req.query('decade'))) || 0
	const tmdbId = Number(c.req.query('tmdb_id')) || 0
	const unmatched = c.req.query('unmatched') === '1'
	const orderBy = LIB_SORTS[c.req.query('sort') ?? ''] ?? LIB_SORTS.title
	const limit = Math.min(Math.max(Number(c.req.query('limit')) || 60, 1), 200)
	const offset = Math.max(Number(c.req.query('offset')) || 0, 0)

	const where: string[] = []
	const args: (string | number)[] = []
	if (q) {
		const imdb = q.match(IMDB_RE)
		if (imdb) {
			// IMDb-kode: finn TMDB-id(er) og se om de finnes i biblioteket
			let hits: Hit[] = []
			try {
				hits = await searchTmdb(c, imdb[0], 'multi')
			} catch {}
			if (!hits.length) where.push('0')
			else (where.push('(' + hits.map(() => '(tmdb_id = ? AND media_type = ?)').join(' OR ') + ')'), hits.forEach((h) => args.push(h.id, h.media_type)))
		} else (where.push('(title LIKE ? OR director LIKE ?)'), args.push(`%${q}%`, `%${q}%`))
	}
	if (format) (where.push('formats LIKE ?'), args.push(`%${format}%`))
	if (director) (where.push('director LIKE ?'), args.push(`%${director}%`))
	if (decade > 0) (where.push('(year >= ? AND year < ?)'), args.push(decade, decade + 10))
	if (tmdbId) (where.push('tmdb_id = ?'), args.push(tmdbId))
	const mediaType = c.req.query('media_type')
	if (mediaType === 'movie' || mediaType === 'tv') (where.push('media_type = ?'), args.push(mediaType))
	if (unmatched) where.push('tmdb_id IS NULL AND collection = 0')
	if (c.req.query('review') === '1') where.push("((tmdb_id IS NULL AND collection = 0) OR match = 'fuzzy')")
	const w = where.length ? 'WHERE ' + where.join(' AND ') : ''

	const [rows, count] = await Promise.all([
		c.env.DB.prepare(
			`SELECT id, title, year, director, formats, tmdb_id, tmdb_title, poster_path, media_type, collection, match FROM library ${w} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
		)
			.bind(...args, limit, offset)
			.all(),
		c.env.DB.prepare(`SELECT COUNT(*) AS n FROM library ${w}`).bind(...args).first<{ n: number }>(),
	])
	return c.json({ results: rows.results, total: count?.n ?? 0 })
})

// Tiår som finnes i biblioteket (til filterknapper)
app.get('/api/library/facets', async (c) => {
	const { results } = await c.env.DB.prepare(
		`SELECT (year / 10) * 10 AS decade, COUNT(*) AS n FROM library WHERE year > 0 GROUP BY decade ORDER BY decade`,
	).all()
	return c.json({ decades: results })
})

// Admin: importer en bunke (maks 8) filmer fra CLZ. Kan kjøres på nytt uten å lage duplikater.
app.post('/api/admin/library/import', async (c) => {
	if (!(await isAdmin(c))) return c.json({ error: 'Krever admin' }, 403)
	const body = await c.req.json<{ items?: any[] }>().catch(() => ({ items: undefined }))
	const raw = Array.isArray(body.items) ? body.items.slice(0, 8) : []

	const items = raw
		.map((i) => ({
			title: String(i?.title ?? '').trim().slice(0, 200),
			year: Math.min(Math.max(Math.trunc(Number(i?.year)) || 0, 0), 2100),
			formats: String(i?.formats ?? '').trim().slice(0, 100),
			genres: String(i?.genres ?? '').slice(0, 200) || null,
			runtime: Math.trunc(Number(i?.runtime)) || null,
			director: String(i?.director ?? '').slice(0, 200) || null,
			distributor: String(i?.distributor ?? '').slice(0, 200) || null,
			added_date: String(i?.added_date ?? '').slice(0, 30) || null,
		}))
		.filter((i) => i.title && i.formats)

	// Hopp over filmer som allerede er matchet (sparer TMDB-oppslag ved ny import)
	const { results: done } = await c.env.DB.prepare(`SELECT title, year FROM library WHERE tmdb_id IS NOT NULL`).all<{ title: string; year: number }>()
	const matched = new Set(done.map((r) => `${r.title}\u0000${r.year}`))

	const matches = await Promise.all(
		items.map((i) =>
			matched.has(`${i.title}\u0000${i.year}`)
				? Promise.resolve(null)
				: matchTitle(c, i.title, i.year),
		),
	)

	const stmts = items.map((i, k) => {
		const m = matches[k] ?? { tmdb_id: null, tmdb_title: null, poster_path: null, media_type: 'movie' as const, match: 'none' as const }
		return c.env.DB.prepare(
			`INSERT INTO library (title, year, formats, genres, runtime, director, director_sort, distributor, added_date, tmdb_id, tmdb_title, poster_path, media_type, match)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (title, year) DO UPDATE SET
			   formats = excluded.formats, genres = excluded.genres, runtime = excluded.runtime,
			   director = excluded.director, director_sort = excluded.director_sort, distributor = excluded.distributor, added_date = excluded.added_date,
			   tmdb_id = COALESCE(library.tmdb_id, excluded.tmdb_id),
			   tmdb_title = COALESCE(library.tmdb_title, excluded.tmdb_title),
			   poster_path = COALESCE(library.poster_path, excluded.poster_path),
			   media_type = CASE WHEN library.tmdb_id IS NULL THEN excluded.media_type ELSE library.media_type END,
			   match = CASE WHEN library.tmdb_id IS NULL THEN excluded.match ELSE library.match END`,
		).bind(i.title, i.year, i.formats, i.genres, i.runtime, i.director, directorSortKey(i.director), i.distributor, i.added_date, m.tmdb_id, m.tmdb_title, m.poster_path, m.media_type, m.match)
	})
	if (stmts.length) await c.env.DB.batch(stmts)

	const count = (k: string) => matches.filter((m) => m?.match === k).length
	return c.json({
		imported: items.length,
		exact: count('exact'),
		fuzzy: count('fuzzy'),
		none: count('none'),
		skipped: matches.filter((m) => m === null).length,
	})
})

// Admin: rett (eller fjern) TMDB-match for en film/serie i biblioteket. Tittel og plakat hentes fra TMDB.
app.patch('/api/admin/library/:id', async (c) => {
	if (!(await isAdmin(c))) return c.json({ error: 'Krever admin' }, 403)
	const id = Number(c.req.param('id'))
	if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Ugyldig id' }, 400)
	const body = await c.req.json<{ tmdb_id?: number | null; media_type?: string }>().catch(() => ({} as { tmdb_id?: number | null; media_type?: string }))

	if (body.tmdb_id === null) {
		const res = await c.env.DB.prepare(
			`UPDATE library SET tmdb_id = NULL, tmdb_title = NULL, poster_path = NULL, media_type = 'movie', match = 'none' WHERE id = ?`,
		)
			.bind(id)
			.run()
		return res.meta.changes ? c.json({ ok: true }) : c.json({ error: 'Fant ikke filmen i biblioteket' }, 404)
	}
	const tmdbId = Number(body.tmdb_id)
	const mt: 'movie' | 'tv' = body.media_type === 'tv' ? 'tv' : 'movie'
	if (!Number.isInteger(tmdbId) || tmdbId <= 0) return c.json({ error: 'Ugyldig TMDB-id' }, 400)

	let m: any
	try {
		m = await tmdb(c, `/${mt}/${tmdbId}`, { language: 'en-US' })
	} catch {
		return c.json({ error: 'Fant ikke denne tittelen i TMDB' }, 404)
	}
	const res = await c.env.DB.prepare(`UPDATE library SET tmdb_id = ?, tmdb_title = ?, poster_path = ?, media_type = ?, match = 'exact' WHERE id = ?`)
		.bind(tmdbId, (mt === 'tv' ? m.name : m.title) ?? null, m.poster_path ?? null, mt, id)
		.run()
	return res.meta.changes ? c.json({ ok: true }) : c.json({ error: 'Fant ikke filmen i biblioteket' }, 404)
})

// Bokssett og samlinger kan ikke matches mot én film
const COLLECTION_RE =
	/\b(collection|trilogy|box ?set|collector'?s set|complete [\w\- ]*(?:series|collection|films|shorts|set)|\d+[- ]film|\d+ films|eighteen films)\b/i
const isCollection = (t: string) => COLLECTION_RE.test(t)

// Regissørnavn fra CLZ ('A | B') mot TMDB-stab: fullt navn, eller samme etternavn + samme forbokstav
function directorsMatch(clz: string | null | undefined, crew: string[]): boolean {
	const a = (clz ?? '').split('|').map((x) => norm(x.replace(/\(.*?\)/g, ''))).filter(Boolean)
	const b = crew.map(norm).filter(Boolean)
	return a.some((x) =>
		b.some((y) => {
			if (x === y || [...x.split(' ')].sort().join(' ') === [...y.split(' ')].sort().join(' ')) return true
			const xs = x.split(' ')
			const ys = y.split(' ')
			return xs.length > 1 && ys.length > 1 && xs[xs.length - 1] === ys[ys.length - 1] && xs[0][0] === ys[0][0] && xs[xs.length - 1].length > 3
		}),
	)
}

// Søkevarianter: «2»→«II», «Dr.»→«Dr», del før « / »
function searchQueries(title: string): string[] {
	const { variants } = titleVariants(title)
	const base = variants[0].split(/\s+\/\s+/)[0].trim()
	const roman = ['', '', 'II', 'III', 'IV', 'V', 'VI']
	const out = [base, base.replace(/\s(\d)$/, (_m, d) => (roman[Number(d)] ? ` ${roman[Number(d)]}` : ` ${d}`)), base.replace(/\./g, '')]
	return [...new Set(out.map((x) => x.trim()).filter((x) => x.length >= 2))].slice(0, 3)
}

// Kontrollert match: kandidater fra TMDB (inkl. alternative titler) godtas bare hvis år (±2) og regissør stemmer
async function verifiedMatch(c: Ctx, title: string, year: number, director: string | null, currentId: number | null): Promise<Match | null> {
	if (!director || !year) return null
	const ids: number[] = currentId ? [currentId] : []
	for (const q of searchQueries(title)) {
		const list = (await tmdb(c, '/search/movie', { query: q, language: 'en-US', include_adult: 'false' })).results ?? []
		for (const r of list.slice(0, 5)) {
			const y = Number((r.release_date ?? '').slice(0, 4)) || 0
			if (y && Math.abs(y - year) <= 2 && !ids.includes(r.id)) ids.push(r.id)
		}
		if (ids.length >= 3) break
	}
	for (const id of ids.slice(0, 3)) {
		const m = await tmdb(c, `/movie/${id}`, { language: 'en-US', append_to_response: 'credits' })
		const y = Number((m.release_date ?? '').slice(0, 4)) || 0
		const crew = ((m.credits?.crew ?? []) as any[]).filter((p) => p.job === 'Director').map((p) => p.name as string)
		if (y && Math.abs(y - year) <= 2 && directorsMatch(director, crew))
			return { tmdb_id: id, tmdb_title: m.title ?? null, poster_path: m.poster_path ?? null, media_type: 'movie', match: 'exact' }
	}
	return null
}

// Siste reserve: Wikidata (titler på mange språk) → IMDb-kode → TMDB. Merkes «fuzzy».
async function wikidataMatch(c: Ctx, title: string, year: number): Promise<Match | null> {
	const headers = { 'user-agent': 'filmtips/1.0 (https://filmtips.hallgeirolsen.com)', accept: 'application/json' }
	const q = searchQueries(title)[0]
	const s1 = await fetch(
		`https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&type=item&limit=5&language=en&search=${encodeURIComponent(q)}`,
		{ headers, cf: { cacheTtl: 2592000, cacheEverything: true } },
	)
	if (!s1.ok) return null
	const ids = ((await s1.json<any>()).search ?? []).map((x: any) => x.id).filter(Boolean)
	if (!ids.length) return null
	const s2 = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims&ids=${ids.join('|')}`, {
		headers,
		cf: { cacheTtl: 2592000, cacheEverything: true },
	})
	if (!s2.ok) return null
	const ents = (await s2.json<any>()).entities ?? {}
	for (const id of ids) {
		const imdb = ents[id]?.claims?.P345?.[0]?.mainsnak?.datavalue?.value
		if (typeof imdb !== 'string' || !/^tt\d{6,10}$/.test(imdb)) continue
		const f = await tmdb(c, `/find/${imdb}`, { external_source: 'imdb_id', language: 'en-US' })
		const mv = (f.movie_results ?? []).find((r: any) => !year || Math.abs((Number((r.release_date ?? '').slice(0, 4)) || 0) - year) <= 2)
		if (mv) return { tmdb_id: mv.id, tmdb_title: mv.title ?? null, poster_path: mv.poster_path ?? null, media_type: 'movie', match: 'fuzzy' }
	}
	return null
}

type RematchRow = { id: number; title: string; year: number; director: string | null; tmdb_id: number | null; match: string }

// Admin: kryssjekk titler uten treff og usikre treff (3 om gangen pga. grensen på 50 oppslag). Klienten sender last_id videre til alle er gått gjennom.
app.post('/api/admin/library/rematch', async (c) => {
	if (!(await isAdmin(c))) return c.json({ error: 'Krever admin' }, 403)
	const body = await c.req.json<{ after_id?: number }>().catch(() => ({} as { after_id?: number }))
	const after = Math.trunc(Number(body.after_id)) || 0
	const where = `id > ? AND collection = 0 AND (tmdb_id IS NULL OR (match = 'fuzzy' AND media_type = 'movie'))`
	const { results: rows } = await c.env.DB.prepare(`SELECT id, title, year, director, tmdb_id, match FROM library WHERE ${where} ORDER BY id LIMIT 3`)
		.bind(after)
		.all<RematchRow>()

	const out = await Promise.all(
		rows.map(async (r): Promise<{ kind: 'collection' | 'upgraded' | 'found' | 'same'; m?: Match }> => {
			if (!r.tmdb_id && isCollection(r.title)) return { kind: 'collection' }
			try {
				const v = await verifiedMatch(c, r.title, r.year, r.director, r.tmdb_id)
				if (v) return { kind: r.tmdb_id ? 'upgraded' : 'found', m: v }
				if (r.tmdb_id) return { kind: 'same' }
				const base = await matchTitle(c, r.title, r.year, true)
				if (base.match !== 'none') return { kind: 'found', m: base }
				const w = await wikidataMatch(c, r.title, r.year)
				return w ? { kind: 'found', m: w } : { kind: 'same' }
			} catch {
				return { kind: 'same' }
			}
		}),
	)

	const stmts = rows.flatMap((r, k) => {
		const o = out[k]
		if (o.kind === 'collection') return [c.env.DB.prepare(`UPDATE library SET collection = 1 WHERE id = ?`).bind(r.id)]
		if (!o.m) return []
		return [
			c.env.DB.prepare(`UPDATE library SET tmdb_id = ?, tmdb_title = ?, poster_path = ?, media_type = ?, match = ? WHERE id = ?`).bind(
				o.m.tmdb_id,
				o.m.tmdb_title,
				o.m.poster_path,
				o.m.media_type,
				o.m.match,
				r.id,
			),
		]
	})
	if (stmts.length) await c.env.DB.batch(stmts)

	const lastId = rows.length ? rows[rows.length - 1].id : after
	const left = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM library WHERE ${where}`).bind(lastId).first<{ n: number }>()
	const found = out.filter((o) => o.m && o.kind !== 'upgraded')
	return c.json({
		processed: rows.length,
		exact: out.filter((o) => o.m?.match === 'exact').length,
		fuzzy: found.filter((o) => o.m?.match === 'fuzzy').length,
		tv: found.filter((o) => o.m?.media_type === 'tv').length,
		collection: out.filter((o) => o.kind === 'collection').length,
		none: out.filter((o) => o.kind === 'same').length,
		last_id: lastId,
		remaining: left?.n ?? 0,
	})
})

// ---------- Strekkode: legg til enkeltfilmer ----------
const FORMATS = ['4K UHD', 'Blu-ray', 'DVD', 'Digital']

// Rydd produkttittel fra butikkdatabasen ("Heat (Blu-ray) [1995]" -> "Heat")
function cleanProductTitle(t: string): string {
	return t
		.replace(/[\[(][^\])]*(blu-?ray|dvd|4k|uhd|ultra hd|digital|edition|widescreen|steelbook|region|disc|\b(?:19|20)\d{2}\b)[^\])]*[\])]/gi, ' ')
		.replace(/\b(blu-?ray|dvd|4k ultra hd|4k uhd|4k|uhd|ultra hd|steelbook|widescreen|collector'?s edition|special edition|combo pack|bluray)\b/gi, ' ')
		.replace(/\s+[-–|:,+]+\s*$/, '')
		.replace(/\s{2,}/g, ' ')
		.trim()
}

// Admin: slå opp strekkode. Sjekker eget bibliotek først, deretter UPCitemdb (gratis: 100/dag), og foreslår TMDB-treff (film og TV).
app.get('/api/admin/barcode/:code', async (c) => {
	if (!(await isAdmin(c))) return c.json({ error: 'Krever admin' }, 403)
	const code = c.req.param('code').replace(/\D/g, '')
	if (code.length < 8 || code.length > 14) return c.json({ error: 'Ugyldig strekkode' }, 400)

	const own = await c.env.DB.prepare(`SELECT id, title, year, formats, tmdb_id, poster_path FROM library WHERE barcode = ?`).bind(code).first()
	if (own) return c.json({ code, own, product_title: null, results: [] })

	let productTitle: string | null = null
	let note: string | null = null
	try {
		const res = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${code}`, {
			headers: { accept: 'application/json' },
			cf: { cacheTtlByStatus: { '200-299': 2592000, '400-599': 0 } },
		})
		if (res.status === 429) note = 'Oppslagstjenesten er opptatt eller dagskvoten (100) er brukt opp. Søk på tittel i stedet.'
		else if (res.ok) productTitle = ((await res.json<any>())?.items?.[0]?.title as string | undefined) ?? null
		if (!productTitle && !note) note = 'Strekkoden finnes ikke i oppslagstjenesten. Søk på tittel i stedet.'
	} catch {
		note = 'Kunne ikke nå oppslagstjenesten. Søk på tittel i stedet.'
	}

	let results: Hit[] = []
	if (productTitle) {
		try {
			results = (await searchTmdb(c, cleanProductTitle(productTitle), 'multi')).slice(0, 8)
		} catch {
			note = 'TMDB-søket feilet.'
		}
	}
	return c.json({ code, own: null, product_title: productTitle, clean_title: productTitle ? cleanProductTitle(productTitle) : null, results, note })
})

// Admin: legg til én film eller serie (valgt i TMDB) i biblioteket med ett eller flere formater
app.post('/api/admin/library/add', async (c) => {
	if (!(await isAdmin(c))) return c.json({ error: 'Krever admin' }, 403)
	const b = await c.req.json<{ tmdb_id?: number; media_type?: string; formats?: string[]; barcode?: string }>().catch(() => null)
	const tmdbId = Number(b?.tmdb_id)
	const mt: 'movie' | 'tv' = b?.media_type === 'tv' ? 'tv' : 'movie'
	const formats = [...new Set((b?.formats ?? []).filter((f) => FORMATS.includes(f)))]
	const barcode = String(b?.barcode ?? '').replace(/\D/g, '')
	if (!Number.isInteger(tmdbId) || tmdbId <= 0) return c.json({ error: 'Ugyldig tittel' }, 400)
	if (!formats.length) return c.json({ error: 'Velg minst ett format' }, 400)

	let m: any
	try {
		m = await tmdb(c, `/${mt}/${tmdbId}`, { language: 'en-US', ...(mt === 'movie' ? { append_to_response: 'credits' } : {}) })
	} catch {
		return c.json({ error: 'Fant ikke tittelen i TMDB' }, 404)
	}
	const title = String((mt === 'tv' ? m.name : m.title) ?? '').slice(0, 200)
	const year = Number(String((mt === 'tv' ? m.first_air_date : m.release_date) ?? '').slice(0, 4)) || 0
	const director =
		(mt === 'tv'
			? ((m.created_by ?? []) as any[]).map((p) => p.name)
			: ((m.credits?.crew ?? []) as any[]).filter((p) => p.job === 'Director').map((p) => p.name)
		).join(' | ') || null
	const runtime = mt === 'tv' ? Number(m.episode_run_time?.[0]) || null : Number(m.runtime) || null
	const code = barcode.length >= 8 && barcode.length <= 14 ? barcode : null

	const row = await c.env.DB.prepare(
		`SELECT id, formats FROM library WHERE (tmdb_id = ? AND media_type = ?) OR (title = ? AND year = ?) ORDER BY (tmdb_id = ? AND media_type = ?) DESC LIMIT 1`,
	)
		.bind(tmdbId, mt, title, year, tmdbId, mt)
		.first<{ id: number; formats: string }>()

	if (row) {
		const merged = [...new Set([...row.formats.split('|'), ...formats])].filter(Boolean).sort().join('|')
		await c.env.DB.prepare(
			`UPDATE library SET formats = ?, barcode = COALESCE(?, barcode), tmdb_id = ?, tmdb_title = ?, poster_path = COALESCE(?, poster_path), media_type = ?, director = COALESCE(NULLIF(director, ''), ?), director_sort = COALESCE(NULLIF(director_sort, ''), ?), match = 'exact' WHERE id = ?`,
		)
			.bind(merged, code, tmdbId, title, m.poster_path ?? null, mt, director, directorSortKey(director), row.id)
			.run()
		return c.json({ ok: true, title, year, formats: merged, existed: true })
	}
	const merged = formats.sort().join('|')
	await c.env.DB.prepare(
		`INSERT INTO library (title, year, formats, genres, runtime, director, director_sort, tmdb_id, tmdb_title, poster_path, barcode, media_type, match)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'exact')`,
	)
		.bind(title, year, merged, (m.genres ?? []).map((g: any) => g.name).join(' | ') || null, runtime, director, directorSortKey(director), tmdbId, title, m.poster_path ?? null, code, mt)
		.run()
	return c.json({ ok: true, title, year, formats: merged, existed: false })
})

app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'Ikke funnet' }, 404) : c.env.ASSETS.fetch(c.req.raw)))

export default app
