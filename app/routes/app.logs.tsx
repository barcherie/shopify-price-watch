import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const observations = await prisma.priceObservation.findMany({
    include: {
      competitor: { select: { name: true } },
      match: { include: { product: { select: { title: true } } } },
    },
    orderBy: { observedAt: "desc" },
    take: 250,
  });

  return {
    observations: observations.map((observation) => ({
      id: observation.id,
      date: observation.observedAt.toISOString(),
      product: observation.match.product.title,
      competitor: observation.competitor.name,
      url: observation.url,
      httpStatus: observation.httpStatus,
      durationMs: observation.durationMs,
      success: observation.success,
      price: observation.price?.toString() || null,
      currencyCode: observation.currencyCode,
      error: observation.errorMessage,
      errorCode: observation.errorCode,
    })),
  };
};

export default function LogsPage() {
  const { observations } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Journal des relevés">
      <s-section
        padding="none"
        accessibilityLabel="Historique des tentatives de relevé"
      >
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Produit</s-table-header>
            <s-table-header>Concurrent</s-table-header>
            <s-table-header>Date</s-table-header>
            <s-table-header format="numeric">HTTP</s-table-header>
            <s-table-header format="numeric">Durée</s-table-header>
            <s-table-header>Résultat</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {observations.map((observation) => (
              <s-table-row key={observation.id}>
                <s-table-cell>
                  <s-stack gap="small-200">
                    <s-text type="strong">{observation.product}</s-text>
                    <s-link href={observation.url} target="_blank">
                      Ouvrir l’URL
                    </s-link>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>{observation.competitor}</s-table-cell>
                <s-table-cell>
                  {new Date(observation.date).toLocaleString("fr-FR")}
                </s-table-cell>
                <s-table-cell>{observation.httpStatus || "—"}</s-table-cell>
                <s-table-cell>{observation.durationMs} ms</s-table-cell>
                <s-table-cell>
                  <s-stack gap="small-200">
                    <s-badge
                      tone={observation.success ? "success" : "critical"}
                    >
                      {observation.success ? "Succès" : "Échec"}
                    </s-badge>
                    <s-text color="subdued">
                      {observation.price
                        ? `${observation.price} ${
                            observation.currencyCode || ""
                          }`
                        : observation.error ||
                          observation.errorCode ||
                          "Sans détail"}
                    </s-text>
                  </s-stack>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>
    </s-page>
  );
}
