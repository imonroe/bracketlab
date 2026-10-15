#!/bin/bash
# Phase 0 toolchain check. Run inside the image:
#
#   docker run --rm bracketlab smoke-test
#       Checks that every native tool starts headless and reports its version.
#
#   docker run --rm -v "$PWD/brackets:/in:ro" bracketlab smoke-test /in/a.ARW /in/b.ARW /in/c.ARW
#       Also merges the files with HDRMerge, renders the DNG with darktable-cli, and
#       checks both outputs. Outputs go to $SMOKE_OUT (default: a temp dir, deleted).
#
# Exit status is non-zero on the first failure.
set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }
warn() { echo "WARN: $*"; }
step() { echo; echo "== $*"; }

out="${SMOKE_OUT:-}"
if [ -z "$out" ]; then
  out="$(mktemp -d)"
  trap 'rm -rf "$out"' EXIT
fi
mkdir -p "$out"

# The service user has no home directory. Give the tools a scratch one so Qt,
# fontconfig and darktable have somewhere to write, as the worker will per job.
export HOME="$out/home" XDG_RUNTIME_DIR="$out/home/run"
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"

step "Tool versions"
echo "node:        $(node --version)"
hdrmerge --help > /dev/null 2>&1 || fail "hdrmerge --help did not run"
echo "hdrmerge:    ${HDRMERGE_COMMIT:-unknown commit}"
dt_version="$(darktable-cli --version 2>&1 | head -1)"
echo "darktable:   $dt_version"
[ "$dt_version" = "darktable ${DARKTABLE_VERSION%%-*}" ] \
  || fail "expected darktable ${DARKTABLE_VERSION%%-*}, got: $dt_version"
echo "exiftool:    $(exiftool -ver)"
echo "libraw:      $(dpkg-query -W -f='${Version}' 'libraw23*' 2>/dev/null)"
test -f "/usr/share/bracketlab/sources/hdrmerge-${HDRMERGE_COMMIT}.tar.gz" \
  || fail "HDRMerge corresponding source archive is missing"

if [ "$#" -eq 0 ]; then
  echo; echo "OK (no input files given; skipped the merge and render check)"
  exit 0
fi


step "Inputs"
exiftool -s -s -s -T -FileName -Model -ISO -FNumber -ExposureTime -FocalLength "$@"


step "Merge with HDRMerge (16-bit float DNG, no embedded preview)"
start=$(date +%s)
hdrmerge -v -p none -b 16 -o "$out/merged.dng" "$@"
echo "merge took $(( $(date +%s) - start ))s"
test -s "$out/merged.dng" || fail "HDRMerge wrote no DNG"

step "Check the DNG"
exiftool -s -DNGVersion -Make -Model -ImageWidth -ImageHeight -BitsPerSample \
  -SampleFormat -PhotometricInterpretation -CFAPattern2 -ColorMatrix1 "$out/merged.dng" \
  | tee "$out/dng-tags.txt"
grep -q 'SampleFormat.*Float' "$out/dng-tags.txt" || fail "DNG samples are not floating point"
grep -q 'PhotometricInterpretation.*Color Filter Array' "$out/dng-tags.txt" \
  || fail "DNG is not CFA (mosaic) data"

step "Render with darktable-cli (2560px JPEG, isolated config)"
dt="$out/darktable"
mkdir -p "$dt/config" "$dt/cache"
start=$(date +%s)
darktable-cli "$out/merged.dng" "$out/preview.jpg" \
  --width 2560 --height 2560 --hq true --upscale false \
  --apply-custom-presets false \
  --core --configdir "$dt/config" --cachedir "$dt/cache" --library :memory: \
  --disable-opencl \
  --conf plugins/imageio/format/jpeg/quality=90
echo "render took $(( $(date +%s) - start ))s"
test -s "$out/preview.jpg" || fail "darktable-cli wrote no JPEG"

step "Check the JPEG"
exiftool -s -ImageWidth -ImageHeight -ColorSpace -ProfileDescription "$out/preview.jpg"
width=$(exiftool -s -s -s -ImageWidth "$out/preview.jpg")
height=$(exiftool -s -s -s -ImageHeight "$out/preview.jpg")
[ "$width" -le 2560 ] && [ "$height" -le 2560 ] || fail "JPEG is ${width}x${height}, over 2560px"

# These are the raw tool outputs. The app strips both files (src/imaging/native.ts).
step "Identifying metadata in the raw tool output (the app strips it)"
for f in "$out/merged.dng" "$out/preview.jpg"; do
  found=$(exiftool -a -G1 -s -GPS:all -SerialNumber -InternalSerialNumber -LensSerialNumber \
    -OwnerName -Artist "$f" | grep -v ': *$' || true)
  if [ -n "$found" ]; then
    warn "$(basename "$f") carries identifying tags:"
    echo "$found" | sed 's/^/      /'
  else
    echo "$(basename "$f"): none found"
  fi
done

echo; echo "OK"
