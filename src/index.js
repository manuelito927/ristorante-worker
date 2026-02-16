import { neon } from "@neondatabase/serverless";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,authorization"
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...cors }
  });

const unauthorized = () => json({ error: "Unauthorized" }, 401);

const isAdmin = (req, env) => {
  const h = req.headers.get("authorization") || "";
  const token = h.replace(/^Bearer\s+/i, "").trim();
  const secret = String(env.ADMIN_TOKEN || "").trim();
  return !!secret && token === secret;
};

const cleanStr = (v) => (v == null ? "" : String(v)).trim();

const normalizeAllergens = (v) => {
  const allowed = new Set([
    "glutine","crostacei","uova","pesce","arachidi","soia","latte",
    "frutta_a_guscio","sedano","senape","sesamo","solfiti",
    "lupini","molluschi","nichel"
  ]);

  const arr = Array.isArray(v) ? v : [];
  return Array.from(
    new Set(
      arr
        .map(x => String(x ?? "").trim().toLowerCase())
        .filter(x => x && allowed.has(x))
    )
  );
};

async function translateToEn(env, text) {
  const t = String(text || "").trim();
  if (!t) return "";

  const out = await env.AI.run("@cf/meta/m2m100-1.2b", {
    text: t,
    source_lang: "it",
    target_lang: "en",
  });

  return out?.translated_text || "";
}

/* =========================================================
   R2: serve immagini pubbliche
   GET /img/NOMEFILE.jpg
   ========================================================= */
async function serveR2Image(req, env, url) {
  if (!url.pathname.startsWith("/img/")) return null;

  const key = url.pathname.replace("/img/", "");
  if (!key) return new Response("Not found", { status: 404, headers: cors });

  if (!env.BUCKET) {
    return new Response("Bucket binding missing", { status: 500, headers: cors });
  }

  const obj = await env.BUCKET.get(key);
  if (!obj) return new Response("Not found", { status: 404, headers: cors });

  const headers = new Headers(cors);
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", "public, max-age=86400");

  return new Response(obj.body, { headers });
}

/* =========================================================
   ADMIN: upload su R2 (gratis finché resti nei limiti R2)
   POST /api/admin/gallery/upload
   Content-Type: multipart/form-data
   form-data:
     - file: (binary)
   ritorna: { ok:true, url:"https://.../img/xxxxx.jpg", key:"xxxxx.jpg" }
   ========================================================= */
async function uploadToR2(req, env, url) {
  if (!(url.pathname === "/api/admin/gallery/upload" && req.method === "POST")) return null;

  if (!isAdmin(req, env)) return unauthorized();

  if (!env.BUCKET) return json({ error: "BUCKET binding missing" }, 500);

  const ct = req.headers.get("content-type") || "";
  if (!ct.includes("multipart/form-data")) {
    return json({ error: "Use multipart/form-data" }, 400);
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!file) return json({ error: "file missing" }, 400);

  // Cloudflare File object
  const fname = (file.name || "upload").toLowerCase();
  const ext = fname.includes(".") ? fname.split(".").pop() : "jpg";

  const allowed = new Set(["jpg", "jpeg", "png", "webp"]);
  if (!allowed.has(ext)) return json({ error: "Only jpg/jpeg/png/webp allowed" }, 400);

  const safeBase =
    "gal_" +
    Date.now() +
    "_" +
    Math.random().toString(16).slice(2);

  const key = `${safeBase}.${ext}`;

  // content-type
  const contentType =
    ext === "png" ? "image/png" :
    ext === "webp" ? "image/webp" :
    "image/jpeg";

  await env.BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType }
  });

  // url pubblico (passa dal Worker)
  const origin = new URL(req.url).origin;
  const publicUrl = `${origin}/img/${key}`;

  return json({ ok: true, key, url: publicUrl }, 201);
}

