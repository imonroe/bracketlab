# BracketLab — Product Requirements Document

**Owner:** Ian Monroe  

### Confirmed user context
- Camera: **Sony a6100**. Actual RAW mode and sample metadata remain to be verified rather than inferred.
- Editing workflow: **darktable and GIMP**. darktable is the primary HDR DNG/RAW editor; GIMP is a subsequent developed-image/retouching destination, not an equivalent test of RAW editing latitude. Document the supported darktable-to-GIMP handoff and bit depth/color profile.
- Intended photographs: predominantly **static tripod shots** for landscapes, real estate, and product photography, plus occasional portraits. Tripod mounting does not freeze foliage, water, clouds, or people; motion limitations remain applicable.
- Implementation owner: **Project Manager** (`project-manager`), who should coordinate the actual implementation and report completion back to Girl Friday for Ian's notification.
- This session currently lacks `message_agent`; no assignment message has been sent and no implementation has begun here.

## 1. Executive summary

A small, self-hosted Next.js web application accepts exactly three exposure-bracketed RAW photographs of the same scene and produces:

1. A downloadable, floating-point HDR DNG for subsequent RAW editing.
2. A downloadable, tone-mapped JPEG preview rendered from that merged DNG.

One screen, one bracket set, one primary action: **Merge exposures**. All processing occurs on the machine running the Docker container. No cloud image service, subscription, GPU, or external account is required.

**Recommended approach:** Next.js/TypeScript for the interface and API; a separate worker process invoking **jcelaya/HDRMerge** for RAW-domain merging and **darktable-cli** for JPEG rendering. Package the web process, worker, and native tools in one Docker image/container, using a mounted volume for job state and temporary files.

**The central constraint:** genuinely editable RAW output makes this a different product from ordinary HDR exposure fusion. Do not demosaic to JPEG, blend images, and call the result RAW. Do not promise a merged Sony ARW: output is DNG.

## 2. Users, problem, and intended value

### Primary user
Ian, processing a three-shot bracket from a Sony camera and wanting a reusable HDR RAW without a heavyweight desktop workflow.

### Secondary users
Photographers running a private instance on a workstation or home server. Other cameras become supported only after representative samples pass the compatibility suite.

### Job to be done
“When I have three bracketed RAW exposures, let me turn them into one editable HDR file and quickly inspect a useful preview, without installing and operating a desktop photo editor.”

### Product principles
- Preserve editing latitude in the DNG; make aesthetic choices only in the preview.
- Make the normal path simple and limitations conspicuous.
- Prefer established imaging tools over inventing a merge algorithm.
- Keep photographs local to the deployment and delete temporary data predictably.
- Design separable web/worker boundaries without building a distributed platform prematurely.

## 3. Terminology and output contract

**RAW input:** camera sensor data plus camera metadata. Sony ARW is the initial priority, not a universal compatibility guarantee.

**HDR RAW output:** a new merged floating-point DNG retaining supported sensor mosaic data. It is a computational derivative, not an untouched original exposure and not an archival replacement for all three source files.

**Default encoding proposal:** DNG 1.4, 16-bit floating-point samples, not 16-bit integer. HDRMerge documents 16/24/32-bit floating-point outputs and recommends 16-bit for most situations. Validate 16-bit quality on the acceptance corpus; use 32-bit as an internal comparison/reference option. Do not expose bit-depth controls in the MVP unless testing demonstrates a user need.

**JPEG preview:** standard 8-bit sRGB, tone-mapped for ordinary displays, maximum 2560 pixels on the long edge, no upscaling, proposed JPEG quality 90. The JPEG does not preserve the DNG's dynamic range and is not an HDR-display/gain-map JPEG. Its appearance is an interpretation, not a guarantee of matching Lightroom, Capture One, or a camera JPEG.

**Embedded preview:** optional. A separate JPEG is required. HDRMerge can embed a preview, but that preview must not be mistaken for the separately rendered, approved JPEG. Disable embedded previews initially or validate their appearance explicitly; do not make DNG preview rewriting an MVP dependency.

## 4. MVP scope

### Included
- Exactly three files per job; one bracket set at a time.
- Sony ARW from a documented, tested model/RAW-mode list.
- Validation of file integrity, camera compatibility, and bracket metadata.
- Automatic exposure ordering, RAW-domain merge, supported small-translation alignment, and common-area cropping.
- One fixed, versioned natural-looking JPEG rendering recipe.
- Upload progress, processing stages, durable status, cancellation, errors, downloads, and deletion.
- Single-container deployment with persistent volume and automatic retention cleanup.

