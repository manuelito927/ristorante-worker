import { neon } from "@neondatabase/serverless";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type"
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...cors }
  });

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

    if (url.pathname === "/api/health") {
      const r = await sql`select 1 as ok`;
      return json({ ok: true, db: r[0].ok === 1 });
    }

    if (url.pathname === "/api/menu") {
      const rows = await sql`
        select id, name, description, price_cents, category
        from menu_items
        where is_available = true
        order by category, position
      `;
      return json({ items: rows });
    }

    return json({ error: "Not found" }, 404);
  }
};