export default {
  async fetch(req, env) {
    // preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(req.url);

    // ✅ 1) PRIMA di tutto: immagini da R2 (così NON serve DATABASE_URL)
    const r2img = await serveR2Image(req, env, url);
    if (r2img) return r2img;

    // ✅ 2) Upload R2 (admin) NON richiede DB
    const r2upload = await uploadToR2(req, env, url);
    if (r2upload) return r2upload;

    // ✅ 3) Da qui in poi serve DB
    if (!env.DATABASE_URL) {
      return json({ error: "DATABASE_URL missing" }, 500);
    }

    const sql = neon(env.DATABASE_URL);
    
// ==========================
// MENU CATEGORIES ORDER (NUMERICO)
// salva/legge l'ordine delle categorie del MENU
// ==========================

// PUBLIC: GET /api/menu/categories
// ritorna: { data: { categories: [{ name:"PIZZE", order:0 }, ...] } }
if (url.pathname === "/api/menu/categories" && req.method === "GET") {
  const rows = await sql`
    select data
    from site_pages
    where slug = 'menu_categories'
    limit 1
  `;

  const d = rows.length && rows[0]?.data && typeof rows[0].data === "object"
    ? rows[0].data
    : {};

  // nuovo formato
  const categories = Array.isArray(d.categories) ? d.categories : [];

  // normalizza: name string, order numero
  const normalized = categories
    .map(c => ({
      name: cleanStr(c?.name),
      order: Number.isFinite(Number(c?.order)) ? Number(c.order) : 0
    }))
    .filter(c => c.name);

  return json({ data: { categories: normalized } });
}

// ADMIN: PUT /api/admin/menu/categories
// body: { categories: [{ name:"PIZZE", order:0 }, ...] }
if (url.pathname === "/api/admin/menu/categories" && req.method === "PUT") {
  if (!isAdmin(req, env)) return unauthorized();

  const body = await req.json().catch(() => ({}));

  const categories = Array.isArray(body.categories) ? body.categories : [];

  const normalized = categories
    .map(c => ({
      name: cleanStr(c?.name),
      order: Number.isFinite(Number(c?.order)) ? Number(c.order) : 0
    }))
    .filter(c => c.name);

  await sql`
    insert into site_pages (slug, data)
    values ('menu_categories', ${JSON.stringify({ categories: normalized })}::jsonb)
    on conflict (slug)
    do update set data = excluded.data, updated_at = now()
  `;

  return json({ ok: true, data: { categories: normalized } });
}
    
    // ==========================
// PUBLIC: BOOKING SETTINGS
// GET /api/settings/booking
// ritorna { data: { enabled, whatsapp } }
// ==========================
if (url.pathname === "/api/settings/booking" && req.method === "GET") {
  const rows = await sql`
    select data
    from site_pages
    where slug = 'booking'
    limit 1
  `;

  const d = rows.length && rows[0]?.data && typeof rows[0].data === "object"
    ? rows[0].data
    : {};

return json({ data: { enabled: d.enabled !== false, whatsapp: d.whatsapp || "" } });
}

// ==========================
// ADMIN: BOOKING SETTINGS
// PUT /api/admin/settings/booking
// body: { enabled: true/false, whatsapp: "+39..." }
// ==========================
if (url.pathname === "/api/admin/settings/booking" && req.method === "PUT") {
  if (!isAdmin(req, env)) return unauthorized();

  const body = await req.json().catch(() => ({}));
  const data = { enabled: !!body.enabled, whatsapp: cleanStr(body.whatsapp) };

  await sql`
    insert into site_pages (slug, data)
    values ('booking', ${JSON.stringify(data)}::jsonb)
    on conflict (slug)
    do update set data = excluded.data, updated_at = now()
  `;

  return json({ ok: true, data });
}

    /* ==========================
       ADMIN: MENU CRUD
       ========================== */

if (url.pathname === "/api/admin/menu" && req.method === "POST") {
  if (!isAdmin(req, env)) return unauthorized();
  const body = await req.json().catch(() => ({}));

  const {
  name,
  description = "",
  category = "",
  name_en = "",
  description_en = "",
  category_en = "",
  image_url = "",
  price_cents,
  position = 0,
  is_available = true,
  allergens = []
} = body;

const allergens_clean = normalizeAllergens(allergens);

  if (!name || typeof price_cents !== "number") {
    return json({ error: "name and price_cents required" }, 400);
  }

  const rows = await sql`
insert into menu_items
  (name, description, price_cents, category, position, is_available,
   name_en, description_en, category_en, allergens, image_url)
values
  (${name}, ${description}, ${price_cents}, ${category}, ${position}, ${is_available},
   ${name_en}, ${description_en}, ${category_en}, ${allergens_clean}, ${image_url})
    returning *
  `;

  return json({ item: rows[0] }, 201);
}

    if (url.pathname.startsWith("/api/admin/menu/") && req.method === "PUT") {
      if (!isAdmin(req, env)) return unauthorized();

      const id = url.pathname.split("/").pop();
      const body = await req.json();
const allergensParam =
  Object.prototype.hasOwnProperty.call(body, "allergens")
    ? normalizeAllergens(body.allergens)
    : null;
const hasImageUrl = Object.prototype.hasOwnProperty.call(body, "image_url");

      const rows = await sql`
        update menu_items
        set
          name = coalesce(${body.name ?? null}, name),
          description = coalesce(${body.description ?? null}, description),
          price_cents = coalesce(${body.price_cents ?? null}, price_cents),
          category = coalesce(${body.category ?? null}, category),
image_url = case
  when ${hasImageUrl} then ${body.image_url ?? null}
  else image_url
end,
          position = coalesce(${body.position ?? null}, position),
          is_available = coalesce(${body.is_available ?? null}, is_available),
          name_en = coalesce(${body.name_en ?? null}, name_en),
          description_en = coalesce(${body.description_en ?? null}, description_en),
          category_en = coalesce(${body.category_en ?? null}, category_en)
,allergens = coalesce(${allergensParam}, allergens)
        where id::text = ${id}
        returning *
      `;
      if (!rows.length) return json({ error: "Not found" }, 404);
      return json({ item: rows[0] });
    }

    if (url.pathname.startsWith("/api/admin/menu/") && req.method === "DELETE") {
      if (!isAdmin(req, env)) return unauthorized();

      const id = url.pathname.split("/").pop();
      const rows = await sql`
        delete from menu_items
        where id::text = ${id}
        returning id
      `;
      if (!rows.length) return json({ error: "Not found" }, 404);
      return json({ ok: true });
    }

  /* ==========================
   PUBLIC: MENU (ritorna IT + EN)
   ========================== */
if (url.pathname === "/api/menu" && req.method === "GET") {
  // 1) prendo tutti gli items
  const rows = await sql`
    select
      id,
      name,
      description,
      price_cents,
      category,
      image_url,
      position,
      is_available,
      name_en,
      description_en,
      category_en,
      allergens
    from menu_items
    where is_available = true
  `;

  // 2) prendo ordine categorie salvato in site_pages
  const catRows = await sql`
    select data
    from site_pages
    where slug = 'menu_categories'
    limit 1
  `;

  const d = catRows.length && catRows[0]?.data && typeof catRows[0].data === "object"
    ? catRows[0].data
    : {};

// nuovo formato: categories: [{name, order}]
const categories = Array.isArray(d.categories) ? d.categories : [];

// map: categoria -> order numerico
const orderMap = new Map();
categories.forEach((c) => {
  const name = cleanStr(c?.name);
  const ord = Number.isFinite(Number(c?.order)) ? Number(c.order) : 9999;
  if (name) orderMap.set(name, ord);
});
  // 3) sort JS: prima categoria (secondo ordine admin), poi position
const items = (rows || []).slice().sort((a, b) => {
  const ac = String(a.category || "").trim();
  const bc = String(b.category || "").trim();

  const ai = orderMap.has(ac) ? orderMap.get(ac) : 9999;
  const bi = orderMap.has(bc) ? orderMap.get(bc) : 9999;

  if (ai !== bi) return ai - bi;

  const ap = Number.isFinite(Number(a.position)) ? Number(a.position) : 0;
  const bp = Number.isFinite(Number(b.position)) ? Number(b.position) : 0;
  if (ap !== bp) return ap - bp;

  // ✅ stabilizza: se stessa position, ordina per id
  const aid = Number(a.id || 0);
  const bid = Number(b.id || 0);
  if (aid !== bid) return aid - bid;

  // fallback finale
  return String(a.name || "").localeCompare(String(b.name || ""), "it");
});
return json({ items });
}
    /* ==========================
       PUBLIC: PRENOTA
       ========================== */
    if (url.pathname === "/api/reservations" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));

      const full_name = cleanStr(body.name);
      const phone = cleanStr(body.phone);
      const people = Number(body.people || 2);

      const date = cleanStr(body.date);
      const time = cleanStr(body.time);
      const notes = cleanStr(body.notes) || null;

      if (!full_name || !phone || !date || !time) {
        return json({ error: "name, phone, date, time required" }, 400);
      }
      if (!Number.isFinite(people) || people < 1 || people > 30) {
        return json({ error: "people invalid" }, 400);
      }

      const reserved_at = `${date} ${time}`;

      const rows = await sql`
        insert into reservations (full_name, phone, people, reserved_at, notes, status)
        values (${full_name}, ${phone}, ${people}, ${reserved_at}::timestamp, ${notes}, 'new')
returning id, created_at, status, to_char(reserved_at, 'YYYY-MM-DD HH24:MI') as reserved_at
      `;

      return json({ ok: true, reservation: rows[0] }, 201);
    }

    /* ==========================
       ADMIN: PRENOTAZIONI
       ========================== */
