#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_EXT_DIR="${REPO_DIR}/extensions"
DST_EXT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}/extensions"

if [[ ! -d "${SRC_EXT_DIR}" ]]; then
  echo "Error: source extensions directory not found: ${SRC_EXT_DIR}" >&2
  exit 1
fi

mkdir -p "${DST_EXT_DIR}"

echo "Syncing extensions from ${SRC_EXT_DIR} -> ${DST_EXT_DIR}"

shopt -s nullglob
entries=("${SRC_EXT_DIR}"/*)

if [[ ${#entries[@]} -eq 0 ]]; then
  echo "No extensions found in ${SRC_EXT_DIR}"
  exit 0
fi

for src_path in "${entries[@]}"; do
  name="$(basename "${src_path}")"
  # Skip hidden files or standalone README files inside extensions/
  if [[ "${name}" == .* || "${name}" == "README.md" ]]; then
    continue
  fi

  base_no_ext="${name%.ts}"
  dst_path="${DST_EXT_DIR}/${name}"
  alt_file_path="${DST_EXT_DIR}/${base_no_ext}.ts"
  alt_dir_path="${DST_EXT_DIR}/${base_no_ext}"

  # Remove existing target (and any old file/folder form with the same base name) in ~/.pi/agent/extensions
  for target in "${dst_path}" "${alt_file_path}" "${alt_dir_path}"; do
    if [[ -e "${target}" || -L "${target}" ]]; then
      echo "  - Removing existing: ${target}"
      rm -rf "${target}"
    fi
  done

  echo "  + Copying: ${name} -> ${dst_path}"
  cp -R "${src_path}" "${dst_path}"
done

echo "Done! Installed extensions in ${DST_EXT_DIR}:"
ls -la "${DST_EXT_DIR}"
