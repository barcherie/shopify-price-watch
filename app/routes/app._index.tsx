import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getBenchmarkRows } from "../services/benchmark.server";
import { syncAllProducts } from "../services/shopify-products.server";
import {
  runPriceWatch,
  ScrapeAlreadyRunningError,
} from "../services/scrape-runner.server";

const STATUS_LABELS = {
  TOP_PRICE: "Top prix",
  COMPETITIVE: "Compétitif",
  WATCH: "À surveiller",
  FIX: "À corriger",
} as const;

const STATUS_TONES = {
  TOP_PRICE: "success",
  COMPETITIVE: "info",
  WATCH: "warning",
  FIX: "critical",
} as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const vendor = url.searchParams.get("vendor") || "";
  const status = url.searchParams.get("status") || "";
  const unmatched = url.searchParams.get("unmatched") === "1";
  const allRows = await getBenchmarkRows();
  const vendors = Array.from(
    new Set(allRows.map((row) => row.vendor).filter(Boolean)),
  ).sort() as string[];

  const rows = allRows.filter(
    (row) =>
      (!vendor || row.vendor === vendor) &&
      (!status || row.status === status) &&
      (!unmatched || row.matchCount === 0),
  );

  return {
    rows,
    vendors,
    filters: { vendor, status, unmatched },
    summary: {
      products: allRows.length,
      topPrice: allRows.filter((row) => row.status === "TOP_PRICE").length,
      competitive: allRows.filter((row) => row.status === "COMPETITIVE").length,
      watch: allRows.filter((row) => row.status === "WATCH").length,
      fix: allRows.filter((row) => row.status === "FIX").length,
      unmatched: allRows.filter((row) => row.matchCount === 0).length,
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "sync") {
    const result = await syncAllProducts(admin);
    return {
      ok: true,
      message: `${result.products} produits et ${result.variants} variantes synchronisés.`,
    };
  }

  if (intent === "scrape") {
    try {
      const run = await runPriceWatch({ trigger: "MANUAL" });
      return {
        ok: true,
        message: `Relevé terminé : ${run.succeeded} succès, ${run.failed} échecs.`,
      };
    } catch (error) {
      if (error instanceof ScrapeAlreadyRunningError) {
        return { ok: false, message: "Un relevé est déjà en cours." };
      }
      throw error;
    }
  }

  return { ok: false, message: "Action inconnue." };
};

function money(value: number | null, currencyCode = "EUR") {
  if (value === null) return "—";
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: currencyCode,
  }).format(value);
}

