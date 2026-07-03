import {
  runPriceWatch,
  ScrapeAlreadyRunningError,
} from "../app/services/scrape-runner.server";
import prisma from "../app/db.server";

async function main() {
  try {
    const run = await runPriceWatch({ trigger: "CRON" });
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
