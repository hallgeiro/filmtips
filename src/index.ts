import { Hono, type Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'

type Bindings = {
	DB: D1Database
	ASSETS: Fetcher
	APP_PASSWORD: string
	ADMIN_PASSWORD?: string
	TMDB_API_KEY: string
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

app.get('/api/search', async (c) => {
	const q = (c.req.query('q') ?? '').trim()
	if (q.length < 2) return c.json({ results: [] })
	try {
		const data = await tmdb(c, '/search/movie', {
			query: q,
			language: 'nb-NO',
			include_adult: 'false',
			page: c.req.query('page') ?? '1',
		})
		const results = (data.results ?? []).slice(0, 20).map((m: any) => ({
			id: m.id,
			title: m.title,
			original_title: m.original_title,
			year: (m.release_date ?? '').slice(0, 4) || null,
			poster_path: m.poster_path ?? null,
			overview: m.overview ?? '',
			vote_average: m.vote_average ?? null,
		}))
		return c.json({ results })
	} catch {
		return c.json({ error: 'Søket mot TMDB feilet' }, 502)
	}
})

// Strømmetjenester i Norge (data fra JustWatch via TMDB)
app.get('/api/movie/:id/providers', async (c) => {
	const id = Number(c.req.param('id'))
	if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Ugyldig id' }, 400)
	try {
		const data = await tmdb(c, `/movie/${id}/watch/providers`)
		const no = data.results?.NO ?? {}
		const pick = (arr: any[] | undefined) =>
			(arr ?? []).map((p) => ({ id: p.provider_id, name: p.provider_name, logo_path: p.logo_path }))
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
})

/* ---------- Anbefalinger (D1) ---------- */

app.get('/api/recommendations', async (c) => {
	const tmdbId = c.req.query('tmdb_id')
	const limit = Math.min(Math.max(Number(c.req.query('limit')) || 100, 1), 200)
	const offset = Math.max(Number(c.req.query('offset')) || 0, 0)

	const select = `SELECT r.*, (SELECT group_concat(l.formats, '|') FROM library l WHERE l.tmdb_id = r.tmdb_id) AS library_formats FROM recommendations r`
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

type Match = { tmdb_id: number | null; tmdb_title: string | null; poster_path: string | null; match: 'exact' | 'fuzzy' | 'none' }

// Finn film i TMDB ut fra tittel + år. Maks 2 oppslag per film.
async function matchMovie(c: Ctx, title: string, year: number): Promise<Match> {
	const none: Match = { tmdb_id: null, tmdb_title: null, poster_path: null, match: 'none' }
	try {
		const n = norm(title)
		const base = norm(title.split(/[:(]/)[0])
		const pick = (r: any) => ({ tmdb_id: r.id as number, tmdb_title: (r.title ?? null) as string | null, poster_path: (r.poster_path ?? null) as string | null })
		const ry = (r: any) => Number((r.release_date ?? '').slice(0, 4)) || 0
		const titleEq = (r: any, x: string) => norm(r.title ?? '') === x || norm(r.original_title ?? '') === x
		const params = { query: title, language: 'en-US', include_adult: 'false' }

		const a: any[] = year ? ((await tmdb(c, '/search/movie', { ...params, primary_release_year: String(year) })).results ?? []) : []
		const exact = a.find((r) => titleEq(r, n))
		if (exact) return { ...pick(exact), match: 'exact' }

		const b: any[] = (await tmdb(c, '/search/movie', params)).results ?? []
		const near = b.find((r) => titleEq(r, n) && (!year || Math.abs(ry(r) - year) <= 1))
		if (near) return { ...pick(near), match: 'exact' }

		// Usikker treff: samme år, og tittelen ligner (del av tittel, f.eks. uten undertittel)
		const fuzzy = a.find((r) => {
			const t = norm(r.title ?? '')
			return titleEq(r, base) || (base.length >= 4 && (t.includes(base) || base.includes(t)))
		})
		if (fuzzy) return { ...pick(fuzzy), match: 'fuzzy' }
		return none
	} catch {
		return none
	}
}

app.get('/api/library', async (c) => {
	const q = (c.req.query('q') ?? '').trim()
	const format = (c.req.query('format') ?? '').trim()
	const tmdbId = Number(c.req.query('tmdb_id')) || 0
	const unmatched = c.req.query('unmatched') === '1'
	const limit = Math.min(Math.max(Number(c.req.query('limit')) || 60, 1), 200)
	const offset = Math.max(Number(c.req.query('offset')) || 0, 0)

	const where: string[] = []
	const args: (string | number)[] = []
	if (q) (where.push('title LIKE ?'), args.push(`%${q}%`))
	if (format) (where.push('formats LIKE ?'), args.push(`%${format}%`))
	if (tmdbId) (where.push('tmdb_id = ?'), args.push(tmdbId))
	if (unmatched) where.push('tmdb_id IS NULL')
	const w = where.length ? 'WHERE ' + where.join(' AND ') : ''

	const [rows, count] = await Promise.all([
		c.env.DB.prepare(
			`SELECT id, title, year, formats, tmdb_id, tmdb_title, poster_path, match FROM library ${w} ORDER BY title COLLATE NOCASE LIMIT ? OFFSET ?`,
		)
			.bind(...args, limit, offset)
			.all(),
		c.env.DB.prepare(`SELECT COUNT(*) AS n FROM library ${w}`).bind(...args).first<{ n: number }>(),
	])
	return c.json({ results: rows.results, total: count?.n ?? 0 })
})

// Admin: importer en bunke (maks 20) filmer fra CLZ. Kan kjøres på nytt uten å lage duplikater.
app.post('/api/admin/library/import', async (c) => {
	if (!(await isAdmin(c))) return c.json({ error: 'Krever admin' }, 403)
	const body = await c.req.json<{ items?: any[] }>().catch(() => ({ items: undefined }))
	const raw = Array.isArray(body.items) ? body.items.slice(0, 20) : []

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
				: matchMovie(c, i.title, i.year),
		),
	)

	const stmts = items.map((i, k) => {
		const m = matches[k] ?? { tmdb_id: null, tmdb_title: null, poster_path: null, match: 'none' as const }
		return c.env.DB.prepare(
			`INSERT INTO library (title, year, formats, genres, runtime, director, distributor, added_date, tmdb_id, tmdb_title, poster_path, match)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (title, year) DO UPDATE SET
			   formats = excluded.formats, genres = excluded.genres, runtime = excluded.runtime,
			   director = excluded.director, distributor = excluded.distributor, added_date = excluded.added_date,
			   tmdb_id = COALESCE(library.tmdb_id, excluded.tmdb_id),
			   tmdb_title = COALESCE(library.tmdb_title, excluded.tmdb_title),
			   poster_path = COALESCE(library.poster_path, excluded.poster_path),
			   match = CASE WHEN library.tmdb_id IS NULL THEN excluded.match ELSE library.match END`,
		).bind(i.title, i.year, i.formats, i.genres, i.runtime, i.director, i.distributor, i.added_date, m.tmdb_id, m.tmdb_title, m.poster_path, m.match)
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

app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'Ikke funnet' }, 404) : c.env.ASSETS.fetch(c.req.raw)))

export default app
