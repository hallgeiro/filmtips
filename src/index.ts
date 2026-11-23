import { Hono, type Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'

type Bindings = {
	DB: D1Database
	ASSETS: Fetcher
	APP_PASSWORD: string
	TMDB_API_KEY: string
	USERS: string
}
type Ctx = Context<{ Bindings: Bindings }>

const app = new Hono<{ Bindings: Bindings }>()

const COOKIE = 'filmtips_session'
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
async function sessionToken(password: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
	const sig = await crypto.subtle.sign('HMAC', key, enc.encode('filmtips-session-v1'))
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

app.post('/api/login', async (c) => {
	const body = await c.req.json<{ password?: string }>().catch(() => ({} as { password?: string }))
	const password = String(body.password ?? '')
	if (!c.env.APP_PASSWORD || !(await safeEqual(password, c.env.APP_PASSWORD))) {
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

app.get('/api/config', (c) => c.json({ users: getUsers(c.env) }))

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

	const stmt = tmdbId
		? c.env.DB.prepare(
				`SELECT * FROM recommendations WHERE tmdb_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
			).bind(Number(tmdbId), limit, offset)
		: c.env.DB.prepare(`SELECT * FROM recommendations ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).bind(
				limit,
				offset,
			)
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

// Tillitsbasert: du kan slette egne anbefalinger ved å oppgi navnet ditt
app.delete('/api/recommendations/:id', async (c) => {
	const id = Number(c.req.param('id'))
	const username = (c.req.query('username') ?? '').trim()
	if (!Number.isInteger(id) || !username) return c.json({ error: 'Ugyldig forespørsel' }, 400)
	const res = await c.env.DB.prepare(`DELETE FROM recommendations WHERE id = ? AND username = ?`).bind(id, username).run()
	return c.json({ ok: true, deleted: res.meta.changes })
})

app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'Ikke funnet' }, 404) : c.env.ASSETS.fetch(c.req.raw)))

export default app
