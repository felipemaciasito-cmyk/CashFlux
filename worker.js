// CashFlux Bank — Cloudflare Worker
// Pont sécurisé entre l'app CashFlux et l'API Enable Banking (lecture seule).
// Liaisons requises : KV namespace "KV" + secret "APP_TOKEN".

const EB = "https://api.enablebanking.com";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-Token",
  "Access-Control-Max-Age": "86400",
};
const json = (d, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const msg = (x) => (typeof x === "string" ? x : x ? JSON.stringify(x) : "");

export default {
  async fetch(req, env) {
    try { return await route(req, env); }
    catch (e) { return json({ error: e.message || String(e), details: e.data }, e.status || 500); }
  },
};

async function route(req, env) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, "") || "/";
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (p === "/") return new Response("CashFlux Bank : serveur en ligne ✓", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  if (p === "/callback") return callback(url, env);

  if (!env.KV) return json({ error: "Liaison KV manquante sur le Worker (nom attendu : KV)" }, 500);
  if (!env.APP_TOKEN) return json({ error: "Secret APP_TOKEN manquant sur le Worker" }, 500);
  if (req.headers.get("X-Token") !== env.APP_TOKEN) return json({ error: "Code d'accès invalide" }, 401);

  if (p === "/status" && req.method === "GET") return status(env);
  if (p === "/setup" && req.method === "POST") return setup(req, env);
  if (p === "/aspsps" && req.method === "GET")
    return json(await eb(env, "/aspsps?country=" + encodeURIComponent(url.searchParams.get("country") || "FR")));
  if (p === "/connect" && req.method === "POST") return connect(req, env, url);

  let m = p.match(/^\/accounts\/([^/]+)\/(balances|transactions)$/);
  if (m && req.method === "GET") {
    const uid = encodeURIComponent(decodeURIComponent(m[1]));
    return m[2] === "transactions" ? transactions(env, uid, url) : json(await eb(env, `/accounts/${uid}/balances`));
  }
  m = p.match(/^\/sessions\/([^/]+)$/);
  if (m && req.method === "DELETE") return removeSession(env, decodeURIComponent(m[1]));
  return json({ error: "Introuvable" }, 404);
}

/* ---------- Clé & JWT ---------- */
async function getCreds(env) {
  if (env.EB_APP_ID && env.EB_PRIVATE_KEY) return { appId: env.EB_APP_ID, pem: env.EB_PRIVATE_KEY };
  return await env.KV.get("creds", "json");
}
let cache = { jwt: null, exp: 0 };
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uStr = (s) => b64u(new TextEncoder().encode(s));
function derLen(n) { if (n < 128) return [n]; const o = []; while (n > 0) { o.unshift(n & 255); n >>= 8; } return [0x80 | o.length, ...o]; }
function pemToPkcs8(pem) {
  const pkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  const b = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  if (!pkcs1) return der.buffer;
  // Enveloppe PKCS#1 -> PKCS#8
  const algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const body = [0x02, 0x01, 0x00, ...algo, 0x04, ...derLen(der.length), ...der];
  return new Uint8Array([0x30, ...derLen(body.length), ...body]).buffer;
}
async function signJwt(creds) {
  const key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(creds.pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const h = b64uStr(JSON.stringify({ typ: "JWT", alg: "RS256", kid: creds.appId }));
  const b = b64uStr(JSON.stringify({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat: now, exp: now + 3600 }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(h + "." + b));
  return { jwt: `${h}.${b}.${b64u(new Uint8Array(sig))}`, exp: now + 3600 };
}
async function jwt(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cache.jwt && cache.exp - now > 120) return cache.jwt;
  const c = await getCreds(env);
  if (!c) { const e = new Error("Clé Enable Banking non configurée"); e.status = 400; throw e; }
  cache = await signJwt(c);
  return cache.jwt;
}
async function eb(env, path, opt = {}, token) {
  const r = await fetch(EB + path, {
    ...opt,
    headers: { Authorization: "Bearer " + (token || (await jwt(env))), "Content-Type": "application/json", ...(opt.headers || {}) },
  });
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = { raw: t.slice(0, 300) }; }
  if (!r.ok) {
    const e = new Error("Enable Banking : " + (msg(d.message) || msg(d.error) || msg(d.detail) || "erreur " + r.status));
    e.status = r.status; e.data = d; throw e;
  }
  return d;
}

/* ---------- Routes ---------- */
async function status(env) {
  const c = await getCreds(env);
  const sessions = (await env.KV.get("sessions", "json")) || [];
  return json({ configured: !!c, appId: c ? c.appId : null, sessions });
}

