#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
command -v node >/dev/null 2>&1 || { echo 'Titan Channels requires Node.js.' >&2; exit 1; }
for file in admin/index.html reseller/index.html user/index.html scripts/install.sh scripts/uninstall.sh; do [ -x "$ROOT/$file" ] || { echo "not executable: $file" >&2; exit 1; }; done
echo 'Titan Channels preflight passed. No hosted runtime or business state was changed.'
