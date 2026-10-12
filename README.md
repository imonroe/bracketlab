# BracketLab

Combine three bracketed RAW exposures (Sony ARW) into one editable floating-point HDR DNG, plus a tone-mapped JPEG preview. Self-hosted, single container, no cloud services. See [`docs/prd.md`](docs/prd.md) for the full product requirements.

## Status

The app merges for real. Each file is checked with ExifTool as soon as it uploads, so problems show next to the file and Merge stays disabled until the bracket is valid. The worker then merges with HDRMerge into a 16-bit floating-point DNG and renders a 2560px JPEG preview with darktable-cli 5.6.2. Identifying metadata (camera serial, GPS, owner) is stripped from both files. See [`docs/phase-0.md`](docs/phase-0.md) for what's still open before the Phase 0 go/no-go.

| `BRACKETLAB_ENGINE` | Behaviour |
| --- | --- |
| `native` (Docker default) | The real pipeline. Needs `hdrmerge`, `darktable-cli` and `exiftool` on PATH. |
| `unavailable` (default outside Docker) | Jobs fail with "the merge engine isn't installed". |
| `fake` | **Development only.** The "DNG" is a copy of the first input and the preview is a 1×1 placeholder. Use it to exercise the UI and job flow. |

## Running with Docker

```sh
docker compose up --build        # http://127.0.0.1:3000
docker run --rm bracketlab smoke-test                          # check the toolchain
docker run --rm -v "$PWD/brackets:/in:ro" bracketlab smoke-test /in/1.ARW /in/2.ARW /in/3.ARW
```

The image runs the web server and worker together by default. `web` and `worker` commands run either one alone against a shared `/data` volume.

## Development

Requires Node.js 22+.

```sh
npm install
npm run dev                              # web app on http://localhost:3000
BRACKETLAB_ENGINE=fake npm run dev:worker   # queue worker, in a second terminal
```

Both processes share the data directory (default `./data`, override with `BRACKETLAB_DATA_DIR`).

```sh
npm test          # unit and API tests (node:test via tsx)
npm run typecheck
npm run lint
npm run build     # Next.js standalone server + dist/worker.mjs
```

## How it fits together

```
Browser ──► Next.js route handlers ──► disk + SQLite queue ──► worker ──► imaging engine
   ▲                                                              │
   └──────────────── status polling and downloads ◄───────────────┘
```

- **Web process** (`src/app/`): one page plus the job API. Uploads stream straight to disk and are metered byte by byte, so RAW files never sit in memory.
- **Worker** (`src/worker/`): claims queued jobs one at a time, runs native tools in their own process group with deadlines, watches for cancellation, and publishes outputs only after they pass validation. On startup, it marks interrupted jobs as failed but retryable. A janitor enforces retention.
- **Job model** (`src/server/jobs/`): SQLite in WAL mode. Every state change is compare-and-swap, so a cancel from the browser can't race the worker into an inconsistent state.
- **Access control**: each job gets a random capability token, held by the browser in an HttpOnly, SameSite=Strict cookie scoped to that job's API path. Only its hash is stored. Requests without it get 404.

### Job states

```
uploading → validating → queued → merging → rendering_preview → complete
                                                       └──→ raw_ready_preview_failed → (retry) queued
plus: failed, canceled, expired
```

### API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/jobs` | Create a job and set its capability cookie |
| `PUT` | `/api/jobs/:id/inputs/:slot` | Stream one file into slot 0, 1 or 2 (`X-Filename` header for display) |
| `POST` | `/api/jobs/:id/start` | Validate and queue (idempotent; also retries retryable failures) |
| `GET` | `/api/jobs/:id` | Status, inputs, artifacts, queue position |
| `POST` | `/api/jobs/:id/cancel` | Cancel; kills any running native process |
| `POST` | `/api/jobs/:id/retry-preview` | Re-render the JPEG without re-merging |
| `GET` | `/api/jobs/:id/artifacts/:kind` | Download `dng` or `jpeg` |
| `DELETE` | `/api/jobs/:id` | Delete the job and all its files |
| `GET` | `/api/health` | Readiness; fails if the worker heartbeat goes stale |

### Configuration

| Variable | Default |
| --- | --- |
| `BRACKETLAB_DATA_DIR` | `./data` |
| `BRACKETLAB_MAX_FILE_MIB` / `BRACKETLAB_MAX_JOB_MIB` | 200 / 600 |
| `BRACKETLAB_MAX_QUEUED_JOBS` | 5 |
| `BRACKETLAB_RETENTION_HOURS` | 24 |
| `BRACKETLAB_UPLOAD_IDLE_MINUTES` | 60 (abandoned uploads expire) |
| `BRACKETLAB_STAGE_TIMEOUT_SECONDS` | 600 |
| `BRACKETLAB_ENGINE` | `unavailable` (`native` in Docker) |
| `BRACKETLAB_SUPPORTED_MODELS` | `ILCE-6100` (comma-separated; `*` accepts any) |

## Not yet built

- RAW fixture regression tests (they need real a6100 brackets).