if (url.pathname === "/api/admin/reservations" && req.method === "GET") {
  if (!isAdmin(req, env)) return unauthorized();

  const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);

  const rows = await sql`
    select
      id,
      created_at,
      full_name,
      phone,
      people,
      to_char(reserved_at, 'YYYY-MM-DD HH24:MI') as reserved_at,
      notes,
      status
    from reservations
    order by created_at desc
    limit ${limit}
  `;
  return json({ reservations: rows });
}

    if (url.pathname.startsWith("/api/admin/reservations/") && req.method === "PUT") {
      if (!isAdmin(req, env)) return unauthorized();

      const id = url.pathname.split("/").pop();
      const body = await req.json().catch(() => ({}));
      const status = cleanStr(body.status);

      if (!["new", "confirmed", "cancelled"].includes(status)) {
        return json({ error: "status must be new|confirmed|cancelled" }, 400);
      }

      const rows = await sql`
        update reservations
        set status = ${status}
        where id::text = ${id}
        returning id, status
      `;
      if (!rows.length) return json({ error: "Not found" }, 404);
      return json({ ok: true, reservation: rows[0] });
    }

    /* ==========================
       PUBLIC: health
       ========================== */
    if (url.pathname === "/api/health") {
      const r = await sql`select 1 as ok`;
      return json({ ok: true, db: r[0].ok === 1 });
    }

