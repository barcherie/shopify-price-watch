import type { ActionFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import { syncSingleProduct } from "../services/shopify-products.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop } = await authenticate.webhook(request);
  const productPayload = payload as {
    id?: number | string;
    admin_graphql_api_id?: string;
  };
  const productId =
    productPayload.admin_graphql_api_id ||
    (productPayload.id
      ? `gid://shopify/Product/${productPayload.id}`
      : undefined);

  if (!productId) return new Response(null, { status: 204 });

  try {
    const { admin } = await unauthenticated.admin(shop);
    await syncSingleProduct(admin, productId);
  } catch (error) {
    console.error("Product webhook sync failed", error);
    return new Response("Temporary sync error", { status: 500 });
  }

  return new Response(null, { status: 204 });
};
