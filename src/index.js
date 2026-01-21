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
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  return !!env.ADMIN_TOKEN && token === env.ADMIN_TOKEN;
};

const cleanStr = (v) => String(v ?? "").trim();

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
  price_cents,
  position = 0,
  is_available = true,
  image_url = null,
  allergens = []
} = body;

const allergens_clean = normalizeAllergens(allergens);

  if (!name || typeof price_cents !== "number") {
    return json({ error: "name and price_cents required" }, 400);
  }

  const rows = await sql`
    insert into menu_items
      (name, description, price_cents, category, position, is_available, image_url,
       name_en, description_en, category_en, allergens)
    values
  (${name}, ${description}, ${price_cents}, ${category}, ${position}, ${is_available}, ${image_url},
   ${name_en}, ${description_en}, ${category_en}, ${allergens_clean})
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


      const rows = await sql`
        update menu_items
        set
          name = coalesce(${body.name ?? null}, name),
          description = coalesce(${body.description ?? null}, description),
          price_cents = coalesce(${body.price_cents ?? null}, price_cents),
          category = coalesce(${body.category ?? null}, category),
          position = coalesce(${body.position ?? null}, position),
          is_available = coalesce(${body.is_available ?? null}, is_available),
          image_url = coalesce(${body.image_url ?? null}, image_url),
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
  const rows = await sql`
    select
      id,
      name,
      description,
      price_cents,
      category,
      position,
      is_available,
      image_url,
      name_en,
      description_en,
      category_en,
      allergens
    from menu_items
    where is_available = true
    order by category, position
  `;
  return json({ items: rows });
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
        values (${full_name}, ${phone}, ${people}, ${reserved_at}::timestamptz, ${notes}, 'new')
                returning id, created_at, status
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
          reserved_at,
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

    // ADMIN: upsert page content
    if (url.pathname.startsWith("/api/admin/page/") && req.method === "PUT") {
      if (!isAdmin(req, env)) return unauthorized();

      const slug = url.pathname.split("/").pop();
      const body = await req.json().catch(() => null);

      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json({ error: "Body must be a JSON object" }, 400);
      }

      const rows = await sql`
        insert into site_pages (slug, data)
        values (${slug}, ${JSON.stringify(body)}::jsonb)
        on conflict (slug)
        do update set data = excluded.data, updated_at = now()
        returning slug, data, updated_at
      `;

      return json(rows[0]);
    }

    return json({ error: "Not found" }, 404);
  }
};
        
        