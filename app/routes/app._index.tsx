import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  useFetcher,
  useLoaderData,
  useLocation,
  useNavigate,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getBenchmarkRows,
  type BenchmarkRow,
} from "../services/benchmark.server";
import { syncAllProducts } from "../services/shopify-products.server";
import {
  runPriceWatch,
  ScrapeAlreadyRunningError,
} from "../services/scrape-runner.server";

const PAGE_SIZE = 50;

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

function sortRows(rows: BenchmarkRow[], sort: string) {
  return [...rows].sort((a, b) => {
    if (sort === "price-asc") return a.shopifyPrice - b.shopifyPrice;
    if (sort === "price-desc") return b.shopifyPrice - a.shopifyPrice;
    if (sort === "gap-desc") {
      return (
        (b.differencePercent ?? -Infinity) - (a.differencePercent ?? -Infinity)
      );
    }
    return a.productTitle.localeCompare(b.productTitle, "fr");
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim().toLocaleLowerCase("fr") || "";
  const vendor = url.searchParams.get("vendor") || "";
  const status = url.searchParams.get("status") || "";
  const sort = url.searchParams.get("sort") || "title";
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const allRows = await getBenchmarkRows();
  const vendors = Array.from(
    new Set(allRows.map((row) => row.vendor).filter(Boolean)),
  ).sort() as string[];

  const filtered = sortRows(
    allRows.filter(
      (row) =>
        (!query ||
          row.productTitle.toLocaleLowerCase("fr").includes(query) ||
          row.vendor?.toLocaleLowerCase("fr").includes(query)) &&
        (!vendor || row.vendor === vendor) &&
        (!status || row.status === status),
    ),
    sort,
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const rows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return {
    rows,
    vendors,
    filters: { query, vendor, status, sort },
    pagination: {
      page: safePage,
      totalPages,
      total: filtered.length,
      hasPreviousPage: safePage > 1,
      hasNextPage: safePage < totalPages,
    },
    summary: {
      products: allRows.length,
      topPrice: allRows.filter((row) => row.status === "TOP_PRICE").length,
      competitive: allRows.filter((row) => row.status === "COMPETITIVE").length,
      watch: allRows.filter((row) => row.status === "WATCH").length,
      fix: allRows.filter((row) => row.status === "FIX").length,
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
      message: `${result.products} produits synchronisés.`,
    };
  }

  if (intent === "scrape") {
    try {
      const run = await runPriceWatch({ trigger: "MANUAL" });
      return {
        ok: true,
        message: `Relevé terminé : ${run.succeeded} succès, ${run.skipped} ignorés, ${run.failed} échecs.`,
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
  const { rows, vendors, filters, pagination, summary } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const location = useLocation();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message, {
        isError: !fetcher.data.ok,
      });
    }
  }, [fetcher.data, shopify]);

  function goToPage(page: number) {
    const params = new URLSearchParams(location.search);
    params.set("page", String(page));
    navigate(`${location.pathname}?${params}`);
  }

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
        gridTemplateColumns="@container (inline-size > 800px) repeat(5, 1fr), @container (inline-size > 450px) repeat(2, 1fr), 1fr"
      >
        <Metric label="Produits suivis" value={summary.products} />
        <Metric label="Top prix" value={summary.topPrice} tone="success" />
        <Metric label="Compétitifs" value={summary.competitive} tone="info" />
        <Metric label="À surveiller" value={summary.watch} tone="warning" />
        <Metric label="À corriger" value={summary.fix} tone="critical" />
      </s-grid>

      <s-section
        heading={`Benchmark · ${pagination.total.toLocaleString("fr-FR")} produit(s)`}
        padding="none"
        accessibilityLabel="Benchmark des produits suivis"
      >
        {pagination.total === 0 ? (
          <s-box padding="large-200">
            <s-stack gap="base" alignItems="center">
              <s-icon type="product" tone="neutral" />
              <s-text type="strong">Aucun produit suivi</s-text>
              <s-text color="subdued">
                Validez une correspondance produit pour la faire apparaître dans
                le benchmark.
              </s-text>
              <s-button href="/app/matches" variant="primary">
                Créer une correspondance
              </s-button>
            </s-stack>
          </s-box>
        ) : (
          <s-table
            paginate
            hasPreviousPage={pagination.hasPreviousPage}
            hasNextPage={pagination.hasNextPage}
            onPreviousPage={() => goToPage(pagination.page - 1)}
            onNextPage={() => goToPage(pagination.page + 1)}
          >
            <Form method="get" slot="filters">
              <s-grid
                gap="small-200"
                gridTemplateColumns="@container (inline-size > 850px) 1fr 200px 180px 180px auto auto"
                alignItems="end"
              >
                <s-text-field
                  label="Rechercher"
                  name="q"
                  value={filters.query}
                  icon="search"
                  placeholder="Nom ou marque"
                />
                <s-select label="Marque" name="vendor" value={filters.vendor}>
                  <s-option value="">Toutes</s-option>
                  {vendors.map((item) => (
                    <s-option key={item} value={item}>
                      {item}
                    </s-option>
                  ))}
                </s-select>
                <s-select label="Statut" name="status" value={filters.status}>
                  <s-option value="">Tous</s-option>
                  {Object.entries(STATUS_LABELS).map(([value, label]) => (
                    <s-option key={value} value={value}>
                      {label}
                    </s-option>
                  ))}
                </s-select>
                <s-select label="Tri" name="sort" value={filters.sort}>
                  <s-option value="title">Nom A–Z</s-option>
                  <s-option value="price-asc">Prix croissant</s-option>
                  <s-option value="price-desc">Prix décroissant</s-option>
                  <s-option value="gap-desc">Écart décroissant</s-option>
                </s-select>
                <s-button type="submit" variant="secondary">
                  Appliquer
                </s-button>
                <s-button href="/app/export" variant="secondary" icon="export">
                  Export
                </s-button>
              </s-grid>
            </Form>

            <s-table-header-row>
              <s-table-header listSlot="primary">Produit</s-table-header>
              <s-table-header format="currency">Prix Besançon</s-table-header>
              <s-table-header>Meilleur concurrent</s-table-header>
              <s-table-header format="currency">Meilleur prix</s-table-header>
              <s-table-header format="currency">Écart €</s-table-header>
              <s-table-header format="numeric">Écart %</s-table-header>
              <s-table-header listSlot="secondary">Statut</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((row) => (
                <s-table-row key={row.productId}>
                  <s-table-cell>
                    <s-stack direction="inline" gap="base" alignItems="center">
                      {row.featuredImageUrl ? (
                        <s-thumbnail
                          src={row.featuredImageUrl}
                          alt={row.featuredImageAlt || row.productTitle}
                          size="small"
                        />
                      ) : (
                        <s-avatar initials={row.productTitle.slice(0, 2)} />
                      )}
                      <s-stack gap="small-200">
                        <s-link href={`/app/matches?product=${row.productId}`}>
                          {row.productTitle}
                        </s-link>
                        <s-text color="subdued">
                          {row.vendor || "Sans marque"}
                        </s-text>
                      </s-stack>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    {money(row.shopifyPrice, row.currencyCode)}
                  </s-table-cell>
                  <s-table-cell>
                    {row.bestCompetitorName || "En attente de relevé"}
                  </s-table-cell>
                  <s-table-cell>
                    {money(row.bestCompetitorPrice, row.currencyCode)}
                  </s-table-cell>
                  <s-table-cell>
                    {money(row.differenceAmount, row.currencyCode)}
                  </s-table-cell>
                  <s-table-cell>
                    {row.differencePercent === null
                      ? "—"
                      : `${row.differencePercent.toFixed(1)} %`}
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={STATUS_TONES[row.status]}>
                      {STATUS_LABELS[row.status]}
                    </s-badge>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
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
