import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useRevalidator,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  cancelDiscoveryRun,
  createDiscoveryRunFromProducts,
  DiscoveryAlreadyRunningError,
  processDiscoveryQueue,
  updateDiscoveryJobSearchQuery,
} from "../services/discovery-queue.server";

const RUN_LABELS = {
  RUNNING: "En cours",
  SUCCESS: "Succès",
  PARTIAL: "Partiel",
  FAILED: "Échec",
  CANCELLED: "Annulée",
} as const;

const RUN_TONES = {
  RUNNING: "info",
  SUCCESS: "success",
  PARTIAL: "warning",
  FAILED: "critical",
  CANCELLED: "info",
} as const;

const JOB_LABELS = {
  PENDING: "En attente",
  RUNNING: "En cours",
  SUCCESS: "Succès",
  PARTIAL: "Partiel",
  FAILED: "Échec",
  CANCELLED: "Annulé",
} as const;

const JOB_TONES = {
  PENDING: "neutral",
  RUNNING: "info",
  SUCCESS: "success",
  PARTIAL: "warning",
  FAILED: "critical",
  CANCELLED: "neutral",
} as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const selectedRunId = url.searchParams.get("run") || "";
  const selectedVendor = url.searchParams.get("vendor") || "";
  const productQuery = url.searchParams.get("productQuery")?.trim() || "";

  const productWhere = {
    status: { not: "DELETED" },
    ...(selectedVendor ? { vendor: selectedVendor } : undefined),
    ...(productQuery
      ? {
          OR: [
            { title: { contains: productQuery, mode: "insensitive" as const } },
            {
              firstVariantSku: {
                contains: productQuery,
                mode: "insensitive" as const,
              },
            },
          ],
        }
      : undefined),
  };

  const [vendors, preparedProducts, runs] = await Promise.all([
    prisma.shopifyProduct.findMany({
      where: { status: { not: "DELETED" }, vendor: { not: null } },
      select: { vendor: true },
      distinct: ["vendor"],
      orderBy: { vendor: "asc" },
    }),
    selectedVendor
      ? prisma.shopifyProduct.findMany({
          where: productWhere,
          select: {
            id: true,
            title: true,
            vendor: true,
            firstVariantSku: true,
            featuredImageUrl: true,
            featuredImageAlt: true,
            _count: {
              select: {
                matches: {
                  where: {
                    status: { in: ["PENDING", "VALIDATED"] },
                    competitor: { active: true, legalStatus: "APPROVED" },
                  },
                },
              },
            },
          },
          orderBy: [{ title: "asc" }],
          take: 200,
        })
      : [],
    prisma.discoveryRun.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { _count: { select: { jobs: true } } },
    }),
  ]);
  const selectedRun =
    (selectedRunId &&
      (await prisma.discoveryRun.findUnique({
        where: { id: selectedRunId },
        include: {
          jobs: {
            include: {
              product: {
                select: {
                  id: true,
                  title: true,
                  vendor: true,
                  featuredImageUrl: true,
                  featuredImageAlt: true,
                },
              },
            },
            orderBy: [{ createdAt: "asc" }],
            take: 100,
          },
        },
      }))) ||
    runs[0] ||
    null;

  return {
    vendors: vendors
      .map((item) => item.vendor)
      .filter((vendor): vendor is string => Boolean(vendor)),
    preparedProducts,
    preparation: { selectedVendor, productQuery },
    runs,
    selectedRun,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  try {
    if (intent === "createPrepared") {
      const vendor = String(formData.get("vendor") || "");
      const productIds = formData.getAll("productId").map(String);
      const productQueries = productIds.map((productId) => ({
        productId,
        searchQuery: String(formData.get(`searchQuery:${productId}`) || ""),
      }));
      const run = await createDiscoveryRunFromProducts({
        vendor,
        productQueries,
      });
      return {
        ok: true,
        runId: run.id,
        message: `${run.totalProducts} produit(s) ajoutés à la tâche préparée.`,
      };
    }

    if (intent === "process") {
      const result = await processDiscoveryQueue({ batchSize: 3 });
      return {
        ok: true,
        message: `${result.processed} produit(s) traité(s).`,
      };
    }

    if (intent === "cancel") {
      const runId = String(formData.get("runId") || "");
      await cancelDiscoveryRun(runId);
      return {
        ok: true,
        message: "Annulation demandée. Les produits non traités sont annulés.",
      };
    }

    if (intent === "updateJobQuery") {
      const jobId = String(formData.get("jobId") || "");
      const searchQuery = String(formData.get("searchQuery") || "");
      await updateDiscoveryJobSearchQuery({ jobId, searchQuery });
      return {
        ok: true,
        message: "Requête de recherche enregistrée.",
      };
    }

    return { ok: false, message: "Action inconnue." };
  } catch (error) {
    if (error instanceof DiscoveryAlreadyRunningError) {
      return {
        ok: false,
        message: "Une recherche automatique est déjà en cours.",
      };
    }
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Erreur pendant la recherche automatique.",
    };
  }
};

