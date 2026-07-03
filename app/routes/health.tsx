export const loader = () =>
  Response.json(
    { ok: true, service: "price-watch", timestamp: new Date().toISOString() },
    { headers: { "cache-control": "no-store" } },
  );