export default function Dashboard() {
  const { rows, vendors, filters, summary } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message, {
        isError: !fetcher.data.ok,
      });
    }
  }, [fetcher.data, shopify]);

  return (
    <s-page heading="Price Watch">
      <s-stack slot="primary-action" direction="inline" gap="base">
        <s-button
          onClick={() => fetcher.submit({ intent: "sync" }, { method: "POST" })}
          {...(busy ? { loading: true } : {})}
        >
          Synchroniser Shopify
        </s-button>
        <s-button
          variant="primary"
          onClick={() =>
            fetcher.submit({ intent: "scrape" }, { method: "POST" })
          }
          {...(busy ? { loading: true } : {})}
        >
          Relever les prix
        </s-button>
      </s-stack>

      <s-grid
        gap="base"
        gridTemplateColumns="@container (inline-size > 900px) repeat(6, 1fr), @container (inline-size > 500px) repeat(3, 1fr), 1fr"
      >
        <Metric label="Variantes" value={summary.products} />
        <Metric label="Top prix" value={summary.topPrice} tone="success" />
        <Metric label="Compétitifs" value={summary.competitive} tone="info" />
        <Metric label="À surveiller" value={summary.watch} tone="warning" />
        <Metric label="À corriger" value={summary.fix} tone="critical" />
        <Metric label="Sans correspondance" value={summary.unmatched} />
      </s-grid>

      <s-section
        heading="Benchmark TTC hors livraison"
        padding="none"
        accessibilityLabel="Benchmark des prix"
      >
        <s-table>
          <Form method="get" slot="filters">
            <s-grid
              gap="small-200"
              gridTemplateColumns="@container (inline-size > 750px) 1fr 220px auto auto auto"
              alignItems="end"
            >
              <s-select label="Marque" name="vendor" value={filters.vendor}>
                <s-option value="">Toutes les marques</s-option>
                {vendors.map((vendor) => (
                  <s-option key={vendor} value={vendor}>
                    {vendor}
                  </s-option>
                ))}
              </s-select>
              <s-select label="Statut" name="status" value={filters.status}>
                <s-option value="">Tous les statuts</s-option>
                {Object.entries(STATUS_LABELS).map(([value, label]) => (
                  <s-option key={value} value={value}>
                    {label}
                  </s-option>
                ))}
              </s-select>
              <s-switch
                label="Sans correspondance"
                name="unmatched"
                value="1"
                defaultChecked={filters.unmatched}
              />
              <s-button type="submit" variant="secondary" icon="filter">
                Filtrer
              </s-button>
              <s-button href="/app/export" variant="secondary" icon="export">
                Export CSV
              </s-button>
            </s-grid>
          </Form>

          <s-table-header-row>
            <s-table-header listSlot="primary">Produit</s-table-header>
            <s-table-header>SKU</s-table-header>
            <s-table-header format="currency">Prix Besançon</s-table-header>
            <s-table-header format="currency">
              Meilleur concurrent
            </s-table-header>
            <s-table-header>Écart</s-table-header>
            <s-table-header format="numeric">Moins chers</s-table-header>
            <s-table-header listSlot="secondary">Statut</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {rows.map((row) => (
              <s-table-row key={row.variantId}>
                <s-table-cell>
                  <s-stack gap="small-200">
                    <s-text type="strong">{row.productTitle}</s-text>
                    {row.variantTitle !== "Default Title" && (
                      <s-text color="subdued">{row.variantTitle}</s-text>
                    )}
                  </s-stack>
                </s-table-cell>
                <s-table-cell>{row.sku || "—"}</s-table-cell>
                <s-table-cell>
                  {money(row.shopifyPrice, row.currencyCode)}
                </s-table-cell>
                <s-table-cell>
                  {row.bestCompetitorPrice === null ? (
                    <s-link href={`/app/matches?variant=${row.variantId}`}>
                      Ajouter une correspondance
                    </s-link>
                  ) : (
                    <s-stack gap="small-200">
                      <s-text>
                        {money(row.bestCompetitorPrice, row.currencyCode)}
                      </s-text>
                      <s-text color="subdued">{row.bestCompetitorName}</s-text>
                    </s-stack>
                  )}
                </s-table-cell>
                <s-table-cell>
                  {row.differenceAmount === null
                    ? "—"
                    : `${money(
                        row.differenceAmount,
                        row.currencyCode,
                      )} (${row.differencePercent?.toFixed(1)} %)`}
                </s-table-cell>
                <s-table-cell>{row.cheaperCompetitors}</s-table-cell>
                <s-table-cell>
                  <s-badge tone={STATUS_TONES[row.status]}>
                    {STATUS_LABELS[row.status]}
                  </s-badge>
                </s-table-cell>
              </s-table-row>
            ))}
            {!rows.length && (
              <s-table-row>
                <s-table-cell>
                  <s-text color="subdued">
                    Aucun produit pour ces filtres.
                  </s-text>
                </s-table-cell>
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
    </s-page>
  );
}

function Metric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "success" | "info" | "warning" | "critical";
}) {
  return (
    <s-box border="base" borderRadius="base" padding="base">
      <s-stack gap="small-200">
        <s-text color="subdued">{label}</s-text>
        <s-stack direction="inline" alignItems="center" gap="small-200">
          <s-text type="strong">{value.toLocaleString("fr-FR")}</s-text>
          {tone !== "neutral" && <s-badge tone={tone}>{label}</s-badge>}
        </s-stack>
      </s-stack>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
