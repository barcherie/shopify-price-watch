import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import type { CompetitorLegalStatus, RenderMode } from "@prisma/client";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

function domainFromInput(raw: FormDataEntryValue | null) {
  const value = String(raw || "")
    .trim()
    .toLowerCase();
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Saisissez uniquement un nom de domaine.");
  }
  return url.hostname.replace(/^www\./, "");
}

function stringOrNull(value: FormDataEntryValue | null) {
  const text = String(value || "").trim();
  return text || null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return {
    competitors: await prisma.competitor.findMany({
      include: { _count: { select: { matches: true } } },
      orderBy: { name: "asc" },
    }),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  try {
    if (intent === "create") {
      const name = String(formData.get("name") || "").trim();
      if (!name) return { ok: false, message: "Le nom est obligatoire." };
      await prisma.competitor.create({
        data: {
          name,
          domain: domainFromInput(formData.get("domain")),
        },
      });
      return { ok: true, message: "Concurrent ajouté." };
    }

    const id = String(formData.get("id") || "");
    if (!id) return { ok: false, message: "Concurrent introuvable." };

    if (intent === "delete") {
      const matchCount = await prisma.productMatch.count({
        where: { competitorId: id },
      });
      if (matchCount) {
        return {
          ok: false,
          message:
            "Ce concurrent possède des correspondances. Désactivez-le au lieu de le supprimer.",
        };
      }
      await prisma.competitor.delete({ where: { id } });
      return { ok: true, message: "Concurrent supprimé." };
    }

    if (intent === "update") {
      const legalStatuses: CompetitorLegalStatus[] = [
        "PENDING",
        "APPROVED",
        "BLOCKED",
      ];
      const renderModes: RenderMode[] = ["HTTP", "BROWSER"];
      const legalStatus = String(
        formData.get("legalStatus"),
      ) as CompetitorLegalStatus;
      const renderMode = String(formData.get("renderMode")) as RenderMode;
      const requestsPerMinute = Math.min(
        30,
        Math.max(1, Number(formData.get("requestsPerMinute") || 6)),
      );

      if (!legalStatuses.includes(legalStatus)) {
        return { ok: false, message: "Statut juridique invalide." };
      }
      if (!renderModes.includes(renderMode)) {
        return { ok: false, message: "Mode de rendu invalide." };
      }

      await prisma.competitor.update({
        where: { id },
        data: {
          name: String(formData.get("name") || "").trim(),
          domain: domainFromInput(formData.get("domain")),
          active: formData.get("active") === "on",
          legalStatus,
          renderMode,
          requestsPerMinute,
          termsUrl: stringOrNull(formData.get("termsUrl")),
          permissionReference: stringOrNull(
            formData.get("permissionReference"),
          ),
          priceSelector: stringOrNull(formData.get("priceSelector")),
          availabilitySelector: stringOrNull(
            formData.get("availabilitySelector"),
          ),
          termsCheckedAt: legalStatus === "PENDING" ? null : new Date(),
        },
      });
      return { ok: true, message: "Concurrent mis à jour." };
    }

    return { ok: false, message: "Action inconnue." };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Impossible d’enregistrer le concurrent.",
    };
  }
};

export default function CompetitorsPage() {
  const { competitors } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <s-page heading="Concurrents">
      <s-section heading="Ajouter un concurrent">
        {actionData?.message && <p className="pw-help">{actionData.message}</p>}
        <Form method="post" className="pw-form-grid">
          <input type="hidden" name="intent" value="create" />
          <label>
            Nom
            <input name="name" required placeholder="Bourgogne Archerie" />
          </label>
          <label>
            Domaine
            <input name="domain" required placeholder="bourgognearcherie.com" />
          </label>
          <button type="submit" className="pw-button">
            Ajouter
          </button>
        </Form>
      </s-section>

      <s-section heading="Configuration et conformité">
        <p className="pw-help">
          Aucun relevé automatique n’est effectué tant que le statut juridique
          n’est pas « Approuvé ». Conservez ici la preuve ou la référence de
          votre validation.
        </p>
        {competitors.map((competitor) => (
          <details key={competitor.id}>
            <summary>
              <strong>{competitor.name}</strong> — {competitor.domain}{" "}
              <span
                className={`pw-status pw-status--${competitor.legalStatus}`}
              >
                {competitor.legalStatus}
              </span>{" "}
              ({competitor._count.matches} correspondances)
            </summary>
            <Form method="post" className="pw-form-grid">
              <input type="hidden" name="intent" value="update" />
              <input type="hidden" name="id" value={competitor.id} />
              <label>
                Nom
                <input name="name" defaultValue={competitor.name} required />
              </label>
              <label>
                Domaine
                <input
                  name="domain"
                  defaultValue={competitor.domain}
                  required
                />
              </label>
              <label>
                Conformité
                <select
                  name="legalStatus"
                  defaultValue={competitor.legalStatus}
                >
                  <option value="PENDING">À vérifier</option>
                  <option value="APPROVED">Approuvé</option>
                  <option value="BLOCKED">Bloqué</option>
                </select>
              </label>
              <label>
                Mode
                <select name="renderMode" defaultValue={competitor.renderMode}>
                  <option value="HTTP">HTML léger</option>
                  <option value="BROWSER">Navigateur dynamique</option>
                </select>
              </label>
              <label>
                Requêtes/minute
                <input
                  name="requestsPerMinute"
                  type="number"
                  min="1"
                  max="30"
                  defaultValue={competitor.requestsPerMinute}
                />
              </label>
              <label>
                URL des conditions
                <input
                  name="termsUrl"
                  type="url"
                  defaultValue={competitor.termsUrl || ""}
                />
              </label>
              <label>
                Preuve / note juridique
                <textarea
                  name="permissionReference"
                  defaultValue={competitor.permissionReference || ""}
                />
              </label>
              <label>
                Sélecteur CSS prix
                <input
                  name="priceSelector"
                  defaultValue={competitor.priceSelector || ""}
                  placeholder='.product-price [itemprop="price"]'
                />
              </label>
              <label>
                Sélecteur disponibilité
                <input
                  name="availabilitySelector"
                  defaultValue={competitor.availabilitySelector || ""}
                />
              </label>
              <label className="pw-checkbox">
                <input
                  name="active"
                  type="checkbox"
                  defaultChecked={competitor.active}
                />
                Actif
              </label>
              <button type="submit" className="pw-button">
                Enregistrer
              </button>
            </Form>
            {!competitor._count.matches && (
              <Form method="post">
                <input type="hidden" name="intent" value="delete" />
                <input type="hidden" name="id" value={competitor.id} />
                <button type="submit" className="pw-button pw-button--danger">
                  Supprimer
                </button>
              </Form>
            )}
          </details>
        ))}
      </s-section>
    </s-page>
  );
}