/* ==========================
   STRIP HOME (pizze / antipasti / dolci)
   ========================== */

// LISTA CATEGORIE STRIP (keys) - PUBLIC
// GET /api/strip
if (url.pathname === "/api/strip" && req.method === "GET") {
  const rows = await sql`
    select slug, data
    from site_pages
    where slug like 'strip_%'
    order by (data->>'order')::int nulls last, slug asc
  `;

  const keys = rows
    .map(r => String(r.slug || "").replace(/^strip_/, ""))
    .filter(Boolean);

  return json({ keys });
}
// PUBLIC
if (url.pathname.startsWith("/api/strip/") && req.method === "GET") {
  const key = url.pathname.split("/").pop(); // pizze
  const slug = "strip_" + key;

  const rows = await sql`
    select data
    from site_pages
    where slug = ${slug}
    limit 1
  `;

  if (!rows.length) return json({ data: null });
  return json({ data: rows[0].data });
}

// ADMIN
if (url.pathname.startsWith("/api/admin/strip/") && req.method === "PUT") {
  if (!isAdmin(req, env)) return unauthorized();

  const key = url.pathname.split("/").pop(); // pizze
  const slug = "strip_" + key;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return json({ error: "Body must be object" }, 400);
  }

  await sql`
    insert into site_pages (slug, data)
    values (${slug}, ${JSON.stringify(body)}::jsonb)
    on conflict (slug)
do update set
  data = coalesce(site_pages.data, '{}'::jsonb) || excluded.data,
  updated_at = now()
  `;

  return json({ ok: true });
}