### Explicitly excluded
- General automatic deghosting or manual mask editing.
- Reliable correction of camera rotation, perspective differences, parallax, lens zoom, or focus changes.
- Batch bracket discovery, albums, editing sliders, presets gallery, panoramic stitching, focus stacking, video, or AI enhancement.
- ARW output; treating TIFF/OpenEXR as equivalent to a RAW DNG.
- Multi-tenant accounts, billing, public anonymous uploads, or cloud storage integrations.
- Serverless-only deployment and browser-side RAW processing.
- Guaranteed support for every format that LibRaw can decode.

**Capture guidance shown before upload:** use a tripod and a static subject; keep camera, aperture, ISO, focus, focal length, and RAW mode fixed; vary shutter speed. Moving foliage, people, water, or clouds may ghost. The application cannot reliably detect every such case.

## 5. Functional requirements

### F1 — Upload
- Drag/drop or file picker with three visible slots; keyboard accessible.
- Accept selection in any order. Show filenames, byte sizes, and upload status; permit replacement before submission.
- Enforce exactly three complete files before queueing.
- Initial configurable limits: 200 MiB/file, 600 MiB/job, 100 megapixels/input. These are proposed safeguards, not measured capacity guarantees.
- Stream each upload to disk; do not load three RAW files into the Node heap with `request.formData()` or whole-file buffers.
- Count bytes during transfer rather than trusting Content-Length. Reject oversize files early and clean partial uploads.
- Interrupted uploads can be retried; resumable/chunked upload protocol is not required in v1.

### F2 — Preflight validation
- Verify the actual decodable format; extension and browser MIME type alone are insufficient.
- Compute checksums and reject duplicate source files.
- Require supported camera/model and RAW mode, matching sensor dimensions, orientation, CFA layout, and compatible black/white levels.
- Require fixed aperture and ISO and three distinct shutter exposures. Reject ambiguous/missing exposure metadata in v1 with an actionable explanation rather than guessing.
- Sort by effective exposure; display the measured bracket spacing. Recommend ±2 EV capture, but do not require symmetric spacing.
- Reject known differing focal lengths; warn that metadata cannot establish identical focus or a static scene.
- Warn about large capture-time gaps when timestamps exist. Missing timestamps alone are not a failure.
- Treat native decoder/merger rejection as authoritative even if initial metadata checks passed.
- Show a permanent motion/alignment limitation notice, not an unsupported “ghost-free” quality score.

### F3 — Merge
- Merge original RAW sensor data before demosaicing, using the pinned HDRMerge engine.
- Enable supported alignment and common-area crop by default. No general geometric image warping in this pipeline.
- Preserve usable color interpretation and RAW calibration metadata; validate output by decoding it, not merely checking its extension or existence.
- Do not claim recovery where all three inputs are clipped, or perfect noise elimination.
- Record input hashes, versions, options, exposure ordering, output dimensions, and any available crop/alignment diagnostics in a job manifest.
- Do not invent detailed diagnostics that the engine does not expose. Additional instrumentation requires a separate feasibility decision.

### F4 — Preview
- Decode the merged DNG and render a JPEG with a pinned darktable version and controlled configuration/recipe.
- Apply a repeatable white-balance policy and explicit sRGB output; validate scene-referred tone mapping across test scenes rather than relying on arbitrary workstation defaults.
- Never substitute an input camera's embedded JPEG for the merged result.
- Preview failure must not destroy a valid DNG: expose “RAW ready; preview failed,” allow the DNG download, and offer preview retry.
- Disclose that exposure/color adjustments remain available in an external RAW editor.

### F5 — Status and controls
- States: uploading → validating → queued → merging → rendering_preview → complete.
- Additional states: raw_ready_preview_failed, failed, canceled, expired.
- Report real stages and elapsed time; avoid fictional processing percentages. Actual upload percentage is appropriate.
- Refresh/reconnect restores access to the job while the browser retains its capability/session token.
- Cancel terminates the native process group, prevents publication of partial outputs, and cleans temporary files.
- Download DNG and JPEG independently. ZIP download is optional, not a launch requirement.
- Display expiration time and a Delete now action. Starting another job does not silently delete an existing result.

