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
  createDiscoveryRun,
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

  const [vendors, runs] = await Promise.all([
    prisma.shopifyProduct.findMany({
      where: { status: { not: "DELETED" }, vendor: { not: null } },
      select: { vendor: true },
      distinct: ["vendor"],
      orderBy: { vendor: "asc" },
    }),
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
    runs,
    selectedRun,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  try {
    if (intent === "create") {
      const limit = Number(formData.get("limit") || 100);
      const run = await createDiscoveryRun({
        query: String(formData.get("query") || ""),
        vendor: String(formData.get("vendor") || ""),
        onlyMissing: formData.get("onlyMissing") === "on",
        limit,
      });
      return {
        ok: true,
        runId: run.id,
        message: `${run.totalProducts} produit(s) ajouté(s) à la file de recherche.`,
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

function percent(run: { totalProducts: number; processed: number }) {
  if (!run.totalProducts) return 100;
  return Math.round((run.processed / run.totalProducts) * 100);
}

export default function DiscoveryPage() {
  const { vendors, runs, selectedRun } = useLoaderData<typeof loader>();
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
        <Form method="post">
          <input type="hidden" name="intent" value="create" />
          <s-stack gap="base">
            <s-banner tone="info" heading="Tu peux quitter la page après le lancement">
              La tâche est enregistrée en base. Le cron Coolify la fera avancer
              par petits lots, et tu peux revenir plus tard pour contrôler les
              correspondances proposées.
            </s-banner>
            <s-grid
              gap="base"
              gridTemplateColumns="@container (inline-size > 700px) repeat(3, 1fr), 1fr"
            >
              <s-text-field
                label="Recherche produit"
                name="query"
                placeholder="Titre, marque ou SKU"
              />
              <s-select label="Marque" name="vendor">
                <s-option value="">Toutes les marques</s-option>
                {vendors.map((vendor) => (
                  <s-option key={vendor} value={vendor}>
                    {vendor}
                  </s-option>
                ))}
              </s-select>
              <s-number-field
                label="Nombre maximum"
                name="limit"
                value="100"
                min={1}
                max={500}
                required
              />
            </s-grid>
            <s-switch
              label="Chercher seulement les produits sans correspondance"
              name="onlyMissing"
              value="on"
              defaultChecked
            />
            <s-stack direction="inline" justifyContent="end" gap="small-200">
              <s-button type="submit" variant="primary" icon="search">
                Créer la tâche
              </s-button>
            </s-stack>
          </s-stack>
        </Form>
      </s-section>

      {selectedRun && (
        <s-section heading="Dernière tâche">
          <s-stack gap="base">
            <s-grid
              gap="base"
              gridTemplateColumns="@container (inline-size > 700px) repeat(5, 1fr), 1fr"
            >
              <Metric label="Avancement" value={`${percent(selectedRun)} %`} />
              <Metric
                label="Produits"
                value={`${selectedRun.processed}/${selectedRun.totalProducts}`}
              />
              <Metric label="Trouvées" value={String(selectedRun.found)} />
              <Metric
                label="Déjà présentes"
                value={String(selectedRun.alreadyExists)}
              />
              <Metric label="Erreurs" value={String(selectedRun.errors)} />
            </s-grid>
            <s-banner
              tone={RUN_TONES[selectedRun.status]}
              heading={RUN_LABELS[selectedRun.status]}
            >
              {selectedRun.message || "Aucun détail disponible."}
            </s-banner>
            {selectedRun.status === "RUNNING" && (
              <s-banner tone="info" heading="Suivi en direct activé">
                Cette page se met à jour automatiquement toutes les 5 secondes
                pendant que le cron traite la file.
              </s-banner>
            )}
            <s-stack direction="inline" justifyContent="space-between">
              <s-text color="subdued">
                Lancée le {dateTime(selectedRun.startedAt)}
                {" · "}
                Dernière mise à jour {dateTime(selectedRun.updatedAt)}
              </s-text>
              <Form method="post">
                <s-stack direction="inline" gap="small-200">
                  <input type="hidden" name="intent" value="process" />
                  <s-button type="submit" variant="secondary" icon="refresh">
                    Traiter maintenant
                  </s-button>
                </s-stack>
              </Form>
              {selectedRun.status === "RUNNING" && (
                <Form method="post">
                  <input type="hidden" name="intent" value="cancel" />
                  <input type="hidden" name="runId" value={selectedRun.id} />
                  <s-button type="submit" variant="tertiary" tone="critical">
                    Annuler la tâche
                  </s-button>
                </Form>
              )}
            </s-stack>
          </s-stack>
        </s-section>
      )}

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

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <s-box border="base" borderRadius="base" padding="base">
      <s-stack gap="small-200">
        <s-text color="subdued">{label}</s-text>
        <s-text type="strong">{value}</s-text>
      </s-stack>
    </s-box>
  );
}