// ADMIN: ELIMINA CATEGORIA STRIP
// DELETE /api/admin/strip/<key>
if (url.pathname.startsWith("/api/admin/strip/") && req.method === "DELETE") {
  if (!isAdmin(req, env)) return unauthorized();

  const key = url.pathname.split("/").pop();
  const slug = "strip_" + key;

  const rows = await sql`
    delete from site_pages
    where slug = ${slug}
    returning slug
  `;

  if (!rows.length) return json({ error: "Categoria non trovata" }, 404);
  return json({ ok: true, slug });
}


/* ==========================
   STRIP: CREA CATEGORIA (vuota)
   POST /api/admin/strip/create
   body: { key:"piatti_gourmet", title:"Piatti gourmet" }
   crea site_pages slug = "strip_<key>" con { title, items:[] }
   ========================== */
if (url.pathname === "/api/admin/strip/create" && req.method === "POST") {
  if (!isAdmin(req, env)) return unauthorized();

  const body = await req.json().catch(() => ({}));
  const key = cleanStr(body.key).toLowerCase();
  const title = cleanStr(body.title) || "";

  if (!key) return json({ error: "key required" }, 400);
  if (!/^[a-z0-9_-]{2,30}$/.test(key)) {
    return json({ error: "key invalid (usa solo a-z 0-9 _ -)" }, 400);
  }

  const slug = "strip_" + key;

  // se esiste già, non sovrascrivere
  const exists = await sql`
    select slug from site_pages where slug = ${slug} limit 1
  `;
  if (exists.length) {
    return json({ error: "Categoria già esistente" }, 409);
  }

  const data = { title: title || key, items: [] };

  await sql`
    insert into site_pages (slug, data)
    values (${slug}, ${JSON.stringify(data)}::jsonb)
  `;

  return json({ ok: true, slug, data }, 201);
}

    /* ==========================
       PAGES CONTENT (come-funziona, gallery, storia, ecc.)
       GET  /api/page/:slug
       PUT  /api/admin/page/:slug   (admin)
       ========================== */

    // PUBLIC: read page content
    if (url.pathname.startsWith("/api/page/") && req.method === "GET") {
      const slug = url.pathname.split("/").pop();

      const rows = await sql`
        select slug, data, updated_at
        from site_pages
        where slug = ${slug}
        limit 1
      `;

      if (!rows.length) return json({ slug, data: {}, updated_at: null });
      return json(rows[0]);
    }

// ADMIN: upsert page content + AUTO TRANSLATE EN
if (url.pathname.startsWith("/api/admin/page/") && req.method === "PUT") {
  if (!isAdmin(req, env)) return unauthorized();

  const slug = url.pathname.split("/").pop();
  const body = await req.json().catch(() => null);

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Body must be a JSON object" }, 400);
  }

  // ✅ NON tocchiamo queste pagine / campi (per sicurezza)
  const SKIP_TRANSLATE_SLUGS = new Set([
    "gallery",      // solo immagini
    "covers",       // solo url immagini
  ]);

  // Chiavi da NON tradurre (url, telefoni, numeri, ecc.)
  const IGNORE_KEYS = new Set([
    "href", "url", "image", "image_url", "images",
    "phone", "whatsapp",
    "enabled",
    "id",
  ]);

  async function autoAddEnglish(obj) {
    // ricorsione: oggetti/array
    if (Array.isArray(obj)) {
      const outArr = [];
      for (const x of obj) outArr.push(await autoAddEnglish(x));
      return outArr;
    }

    if (!obj || typeof obj !== "object") return obj;

    const out = { ...obj };

    for (const k of Object.keys(obj)) {
      const v = obj[k];

      // se è già inglese o è una chiave da ignorare → skip
      if (k.endsWith("_en")) continue;
      if (IGNORE_KEYS.has(k)) continue;

      // oggetti/array dentro
      if (Array.isArray(v) || (v && typeof v === "object")) {
        out[k] = await autoAddEnglish(v);
        continue;
      }

      // se è stringa → crea *_en se manca
      if (typeof v === "string") {
        const s = v.trim();

        // non tradurre stringhe vuote o che sembrano url
        if (!s) continue;
        if (/^https?:\/\//i.test(s)) continue;
        if (/^\/[a-z0-9/_-]*$/i.test(s)) continue; // es. "/menu/"

        const enKey = k + "_en";
        if (out[enKey] == null || String(out[enKey]).trim() === "") {
          out[enKey] = await translateToEn(env, s);
        }
      }
    }

    return out;
  }

  let finalBody = body;

  // ✅ per queste pagine: traduco automaticamente
  // (NON menu: tu già l’hai fatto e non passa da qui)
  if (!SKIP_TRANSLATE_SLUGS.has(slug)) {
    try {
      finalBody = await autoAddEnglish(body);
    } catch (e) {
      // se AI fallisce, salva comunque l’italiano
      finalBody = body;
    }
  }

  const rows = await sql`
    insert into site_pages (slug, data)
    values (${slug}, ${JSON.stringify(finalBody)}::jsonb)
    on conflict (slug)
    do update set
      data = coalesce(site_pages.data, '{}'::jsonb) || excluded.data,
      updated_at = now()
    returning slug, data, updated_at
  `;

  return json(rows[0]);
}

