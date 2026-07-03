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

      <div className="pw-metrics">
        <Metric label="Variantes" value={summary.products} />
        <Metric label="Top prix" value={summary.topPrice} tone="success" />
        <Metric label="Compétitifs" value={summary.competitive} tone="info" />
        <Metric label="À surveiller" value={summary.watch} tone="warning" />
        <Metric label="À corriger" value={summary.fix} tone="critical" />
        <Metric label="Sans correspondance" value={summary.unmatched} />
      </div>

      <s-section heading="Benchmark TTC hors livraison">
        <Form method="get" className="pw-filters">
          <label>
            Marque
            <select name="vendor" defaultValue={filters.vendor}>
              <option value="">Toutes</option>
              {vendors.map((vendor) => (
                <option key={vendor} value={vendor}>
                  {vendor}
                </option>
              ))}
            </select>
          </label>
          <label>
            Statut
            <select name="status" defaultValue={filters.status}>
              <option value="">Tous</option>
              {Object.entries(STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="pw-checkbox">
            <input
              type="checkbox"
              name="unmatched"
              value="1"
              defaultChecked={filters.unmatched}
            />
            Sans correspondance
          </label>
          <button className="pw-button" type="submit">
            Filtrer
          </button>
          <a className="pw-button pw-button--secondary" href="/app/export">
            Export CSV
          </a>
        </Form>

        <div className="pw-table-wrap">
          <table className="pw-table">
            <thead>
              <tr>
                <th>Produit</th>
                <th>SKU</th>
                <th>Prix Besançon</th>
                <th>Meilleur concurrent</th>
                <th>Écart</th>
                <th>Moins chers</th>
                <th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.variantId}>
                  <td>
                    <strong>{row.productTitle}</strong>
                    {row.variantTitle !== "Default Title" && (
                      <small>{row.variantTitle}</small>
                    )}
                  </td>
                  <td>{row.sku || "—"}</td>
                  <td>{money(row.shopifyPrice, row.currencyCode)}</td>
                  <td>
                    {row.bestCompetitorPrice === null ? (
                      <a href={`/app/matches?variant=${row.variantId}`}>
                        Ajouter une correspondance
                      </a>
                    ) : (
                      <>
                        {money(row.bestCompetitorPrice, row.currencyCode)}
                        <small>{row.bestCompetitorName}</small>
                      </>
                    )}
                  </td>
                  <td>
                    {row.differenceAmount === null
                      ? "—"
                      : `${money(row.differenceAmount, row.currencyCode)} (${row.differencePercent?.toFixed(1)} %)`}
                  </td>
                  <td>{row.cheaperCompetitors}</td>
                  <td>
                    <span className={`pw-status pw-status--${row.status}`}>
                      {STATUS_LABELS[row.status]}
                    </span>
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={7} className="pw-empty">
                    Aucun produit pour ces filtres. Lancez d’abord une
                    synchronisation Shopify.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
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
  tone?: string;
}) {
  return (
    <div className={`pw-metric pw-metric--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
