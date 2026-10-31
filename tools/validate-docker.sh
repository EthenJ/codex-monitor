#!/usr/bin/env bash
set -euo pipefail

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo"
if [[ $# -gt 1 ]]; then
  echo 'Usage: bash tools/validate-docker.sh [new-output-directory]' >&2
  exit 2
fi
if [[ $# -eq 1 ]]; then
  output=$1
  mkdir -- "$output"
  output=$(cd -- "$output" && pwd)
else
  output=$(mktemp -d "${TMPDIR:-/tmp}/codex-monitor-docker-XXXXXX")
fi
printf 'Validation artifacts: %s\n' "$output"
docker version > "$output/docker-version.txt"
docker info > "$output/docker-info.txt"
git rev-parse HEAD > "$output/base-commit.txt"
git diff --binary > "$output/tracked-changes.patch"
git status --short > "$output/worktree.txt"
run_id="$(date -u +%Y%m%d%H%M%S)-$$"
network_image="codex-monitor-network-test:local-$run_id"
ubuntu_image="codex-monitor-ubuntu-test:local-$run_id"
containers=("codex-monitor-network-$run_id" "codex-monitor-ubuntu-$run_id")
cleanup() {
  # Only names created by this invocation; never stop unrelated containers.
  for container in "${containers[@]}"; do
    docker rm -f "$container" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n%s\n' "$network_image" "$ubuntu_image" > "$output/images.txt"
printf '%s\n' "${containers[@]}" > "$output/containers.txt"

docker build --progress=plain -f tests/container/Dockerfile -t "$network_image" . 2>&1 | tee "$output/network-build.log"
docker run --rm --init --network none --cpus 2 --memory 3g --pids-limit 512 \
  --name "${containers[0]}" "$network_image" 2>&1 | tee "$output/network-test.log"
docker build --progress=plain -f tests/container/Dockerfile.ubuntu -t "$ubuntu_image" . 2>&1 | tee "$output/ubuntu-build.log"
docker image inspect "$ubuntu_image" --format '{{json .Config}}' > "$output/ubuntu-image-config.json"
docker run --rm --init --network none --cpus 2 --memory 3g --pids-limit 512 \
  --name "${containers[1]}" "$ubuntu_image" 2>&1 | tee "$output/ubuntu-test.log"
printf 'Docker validation passed; images retained for reuse, test containers removed. Logs: %s\n' "$output"
