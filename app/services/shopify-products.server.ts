import prisma from "../db.server";

type GraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

type ShopifyProductNode = {
  id: string;
  title: string;
  handle: string;
  vendor: string | null;
  productType: string;
  status: string;
  onlineStoreUrl: string | null;
  createdAt: string;
  updatedAt: string;
  category: { name: string } | null;
  featuredImage: { url: string; altText: string | null } | null;
  media: {
    nodes: Array<{
      preview: {
        image: { url: string; altText: string | null } | null;
      } | null;
    }>;
  };
  variants: {
    nodes: Array<{
      id: string;
      title: string;
      sku: string | null;
      price: string;
    }>;
  };
};

const PRODUCT_FIELDS = `#graphql
  fragment PriceWatchProduct on Product {
    id
    title
    handle
    vendor
    productType
    status
    onlineStoreUrl
    createdAt
    updatedAt
    category { name }
    featuredImage { url altText }
    media(first: 1) {
      nodes {
        preview {
          image { url altText }
        }
      }
    }
    variants(first: 1) {
      nodes { id title sku price }
    }
  }
`;

async function readGraphql<T>(
  response: Response,
): Promise<{ data: T; errors?: Array<{ message: string }> }> {
  if (!response.ok) {
    throw new Error(`Shopify Admin API returned HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    data: T;
    errors?: Array<{ message: string }>;
  };
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }
  return payload;
}

async function persistProduct(
  product: ShopifyProductNode,
  currencyCode: string,
) {
  const firstVariant = product.variants.nodes[0] || null;
  const fallbackImage = product.media.nodes[0]?.preview?.image || null;
  const image = product.featuredImage || fallbackImage;
  const now = new Date();

  return prisma.shopifyProduct.upsert({
    where: { shopifyId: product.id },
    update: {
      title: product.title,
      handle: product.handle,
      vendor: product.vendor || null,
      productType: product.productType || null,
      categoryName: product.category?.name || null,
      featuredImageUrl: image?.url || null,
      featuredImageAlt: image?.altText || null,
      onlineStoreUrl: product.onlineStoreUrl,
      status: product.status,
      firstVariantShopifyId: firstVariant?.id || null,
      firstVariantTitle: firstVariant?.title || null,
      firstVariantSku: firstVariant?.sku || null,
      price: firstVariant?.price || "0",
      currencyCode,
      shopifyCreatedAt: new Date(product.createdAt),
      shopifyUpdatedAt: new Date(product.updatedAt),
      syncedAt: now,
    },
    create: {
      shopifyId: product.id,
      title: product.title,
      handle: product.handle,
      vendor: product.vendor || null,
      productType: product.productType || null,
      categoryName: product.category?.name || null,
      featuredImageUrl: image?.url || null,
      featuredImageAlt: image?.altText || null,
      onlineStoreUrl: product.onlineStoreUrl,
      status: product.status,
      firstVariantShopifyId: firstVariant?.id || null,
      firstVariantTitle: firstVariant?.title || null,
      firstVariantSku: firstVariant?.sku || null,
      price: firstVariant?.price || "0",
      currencyCode,
      shopifyCreatedAt: new Date(product.createdAt),
      shopifyUpdatedAt: new Date(product.updatedAt),
      syncedAt: now,
    },
  });
}

export async function syncAllProducts(admin: GraphqlClient) {
  let cursor: string | null = null;
  let hasNextPage = true;
  let productCount = 0;
  const seenProductIds: string[] = [];
  let currencyCode = "EUR";

  while (hasNextPage) {
    const response = await admin.graphql(
      `${PRODUCT_FIELDS}
       query PriceWatchProducts($after: String) {
         shop { currencyCode }
         products(first: 100, after: $after, sortKey: ID) {
           nodes { ...PriceWatchProduct }
           pageInfo { hasNextPage endCursor }
         }
       }`,
      { variables: { after: cursor } },
    );

    const payload = await readGraphql<{
      shop: { currencyCode: string };
      products: {
        nodes: ShopifyProductNode[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    }>(response);

    currencyCode = payload.data.shop.currencyCode;
    for (const product of payload.data.products.nodes) {
      await persistProduct(product, currencyCode);
      seenProductIds.push(product.id);
      productCount += 1;
    }

    hasNextPage = payload.data.products.pageInfo.hasNextPage;
    cursor = payload.data.products.pageInfo.endCursor;
  }

  await prisma.shopifyProduct.updateMany({
    where: seenProductIds.length
      ? { shopifyId: { notIn: seenProductIds } }
      : undefined,
    data: { status: "DELETED", syncedAt: new Date() },
  });

  return { products: productCount, currencyCode };
}

export async function syncSingleProduct(
  admin: GraphqlClient,
  productId: string,
) {
  const response = await admin.graphql(
    `${PRODUCT_FIELDS}
     query PriceWatchProduct($id: ID!) {
       shop { currencyCode }
       product(id: $id) { ...PriceWatchProduct }
     }`,
    { variables: { id: productId } },
  );

  const payload = await readGraphql<{
    shop: { currencyCode: string };
    product: ShopifyProductNode | null;
  }>(response);

  if (!payload.data.product) {
    await markProductDeleted(productId);
    return null;
  }

  return persistProduct(payload.data.product, payload.data.shop.currencyCode);
}

export async function markProductDeleted(shopifyId: string) {
  await prisma.shopifyProduct.updateMany({
    where: { shopifyId },
    data: { status: "DELETED", syncedAt: new Date() },
  });
}
