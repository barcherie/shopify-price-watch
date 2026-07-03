import { timingSafeEqual } from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import {
  runPriceWatch,
  ScrapeAlreadyRunningError,
} from "../services/scrape-runner.server";

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization");
  if (!secret || !authorization?.startsWith("Bearer ")) return false;

  const received = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(secret);
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

export const loader = async () =>
  new Response("Method Not Allowed", { status: 405 });

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!authorized(request)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const run = await runPriceWatch({ trigger: "CRON" });
    return Response.json({
      ok: true,
      runId: run.id,
      succeeded: run.succeeded,
      skipped: run.skipped,
      failed: run.failed,
    });
  } catch (error) {
    if (error instanceof ScrapeAlreadyRunningError) {
      return Response.json(
        { ok: false, error: "A scrape is already running" },
        { status: 409 },
      );
    }
    throw error;
  }
};
