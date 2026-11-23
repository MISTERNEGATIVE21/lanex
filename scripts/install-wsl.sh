#!/usr/bin/env bash
# install-wsl.sh — back-compat entry point. The real installer is install.sh
# (universal: any major Linux distro, WSL2, macOS); this URL/name is kept
# working forever because it is baked into older READMEs and guides:
#
#   curl -fsSL https://raw.githubusercontent.com/lanex-eda/lanex/main/scripts/install-wsl.sh | bash
#
# Runs the exact sibling script when executed from a checkout, otherwise fetches
# the install.sh of the release below and runs it. The whole body is in main(),
# called on the last line, so a partly downloaded copy never runs half of it.
set -u -o pipefail

# Same stamp as install.sh (scripts/stamp_release_ref.py writes both).
LANEX_RELEASE_REF="main"

fail() { printf '%s\n' "$@" >&2; exit 1; }

main() {
    local here repo ref url tmp rc
    here="$(cd "$(dirname "${BASH_SOURCE[0]:-/}")" 2>/dev/null && pwd || true)"
    if [ -n "$here" ] && [ -f "$here/install.sh" ] && [ "${BASH_SOURCE[0]:-}" = "$0" ]; then
        exec bash "$here/install.sh" "$@"
    fi

    repo="${LANEX_REPO:-lanex-eda/lanex}"
    ref="${LANEX_REF:-$LANEX_RELEASE_REF}"
    url="https://raw.githubusercontent.com/${repo}/${ref}/scripts/install.sh"
    # To a file, then run it: passing the download inline to bash -c ran an empty script and
    # exited 0 when the download failed, and it breaks once install.sh grows
    # past Linux's 128 KiB limit for one argument.
    tmp="$(mktemp 2>/dev/null || mktemp -t lanex-install)" \
        || fail "Could not create a temporary file for the LanEx installer (is /tmp full?)."
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 180 -o "$tmp" "$url"
        rc=$?
    elif command -v wget >/dev/null 2>&1; then
        wget -q -T 30 -t 3 -O "$tmp" "$url"
        rc=$?
    else
        rm -f "$tmp"
        fail "Need curl or wget to fetch the LanEx installer:" "  $url" \
            "Install one of them (for example: sudo apt install curl), then run this again."
    fi
    if [ "$rc" -ne 0 ] || [ ! -s "$tmp" ] || ! tail -n 1 "$tmp" | grep -q '^main "\$@"'; then
        rm -f "$tmp"
        fail "Could not download the LanEx installer (exit code ${rc}) from:" "  $url" \
            "Check the internet connection, a proxy or VPN, and LANEX_REF / LANEX_REPO if you set them," \
            "then run this again. Nothing was installed."
    fi
    LANEX_BOOTSTRAPPED=1 LANEX_REF="$ref" bash "$tmp" "$@"
    rc=$?
    rm -f "$tmp"
    exit "$rc"
}

main "$@"
