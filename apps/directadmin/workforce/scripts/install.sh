#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
command -v node >/dev/null 2>&1 || { echo 'Titan Workforce requires Node.js 22 or newer.' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Titan Workforce requires Node.js 22 or newer."); process.exit(1); }'
for rel in admin reseller user hooks scripts lib images; do
  if [ ! -d "$PLUGIN_DIR/$rel" ] || [ -L "$PLUGIN_DIR/$rel" ]; then
    echo "Titan Workforce preflight failed: missing or unsafe directory $rel" >&2
    exit 1
  fi
done
for rel in AGENTS.md README.md plugin.conf admin/index.html admin/bootstrap-nonce.raw admin/bootstrap.raw reseller/index.html reseller/bootstrap-nonce.raw reseller/bootstrap.raw user/index.html user/bootstrap-nonce.raw user/bootstrap.raw hooks/admin_txt.html hooks/reseller_txt.html hooks/user_txt.html scripts/install.sh scripts/update.sh scripts/uninstall.sh lib/entry.mjs lib/directadmin-bootstrap-raw.mjs images/cockpit.mjs images/controller.mjs images/api.mjs images/presentation.mjs images/sdk.mjs images/style.css; do
  if [ ! -f "$PLUGIN_DIR/$rel" ] || [ -L "$PLUGIN_DIR/$rel" ]; then
    echo "Titan Workforce preflight failed: missing or unsafe $rel" >&2
    exit 1
  fi
done
for rel in admin/index.html admin/bootstrap-nonce.raw admin/bootstrap.raw reseller/index.html reseller/bootstrap-nonce.raw reseller/bootstrap.raw user/index.html user/bootstrap-nonce.raw user/bootstrap.raw scripts/install.sh scripts/update.sh scripts/uninstall.sh; do
  [ -x "$PLUGIN_DIR/$rel" ] || { echo "Titan Workforce preflight failed: $rel must be executable" >&2; exit 1; }
done
echo 'Titan Workforce package preflight passed. Configure the protected hosted identity bridge before use; no hosted runtime or business state was changed.'
