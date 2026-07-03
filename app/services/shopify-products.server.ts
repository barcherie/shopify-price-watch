import type { Prisma } from "@prisma/client";
import prisma from "../db.server";

type GraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

type ShopifyVariantNode = {
  id: string;
  title: string;
  sku: string | null;
  barcode: string | null;
  price: string;
  selectedOptions: Array<{ name: string; value: string }>;
};

type ShopifyProductNode = {
  id: string;
  title: string;
  vendor: string | null;
  handle: string;
  productType: string;
  status: string;
  onlineStoreUrl: string | null;
  category: { name: string } | null;
  variants: {
    nodes: ShopifyVariantNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

const PRODUCT_FIELDS = `#graphql
  fragment PriceWatchProduct on Product {
    id
    title
    vendor
    handle
    productType
    status
    onlineStoreUrl
    category { name }
    variants(first: 100) {
      nodes {
        id
        title
        sku
        barcode
        price
        selectedOptions { name value }
      }
      pageInfo { hasNextPage endCursor }
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

async function loadRemainingVariants(
  admin: GraphqlClient,
  product: ShopifyProductNode,
) {
  let cursor = product.variants.pageInfo.endCursor;
  let hasNextPage = product.variants.pageInfo.hasNextPage;

  while (hasNextPage) {
    const response = await admin.graphql(
      `#graphql
        query PriceWatchProductVariants($id: ID!, $after: String) {
          product(id: $id) {
            variants(first: 100, after: $after) {
              nodes {
                id
                title
                sku
                barcode
                price
                selectedOptions { name value }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      `,
      { variables: { id: product.id, after: cursor } },
    );

    const payload = await readGraphql<{
      product: {
        variants: ShopifyProductNode["variants"];
      } | null;
    }>(response);

    if (!payload.data.product) break;

    product.variants.nodes.push(...payload.data.product.variants.nodes);
    hasNextPage = payload.data.product.variants.pageInfo.hasNextPage;
    cursor = payload.data.product.variants.pageInfo.endCursor;
  }
}

async function persistProduct(
  product: ShopifyProductNode,
  currencyCode: string,
) {
  const now = new Date();
  const storedProduct = await prisma.shopifyProduct.upsert({
    where: { shopifyId: product.id },
    update: {
      title: product.title,
      vendor: product.vendor || null,
      handle: product.handle,
      productType: product.productType || null,
      categoryName: product.category?.name || null,
      onlineStoreUrl: product.onlineStoreUrl,
      status: product.status,
      syncedAt: now,
    },
    create: {
      shopifyId: product.id,
      title: product.title,
      vendor: product.vendor || null,
      handle: product.handle,
      productType: product.productType || null,
      categoryName: product.category?.name || null,
      onlineStoreUrl: product.onlineStoreUrl,
      status: product.status,
      syncedAt: now,
    },
  });

  const seenVariantIds: string[] = [];
  for (const variant of product.variants.nodes) {
    seenVariantIds.push(variant.id);
    const selectedOptions = variant.selectedOptions as Prisma.InputJsonValue;

    await prisma.shopifyVariant.upsert({
      where: { shopifyId: variant.id },
      update: {
        productId: storedProduct.id,
        title: variant.title,
        sku: variant.sku || null,
        barcode: variant.barcode || null,
        price: variant.price,
        currencyCode,
        selectedOptions,
        active: true,
        syncedAt: now,
      },
      create: {
        shopifyId: variant.id,
        productId: storedProduct.id,
        title: variant.title,
        sku: variant.sku || null,
        barcode: variant.barcode || null,
        price: variant.price,
        currencyCode,
        selectedOptions,
        syncedAt: now,
      },
    });
  }

  await prisma.shopifyVariant.updateMany({
    where: {
      productId: storedProduct.id,
      ...(seenVariantIds.length
        ? { shopifyId: { notIn: seenVariantIds } }
        : {}),
    },
    data: { active: false, syncedAt: now },
  });

  if (seenVariantIds.length) {
    await prisma.shopifyVariant.updateMany({
      where: { shopifyId: { in: seenVariantIds } },
      data: { active: true },
    });
  }

  return { product: storedProduct, variants: seenVariantIds.length };
}

export async function syncAllProducts(admin: GraphqlClient) {
  let cursor: string | null = null;
  let hasNextPage = true;
  let productCount = 0;
  let variantCount = 0;
  const seenProductIds: string[] = [];
  const seenVariantIds: string[] = [];
  let currencyCode = "EUR";

  while (hasNextPage) {
    const response = await admin.graphql(
      `${PRODUCT_FIELDS}
       query PriceWatchProducts($after: String) {
         shop { currencyCode }
         products(first: 50, after: $after, sortKey: ID) {
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
      await loadRemainingVariants(admin, product);
      const result = await persistProduct(product, currencyCode);
      seenProductIds.push(product.id);
      seenVariantIds.push(
        ...product.variants.nodes.map((variant) => variant.id),
      );
      productCount += 1;
      variantCount += result.variants;
    }

    hasNextPage = payload.data.products.pageInfo.hasNextPage;
    cursor = payload.data.products.pageInfo.endCursor;
  }

  const now = new Date();
  await prisma.shopifyProduct.updateMany({
    where: seenProductIds.length
      ? { shopifyId: { notIn: seenProductIds } }
      : undefined,
    data: { status: "DELETED", syncedAt: now },
  });
  await prisma.shopifyVariant.updateMany({
    where: seenVariantIds.length
      ? { shopifyId: { notIn: seenVariantIds } }
      : undefined,
    data: { active: false, syncedAt: now },
  });

  return { products: productCount, variants: variantCount, currencyCode };
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

  await loadRemainingVariants(admin, payload.data.product);
  return persistProduct(payload.data.product, payload.data.shop.currencyCode);
}

export async function markProductDeleted(shopifyId: string) {
  const product = await prisma.shopifyProduct.findUnique({
    where: { shopifyId },
    select: { id: true },
  });
  if (!product) return;

  await prisma.$transaction([
    prisma.shopifyProduct.update({
      where: { id: product.id },
      data: { status: "DELETED", syncedAt: new Date() },
    }),
    prisma.shopifyVariant.updateMany({
      where: { productId: product.id },
      data: { active: false, syncedAt: new Date() },
    }),
  ]);
}
