import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import type { ProductMatchStatus } from "@prisma/client";
import { useAppBridge } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { runPriceWatch } from "../services/scrape-runner.server";
import { validateTargetUrl } from "../services/url-safety.server";

const MATCH_STATUS_LABELS = {
  PENDING: "À vérifier",
  VALIDATED: "Validée",
  REJECTED: "Rejetée",
} as const;

const MATCH_STATUS_TONES = {
  PENDING: "warning",
  VALIDATED: "success",
  REJECTED: "critical",
} as const;

const LEGAL_STATUS_LABELS = {
  PENDING: "Juridique à vérifier",
  APPROVED: "Collecte autorisée",
  BLOCKED: "Collecte bloquée",
} as const;

const LEGAL_STATUS_TONES = {
  PENDING: "warning",
  APPROVED: "success",
  BLOCKED: "critical",
} as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const selectedProductId =
    url.searchParams.get("product") || url.searchParams.get("variant") || "";
  const query = url.searchParams.get("q")?.trim() || "";
  const status = url.searchParams.get("status") || "";

  const [initialProduct, competitors, matches] = await Promise.all([
    selectedProductId
      ? prisma.shopifyProduct.findUnique({
          where: { id: selectedProductId },
        })
      : null,
    prisma.competitor.findMany({ orderBy: { name: "asc" } }),
    prisma.productMatch.findMany({
      where: {
        ...(status ? { status: status as ProductMatchStatus } : undefined),
        ...(query
          ? {
              OR: [
                {
                  product: {
                    title: { contains: query, mode: "insensitive" },
                  },
                },
                {
                  product: {
                    vendor: { contains: query, mode: "insensitive" },
                  },
                },
                {
                  competitor: {
                    name: { contains: query, mode: "insensitive" },
                  },
                },
              ],
            }
          : undefined),
      },
      include: {
        competitor: true,
        product: true,
        observations: { orderBy: { observedAt: "desc" }, take: 1 },
      },
      orderBy: { updatedAt: "desc" },
      take: 250,
    }),
  ]);

  return {
    filters: { query, status },
    initialProduct: initialProduct
      ? {
          shopifyId: initialProduct.shopifyId,
          title: initialProduct.title,
          vendor: initialProduct.vendor,
          imageUrl: initialProduct.featuredImageUrl,
          imageAlt: initialProduct.featuredImageAlt,
          price: initialProduct.price.toString(),
          currencyCode: initialProduct.currencyCode,
        }
      : null,
    competitors,
    matches: matches.map((match) => ({
      id: match.id,
      productId: match.product.id,
      productShopifyId: match.product.shopifyId,
      product: match.product.title,
      vendor: match.product.vendor,
      imageUrl: match.product.featuredImageUrl,
      imageAlt: match.product.featuredImageAlt,
      shopifyPrice: match.product.price.toString(),
      currencyCode: match.product.currencyCode,
      competitorId: match.competitor.id,
      competitor: match.competitor.name,
      url: match.url,
      status: match.status,
      legalStatus: match.competitor.legalStatus,
      active: match.competitor.active,
      latest: match.observations[0]
        ? {
            price: match.observations[0].price?.toString() || null,
            currencyCode: match.observations[0].currencyCode,
            error: match.observations[0].errorMessage,
            observedAt: match.observations[0].observedAt.toISOString(),
          }
        : null,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  try {
    if (intent === "create" || intent === "addCompetitor") {
      const productShopifyId = String(formData.get("productShopifyId") || "");
      const productId = String(formData.get("productId") || "");
      const competitorId = String(formData.get("competitorId") || "");
      const [product, competitor] = await Promise.all([
        intent === "create"
          ? prisma.shopifyProduct.findUnique({
              where: { shopifyId: productShopifyId },
            })
          : prisma.shopifyProduct.findUnique({ where: { id: productId } }),
        prisma.competitor.findUnique({ where: { id: competitorId } }),
      ]);

      if (!product || product.status === "DELETED") {
        return {
          ok: false,
          message:
            "Produit introuvable dans Price Watch. Synchronisez Shopify puis réessayez.",
        };
      }
      if (!competitor) {
        return { ok: false, message: "Concurrent introuvable." };
      }
      const existing = await prisma.productMatch.findFirst({
        where: { productId: product.id, competitorId },
      });
      if (existing) {
        return {
          ok: false,
          message:
            "Ce concurrent est déjà renseigné pour ce produit. Modifiez sa ligne existante.",
        };
      }

      const url = validateTargetUrl(
        String(formData.get("url") || ""),
        competitor.domain,
      ).toString();
      await prisma.productMatch.create({
        data: {
          productId: product.id,
          competitorId,
          url,
        },
      });
      return {
        ok: true,
        message:
          intent === "create"
            ? "Correspondance produit créée."
            : "Concurrent ajouté à la correspondance.",
      };
    }

    const id = String(formData.get("id") || "");
    if (!id) return { ok: false, message: "Correspondance introuvable." };

    if (intent === "delete") {
      await prisma.productMatch.delete({ where: { id } });
      return { ok: true, message: "Correspondance supprimée." };
    }

    if (intent === "status") {
      const statuses: ProductMatchStatus[] = [
        "PENDING",
        "VALIDATED",
        "REJECTED",
      ];
      const nextStatus = String(formData.get("status")) as ProductMatchStatus;
      if (!statuses.includes(nextStatus)) {
        return { ok: false, message: "Statut invalide." };
      }
      await prisma.productMatch.update({
        where: { id },
        data: { status: nextStatus },
      });
      return { ok: true, message: "Statut mis à jour." };
    }

    if (intent === "update") {
      const statuses: ProductMatchStatus[] = [
        "PENDING",
        "VALIDATED",
        "REJECTED",
      ];
      const status = String(formData.get("status")) as ProductMatchStatus;
      const competitorId = String(formData.get("competitorId") || "");
      if (!statuses.includes(status)) {
        return { ok: false, message: "Statut invalide." };
      }

      const [match, competitor] = await Promise.all([
        prisma.productMatch.findUnique({ where: { id } }),
        prisma.competitor.findUnique({ where: { id: competitorId } }),
      ]);
      if (!match || !competitor) {
        return {
          ok: false,
          message: "Correspondance ou concurrent introuvable.",
        };
      }
      const duplicate = await prisma.productMatch.findFirst({
        where: {
          productId: match.productId,
          competitorId,
          id: { not: id },
        },
      });
      if (duplicate) {
        return {
          ok: false,
          message: "Ce concurrent est déjà renseigné pour ce produit.",
        };
      }
      const url = validateTargetUrl(
        String(formData.get("url") || ""),
        competitor.domain,
      ).toString();
      const targetChanged =
        match.competitorId !== competitorId || match.url !== url;
      await prisma.productMatch.update({
        where: { id },
        data: {
          competitorId,
          url,
          status,
          ...(targetChanged ? { lastScrapedAt: null } : {}),
        },
      });
      return { ok: true, message: "Ligne concurrente modifiée." };
    }

    if (intent === "scrape") {
      const run = await runPriceWatch({
        trigger: "MANUAL",
        matchId: id,
        testPendingMatch: true,
      });
      return {
        ok: run.succeeded === 1 || run.skipped === 1,
        message:
          run.succeeded === 1
            ? "Prix relevé."
            : run.skipped === 1
              ? "Ce produit a déjà été vérifié au cours des dernières 24 heures."
              : "Le relevé a échoué. Consultez le dernier message.",
      };
    }

    return { ok: false, message: "Action inconnue." };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Erreur inattendue.",
    };
  }
};

type PickedProduct = {
  shopifyId: string;
  title: string;
  vendor: string | null;
  imageUrl: string | null;
  imageAlt: string | null;
  price: string;
  currencyCode: string;
};

export default function MatchesPage() {
  const { competitors, matches, initialProduct, filters } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const [pickedProduct, setPickedProduct] = useState<PickedProduct | null>(
    initialProduct,
  );

  useEffect(() => {
    if (actionData?.message) {
      shopify.toast.show(actionData.message, { isError: !actionData.ok });
    }
  }, [actionData, shopify]);

  const approvedCompetitors = useMemo(
    () =>
      competitors.filter(
        (competitor) =>
          competitor.active && competitor.legalStatus === "APPROVED",
      ).length,
    [competitors],
  );
  const productGroups = useMemo(
    () =>
      matches.reduce<
        Array<{
          productId: string;
          product: string;
          vendor: string | null;
          imageUrl: string | null;
          imageAlt: string | null;
          shopifyPrice: string;
          currencyCode: string;
          matches: typeof matches;
        }>
      >((groups, match) => {
        let group = groups.find((item) => item.productId === match.productId);
        if (!group) {
          group = {
            productId: match.productId,
            product: match.product,
            vendor: match.vendor,
            imageUrl: match.imageUrl,
            imageAlt: match.imageAlt,
            shopifyPrice: match.shopifyPrice,
            currencyCode: match.currencyCode,
            matches: [],
          };
          groups.push(group);
        }
        group.matches.push(match);
        return groups;
      }, []),
    [matches],
  );

  async function openProductPicker() {
    const selection = await shopify.resourcePicker({
      type: "product",
      action: "select",
      multiple: false,
      filter: { variants: false },
    });
    const product = selection?.[0];
    if (!product) return;

    setPickedProduct({
      shopifyId: product.id,
      title: product.title,
      vendor: product.vendor || null,
      imageUrl: product.images?.[0]?.originalSrc || null,
      imageAlt: product.images?.[0]?.altText || null,
      price: product.variants?.[0]?.price || "—",
      currencyCode: "EUR",
    });
  }

  return (
    <s-page heading="Correspondances produits">
      <s-section heading="Nouvelle correspondance">
        <Form method="post">
          <input type="hidden" name="intent" value="create" />
          <input
            type="hidden"
            name="productShopifyId"
            value={pickedProduct?.shopifyId || ""}
          />
          <s-stack gap="base">
            <s-box
              border="base"
              borderRadius="base"
              padding="base"
              background="subdued"
            >
              <s-stack
                direction="inline"
                gap="base"
                alignItems="center"
                justifyContent="space-between"
              >
                <s-stack direction="inline" gap="base" alignItems="center">
                  {pickedProduct?.imageUrl && (
                    <s-thumbnail
                      src={pickedProduct.imageUrl}
                      alt={pickedProduct.imageAlt || pickedProduct.title}
                      size="small"
                    />
                  )}
                  <s-stack gap="small-200">
                    <s-text type="strong">
                      {pickedProduct
                        ? pickedProduct.title
                        : "Aucun produit sélectionné"}
                    </s-text>
                    <s-text color="subdued">
                      {pickedProduct
                        ? `${pickedProduct.vendor || "Sans marque"} · ${
                            pickedProduct.price
                          } ${pickedProduct.currencyCode}`
                        : "Utilisez le Product Picker Shopify."}
                    </s-text>
                  </s-stack>
                </s-stack>
                <s-button
                  type="button"
                  icon="product"
                  variant={pickedProduct ? "secondary" : "primary"}
                  onClick={openProductPicker}
                >
                  {pickedProduct ? "Changer" : "Choisir dans Shopify"}
                </s-button>
              </s-stack>
            </s-box>

            <s-grid
              gap="base"
              gridTemplateColumns="@container (inline-size > 700px) 1fr 1fr"
            >
              <s-select
                label="Concurrent"
                name="competitorId"
                required
                details={`${approvedCompetitors} concurrent(s) autorisé(s) pour la collecte`}
              >
                {competitors.map((competitor) => (
                  <s-option key={competitor.id} value={competitor.id}>
                    {competitor.name} ·{" "}
                    {LEGAL_STATUS_LABELS[competitor.legalStatus]}
                  </s-option>
                ))}
              </s-select>
              <s-url-field
                label="URL concurrente exacte"
                name="url"
                required
                placeholder="https://concurrent.fr/produit"
              />
            </s-grid>
            <s-stack direction="inline" justifyContent="end">
              <s-button
                type="submit"
                variant="primary"
                disabled={!pickedProduct}
              >
                Ajouter à vérifier
              </s-button>
            </s-stack>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Correspondances enregistrées">
        <Form method="get">
          <s-grid
            gap="small-200"
            gridTemplateColumns="@container (inline-size > 600px) 1fr 220px auto"
          >
            <s-text-field
              label="Rechercher"
              labelAccessibilityVisibility="exclusive"
              name="q"
              value={filters.query}
              icon="search"
              placeholder="Produit, marque ou concurrent"
            />
            <s-select
              label="Statut"
              labelAccessibilityVisibility="exclusive"
              name="status"
              value={filters.status}
            >
              <s-option value="">Tous les statuts</s-option>
              <s-option value="PENDING">À vérifier</s-option>
              <s-option value="VALIDATED">Validées</s-option>
              <s-option value="REJECTED">Rejetées</s-option>
            </s-select>
            <s-button type="submit" variant="secondary" icon="search">
              Filtrer
            </s-button>
          </s-grid>
        </Form>
      </s-section>

      {productGroups.map((group) => {
        const addModalId = `add-competitor-${group.productId}`;
        return (
          <s-section key={group.productId} padding="none">
            <s-box padding="base">
              <s-stack
                direction="inline"
                gap="base"
                alignItems="center"
                justifyContent="space-between"
              >
                <s-stack direction="inline" gap="base" alignItems="center">
                  {group.imageUrl ? (
                    <s-thumbnail
                      src={group.imageUrl}
                      alt={group.imageAlt || group.product}
                      size="small"
                    />
                  ) : (
                    <s-avatar initials={group.product.slice(0, 2)} />
                  )}
                  <s-stack gap="small-200">
                    <s-text type="strong">{group.product}</s-text>
                    <s-text color="subdued">
                      {group.vendor || "Sans marque"} · {group.shopifyPrice}{" "}
                      {group.currencyCode} · {group.matches.length} concurrent(s)
                    </s-text>
                  </s-stack>
                </s-stack>
                <s-button
                  variant="primary"
                  icon="plus"
                  commandFor={addModalId}
                  command="--show"
                >
                  Ajouter un concurrent
                </s-button>
              </s-stack>
            </s-box>

            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Concurrent</s-table-header>
                <s-table-header>URL</s-table-header>
                <s-table-header>Dernier relevé</s-table-header>
                <s-table-header listSlot="secondary">Statut</s-table-header>
                <s-table-header>Actions</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {group.matches.map((match) => {
                  const editModalId = `edit-match-${match.id}`;
                  return (
                    <s-table-row key={match.id}>
                      <s-table-cell>
                        <s-stack gap="small-200">
                          <s-text type="strong">{match.competitor}</s-text>
                          <s-badge
                            tone={LEGAL_STATUS_TONES[match.legalStatus]}
                          >
                            {LEGAL_STATUS_LABELS[match.legalStatus]}
                          </s-badge>
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>
                        <s-link href={match.url} target="_blank">
                          Ouvrir la page produit
                        </s-link>
                      </s-table-cell>
                      <s-table-cell>
                        <s-stack gap="small-200">
                          <s-text>
                            {match.latest?.price
                              ? `${match.latest.price} ${
                                  match.latest.currencyCode || ""
                                }`
                              : match.latest?.error || "Aucun relevé"}
                          </s-text>
                          {match.latest && (
                            <s-text color="subdued">
                              {new Date(
                                match.latest.observedAt,
                              ).toLocaleString("fr-FR")}
                            </s-text>
                          )}
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>
                        <s-badge tone={MATCH_STATUS_TONES[match.status]}>
                          {MATCH_STATUS_LABELS[match.status]}
                        </s-badge>
                      </s-table-cell>
                      <s-table-cell>
                        <s-stack direction="inline" gap="small-200">
                          <s-button
                            variant="tertiary"
                            icon="edit"
                            commandFor={editModalId}
                            command="--show"
                          >
                            Modifier
                          </s-button>
                          {match.status !== "VALIDATED" && (
                            <MatchAction
                              id={match.id}
                              intent="status"
                              status="VALIDATED"
                              label="Valider"
                            />
                          )}
                          {match.status !== "REJECTED" && (
                            <MatchAction
                              id={match.id}
                              intent="scrape"
                              label="Tester"
                              icon="refresh"
                              disabled={
                                match.legalStatus !== "APPROVED" || !match.active
                              }
                            />
                          )}
                          <MatchAction
                            id={match.id}
                            intent="delete"
                            label="Supprimer"
                            tone="critical"
                            icon="delete"
                          />
                        </s-stack>
                        <EditMatchModal
                          modalId={editModalId}
                          match={match}
                          competitors={competitors}
                        />
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
            <AddCompetitorModal
              modalId={addModalId}
              productId={group.productId}
              productName={group.product}
              competitors={competitors}
              usedCompetitorIds={group.matches.map(
                (match) => match.competitorId,
              )}
            />
          </s-section>
        );
      })}

      {!productGroups.length && (
        <s-section>
          <s-stack gap="base" alignItems="center">
            <s-icon type="product" tone="neutral" />
            <s-text type="strong">Aucune correspondance</s-text>
            <s-text color="subdued">
              Ajoutez un produit et sa première URL concurrente.
            </s-text>
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

type MatchRow = ReturnType<
  typeof useLoaderData<typeof loader>
>["matches"][number];
type CompetitorRow = ReturnType<
  typeof useLoaderData<typeof loader>
>["competitors"][number];

function AddCompetitorModal({
  modalId,
  productId,
  productName,
  competitors,
  usedCompetitorIds,
}: {
  modalId: string;
  productId: string;
  productName: string;
  competitors: CompetitorRow[];
  usedCompetitorIds: string[];
}) {
  const availableCompetitors = competitors.filter(
    (competitor) => !usedCompetitorIds.includes(competitor.id),
  );

  return (
    <s-modal
      id={modalId}
      heading={`Ajouter un concurrent à ${productName}`}
      size="large"
    >
      {availableCompetitors.length ? (
        <Form method="post">
          <input type="hidden" name="intent" value="addCompetitor" />
          <input type="hidden" name="productId" value={productId} />
          <s-stack gap="base">
            <s-select label="Concurrent" name="competitorId" required>
              {availableCompetitors.map((competitor) => (
                <s-option key={competitor.id} value={competitor.id}>
                  {competitor.name}
                  {!competitor.active ? " · Inactif" : ""}
                </s-option>
              ))}
            </s-select>
            <s-url-field
              label="URL exacte de la page produit"
              name="url"
              required
              placeholder="https://concurrent.fr/produit"
            />
            <s-stack direction="inline" justifyContent="end" gap="small">
              <s-button type="button" commandFor={modalId} command="--hide">
                Annuler
              </s-button>
              <s-button type="submit" variant="primary">
                Ajouter
              </s-button>
            </s-stack>
          </s-stack>
        </Form>
      ) : (
        <s-stack gap="base">
          <s-text color="subdued">
            Tous les concurrents disponibles sont déjà renseignés pour ce
            produit.
          </s-text>
          <s-stack direction="inline" justifyContent="end">
            <s-button type="button" commandFor={modalId} command="--hide">
              Fermer
            </s-button>
          </s-stack>
        </s-stack>
      )}
    </s-modal>
  );
}

function EditMatchModal({
  modalId,
  match,
  competitors,
}: {
  modalId: string;
  match: MatchRow;
  competitors: CompetitorRow[];
}) {
  return (
    <s-modal
      id={modalId}
      heading={`Modifier ${match.competitor}`}
      size="large"
    >
      <Form method="post">
        <input type="hidden" name="intent" value="update" />
        <input type="hidden" name="id" value={match.id} />
        <s-stack gap="base">
          <s-select
            label="Concurrent"
            name="competitorId"
            value={match.competitorId}
            required
          >
            {competitors.map((competitor) => (
              <s-option key={competitor.id} value={competitor.id}>
                {competitor.name}
                {!competitor.active ? " · Inactif" : ""}
              </s-option>
            ))}
          </s-select>
          <s-url-field
            label="URL exacte de la page produit"
            name="url"
            value={match.url}
            required
          />
          <s-select
            label="Statut"
            name="status"
            value={match.status}
            required
          >
            <s-option value="PENDING">À vérifier</s-option>
            <s-option value="VALIDATED">Validée</s-option>
            <s-option value="REJECTED">Rejetée</s-option>
          </s-select>
          <s-stack direction="inline" justifyContent="end" gap="small">
            <s-button type="button" commandFor={modalId} command="--hide">
              Annuler
            </s-button>
            <s-button type="submit" variant="primary">
              Enregistrer
            </s-button>
          </s-stack>
        </s-stack>
      </Form>
    </s-modal>
  );
}

function MatchAction({
  id,
  intent,
  status,
  label,
  tone,
  icon,
  disabled = false,
}: {
  id: string;
  intent: "status" | "scrape" | "delete";
  status?: ProductMatchStatus;
  label: string;
  tone?: "critical";
  icon?: "refresh" | "delete";
  disabled?: boolean;
}) {
  return (
    <Form method="post">
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="id" value={id} />
      {status && <input type="hidden" name="status" value={status} />}
      <s-button
        type="submit"
        variant="tertiary"
        {...(tone ? { tone } : {})}
        {...(icon ? { icon } : {})}
        disabled={disabled}
      >
        {label}
      </s-button>
    </Form>
  );
}