## 6. User flow

1. Open the single-page application and see privacy, retention, format, and static-scene guidance.
2. Select three files; upload them with per-file progress.
3. Review detected camera and bracket spacing; resolve validation errors or acknowledge warnings.
4. Click **Merge exposures**.
5. Observe queue/stage status; cancellation remains available.
6. Inspect the merged JPEG and output details.
7. Download **HDR RAW (.dng)** and **JPEG preview (.jpg)**.
8. Delete the job immediately or let retention cleanup remove it.

If preview rendering fails, step 6 instead explains the partial success and retains the valid DNG. If merging fails, provide a readable cause and retry/capture guidance, not a raw subprocess traceback.

## 7. Recommended technical architecture

### Runtime components
- **Next.js App Router + TypeScript:** UI, job APIs, streaming uploads and downloads. Node runtime, not Edge.
- **Node worker process:** claims jobs transactionally and supervises native subprocesses outside HTTP request lifetimes.
- **SQLite:** durable single-instance queue and job state; no Redis for MVP.
- **Filesystem volume:** per-job inputs, intermediate artifacts, outputs, logs, and manifest.
- **HDRMerge:** RAW merge engine, built/pinned with a verified compatible LibRaw version.
- **darktable-cli:** headless DNG-to-JPEG renderer with isolated job configuration/cache/library paths.
- **Metadata inspection:** ExifTool and decoder validation as needed; do not assume metadata extraction proves RAW decoding support.

### Processing boundary

Browser → Next.js upload/API → disk + SQLite queue → worker → HDRMerge → validated DNG → darktable-cli → JPEG → download API.

One image and one container can run both web and worker under a small process supervisor. A PID 1 init alone is not a service supervisor. Shutdown must reach all children; readiness must fail if the worker dies. Keep role-specific entrypoints so a later release can run the same image as separate web/worker containers without redesigning the imaging interface.

### Proposed API surface
- `POST /api/jobs`: create job and browser-bound access capability.
- `PUT /api/jobs/:id/inputs/:slot`: stream one of three inputs.
- `POST /api/jobs/:id/start`: validate/queue idempotently.
- `GET /api/jobs/:id`: status and artifact availability; poll around every two seconds during active work.
- `POST /api/jobs/:id/cancel`: cancel processing.
- `GET /api/jobs/:id/artifacts/:kind`: stream authorized DNG or JPEG download.
- `POST /api/jobs/:id/retry-preview`: retry only the failed rendering stage.
- `DELETE /api/jobs/:id`: delete job and artifacts.

All operations verify access ownership/capability. An opaque job ID alone is not authorization. Do not place authorization tokens in query strings or logs.

### Proposed repository boundaries
- `src/app/`: UI and HTTP handlers.
- `src/server/jobs/`: database, state transitions, retention, authorization.
- `src/server/storage/`: bounded streaming IO and safe paths.
- `src/worker/`: queue consumer and subprocess lifecycle.
- `src/imaging/`: engine adapter, diagnostics parsing, artifact validation.
- `imaging/`: pinned renderer recipe and native dependency/build definitions.
- `tests/`: API, worker, browser, and RAW-fixture tests.
- `Dockerfile`, `compose.yaml`, `docs/`: packaging and operation instructions.

These are architectural boundaries, not a mandate to add generic plugin frameworks or a Python service.

## 8. Tool choice and alternatives

### Recommended: jcelaya/HDRMerge
Its documented output is floating-point DNG, and its merge operates on RAW data. Its CLI supports alignment, crop, sample depth, and embedded-preview controls. This is a close functional match.

**Important limits:** the manual describes small translations, not rotations, and GUI mask editing for moving objects. The CLI lacks those interactive editing tools. Documentation/release history is old enough to make modern compiler, headless Qt, camera support, and dependency compatibility explicit feasibility gates. Do not label it abandoned or production-ready without further evidence.

### darktable-cli
Documented console-only RAW rendering makes it a strong JPEG candidate. Its versioned processing behavior and configuration isolation matter; merely invoking it does not guarantee a good-looking preview. RawTherapee CLI is the fallback candidate if the chosen DNG/renderer combination fails the visual or compatibility tests.

