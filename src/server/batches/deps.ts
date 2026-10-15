import { getContext } from "../context";
import type { BatchDeps } from "./service";

export function batchDeps(): BatchDeps {
  const { batches, store, config } = getContext();
  return { batches, jobs: store, config };
}
