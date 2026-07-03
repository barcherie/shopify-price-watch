import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import type { ProductMatchStatus } from "@prisma/client";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { runPriceWatch } from "../services/scrape-runner.server";
import { validateTargetUrl } from "../services/url-safety.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const selectedVariant =
    new URL(request.url).searchParams.get("variant") || "";

  const [variants, competitors, matches] = await Promise.all([
    prisma.shopifyVariant.findMany({
      where: { active: true, product: { status: { not: "DELETED" } } },
      include: { product: true },
      orderBy: [{ product: { title: "asc" } }, { title: "asc" }],
      take: 250,
    }),
    prisma.competitor.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
    }),
    prisma.productMatch.findMany({
      include: {
        competitor: true,
        variant: { include: { product: true } },
        observations: { orderBy: { observedAt: "desc" }, take: 1 },
      },
      orderBy: { updatedAt: "desc" },
      take: 250,
    }),
  ]);

  return {
    selectedVariant,
    variants: variants.map((variant) => ({
      id: variant.id,
      label: `${variant.product.title} — ${variant.title} — ${variant.sku || "sans SKU"}`,
    })),
    competitors,
    matches: matches.map((match) => ({
      id: match.id,
      product: match.variant.product.title,
      variant: match.variant.title,
      sku: match.variant.sku,
      competitor: match.competitor.name,
      url: match.url,
      status: match.status,
      confidenceScore: match.confidenceScore,
      internalNote: match.internalNote,
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
    if (intent === "create") {
      const variantId = String(formData.get("variantId") || "");
      const competitorId = String(formData.get("competitorId") || "");
      const competitor = await prisma.competitor.findUnique({
        where: { id: competitorId },
      });
      if (!competitor) {
        return { ok: false, message: "Concurrent introuvable." };
      }

      const url = validateTargetUrl(
        String(formData.get("url") || ""),
        competitor.domain,
      ).toString();
      const scoreText = String(formData.get("confidenceScore") || "").trim();
      const confidenceScore = scoreText ? Number(scoreText) : null;
      if (
        confidenceScore !== null &&
        (!Number.isInteger(confidenceScore) ||
          confidenceScore < 0 ||
          confidenceScore > 100)
      ) {
        return {
          ok: false,
          message: "Le score doit être compris entre 0 et 100.",
        };
      }

      await prisma.productMatch.create({
        data: {
          variantId,
          competitorId,
          url,
          confidenceScore,
          internalNote:
            String(formData.get("internalNote") || "").trim() || null,
        },
      });
      return {
        ok: true,
        message: "Correspondance ajoutée. Validez-la avant le premier relevé.",
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
      const status = String(formData.get("status")) as ProductMatchStatus;
      if (!statuses.includes(status)) {
        return { ok: false, message: "Statut invalide." };
      }
      await prisma.productMatch.update({
        where: { id },
        data: { status },
      });
      return { ok: true, message: "Statut mis à jour." };
    }

    if (intent === "scrape") {
      const run = await runPriceWatch({ trigger: "MANUAL", matchId: id });
      return {
        ok: run.succeeded === 1,
        message:
          run.succeeded === 1
            ? "Prix relevé."
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

export default function MatchesPage() {
  const { variants, competitors, matches, selectedVariant } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <s-page heading="Correspondances produits">
      <s-section heading="Nouvelle correspondance">
        {actionData?.message && <p className="pw-help">{actionData.message}</p>}
        <Form method="post" className="pw-form-grid">
          <input type="hidden" name="intent" value="create" />
          <label>
            Variante Shopify
            <select
              name="variantId"
              required
              defaultValue={selectedVariant || variants[0]?.id}
            >
              {variants.map((variant) => (
                <option key={variant.id} value={variant.id}>
                  {variant.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Concurrent
            <select name="competitorId" required>
              {competitors.map((competitor) => (
                <option key={competitor.id} value={competitor.id}>
                  {competitor.name} — {competitor.legalStatus}
                </option>
              ))}
            </select>
          </label>
          <label>
            URL exacte
            <input name="url" type="url" required />
          </label>
          <label>
            Confiance (0–100)
            <input name="confidenceScore" type="number" min="0" max="100" />
          </label>
          <label>
            Note interne
            <textarea name="internalNote" />
          </label>
          <button type="submit" className="pw-button">
            Ajouter à vérifier
          </button>
        </Form>
      </s-section>

      <s-section heading="Correspondances enregistrées">
        <div className="pw-table-wrap">
          <table className="pw-table">
            <thead>
              <tr>
                <th>Produit</th>
                <th>Concurrent</th>
                <th>URL</th>
                <th>Dernier relevé</th>
                <th>Statut</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {matches.map((match) => (
                <tr key={match.id}>
                  <td>
                    <strong>{match.product}</strong>
                    <small>
                      {match.variant} — {match.sku || "sans SKU"}
                    </small>
                  </td>
                  <td>
                    {match.competitor}
                    <small>{match.legalStatus}</small>
                  </td>
                  <td>
                    <a href={match.url} target="_blank" rel="noreferrer">
                      Ouvrir
                    </a>
                    {match.internalNote && <small>{match.internalNote}</small>}
                  </td>
                  <td>
                    {match.latest?.price
                      ? `${match.latest.price} ${match.latest.currencyCode || ""}`
                      : match.latest?.error || "—"}
                    {match.latest && (
                      <small>
                        {new Date(match.latest.observedAt).toLocaleString(
                          "fr-FR",
                        )}
                      </small>
                    )}
                  </td>
                  <td>
                    <span className={`pw-status pw-status--${match.status}`}>
                      {match.status}
                    </span>
                  </td>
                  <td>
                    <Form method="post">
                      <input type="hidden" name="intent" value="status" />
                      <input type="hidden" name="id" value={match.id} />
                      <select name="status" defaultValue={match.status}>
                        <option value="PENDING">À vérifier</option>
                        <option value="VALIDATED">Validé</option>
                        <option value="REJECTED">Rejeté</option>
                      </select>
                      <button type="submit" className="pw-button">
                        Enregistrer
                      </button>
                    </Form>
                    {match.status === "VALIDATED" &&
                      match.legalStatus === "APPROVED" &&
                      match.active && (
                        <Form method="post">
                          <input type="hidden" name="intent" value="scrape" />
                          <input type="hidden" name="id" value={match.id} />
                          <button
                            type="submit"
                            className="pw-button pw-button--secondary"
                          >
                            Tester
                          </button>
                        </Form>
                      )}
                    <Form method="post">
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="id" value={match.id} />
                      <button
                        type="submit"
                        className="pw-button pw-button--danger"
                      >
                        Supprimer
                      </button>
                    </Form>
                  </td>
                </tr>
              ))}
              {!matches.length && (
                <tr>
                  <td colSpan={6} className="pw-empty">
                    Aucune correspondance.
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