### Why not FFmpeg?
Excellent for audiovisual conversion, but not the right center of a camera-RAW HDR merge workflow. DNG decoding support is not equivalent to calibrated RAW merging, reliable color rendering, and floating-point DNG writing. No FFmpeg dependency is justified by this MVP.

### Why not OpenCV / exposure fusion?
Useful for developed-image alignment or RGB HDR algorithms, but would require substantial custom RAW calibration, CFA handling, output writing, and validation to satisfy this product. Enfuse-style exposure fusion generally solves a different output problem.

### Other HDRMerge project
`wjakob/hdrmerge` is a separate scientific tool producing OpenEXR and assuming aligned frames. Do not confuse it with the proposed DNG-producing `jcelaya/hdrmerge`.

## 9. Deployment and operational requirements

- Provide a multi-stage Debian/Ubuntu-based image; prefer native-library compatibility over an aggressively tiny Alpine image.
- Ship pinned dependency versions/checksums and build/source provenance. Confirm any required headless Qt setup in the feasibility spike.
- Start with Linux amd64; Docker Desktop on Windows can run this image. ARM64 is a separate tested compatibility target, not an automatic claim.
- One mounted `/data` volume, one exposed HTTP port, no database service, GPU, host display, or privileged container.
- Local example binds to loopback. Remote access requires an authenticated TLS reverse proxy/private-access boundary; anonymous public exposure is unsupported.
- Default worker concurrency: one. Proposed maximum queue: five jobs. Apply admission control by both queue depth and reserved disk budget.
- Proposed deployment envelope: 4 CPU cores, 8 GiB container memory, at least 10 GiB free working space; benchmark before declaring these sufficient. High-resolution RAW buffers may multiply memory requirements far beyond compressed upload size.
- Configure native thread counts, subprocess deadlines (initial proposal: ten minutes per processing stage), memory/CPU ceilings, and disk thresholds.
- Default retention proposal: inputs and intermediates removed after full success; partial-success inputs retained for preview recovery only as needed; all remaining job artifacts expire within 24 hours. Failed/canceled uploads cleaned promptly. A periodic janitor and startup reconciliation handle abandoned files.
- Interrupted active jobs after restart become failed/interrupted with retry available; queued jobs survive. Do not blindly duplicate native work.
- Logs include job IDs, durations, stage, exit status, engine versions, and resource failures, not image data, GPS, tokens, or unrestricted metadata dumps.

## 10. Security, privacy, and licensing

- Treat image decoders as an untrusted-file attack surface: non-root, read-only root filesystem where practical, limited writable paths, dropped capabilities, no Docker socket, no host home-directory mounts.
- Use generated internal filenames and subprocess argument arrays; never shell-interpolate upload names or accept user-supplied native-tool flags.
- Reject path traversal, excessive dimensions, malformed inputs, and upload abuse; enforce request and disk quotas at application and proxy layers.
- Child imaging tools need no network access. Full hostile multi-tenant sandboxing is out of scope; do not market a single shared container as strong isolation between public users.
- Keep optical/color metadata necessary for rendering. Strip location and identifying metadata from JPEGs. Verify the DNG metadata policy during feasibility: remove GPS/serial/owner identifiers without damaging calibration, or clearly disclose any retained identifiers before release.
- No analytics upload, external photo API, or runtime model download.
- HDRMerge is GPLv3. Review obligations for distributing its binary and modifications within the Docker image; provide applicable notices, corresponding source, and build instructions. Separate-process use is an architectural choice, not an automatic legal exemption. Review all bundled dependencies as well.

## 11. Acceptance criteria and success measures

### Functional release tests
- Valid supported stationary brackets produce both artifacts in every curated acceptance case.
- Wrong counts, duplicates, mixed cameras/modes, inconsistent dimensions/ISO/aperture, corrupt files, missing exposure metadata, and oversize inputs fail clearly.
- A sample with clipped middle-exposure highlights but usable short-exposure detail retains recoverable detail in the output; compare against the original frames under controlled rendering.
- Inspect shadow noise, color casts, clipping, seam artifacts, and crop behavior at 100%; include small shifts and intentional rotation/motion examples to document limitations.
- JPEGs have correct orientation, approved sRGB rendering, bounded dimensions, and no GPS/identity metadata.
- Preview failure preserves the DNG and preview retry does not re-merge unnecessarily.
- Browser refresh, canceled upload, cancellation during native work, container restart, timeout, full disk, and memory exhaustion leave consistent state and no published partial files.
- Unauthorized artifact access is denied; delete/expiry removes all associated files; queued jobs cannot exceed admission limits.
- Full browser flow works in current Chrome/Edge and Firefox; keyboard navigation and status announcements meet practical WCAG 2.2 AA requirements.

