import { timingSafeEqual } from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { syncAllProducts } from "../services/shopify-products.server";
import { unauthenticated } from "../shopify.server";

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization");
  if (!secret || !authorization?.startsWith("Bearer ")) return false;

  const received = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(secret);
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

export const loader = async () =>
  new Response("Method Not Allowed", { status: 405 });

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!authorized(request)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const offlineSession = await prisma.session.findFirst({
    where: { isOnline: false },
    select: { shop: true },
  });

  if (!offlineSession) {
    return Response.json(
      {
        ok: false,
        error: "No offline Shopify session found. Reinstall the app first.",
      },
      { status: 409 },
    );
  }

  const { admin } = await unauthenticated.admin(offlineSession.shop);
  const result = await syncAllProducts(admin);

  return Response.json({
    ok: true,
    shop: offlineSession.shop,
    ...result,
  });
};