async function setup(req, env) {
  const { appId, pem } = await req.json();
  if (!appId || !/PRIVATE KEY/.test(pem || "")) return json({ error: "Identifiant ou clé .pem invalide" }, 400);
  let test;
  try { test = await signJwt({ appId, pem }); }
  catch { return json({ error: "Clé illisible : vérifie que c'est bien le fichier .pem d'Enable Banking" }, 400); }
  try { await eb(env, "/aspsps?country=FR", {}, test.jwt); }
  catch (e) { return json({ error: "Clé refusée par Enable Banking (" + e.message + "). Vérifie l'identifiant de l'application." }, 400); }
  await env.KV.put("creds", JSON.stringify({ appId, pem }));
  cache = test;
  return json({ ok: true });
}

async function connect(req, env, url) {
  const { aspsp, returnUrl, days } = await req.json();
  if (!aspsp || !aspsp.name) return json({ error: "Banque manquante" }, 400);
  const state = crypto.randomUUID();
  const tries = [...new Set([Math.max(1, Math.min(+days || 90, 180)), 90, 30])].sort((a, b) => b - a);
  let last;
  for (const d of tries) {
    const body = {
      access: { valid_until: new Date(Date.now() + d * 864e5).toISOString() },
      aspsp: { name: aspsp.name, country: aspsp.country || "FR" },
      state,
      redirect_url: url.origin + "/callback",
      psu_type: "personal",
    };
    try {
      const r = await eb(env, "/auth", { method: "POST", body: JSON.stringify(body) });
      await env.KV.put("state:" + state, JSON.stringify({ returnUrl, aspsp: body.aspsp }), { expirationTtl: 3600 });
      return json({ url: r.url });
    } catch (e) {
      last = e;
      if (!(e.status >= 400 && e.status < 500)) break;
    }
  }
  throw last;
}

function donePage(ok, text) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:-apple-system,sans-serif;background:#0B0C16;color:#F1F1F9;display:grid;place-items:center;min-height:90vh;text-align:center;padding:24px">
<div><div style="font-size:48px">${ok ? "✅" : "⚠️"}</div><h2>${ok ? "Banque connectée" : "Connexion échouée"}</h2>
<p style="color:#8E90AB">${ok ? "Retourne dans CashFlux pour associer tes comptes." : String(text || "").replace(/[<>&]/g, "")}</p></div></body>`;
}

async function callback(url, env) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const err = url.searchParams.get("error");
  const st = state && env.KV ? await env.KV.get("state:" + state, "json") : null;
  const done = (ok, text) => {
    if (st && st.returnUrl) {
      const u = st.returnUrl.split("#")[0] + "#bank=" + (ok ? "ok" : "error") + (text ? "&msg=" + encodeURIComponent(text) : "");
      return Response.redirect(u, 302);
    }
    return new Response(donePage(ok, text), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  };
  if (err || !code) return done(false, url.searchParams.get("error_description") || err || "Autorisation annulée");
  if (!st) return done(false, "Lien expiré : recommence la connexion depuis CashFlux");
  try {
    const s = await eb(env, "/sessions", { method: "POST", body: JSON.stringify({ code }) });
    const accounts = [];
    for (const a of s.accounts || []) {
      const uid = typeof a === "string" ? a : a.uid;
      let info = typeof a === "object" ? a : {};
      if (typeof a === "string") { try { info = await eb(env, `/accounts/${encodeURIComponent(uid)}/details`); } catch {} }
      accounts.push({
        uid,
        name: info.name || info.product || info.details || "",
        iban: (info.account_id && info.account_id.iban) || "",
        currency: info.currency || "EUR",
      });
    }
    const newIbans = new Set(accounts.map((a) => a.iban).filter(Boolean));
    let sessions = (await env.KV.get("sessions", "json")) || [];
    // Un renouvellement remplace l'ancienne session de la même banque
    sessions = sessions.filter((x) => !(x.aspsp.name === st.aspsp.name && x.accounts.length && x.accounts.every((a) => a.iban && newIbans.has(a.iban))));
    sessions.push({
      session_id: s.session_id,
      aspsp: st.aspsp,
      valid_until: (s.access && s.access.valid_until) || null,
      created: new Date().toISOString(),
      accounts,
    });
    await env.KV.put("sessions", JSON.stringify(sessions));
    await env.KV.delete("state:" + state);
    return done(true);
  } catch (e) {
    return done(false, e.message);
  }
}

async function transactions(env, uid, url) {
  const from = url.searchParams.get("date_from");
  let all = [], key = null, i = 0;
  do {
    const q = new URLSearchParams();
    if (from) q.set("date_from", from);
    if (key) q.set("continuation_key", key);
    const d = await eb(env, `/accounts/${uid}/transactions?${q}`);
    all = all.concat(d.transactions || []);
    key = d.continuation_key || null;
    i++;
  } while (key && i < 15);
  return json({ transactions: all });
}

async function removeSession(env, id) {
  try { await eb(env, "/sessions/" + encodeURIComponent(id), { method: "DELETE" }); } catch {}
  const sessions = ((await env.KV.get("sessions", "json")) || []).filter((s) => s.session_id !== id);
  await env.KV.put("sessions", JSON.stringify(sessions));
  return json({ ok: true });
}