function dateTime(value: string | Date | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("fr-FR");
}

export default function DiscoveryPage() {
  const { vendors, preparedProducts, preparation, runs, selectedRun } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();

  useEffect(() => {
    if (actionData?.message) {
      shopify.toast.show(actionData.message, { isError: !actionData.ok });
    }
  }, [actionData, shopify]);

  useEffect(() => {
    const hasRunningRun =
      selectedRun?.status === "RUNNING" ||
      runs.some((run) => run.status === "RUNNING");
    if (!hasRunningRun) return;
    const interval = window.setInterval(() => {
      if (revalidator.state === "idle") {
        revalidator.revalidate();
      }
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [revalidator, runs, selectedRun?.status]);

  return (
    <s-page heading="Recherche automatique">
      <s-section heading="Lancer un lot">
        <s-stack gap="base">
          <Form method="get">
            <s-stack gap="base">
              <s-banner
                tone="info"
                heading="Prépare la recherche avant de lancer"
              >
                Choisis une marque, ajuste la requête de recherche sur chaque
                produit, puis crée la tâche. Les URLs trouvées resteront à
                vérifier avant validation.
              </s-banner>
              <s-grid
                gap="base"
                gridTemplateColumns="@container (inline-size > 700px) 1fr 1fr auto, 1fr"
              >
                <s-select
                  label="Marque à préparer"
                  name="vendor"
                  value={preparation.selectedVendor}
                >
                  <s-option value="">Choisir une marque</s-option>
                  {vendors.map((vendor) => (
                    <s-option key={vendor} value={vendor}>
                      {vendor}
                    </s-option>
                  ))}
                </s-select>
                <s-text-field
                  label="Filtrer les produits"
                  name="productQuery"
                  value={preparation.productQuery}
                  placeholder="Optionnel : modèle ou SKU"
                />
                <s-button type="submit" variant="secondary">
                  Afficher les produits
                </s-button>
              </s-grid>
            </s-stack>
          </Form>

          {preparation.selectedVendor && (
            <Form method="post">
              <input type="hidden" name="intent" value="createPrepared" />
              <input type="hidden" name="vendor" value={preparation.selectedVendor} />
              <s-stack gap="base">
                <s-table>
                  <s-table-header-row>
                    <s-table-header listSlot="primary">Produit</s-table-header>
                    <s-table-header>Inclure</s-table-header>
                    <s-table-header>Requête de recherche</s-table-header>
                    <s-table-header listSlot="secondary">
                      Correspondances
                    </s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {preparedProducts.map((product) => (
                      <s-table-row key={product.id}>
                        <s-table-cell>
                          <s-stack
                            direction="inline"
                            gap="small-200"
                            alignItems="center"
                          >
                            {product.featuredImageUrl && (
                              <s-thumbnail
                                src={product.featuredImageUrl}
                                alt={
                                  product.featuredImageAlt || product.title
                                }
                                size="small"
                              />
                            )}
                            <s-stack gap="none">
                              <s-text type="strong">{product.title}</s-text>
                              <s-text color="subdued">
                                {product.firstVariantSku || "SKU absent"}
                              </s-text>
                            </s-stack>
                          </s-stack>
                        </s-table-cell>
                        <s-table-cell>
                          <s-checkbox
                            label="Inclure"
                            name="productId"
                            value={product.id}
                            defaultChecked
                          />
                        </s-table-cell>
                        <s-table-cell>
                          <s-text-field
                            label="Requête"
                            labelAccessibilityVisibility="exclusive"
                            name={`searchQuery:${product.id}`}
                            value={product.title}
                            placeholder={product.title}
                          />
                        </s-table-cell>
                        <s-table-cell>
                          <s-text color="subdued">
                            {product._count.matches} existante(s)
                          </s-text>
                        </s-table-cell>
                      </s-table-row>
                    ))}
                    {!preparedProducts.length && (
                      <s-table-row>
                        <s-table-cell>Aucun produit pour cette marque</s-table-cell>
                        <s-table-cell>—</s-table-cell>
                        <s-table-cell>—</s-table-cell>
                        <s-table-cell>—</s-table-cell>
                      </s-table-row>
                    )}
                  </s-table-body>
                </s-table>
                <s-stack direction="inline" justifyContent="end" gap="small-200">
                  <s-button
                    type="submit"
                    variant="primary"
                    icon="search"
                    disabled={!preparedProducts.length}
                  >
                    Créer la tâche avec les produits cochés
                  </s-button>
                </s-stack>
              </s-stack>
            </Form>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Historique" padding="none">
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Date</s-table-header>
            <s-table-header>État</s-table-header>
            <s-table-header>Produits</s-table-header>
            <s-table-header>Trouvées</s-table-header>
            <s-table-header>Sans résultat</s-table-header>
            <s-table-header>Erreurs</s-table-header>
            <s-table-header listSlot="secondary">Actions</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {runs.map((run) => (
              <s-table-row key={run.id}>
                <s-table-cell>{dateTime(run.startedAt)}</s-table-cell>
                <s-table-cell>
                  <s-badge tone={RUN_TONES[run.status]}>
                    {RUN_LABELS[run.status]}
                  </s-badge>
                </s-table-cell>
                <s-table-cell>
                  {run.processed}/{run.totalProducts}
                </s-table-cell>
                <s-table-cell>{run.found}</s-table-cell>
                <s-table-cell>{run.notFound}</s-table-cell>
                <s-table-cell>{run.errors}</s-table-cell>
                <s-table-cell>
                  <s-stack direction="inline" gap="small-200">
                    <s-link href={`/app/discovery?run=${run.id}`}>
                      Voir le détail
                    </s-link>
                    {run.status === "RUNNING" && (
                      <Form method="post">
                        <input type="hidden" name="intent" value="cancel" />
                        <input type="hidden" name="runId" value={run.id} />
                        <s-button
                          type="submit"
                          variant="tertiary"
                          tone="critical"
                        >
                          Annuler
                        </s-button>
                      </Form>
                    )}
                  </s-stack>
                </s-table-cell>
              </s-table-row>
            ))}
            {!runs.length && (
              <s-table-row>
                <s-table-cell>Aucune tâche lancée</s-table-cell>
                <s-table-cell>—</s-table-cell>
                <s-table-cell>—</s-table-cell>
                <s-table-cell>—</s-table-cell>
                <s-table-cell>—</s-table-cell>
                <s-table-cell>—</s-table-cell>
                <s-table-cell>—</s-table-cell>
              </s-table-row>
            )}
          </s-table-body>
        </s-table>
      </s-section>

      {selectedRun && "jobs" in selectedRun && (
        <s-section heading="Détail des produits" padding="none">
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Produit</s-table-header>
              <s-table-header>État</s-table-header>
              <s-table-header>Requête</s-table-header>
              <s-table-header>Trouvées</s-table-header>
              <s-table-header>Sans résultat</s-table-header>
              <s-table-header>Erreurs</s-table-header>
              <s-table-header listSlot="secondary">Message</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {selectedRun.jobs.map((job) => (
                <s-table-row key={job.id}>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200" alignItems="center">
                      {job.product.featuredImageUrl && (
                        <s-thumbnail
                          src={job.product.featuredImageUrl}
                          alt={job.product.featuredImageAlt || job.product.title}
                          size="small"
                        />
                      )}
                      <s-stack gap="none">
                        <s-text type="strong">{job.product.title}</s-text>
                        <s-text color="subdued">{job.product.vendor || "—"}</s-text>
                      </s-stack>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={JOB_TONES[job.status]}>
                      {JOB_LABELS[job.status]}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    {job.status === "PENDING" && selectedRun.status === "RUNNING" ? (
                      <Form method="post">
                        <input
                          type="hidden"
                          name="intent"
                          value="updateJobQuery"
                        />
                        <input type="hidden" name="jobId" value={job.id} />
                        <s-stack gap="small-200">
                          <s-text-field
                            label="Requête"
                            labelAccessibilityVisibility="exclusive"
                            name="searchQuery"
                            value={job.searchQuery || ""}
                            placeholder={selectedRun.query || job.product.title}
                          />
                          <s-button type="submit" variant="secondary">
                            Enregistrer
                          </s-button>
                        </s-stack>
                      </Form>
                    ) : (
                      <s-text color={job.searchQuery ? "base" : "subdued"}>
                        {job.searchQuery || selectedRun.query || "—"}
                      </s-text>
                    )}
                  </s-table-cell>
                  <s-table-cell>{job.found}</s-table-cell>
                  <s-table-cell>{job.notFound}</s-table-cell>
                  <s-table-cell>{job.errors}</s-table-cell>
                  <s-table-cell>{job.message || "—"}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}
    </s-page>
  );
}
