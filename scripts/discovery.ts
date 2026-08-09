import prisma from "../app/db.server";
import {
  DiscoveryAlreadyRunningError,
  processDiscoveryQueue,
} from "../app/services/discovery-queue.server";

async function main() {
  try {
    const result = await processDiscoveryQueue({
      batchSize: Number(process.env.DISCOVERY_BATCH_SIZE || 1),
      logger: (message) => console.log(`[discovery] ${message}`),
    });
    console.log(
      `Discovery queue: ${result.processed} product(s) processed.`,
    );
  } catch (error) {
    if (error instanceof DiscoveryAlreadyRunningError) {
      console.log("Discovery queue: already active, skipped this passage.");
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
