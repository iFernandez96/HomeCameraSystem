#!/usr/bin/env bash
# Download one immutable artifact, verify its SHA-256, then replace DEST.

set -euo pipefail

if [ "$#" -ne 3 ]; then
    echo "Usage: $0 URL EXPECTED_SHA256 DEST" >&2
    exit 2
fi

url=$1
expected_sha256=$2
dest=$3

case "$expected_sha256" in
    *[!0-9a-f]*|'')
        echo "Invalid expected SHA-256 for $url" >&2
        exit 2
        ;;
esac
if [ "${#expected_sha256}" -ne 64 ]; then
    echo "Invalid expected SHA-256 length for $url" >&2
    exit 2
fi

mkdir -p "$(dirname "$dest")"
tmp=$(mktemp "${dest}.download.XXXXXX")
cleanup() { rm -f "$tmp"; }
trap cleanup EXIT HUP INT TERM

curl -fsSL "$url" -o "$tmp"
actual_sha256=$(sha256sum "$tmp" | awk '{print $1}')
if [ "$actual_sha256" != "$expected_sha256" ]; then
    echo "SHA-256 verification failed for $url" >&2
    echo "Expected: $expected_sha256" >&2
    echo "Actual:   $actual_sha256" >&2
    exit 1
fi

mv -f "$tmp" "$dest"
trap - EXIT HUP INT TERM
