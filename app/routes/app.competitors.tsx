import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import type { CompetitorLegalStatus, RenderMode } from "@prisma/client";
import { useAppBridge } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { fetchRobotsTxt } from "../services/robots.server";

const LEGAL_STATUS_LABELS = {
  PENDING: "À vérifier",
  APPROVED: "Approuvé",
  BLOCKED: "Bloqué",
} as const;

const LEGAL_STATUS_TONES = {
  PENDING: "warning",
  APPROVED: "success",
  BLOCKED: "critical",
} as const;

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
      const domain = domainFromInput(formData.get("domain"));
      const robots = await fetchRobotsTxt(domain);
      await prisma.competitor.create({
        data: {
          name,
          domain,
          robotsContent: robots.content,
          robotsAccess: robots.access,
          robotsCheckedAt: robots.checkedAt,
        },
      });
      return {
        ok: true,
        message: "Concurrent ajouté et robots.txt vérifié.",
      };
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

    if (intent === "robots") {
      const competitor = await prisma.competitor.findUnique({ where: { id } });
      if (!competitor) {
        return { ok: false, message: "Concurrent introuvable." };
      }
      const robots = await fetchRobotsTxt(competitor.domain);
      await prisma.competitor.update({
        where: { id },
        data: {
          robotsContent: robots.content,
          robotsAccess: robots.access,
          robotsCheckedAt: robots.checkedAt,
          robotsOverrideConfirmed: false,
        },
      });
      return { ok: true, message: "robots.txt vérifié à nouveau." };
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
          robotsOverrideConfirmed:
            formData.get("robotsOverrideConfirmed") === "on",
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
  const shopify = useAppBridge();

  useEffect(() => {
    if (actionData?.message) {
      shopify.toast.show(actionData.message, { isError: !actionData.ok });
    }
  }, [actionData, shopify]);

  return (
    <s-page heading="Concurrents">
      <s-section heading="Ajouter un concurrent">
        <Form method="post">
          <input type="hidden" name="intent" value="create" />
          <s-grid
            gap="base"
            gridTemplateColumns="@container (inline-size > 650px) 1fr 1fr auto"
            alignItems="end"
          >
            <s-text-field
              label="Nom"
              name="name"
              required
              placeholder="Bourgogne Archerie"
            />
            <s-text-field
              label="Domaine"
              name="domain"
              required
              prefix="https://"
              placeholder="bourgognearcherie.com"
            />
            <s-button type="submit" variant="primary" icon="plus">
              Ajouter
            </s-button>
          </s-grid>
        </Form>
      </s-section>

      <s-section>
        <s-banner tone="info" heading="Collecte désactivée par défaut">
          Aucun relevé automatique n’est effectué tant que le statut juridique
          n’est pas « Approuvé ». Conservez une référence de votre vérification
          dans la fiche du concurrent.
        </s-banner>
      </s-section>

      <s-section
        heading="Configuration et conformité"
        padding="none"
        accessibilityLabel="Liste des concurrents"
      >
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Concurrent</s-table-header>
            <s-table-header>Conformité</s-table-header>
            <s-table-header>Collecte</s-table-header>
            <s-table-header>robots.txt</s-table-header>
            <s-table-header format="numeric">Correspondances</s-table-header>
            <s-table-header listSlot="secondary">État</s-table-header>
            <s-table-header>Actions</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {competitors.map((competitor) => {
              const modalId = `competitor-${competitor.id}`;
              return (
                <s-table-row key={competitor.id}>
                  <s-table-cell>
                    <s-stack gap="small-200">
                      <s-text type="strong">{competitor.name}</s-text>
                      <s-link
                        href={`https://${competitor.domain}`}
                        target="_blank"
                      >
                        {competitor.domain}
                      </s-link>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={LEGAL_STATUS_TONES[competitor.legalStatus]}>
                      {LEGAL_STATUS_LABELS[competitor.legalStatus]}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    {competitor.renderMode === "HTTP"
                      ? "HTML léger"
                      : "Navigateur dynamique"}
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge
                      tone={
                        competitor.robotsAccess === "ALLOWED"
                          ? "success"
                          : competitor.robotsAccess === "DISALLOWED"
                            ? "critical"
                            : "warning"
                      }
                    >
                      {competitor.robotsAccess === "ALLOWED"
                        ? "Autorisé"
                        : competitor.robotsAccess === "DISALLOWED"
                          ? "Interdit"
                          : "Indéterminé"}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>{competitor._count.matches}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={competitor.active ? "success" : "neutral"}>
                      {competitor.active ? "Actif" : "Inactif"}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200">
                      <s-button
                        variant="tertiary"
                        icon="edit"
                        commandFor={modalId}
                        command="--show"
                      >
                        Configurer
                      </s-button>
                      <Form method="post">
                        <input type="hidden" name="intent" value="robots" />
                        <input type="hidden" name="id" value={competitor.id} />
                        <s-button
                          type="submit"
                          variant="tertiary"
                          icon="refresh"
                        >
                          robots.txt
                        </s-button>
                      </Form>
                      {!competitor._count.matches && (
                        <Form method="post">
                          <input type="hidden" name="intent" value="delete" />
                          <input
                            type="hidden"
                            name="id"
                            value={competitor.id}
                          />
                          <s-button
                            type="submit"
                            variant="tertiary"
                            tone="critical"
                            icon="delete"
                          >
                            Supprimer
                          </s-button>
                        </Form>
                      )}
                    </s-stack>
                    <CompetitorModal
                      modalId={modalId}
                      competitor={competitor}
                    />
                  </s-table-cell>
                </s-table-row>
              );
            })}
          </s-table-body>
        </s-table>
      </s-section>
    </s-page>
  );
}

