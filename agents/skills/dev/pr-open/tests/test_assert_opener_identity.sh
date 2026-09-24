#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
script="${repo_root}/agents/skills/dev/pr-open/scripts/assert-opener-identity.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

cat > "${tmp_dir}/gh" <<'EOF'
#!/usr/bin/env bash
if [[ "${FAKE_GH_LOGIN:-}" == "error" ]]; then
  exit 1
fi
printf '%s\n' "${FAKE_GH_LOGIN:-quinnstoffer}"
EOF
chmod +x "${tmp_dir}/gh" "${script}"

PATH="${tmp_dir}:${PATH}" FAKE_GH_LOGIN=rowanstoffer \
  "${script}" rowanstoffer >/dev/null

if PATH="${tmp_dir}:${PATH}" FAKE_GH_LOGIN=quinnstoffer \
  "${script}" rowanstoffer >/dev/null 2>&1; then
  echo "expected identity mismatch to fail" >&2
  exit 1
fi

if PATH="${tmp_dir}:${PATH}" FAKE_GH_LOGIN=error \
  "${script}" rowanstoffer >/dev/null 2>&1; then
  echo "expected gh failure to fail" >&2
  exit 1
fi

if PATH="${tmp_dir}:${PATH}" "${script}" >/dev/null 2>&1; then
  echo "expected missing argument to fail" >&2
  exit 1
fi

echo "assert-opener-identity tests passed"
