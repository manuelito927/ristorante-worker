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

    // ADMIN: create item (IT + EN)
    if (url.pathname === "/api/admin/menu" && req.method === "POST") {
      if (!isAdmin(req, env)) return unauthorized();

      const body = await req.json();
      const {
        name,
        description = "",
        name_en = null,
        description_en = null,

        price_cents,

        category = "",
        category_en = null,

        position = 0,
        is_available = true,
        image_url = null
      } = body;

      if (!name || typeof price_cents !== "number") {
        return json({ error: "name and price_cents required" }, 400);
      }

      const rows = await sql`
        insert into menu_items (
          name, description, name_en, description_en,
          price_cents,
          category, category_en,
          position, is_available, image_url
        )
        values (
          ${name}, ${description}, ${name_en}, ${description_en},
          ${price_cents},
          ${category}, ${category_en},
          ${position}, ${is_available}, ${image_url}
        )
        returning *
      `;
      return json({ item: rows[0] }, 201);
    }

    // ADMIN: update item (IT + EN)
    if (url.pathname.startsWith("/api/admin/menu/") && req.method === "PUT") {
      if (!isAdmin(req, env)) return unauthorized();

      const id = url.pathname.split("/").pop();
      const body = await req.json();

      const rows = await sql`
        update menu_items
        set
          name = coalesce(${body.name ?? null}, name),
          description = coalesce(${body.description ?? null}, description),
          name_en = coalesce(${body.name_en ?? null}, name_en),
          description_en = coalesce(${body.description_en ?? null}, description_en),

          price_cents = coalesce(${body.price_cents ?? null}, price_cents),

          category = coalesce(${body.category ?? null}, category),
          category_en = coalesce(${body.category_en ?? null}, category_en),

          position = coalesce(${body.position ?? null}, position),
          is_available = coalesce(${body.is_available ?? null}, is_available),
          image_url = coalesce(${body.image_url ?? null}, image_url)
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

    // PUBLIC: health
    if (url.pathname === "/api/health") {
      const r = await sql`select 1 as ok`;
      return json({ ok: true, db: r[0].ok === 1 });
    }

    // PUBLIC: menu (IT + EN fields)
    if (url.pathname === "/api/menu") {
      const rows = await sql`
        select
          id,
          name, description, category,
          name_en, description_en, category_en,
          price_cents, position, is_available, image_url
        from menu_items
        where is_available = true
        order by category, position
      `;
      return json({ items: rows });
    }

    return json({ error: "Not found" }, 404);
  }
};