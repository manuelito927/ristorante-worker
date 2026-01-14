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

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (!env.DATABASE_URL) {
      return json({ error: "DATABASE_URL missing" }, 500);
    }

    const url = new URL(req.url);
    const sql = neon(env.DATABASE_URL);

    /* ==========================
       ADMIN: MENU CRUD
       ========================== */

    // ADMIN: create item
    if (url.pathname === "/api/admin/menu" && req.method === "POST") {
      if (!isAdmin(req, env)) return unauthorized();

      const body = await req.json();

      const {
        // IT
        name,
        description = "",
        category = "",

        // EN
        name_en = "",
        description_en = "",
        category_en = "",

        // comuni
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

    // ADMIN: update item
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

    // ADMIN: delete item
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
       GET /api/menu?lang=it|en
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
       POST /api/reservations
       Body: { name, phone, people, date, time, notes }
       DB columns: full_name, phone, people, reserved_at, notes, status, created_at
       ========================== */
    if (url.pathname === "/api/reservations" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));

      const full_name = cleanStr(body.name); // dal form arriva "name"
      const phone = cleanStr(body.phone);
      const people = Number(body.people || 2);

      const date = cleanStr(body.date); // es: 2026-01-14
      const time = cleanStr(body.time); // es: 20:30
      const notes = cleanStr(body.notes) || null;

      if (!full_name || !phone || !date || !time) {
        return json({ error: "name, phone, date, time required" }, 400);
      }
      if (!Number.isFinite(people) || people < 1 || people > 30) {
        return json({ error: "people invalid" }, 400);
      }

      // Combino data+ora → reserved_at
      // NB: senza timezone esplicito Postgres usa la timezone della sessione (spesso UTC su Neon).
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
       GET  /api/admin/reservations?limit=50
       PUT  /api/admin/reservations/:id  { status }
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
       PAGES CONTENT (come-funziona, storia, ecc.)
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