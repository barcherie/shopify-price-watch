import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getBenchmarkRows } from "../services/benchmark.server";

function cell(value: string | number | null) {
  const text =
    typeof value === "number"
      ? value.toFixed(2).replace(".", ",")
      : String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const rows = await getBenchmarkRows();
  const header = [
    "Produit",
    "Marque",
    "Catégorie",
    "Prix Besançon",
    "Devise",
    "Meilleur prix concurrent",
    "Concurrent le moins cher",
    "Écart €",
    "Écart %",
    "Nombre de concurrents moins chers",
    "Nombre de concurrents plus chers",
    "Correspondances validées",
    "Statut",
    "Dernier relevé",
  ];

  const lines = rows.map((row) =>
    [
      row.productTitle,
      row.vendor,
      row.category,
      row.shopifyPrice,
      row.currencyCode,
      row.bestCompetitorPrice,
      row.bestCompetitorName,
      row.differenceAmount,
      row.differencePercent,
      row.cheaperCompetitors,
      row.moreExpensiveCompetitors,
      row.matchCount,
      row.status,
      row.lastObservedAt,
    ]
      .map(cell)
      .join(";"),
  );

  const csv = `\uFEFF${header.map(cell).join(";")}\r\n${lines.join("\r\n")}`;
  const date = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="price-watch-${date}.csv"`,
      "cache-control": "no-store",
    },
  });
};