function CompetitorModal({
  modalId,
  competitor,
}: {
  modalId: string;
  competitor: ReturnType<
    typeof useLoaderData<typeof loader>
  >["competitors"][number];
}) {
  return (
    <s-modal
      id={modalId}
      heading={`Configurer ${competitor.name}`}
      size="large"
    >
      <Form method="post">
        <input type="hidden" name="intent" value="update" />
        <input type="hidden" name="id" value={competitor.id} />
        <s-stack gap="base">
          <s-grid
            gap="base"
            gridTemplateColumns="@container (inline-size > 600px) 1fr 1fr"
          >
            <s-text-field
              label="Nom"
              name="name"
              value={competitor.name}
              required
            />
            <s-text-field
              label="Domaine"
              name="domain"
              value={competitor.domain}
              required
            />
            <s-select
              label="Conformité"
              name="legalStatus"
              value={competitor.legalStatus}
            >
              <s-option value="PENDING">À vérifier</s-option>
              <s-option value="APPROVED">Approuvé</s-option>
              <s-option value="BLOCKED">Bloqué</s-option>
            </s-select>
            <s-select
              label="Mode de rendu"
              name="renderMode"
              value={competitor.renderMode}
            >
              <s-option value="HTTP">HTML léger</s-option>
              <s-option value="BROWSER">Navigateur dynamique</s-option>
            </s-select>
            <s-url-field
              label="URL des conditions"
              name="termsUrl"
              value={competitor.termsUrl || ""}
            />
            <s-text-field
              label="Sélecteur CSS du prix"
              name="priceSelector"
              value={competitor.priceSelector || ""}
              placeholder='.product-price [itemprop="price"]'
            />
            <s-text-field
              label="Sélecteur de disponibilité"
              name="availabilitySelector"
              value={competitor.availabilitySelector || ""}
            />
          </s-grid>
          <s-text-area
            label="Preuve ou note juridique"
            name="permissionReference"
            value={competitor.permissionReference || ""}
            rows={4}
          />
          <s-switch
            label="Concurrent actif"
            name="active"
            value="on"
            defaultChecked={competitor.active}
          />
          {competitor.robotsAccess === "DISALLOWED" && (
            <s-banner tone="critical" heading="Chemin potentiellement interdit">
              La collecte automatique restera bloquée tant que vous n’aurez pas
              confirmé explicitement l’exception ci-dessous.
            </s-banner>
          )}
          <s-switch
            label="Confirmer manuellement la collecte malgré robots.txt"
            name="robotsOverrideConfirmed"
            value="on"
            defaultChecked={competitor.robotsOverrideConfirmed}
          />
          <s-text-area
            label="Contenu de robots.txt"
            value={competitor.robotsContent || "Non disponible"}
            rows={8}
            readOnly
          />
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
