# BracketLab

Combine three bracketed RAW exposures (Sony ARW) into one editable floating-point HDR DNG, plus a tone-mapped JPEG preview. Self-hosted, single container, no cloud services. See [`docs/prd.md`](docs/prd.md) for the full product requirements.

## Status

The app merges for real. Each file is checked with ExifTool as soon as it uploads, so problems show next to the file and Merge stays disabled until the bracket is valid. The worker then merges with HDRMerge into a 16-bit floating-point DNG and renders a 2560px JPEG preview with darktable-cli 5.6.2. Identifying metadata (camera serial, GPS, owner) is stripped from both files. See [`docs/phase-0.md`](docs/phase-0.md) for what's still open before the Phase 0 go/no-go.

| `BRACKETLAB_ENGINE` | Behaviour |
| --- | --- |
| `native` (Docker default) | The real pipeline. Needs `hdrmerge`, `darktable-cli` and `exiftool` on PATH. |
| `unavailable` (default outside Docker) | Jobs fail with "the merge engine isn't installed". |
| `fake` | **Development only.** The "DNG" is a copy of the first input and the preview is a 1×1 placeholder. Use it to exercise the UI and job flow. |

### Batch mode

`/batch` takes a whole shoot at once, for example a real-estate job with a bracket per room:

1. **Upload** every RAW file. Each one's exposure and capture time are read as it arrives.
2. **Matching** (`src/imaging/grouping.ts`) sorts the files by capture time and splits them into sets of three. Each set must pass the single-bracket check (one camera, fixed ISO, aperture and focal length, three distinct shutter speeds) and be shot within a minute. The matcher picks the split that places the most files, then the one with the tightest sets. A stray test shot is left out without shifting every set after it, and both camera bracket mode (frames a fraction of a second apart) and hand bracketing (a few seconds apart) work. Unevenly spaced exposures are flagged for review.
3. **Review**: each set is listed with its files and exposures and an Include checkbox. Files that fit no set are listed with the reason.
4. **Merge**: each included set becomes an ordinary job. One ZIP holds `<first>-<last>.dng` for every finished set, plus `previews/<first>-<last>.jpg`.

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

### Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `dev` and `main`:

- **Lint, typecheck, test, build**: the same commands as above, on Node 22.
- **Docker image and toolchain smoke test**: builds the image (its build stage runs the tests too), runs `smoke-test` to check that HDRMerge, darktable-cli 5.6.2 and ExifTool start headless, then starts the app with the hardened flags and waits for `/api/health`. This catches problems only the image can show, such as darktable's build repository replacing the pinned build.

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
| `POST` | `/api/batches` | Create a batch and set its capability cookie |
| `POST` | `/api/batches/:id/files` | Stream one file into an open batch (`X-Filename` header) |
| `DELETE` | `/api/batches/:id/files/:fileId` | Remove a file from an open batch |
| `GET` | `/api/batches/:id` | Files, proposed sets and unplaced files while open; per-set jobs once submitted |
| `POST` | `/api/batches/:id/submit` | `{ "include": [setKey, ...] }`: merge the reviewed sets |
| `GET` | `/api/batches/:id/download` | ZIP of every finished set |
| `GET` | `/api/batches/:id/sets/:jobId/:kind` | One set's `dng` or `jpeg` |
| `POST` | `/api/batches/:id/sets/:jobId/retry` | Retry a set whose preview failed or that was interrupted |
| `DELETE` | `/api/batches/:id` | Delete the batch, its sets and all their files |

### Configuration

| Variable | Default |
| --- | --- |
| `BRACKETLAB_DATA_DIR` | `./data` |
| `BRACKETLAB_MAX_FILE_MIB` / `BRACKETLAB_MAX_JOB_MIB` | 200 / 600 |
| `BRACKETLAB_MAX_QUEUED_JOBS` | 5 (single brackets; batch sets don't count) |
| `BRACKETLAB_MAX_BATCH_FILES` / `BRACKETLAB_MAX_BATCH_MIB` | 150 / 4096 |
| `BRACKETLAB_MAX_ACTIVE_BATCHES` | 2 (batches merging at once) |
| `BRACKETLAB_RETENTION_HOURS` | 24 |
| `BRACKETLAB_UPLOAD_IDLE_MINUTES` | 60 (abandoned uploads expire) |
| `BRACKETLAB_STAGE_TIMEOUT_SECONDS` | 600 |
| `BRACKETLAB_ENGINE` | `unavailable` (`native` in Docker) |
| `BRACKETLAB_SUPPORTED_MODELS` | `ILCE-6100` (comma-separated; `*` accepts any) |

## Not yet built

- RAW fixture regression tests (they need real a6100 brackets).
