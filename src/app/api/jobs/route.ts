import { getContext } from "@/server/context";
import { json } from "@/server/http";
import { buildJobCookie } from "@/server/jobs/auth";
import { createJob, toPublicJob } from "@/server/jobs/service";

/** Creates an empty job and hands the browser its capability cookie. */
export async function POST(request: Request) {
  const { store, config } = getContext();
  const { job, token } = createJob(store, config);
  return json(toPublicJob(store, config, job), {
    status: 201,
    headers: { "set-cookie": buildJobCookie(request, job.id, token, config.retentionMs) },
  });
}
