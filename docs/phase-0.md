# Phase 0: imaging feasibility

Status: **toolchain proven in the container; merge quality untested.** The go/no-go decision needs real a6100 brackets.

## Toolchain

| Component | Version | Source |
| --- | --- | --- |
| HDRMerge | upstream master `2dbfd7d` (July 2026) | Built from source in the image. The last tagged release, v0.5.0, dates from 2015. Debian's package is a 2020 snapshot that predates the LibRaw 0.21 and Exiv2 0.28 fixes. |
| LibRaw | 0.21.4 (Debian 13) | System library linked by HDRMerge. |
| darktable | 5.6.2 | Official openSUSE Build Service repository, so it matches the desktop version used for acceptance. Debian 13 ships 5.0.1. |
| ExifTool | 13.25 (Debian 13) | |
| Node.js | 22 | Copied from the pinned `node:22-trixie-slim` image. |

Base images are pinned by digest in the `Dockerfile`. The darktable repository key is checked against its fingerprint before use.

## How to check it

```sh
docker build -t bracketlab .
docker run --rm bracketlab smoke-test                         # tools start and report versions
docker run --rm -v "$PWD/brackets:/in:ro" bracketlab smoke-test /in/1.ARW /in/2.ARW /in/3.ARW
```

The second form merges the files, renders the DNG, and checks both outputs. Set `SMOKE_OUT` and mount a writable directory to keep the files.

## Findings so far

Tested with one public a6100 sample (`DSC00033.ARW` from raw.pixls.us, CC0), passed three times. A single exposure proves the tools decode, run and write valid files. It says nothing about merge quality.

1. **a6100 ARW decodes.** LibRaw reads it as 6024x4024, 14-bit (saturation 16383, black 512), RGGB.
2. **HDRMerge runs headless.** It links Qt Widgets and constructs a `QApplication` even in CLI mode, so it aborts without a display unless `QT_QPA_PLATFORM=offscreen` is set. With that set, it needs no X server.
3. **The DNG looks right structurally.** DNG 1.4, 16-bit floating-point samples, CFA (mosaic) data, the camera colour matrix, and lens metadata all survive. The merge took 2 to 4 seconds on this host.
4. **darktable-cli renders it headless.** About 5 seconds for a 2560px sRGB JPEG with an isolated config directory, an in-memory library and OpenCL disabled. The result has correct colour and orientation.
5. **The tools need a writable HOME.** The service user has none. The worker must give each native process a scratch HOME and `XDG_RUNTIME_DIR` inside the job folder.
6. **Privacy gap.** Both the DNG and the JPEG keep the camera's `InternalSerialNumber`. This sample has no GPS, so location tags are still unchecked. PRD section 10 requires stripping identifiers from the JPEG and a decision for the DNG.
7. **Visible vignetting at 16mm.** darktable's defaults apply no lens correction. The DNG carries the lens model, so lens correction is possible. Whether the preview recipe should apply it is an open question.
8. **HDRMerge white level.** With identical inputs it reported "Using white level 3445" rather than the sensor's 16383. That may be an artifact of feeding it the same exposure three times. Check it on a real bracket.

## Still needed for a go/no-go

- [ ] Three or more real a6100 brackets (±2 EV, tripod), including one with clipped highlights in the middle exposure.
- [ ] Open the merged DNGs in darktable 5.6.2 on the desktop and confirm highlight recovery and editing latitude.
- [ ] Compare 16-bit and 32-bit float output on the clipped-highlight scene.
- [ ] Decide the preview recipe: lens correction, exposure and tone mapping defaults.
- [ ] Decide the DNG metadata policy and strip identifiers from the JPEG.
- [ ] Measure peak memory and time for a full-resolution bracket inside the 4-core, 8 GiB limit.

## Container notes

- One image runs both processes under `tini` and a small bash supervisor (`docker/entrypoint.sh`). If either the web server or the worker exits, the container exits with that status so the restart policy recovers both. A requested stop exits 0.
- `compose.yaml` binds to 127.0.0.1, runs as a non-root user with a read-only root filesystem, drops all capabilities, and sets `no-new-privileges`.
- The image is about 1.6 GB, mostly darktable and its GTK dependencies.
- HDRMerge is GPLv3. The image ships the exact source it was built from at `/usr/share/bracketlab/sources/`. A full licensing review of bundled dependencies is still a Phase 2 task.