### Proposed performance targets, not benchmark results
- For a three-frame 24–33 MP supported bracket on the defined 4-core/8-GiB test host: target p95 processing under two minutes, excluding upload and queue wait.
- Status/control APIs remain responsive during a merge; target p95 under 500 ms on that host.
- No unbounded heap growth with input upload size; one active native job stays within the tested memory ceiling.
- Track acceptance-corpus success rate, processing time by resolution, peak resources, and failure reasons locally. No telemetry infrastructure is needed for v1.

## 12. Delivery sequence

**Phase 0 — Imaging feasibility:** real samples, camera/editor compatibility, native headless execution, quality and resource measurements. Go/no-go decision.

**Phase 1 — Vertical slice:** three uploads → persistent job → worker → DNG/JPEG → downloads inside the single container.

**Phase 2 — Reliability and safety:** validation, quotas, cancellation, restart recovery, retention, access control, licensing and metadata checks.

**Phase 3 — Release polish:** accessible single-screen UX, concise limitations, fixture regression suite, reproducible image build, deployment/runbook documentation.

No implementation or native image-processing benchmark was completed for this PRD. Recommendations are supported by upstream documentation; container, camera, output quality, and editor compatibility remain to be demonstrated.

## 13. Deferred enhancements

- More RAW models/formats after fixtures pass.
- Multiple bracket sets and automatic bracket grouping.
- Full-resolution JPEG export and preview-only exposure adjustments.
- Improved alignment or deghosting, potentially requiring a different merge pipeline and revised RAW-output contract.
- User accounts, external queue/storage, multi-worker deployment, and stronger job sandboxing for public hosting.
- Embedded preview matching the separate JPEG, if justified by actual editor/browser behavior.

## 14. Confirmed decisions and remaining feasibility inputs

1. **Camera confirmed: Sony a6100.** Inspect representative files to establish the actual RAW mode and dimensions; do not assume the camera offers every RAW mode listed in the original draft.
2. **Editors confirmed: darktable and GIMP.** Confirm the darktable version used for DNG acceptance. Test/document GIMP's supported developed-image handoff separately; do not treat GIMP as a substitute RAW-editor compatibility test.
3. **Capture style confirmed: mostly static tripod shots.** Landscapes, real estate, product photography, and occasional portraits. Preserve motion warnings for foliage, water, clouds, and people; automatic portrait deghosting is not added to scope.
4. **Floating-point DNG remains the proposed RAW deliverable.** Merged ARW is not proposed; escalate if the implementation requires changing that output contract.
5. **2560-pixel JPEG preview remains the default proposal.** Full-resolution JPEG export was not explicitly requested.

## 15. Research references

1. [HDRMerge repository and license](https://github.com/jcelaya/hdrmerge) — floating-point DNG output, RAW-domain merge, output depth, GPLv3.
2. [HDRMerge manual](https://jcelaya.github.io/hdrmerge/documentation/2014/05/24/using-hdrmerge.html) — compatibility checks, alignment limitations, motion-mask editing, CLI switches and previews. Full manual inspected; old documentation is a reason to verify the selected build.
3. [HDRMerge releases](https://github.com/jcelaya/hdrmerge/releases) — select and audit a pinned release/commit during feasibility; no latest-version claim made here.
4. [darktable-cli documentation](https://docs.darktable.org/usermanual/development/en/special-topics/program-invocation/darktable-cli/) — headless rendering, output sizing, ICC configuration and JPEG quality. This is development documentation; verify flags against the pinned released binary.
5. [LibRaw camera support](https://www.libraw.org/supported-cameras) and [Sony lossless-compression support announcement](https://www.libraw.org/news/libraw-202110-snapshot) — support varies by version and camera/mode; decoder support alone does not prove the entire pipeline.
6. [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting) and [deployment options](https://nextjs.org/docs/app/getting-started/deploying) — Docker/Node deployment, reverse-proxy and streaming considerations.
7. [Scientific HDRMerge, a different project](https://github.com/wjakob/hdrmerge) — OpenEXR output and prealigned-input assumptions distinguish it from the recommended engine.