/* ==========================
   STRIP ITEMS (aggiungi singolo piatto con immagine)
   POST /api/admin/strip/items
   body: { key:"pizze", name:"Margherita", image_url:"https://.../img/xxx.jpg" }
   salva dentro site_pages slug = "strip_<key>" come: { title, items:[] }
   ========================== */

if (url.pathname === "/api/admin/strip/items" && req.method === "POST") {
  if (!isAdmin(req, env)) return unauthorized();

  const body = await req.json().catch(() => ({}));
  const key = cleanStr(body.key).toLowerCase();
  const name = cleanStr(body.name);
  const image_url = cleanStr(body.image_url);

  if (!key) return json({ error: "key required" }, 400);
  if (!name) return json({ error: "name required" }, 400);
  if (!image_url) return json({ error: "image_url required" }, 400);

  const slug = "strip_" + key;

  // leggi dati attuali
  const rows = await sql`
    select data
    from site_pages
    where slug = ${slug}
    limit 1
  `;

  const current = rows.length && rows[0].data && typeof rows[0].data === "object"
    ? rows[0].data
    : {};

  const items = Array.isArray(current.items) ? current.items : [];

  const newItem = {
    id: Date.now(),
    name,
    image_url
  };

  const nextData = {
    ...current,
    items: [...items, newItem]
  };

  await sql`
    insert into site_pages (slug, data)
    values (${slug}, ${JSON.stringify(nextData)}::jsonb)
    on conflict (slug)
    do update set data = excluded.data, updated_at = now()
  `;

  return json({ ok: true, item: newItem });
}


// ==========================
// ADMIN: GALLERY (sostituisce TUTTA la gallery)
// POST /api/admin/gallery
// body: { images: [url1, url2, ...] }
// ==========================
if (url.pathname === "/api/admin/gallery" && req.method === "POST") {
  if (!isAdmin(req, env)) return unauthorized();

  const body = await req.json().catch(() => ({}));

  const images = Array.isArray(body.images)
    ? body.images.map(cleanStr).filter(Boolean)
    : [];

  if (!images.length) {
    return json({ error: "images array required" }, 400);
  }

  const next = { images };

  await sql`
    insert into site_pages (slug, data)
    values ('gallery', ${JSON.stringify(next)}::jsonb)
    on conflict (slug)
    do update set data = excluded.data, updated_at = now()
  `;

  return json({ ok: true, count: images.length });
}

// ==========================
// PUBLIC: GALLERY
// GET /api/gallery
// ==========================
if (url.pathname === "/api/gallery" && req.method === "GET") {
  const rows = await sql`
    select data
    from site_pages
    where slug = 'gallery'
    limit 1
  `;

  const images =
    rows.length && rows[0].data && Array.isArray(rows[0].data.images)
      ? rows[0].data.images
      : [];

  return json({ images });
}

    return json({ error: "Not found" }, 404);
  }
};
        
        