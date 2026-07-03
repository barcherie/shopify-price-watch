import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { markProductDeleted } from "../services/shopify-products.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload } = await authenticate.webhook(request);
  const productPayload = payload as { id?: number | string };
  if (productPayload.id) {
    await markProductDeleted(`gid://shopify/Product/${productPayload.id}`);
  }
  return new Response(null, { status: 204 });
};
