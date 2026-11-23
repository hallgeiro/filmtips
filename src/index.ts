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

app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'Ikke funnet' }, 404) : c.env.ASSETS.fetch(c.req.raw)))

export default app
