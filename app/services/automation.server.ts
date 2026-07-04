import prisma from "../db.server";
import {
  DAY_MS,
  runPriceWatch,
  ScrapeAlreadyRunningError,
} from "./scrape-runner.server";

export const AUTOMATION_SETTINGS_ID = "default";

export function isAutomationDue(
  settings: { enabled: boolean; nextRunAt: Date | null },
  now = new Date(),
) {
  return (
    settings.enabled &&
    (!settings.nextRunAt || settings.nextRunAt.getTime() <= now.getTime())
  );
}

export async function getAutomationSettings() {
  return prisma.automationSettings.upsert({
    where: { id: AUTOMATION_SETTINGS_ID },
    update: {},
    create: {
      id: AUTOMATION_SETTINGS_ID,
      enabled: true,
      intervalDays: 5,
      nextRunAt: new Date(),
    },
  });
}

export async function updateAutomationSettings(input: {
  enabled: boolean;
  intervalDays: number;
}) {
  const intervalDays = Math.min(30, Math.max(1, input.intervalDays));
  const current = await getAutomationSettings();
  return prisma.automationSettings.update({
    where: { id: AUTOMATION_SETTINGS_ID },
    data: {
      enabled: input.enabled,
      intervalDays,
      nextRunAt:
        input.enabled &&
        (!current.enabled || current.intervalDays !== intervalDays)
          ? new Date()
          : current.nextRunAt,
    },
  });
}

export async function runScheduledPriceWatch(options?: { runNow?: boolean }) {
  const now = new Date();
  const settings = await getAutomationSettings();
  await prisma.automationSettings.update({
    where: { id: AUTOMATION_SETTINGS_ID },
    data: { lastSchedulerCheckAt: now },
  });

  if (!settings.enabled && !options?.runNow) {
    return { launched: false as const, reason: "DISABLED" as const };
  }
  if (!options?.runNow && !isAutomationDue(settings, now)) {
    return {
      launched: false as const,
      reason: "NOT_DUE" as const,
      nextRunAt: settings.nextRunAt,
    };
  }

  try {
    const run = await runPriceWatch({
      trigger: "CRON",
      cooldownMs: settings.intervalDays * DAY_MS,
    });
    const nextRunAt = new Date(
      now.getTime() + settings.intervalDays * DAY_MS,
    );
    await prisma.automationSettings.update({
      where: { id: AUTOMATION_SETTINGS_ID },
      data: {
        nextRunAt,
        lastSchedulerStatus: run.status,
        lastSchedulerMessage:
          run.status === "SUCCESS"
            ? `${run.succeeded} prix relevé(s), ${run.skipped} ignoré(s).`
            : run.errorMessage ||
              `${run.failed} erreur(s), ${run.succeeded} succès.`,
      },
    });
    return { launched: true as const, run, nextRunAt };
  } catch (error) {
    const message =
      error instanceof ScrapeAlreadyRunningError
        ? "Un relevé est déjà en cours."
        : error instanceof Error
          ? error.message.slice(0, 500)
          : "Erreur inconnue.";
    await prisma.automationSettings.update({
      where: { id: AUTOMATION_SETTINGS_ID },
      data: {
        nextRunAt: new Date(now.getTime() + 60 * 60 * 1000),
        lastSchedulerStatus: "FAILED",
        lastSchedulerMessage: message,
      },
    });
    throw error;
  }
}
