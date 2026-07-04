import { runScheduledPriceWatch } from "../app/services/automation.server";
import { ScrapeAlreadyRunningError } from "../app/services/scrape-runner.server";
import prisma from "../app/db.server";

async function main() {
  try {
    const result = await runScheduledPriceWatch();
    if (!result.launched) {
      console.log(
        result.reason === "DISABLED"
          ? "Price Watch automation is disabled."
          : `Price Watch is not due yet${
              "nextRunAt" in result
                ? ` (next run: ${result.nextRunAt?.toISOString() || "unknown"})`
                : ""
            }.`,
      );
      return;
    }
    const { run } = result;
    console.log(
      `Price Watch run ${run.id}: ${run.succeeded} succeeded, ${run.skipped} skipped, ${run.failed} failed.`,
    );
    process.exitCode = run.failed ? 2 : 0;
  } catch (error) {
    if (error instanceof ScrapeAlreadyRunningError) {
      console.error("A Price Watch run is already active.");
      process.exitCode = 3;
      return;
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
