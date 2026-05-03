#!/usr/bin/env bash
# find-jetson.sh — locate a headless Nvidia Jetson on the LAN.
#
# Strategy:
#   1. Try mDNS (`*.local`) — JetPack ships avahi by default.
#   2. If nothing answers, port-22 sweep the local /24 with nmap.
#   3. ssh-keyscan each candidate so you can see the SSH banner; flag the
#      ones that look Jetson-like (Ubuntu / Tegra / Jetson in the version).
#
# Usage:
#   ./scripts/find-jetson.sh
#   ./scripts/find-jetson.sh 192.168.1.0/24      # explicit subnet
#   ./scripts/find-jetson.sh my-host.local       # single hostname / IP probe

set -euo pipefail

# ---------- pretty printing ----------
if [[ -t 1 ]]; then
  CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
  RED='\033[0;31m'; DIM='\033[2m'; BOLD='\033[1m'; NC='\033[0m'
else
  CYAN=''; GREEN=''; YELLOW=''; RED=''; DIM=''; BOLD=''; NC=''
fi
log()   { printf "${CYAN}==>${NC} %s\n" "$*"; }
ok()    { printf "${GREEN}✓${NC}  %s\n" "$*"; }
warn()  { printf "${YELLOW}!${NC}  %s\n" "$*"; }
err()   { printf "${RED}✗${NC}  %s\n" "$*" >&2; }

# ---------- usage ----------
if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  awk 'NR==1 && /^#!/ {next} /^#/ {sub(/^# ?/, ""); print; next} {exit}' "$0"
  exit 0
fi

# ---------- candidate mDNS hostnames ----------
CANDIDATE_HOSTS=(
  "jetson-nano.local"
  "jetson-desktop.local"
  "jetson.local"
  "nano.local"
  "nano-desktop.local"
  "ubuntu.local"
  "tegra-ubuntu.local"
)

