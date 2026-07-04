import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  getAutomationSettings,
  runScheduledPriceWatch,
  updateAutomationSettings,
} from "../services/automation.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const [settings, runs] = await Promise.all([
    getAutomationSettings(),
    prisma.scrapeRun.findMany({
      where: { trigger: "CRON" },
      orderBy: { startedAt: "desc" },
      take: 10,
    }),
  ]);
  return { settings, runs };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  try {
    if (intent === "save") {
      const intervalDays = Number(formData.get("intervalDays"));
      if (!Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 30) {
        return {
          ok: false,
          message: "La fréquence doit être comprise entre 1 et 30 jours.",
        };
      }
      await updateAutomationSettings({
        enabled: formData.get("enabled") === "on",
        intervalDays,
      });
      return { ok: true, message: "Planification enregistrée." };
    }

    if (intent === "runNow") {
      const result = await runScheduledPriceWatch({ runNow: true });
      if (!result.launched) {
        return { ok: false, message: "Le relevé n’a pas été lancé." };
      }
      return {
        ok: result.run.failed === 0,
        message: `Terminé : ${result.run.succeeded} succès, ${result.run.skipped} ignorés, ${result.run.failed} erreurs.`,
      };
    }

    return { ok: false, message: "Action inconnue." };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "Erreur d’automatisation.",
    };
  }
};

function dateTime(value: string | Date | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("fr-FR");
}

const RUN_LABELS = {
  RUNNING: "En cours",
  SUCCESS: "Succès",
  PARTIAL: "Partiel",
  FAILED: "Échec",
} as const;

const RUN_TONES = {
  RUNNING: "info",
  SUCCESS: "success",
  PARTIAL: "warning",
  FAILED: "critical",
} as const;

export default function AutomationPage() {
  const { settings, runs } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();

  useEffect(() => {
    if (actionData?.message) {
      shopify.toast.show(actionData.message, { isError: !actionData.ok });
    }
  }, [actionData, shopify]);

  return (
    <s-page heading="Automatisation">
      <s-section heading="Planification des prix">
        <Form method="post">
          <input type="hidden" name="intent" value="save" />
          <s-stack gap="base">
            <s-switch
              label="Activer les relevés automatiques"
              name="enabled"
              value="on"
              defaultChecked={settings.enabled}
            />
            <s-number-field
              label="Fréquence en jours"
              name="intervalDays"
              value={String(settings.intervalDays)}
              min={1}
              max={30}
              required
              details="5 jours est la valeur recommandée. Le contrôle Coolify peut s’exécuter chaque heure sans lancer de crawl inutile."
            />
            <s-stack direction="inline" justifyContent="end" gap="small-200">
              <s-button type="submit" variant="primary">
                Enregistrer
              </s-button>
            </s-stack>
          </s-stack>
        </Form>
      </s-section>

      <s-grid
        gap="base"
        gridTemplateColumns="@container (inline-size > 700px) repeat(3, 1fr), 1fr"
      >
        <Metric
          label="État"
          value={settings.enabled ? "Activée" : "Désactivée"}
        />
        <Metric
          label="Prochain relevé"
          value={settings.enabled ? dateTime(settings.nextRunAt) : "—"}
        />
        <Metric
          label="Dernier contrôle Coolify"
          value={dateTime(settings.lastSchedulerCheckAt)}
        />
      </s-grid>

      {settings.lastSchedulerStatus && (
        <s-section heading="Dernier retour du planificateur">
          <s-banner
            tone={
              settings.lastSchedulerStatus === "SUCCESS"
                ? "success"
                : settings.lastSchedulerStatus === "PARTIAL"
                  ? "warning"
                  : "critical"
            }
            heading={
              settings.lastSchedulerStatus === "SUCCESS"
                ? "Dernier lancement réussi"
                : settings.lastSchedulerStatus === "PARTIAL"
                  ? "Dernier lancement partiel"
                  : "Dernier lancement en échec"
            }
          >
            {settings.lastSchedulerMessage || "Aucun détail disponible."}
          </s-banner>
        </s-section>
      )}

      <s-section>
        <Form method="post">
          <input type="hidden" name="intent" value="runNow" />
          <s-button type="submit" variant="secondary" icon="refresh">
            Lancer un relevé maintenant
          </s-button>
        </Form>
      </s-section>

      <s-section heading="Historique des lancements" padding="none">
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Date</s-table-header>
            <s-table-header>Résultat</s-table-header>
            <s-table-header format="numeric">Succès</s-table-header>
            <s-table-header format="numeric">Ignorés</s-table-header>
            <s-table-header format="numeric">Erreurs</s-table-header>
            <s-table-header listSlot="secondary">Message</s-table-header>
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
                <s-table-cell>{run.succeeded}</s-table-cell>
                <s-table-cell>{run.skipped}</s-table-cell>
                <s-table-cell>{run.failed}</s-table-cell>
                <s-table-cell>{run.errorMessage || "—"}</s-table-cell>
              </s-table-row>
            ))}
            {!runs.length && (
              <s-table-row>
                <s-table-cell>Aucun lancement planifié</s-table-cell>
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
