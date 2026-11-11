// 엄마 항암 수첩 — Cloudflare Pages Functions API
// Bindings (Pages → Settings): D1 database "DB", secrets FAMILY_PASSWORD, ANTHROPIC_API_KEY
const COLLS = new Set(["schedules", "days", "entries", "labs", "claims"]);
const ID_RE = /^[A-Za-z0-9_\-.:]{1,80}$/;
const COOKIE = "momnote";
const MODEL = "claude-sonnet-5-5";

const json = (o, s = 200, h = {}) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...h } });

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const token = env => hmac(env.FAMILY_PASSWORD, "mom-note-v1");
function getCookie(req, name) {
  const m = (req.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? m[1] : null;
}
function same(a, b) { if (!a || !b || a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

let ready = false;
async function init(db) {
  if (ready) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS docs (coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT, v INTEGER NOT NULL, del INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (coll, id))"),
    db.prepare("CREATE INDEX IF NOT EXISTS docs_v ON docs (v)"),
    db.prepare("CREATE TABLE IF NOT EXISTS lim (k TEXT PRIMARY KEY, n INTEGER NOT NULL, t INTEGER NOT NULL)"),
  ]);
  ready = true;
}
async function bump(db, key, max, windowMs) { // returns true when over the limit
  const now = Date.now();
  const row = await db.prepare("SELECT n, t FROM lim WHERE k=?").bind(key).first();
  if (!row || now - row.t > windowMs) { await db.prepare("INSERT OR REPLACE INTO lim (k,n,t) VALUES (?,1,?)").bind(key, now).run(); return false; }
  if (row.n >= max) return true;
  await db.prepare("UPDATE lim SET n=n+1 WHERE k=?").bind(key).run();
  return false;
}
let lastV = 0;
const nextV = () => (lastV = Math.max(Date.now(), lastV + 1));
const newId = () => [...crypto.getRandomValues(new Uint8Array(12))].map(b => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");

export async function onRequest({ request, env, params }) {
  if (!env.DB) return json({ error: "no_db" }, 500);
  if (!env.FAMILY_PASSWORD) return json({ error: "no_password" }, 500);
  const db = env.DB; await init(db);
  const path = [].concat(params.path || []);
  const ip = request.headers.get("cf-connecting-ip") || "?";
  const m = request.method;

  if (path[0] === "login" && m === "POST") {
    if (await bump(db, "login:" + ip, 10, 10 * 60 * 1000)) return json({ error: "too_many" }, 429);
    let pw = ""; try { pw = String((await request.json()).pw || ""); } catch (_) {}
    if (!same(pw, env.FAMILY_PASSWORD)) return json({ error: "wrong" }, 401);
    const t = await token(env);
    return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=${t}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax` });
  }
  if (path[0] === "logout") return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` });

  if (!same(getCookie(request, COOKIE), await token(env))) return json({ error: "auth" }, 401);

  // GET /api/sync?since=V → changed docs since V
  if (path[0] === "sync" && m === "GET") {
    const since = Number(new URL(request.url).searchParams.get("since") || 0) || 0;
    const { results } = await db.prepare("SELECT coll, id, data, v, del FROM docs WHERE v > ? ORDER BY v").bind(since).all();
    let v = since; for (const r of results) v = Math.max(v, r.v);
    return json({ v, docs: results.map(r => ({ coll: r.coll, id: r.id, v: r.v, del: !!r.del, data: r.del ? null : JSON.parse(r.data) })) });
  }

  // /api/doc/:coll[/:id]
  if (path[0] === "doc") {
    const coll = path[1], id = path[2];
    if (!COLLS.has(coll)) return json({ error: "bad_coll" }, 400);
    if (id && !ID_RE.test(id)) return json({ error: "bad_id" }, 400);
    if (m === "DELETE" && id) {
      await db.prepare("INSERT INTO docs (coll,id,data,v,del) VALUES (?,?,NULL,?,1) ON CONFLICT(coll,id) DO UPDATE SET data=NULL, v=excluded.v, del=1").bind(coll, id, nextV()).run();
      return json({ ok: true });
    }
    if (m === "PUT" || m === "POST") {
      const text = await request.text();
      if (text.length > 60000) return json({ error: "too_big" }, 413);
      let data; try { data = JSON.parse(text); } catch (_) { return json({ error: "bad_json" }, 400); }
      if (!data || typeof data !== "object" || Array.isArray(data)) return json({ error: "bad_json" }, 400);
      const did = id || newId(), v = nextV();
      await db.prepare("INSERT INTO docs (coll,id,data,v,del) VALUES (?,?,?,?,0) ON CONFLICT(coll,id) DO UPDATE SET data=excluded.data, v=excluded.v, del=0").bind(coll, did, JSON.stringify(data), v).run();
      return json({ ok: true, id: did, v });
    }
    return json({ error: "method" }, 405);
  }

  // POST /api/import  {schedules:{id:data},...} — only fills ids that don't exist yet
  if (path[0] === "import" && m === "POST") {
    let body; try { body = await request.json(); } catch (_) { return json({ error: "bad_json" }, 400); }
    const stmts = []; let n = 0;
    for (const coll of COLLS) for (const [id, data] of Object.entries(body[coll] || {})) {
      if (!ID_RE.test(id) || !data || typeof data !== "object") continue;
      stmts.push(db.prepare("INSERT OR IGNORE INTO docs (coll,id,data,v,del) VALUES (?,?,?,?,0)").bind(coll, id, JSON.stringify(data), nextV())); n++;
    }
    for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
    return json({ ok: true, n });
  }

  // GET /api/export → everything, for the family's own backup
  if (path[0] === "export" && m === "GET") {
    const { results } = await db.prepare("SELECT coll, id, data FROM docs WHERE del=0").all();
    const out = {}; for (const c of COLLS) out[c] = {};
    for (const r of results) out[r.coll][r.id] = JSON.parse(r.data);
    return json(out);
  }

  // POST /api/scan {prompt, images:[{type,data}]} → Claude reads lab captures
  if (path[0] === "scan" && m === "POST") {
    if (!env.ANTHROPIC_API_KEY) return json({ error: "no_key" }, 501);
    if (await bump(db, "scan:day:" + new Date().toISOString().slice(0, 10), 60, 86400000)) return json({ error: "rate_limited" }, 429);
    let body; try { body = await request.json(); } catch (_) { return json({ error: "bad_json" }, 400); }
    const imgs = (body.images || []).slice(0, 6).filter(x => /^image\/(png|jpeg|webp|gif)$/.test(x.type) && typeof x.data === "string");
    if (!imgs.length) return json({ error: "image_rejected" }, 400);
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL, max_tokens: 4000,
        messages: [{ role: "user", content: [...imgs.map(x => ({ type: "image", source: { type: "base64", media_type: x.type, data: x.data } })), { type: "text", text: String(body.prompt || "").slice(0, 8000) }] }],
      }),
    });
    if (!r.ok) return json({ error: r.status === 429 ? "rate_limited" : "api_error", status: r.status }, 502);
    const out = await r.json();
    const text = (out.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    const mm = text.match(/\{[\s\S]*\}/);
    try { return json({ ok: true, result: JSON.parse(mm ? mm[0] : text) }); } catch (_) { return json({ error: "invalid_json" }, 502); }
  }

  return json({ error: "not_found" }, 404);
}