# If the arg looks like a hostname, only probe that.
ARG="${1:-}"
if [[ -n "$ARG" && "$ARG" != */* && ! "$ARG" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  CANDIDATE_HOSTS=("$ARG")
fi

# ---------- helpers ----------
resolve_host() {
  local host="$1"
  if command -v avahi-resolve-host-name >/dev/null 2>&1; then
    avahi-resolve-host-name -4 "$host" 2>/dev/null | awk '{print $2; exit}'
  elif command -v getent >/dev/null 2>&1; then
    getent ahostsv4 "$host" 2>/dev/null | awk '{print $1; exit}'
  else
    ping -c 1 -W 1 "$host" 2>/dev/null \
      | sed -n 's/.*(\([0-9.]*\)).*/\1/p' | head -1
  fi
}

ssh_banner() {
  local addr="$1"
  # ssh-keyscan grabs the SSH version string with no auth; banner shows up
  # in stderr as a `# host:port SSH-2.0-OpenSSH_X.Y` comment line.
  ssh-keyscan -T 5 -t ed25519,rsa "$addr" 2>&1 \
    | grep -oE 'SSH-[0-9.]+-[^[:space:]]+([[:space:]]+[^[:cntrl:]]+)?' \
    | head -1
}

is_jetson_like() {
  echo "${1:-}" | grep -qiE 'ubuntu|jetson|tegra'
}

# ---------- step 1: mDNS sweep ----------
log "Trying mDNS hostnames"
FOUND_HOSTS=()
for h in "${CANDIDATE_HOSTS[@]}"; do
  ip=$(resolve_host "$h" || true)
  if [[ -n "${ip:-}" ]]; then
    ok "${h} → ${ip}"
    FOUND_HOSTS+=("$ip|$h")
  else
    printf "${DIM}   %s — no response${NC}\n" "$h"
  fi
done

if [[ ${#FOUND_HOSTS[@]} -gt 0 ]]; then
  echo
  log "Probing SSH on each match"
  for entry in "${FOUND_HOSTS[@]}"; do
    ip="${entry%%|*}"
    h="${entry##*|}"
    banner=$(ssh_banner "$ip" || true)
    if [[ -n "$banner" ]]; then
      if is_jetson_like "$banner"; then
        ok "${BOLD}${h}${NC} (${ip}) — ${banner}  ${GREEN}(Jetson-like)${NC}"
      else
        ok "${h} (${ip}) — ${banner}"
      fi
    else
      warn "${h} (${ip}) — SSH did not respond on :22"
    fi
  done
  echo
  primary="${FOUND_HOSTS[0]##*|}"
  log "Try: ${BOLD}ssh <user>@${primary}${NC}"
  exit 0
fi

# ---------- step 2: subnet scan ----------
echo
log "mDNS turned up nothing. Falling back to subnet scan."

if ! command -v nmap >/dev/null 2>&1; then
  err "nmap not installed. Either:"
  err "  sudo apt install nmap        # Debian / Ubuntu"
  err "  brew install nmap            # macOS"
  err "Or pass a hostname explicitly: $0 my-jetson.local"
  exit 1
fi

# Decide what to scan.
if [[ "$ARG" =~ / ]]; then
  SUBNET="$ARG"
elif [[ -n "$ARG" && "$ARG" =~ ^[0-9.]+$ ]]; then
  SUBNET="$ARG"
else
  SUBNET=$(ip -o -4 addr show scope global 2>/dev/null \
            | awk 'NR==1 {print $4}')
fi

if [[ -z "${SUBNET:-}" ]]; then
  err "Could not detect local subnet. Pass it explicitly:"
  err "  $0 192.168.1.0/24"
  exit 1
fi

log "Scanning ${BOLD}${SUBNET}${NC} for hosts with SSH open (this can take ~30 s)"

mapfile -t HITS < <(
  nmap -p 22 --open -n -T4 -oG - "$SUBNET" 2>/dev/null \
    | awk '/Ports:.*22\/open/ {print $2}'
)

if [[ ${#HITS[@]} -eq 0 ]]; then
  err "No hosts with SSH found on ${SUBNET}."
  err "Checks: Jetson powered + cabled? Same LAN? Firewall on the host blocking outbound :22?"
  exit 1
fi

# Drop the running host from the list (no point checking ourselves).
SELF_IPS=$(ip -o -4 addr show scope global | awk '{split($4,a,"/"); print a[1]}')
FILTERED=()
for ip in "${HITS[@]}"; do
  if echo "$SELF_IPS" | grep -qx "$ip"; then continue; fi
  FILTERED+=("$ip")
done
HITS=("${FILTERED[@]}")

log "Found ${BOLD}${#HITS[@]}${NC} host(s) with SSH open. Grabbing banners…"
echo
JETSON_LIKE=()
for ip in "${HITS[@]}"; do
  banner=$(ssh_banner "$ip" || true)
  if [[ -z "$banner" ]]; then
    printf "${DIM}   %-15s  no banner${NC}\n" "$ip"
  elif is_jetson_like "$banner"; then
    printf "${GREEN}✓  %-15s  ${BOLD}%s${NC}  ${GREEN}(Jetson-like)${NC}\n" "$ip" "$banner"
    JETSON_LIKE+=("$ip")
  else
    printf "${DIM}   %-15s  %s${NC}\n" "$ip" "$banner"
  fi
done

echo
if [[ ${#JETSON_LIKE[@]} -gt 0 ]]; then
  log "Best guess: ${BOLD}ssh <user>@${JETSON_LIKE[0]}${NC}"
  if [[ ${#JETSON_LIKE[@]} -gt 1 ]]; then
    warn "Multiple Jetson-like hosts. Use \`arp -a\` and check MAC OUIs to disambiguate."
  fi
else
  warn "No Ubuntu/Jetson-style banners found, but ${#HITS[@]} SSH host(s) responded."
  warn "Try each: ${HITS[*]}"
fi
