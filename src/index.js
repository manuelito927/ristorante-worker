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
      const body = await req.json();

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
        image_url = null
      } = body;

      if (!name || typeof price_cents !== "number") {
        return json({ error: "name and price_cents required" }, 400);
      }

      const rows = await sql`
        insert into menu_items
          (name, description, price_cents, category, position, is_available, image_url,
           name_en, description_en, category_en)
        values
          (${name}, ${description}, ${price_cents}, ${category}, ${position}, ${is_available}, ${image_url},
           ${name_en}, ${description_en}, ${category_en})
        returning *
      `;
      return json({ item: rows[0] }, 201);
    }

    if (url.pathname.startsWith("/api/admin/menu/") && req.method === "PUT") {
      if (!isAdmin(req, env)) return unauthorized();

      const id = url.pathname.split("/").pop();
      const body = await req.json();

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
       PUBLIC: MENU con lingua
       ========================== */
    if (url.pathname === "/api/menu" && req.method === "GET") {
      const lang = (url.searchParams.get("lang") || "it").toLowerCase();

      const rows = await sql`
        select
          id,
          case when ${lang}='en' and coalesce(nullif(name_en,''), '') <> '' then name_en else name end as name,
          case when ${lang}='en' and coalesce(nullif(description_en,''), '') <> '' then description_en else description end as description,
          price_cents,
          case when ${lang}='en' and coalesce(nullif(category_en,''), '') <> '' then category_en else category end as category,
          position,
          is_available,
          image_url
        from menu_items
        where is_available = true
        order by
          (case when ${lang}='en' and coalesce(nullif(category_en,''), '') <> '' then category_en else category end),
          position
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