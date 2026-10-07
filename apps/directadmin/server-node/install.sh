#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test -f "$ROOT/update.sh" && [ ! -L "$ROOT/update.sh" ] || { echo "update.sh must be a regular file" >&2; exit 1; }
source "$ROOT/update.sh"

SERVER_NODE_TOKEN_CREATED=false
SERVER_NODE_CONFIG_DIR_CREATED=false
SERVER_NODE_TOKEN_STAGE=''

server_node_install_checkpoint() { :; }

server_node_install_report() {
  local lifecycle="$1" rollback="$2" persistent="$3" installed="${4:-null}" updated=false
  if [ "$lifecycle" = installed ]; then installed=true; fi
  printf '{"plugin":"titan-server-node","lifecycle":"%s","installation_attempted":true,"installed":%s,"updated":%s,"rollback":"%s","persistent":"%s"}\n' \
    "$lifecycle" "$installed" "$updated" "$rollback" "$persistent"
}

server_node_install_token() {
  local config="$1" expected_owner="$2" config_dir token_stage
  SERVER_NODE_TOKEN_CREATED=false
  SERVER_NODE_CONFIG_DIR_CREATED=false
  SERVER_NODE_TOKEN_STAGE=''
  validate_server_node_token_file "$config" "$expected_owner"
  if [ -e "$config" ] || [ -L "$config" ]; then return 0; fi

  config_dir="$(dirname "$config")"
  if [ ! -d "$config_dir" ]; then
    install -d -m 0750 "$config_dir"
    SERVER_NODE_CONFIG_DIR_CREATED=true
  fi
  validate_server_node_directory "$config_dir" "$expected_owner"
  token_stage="$(mktemp "$config_dir/.server-node.env.XXXXXX")"
  SERVER_NODE_TOKEN_STAGE="$token_stage"
  if ! node -e 'process.stdout.write("TITAN_NODE_AUTH_TOKEN=" + require("node:crypto").randomBytes(32).toString("hex") + String.fromCharCode(10))' > "$token_stage"; then
    rm -f -- "$token_stage" || return 1
    SERVER_NODE_TOKEN_STAGE=''
    return 1
  fi
  if ! chmod 0600 "$token_stage"; then
    rm -f -- "$token_stage" || return 1
    SERVER_NODE_TOKEN_STAGE=''
    return 1
  fi
  # link(2) gives us an atomic no-overwrite create. A concurrent or pre-existing
  # credential is validated and retained; it is never replaced or printed.
  if ! ln -- "$token_stage" "$config"; then
    rm -f -- "$token_stage" || return 1
    SERVER_NODE_TOKEN_STAGE=''
    if [ -e "$config" ] || [ -L "$config" ]; then
      validate_server_node_token_file "$config" "$expected_owner"
      return 0
    fi
    echo 'unable to create Server Node token file' >&2
    return 1
  fi
  SERVER_NODE_TOKEN_CREATED=true
  rm -f -- "$token_stage"
  SERVER_NODE_TOKEN_STAGE=''
  validate_server_node_token_file "$config" "$expected_owner"
}

server_node_install_runtime_matches() {
  local installed="$1" expected_manifest="$2" current_manifest expected_names current_names
  [ -d "$installed" ] && [ ! -L "$installed" ] || return 1
  [ -f "$installed/SHA256SUMS" ] && [ ! -L "$installed/SHA256SUMS" ] || return 1
  current_manifest="$(cat "$installed/SHA256SUMS")" || return 1
  [ "$current_manifest" = "$expected_manifest" ] || return 1
  (cd "$installed" && sha256sum --check --status SHA256SUMS) || return 1
  expected_names=$'SHA256SUMS\ndirectadmin-relay.mjs\nfile-bridge.mjs\nhealth.sh\npackage.json\nplugin.conf\nruntime.mjs\ntitan-server-node.service'
  current_names="$(find "$installed" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)" || return 1
  [ "$current_names" = "$expected_names" ]
}

install_server_node() (
  set -Eeuo pipefail
  local source="$1" installed="$2" unit="$3" state_dir="$4" config="$5"
  local token_owner="${6:-0}" service_user="${7:-titan-node}" service_group="${8:-titan-node}"
  local service_node="${9:-/usr/bin/node}" service_uid install_parent
  local file
  local runtime_stage='' unit_stage='' unit_hash='' expected_manifest=''
  local service_user_created=false state_dir_created=false token_created=false config_dir_created=false
  local runtime_promoted=false unit_promoted=false activation_attempted=false
  local runtime_parent_created=false rollback_complete=true persistent=false original_status
  local initial_paths_confirmed_absent=false

  install_failure() {
    original_status="$1"
    trap - ERR INT TERM
    set +e
    [ "$SERVER_NODE_TOKEN_CREATED" = true ] && token_created=true
    [ "$SERVER_NODE_CONFIG_DIR_CREATED" = true ] && config_dir_created=true
    if [ -n "$SERVER_NODE_TOKEN_STAGE" ]; then rm -f -- "$SERVER_NODE_TOKEN_STAGE" || rollback_complete=false; fi
    if [ -n "$runtime_stage" ]; then rm -rf -- "$runtime_stage" || rollback_complete=false; fi
    if [ -n "$unit_stage" ]; then rm -f -- "$unit_stage" || rollback_complete=false; fi

    if [ "$activation_attempted" = true ]; then
      systemctl disable --now titan-server-node.service >/dev/null 2>&1 || rollback_complete=false
      local active_state enabled_state
      active_state="$(systemctl show --property=ActiveState --value titan-server-node.service 2>/dev/null)" || rollback_complete=false
      [ "$active_state" = inactive ] || rollback_complete=false
      enabled_state="$(systemctl show --property=UnitFileState --value titan-server-node.service 2>/dev/null)" || rollback_complete=false
      [ "$enabled_state" = disabled ] || rollback_complete=false
    fi

    if [ "$rollback_complete" = true ]; then
      if [ "$unit_promoted" = true ]; then
        [ -f "$unit" ] && [ ! -L "$unit" ] && [ "$(sha256sum "$unit" | cut -d' ' -f1)" = "$unit_hash" ] || rollback_complete=false
      fi
      if [ "$rollback_complete" = true ] && [ "$runtime_promoted" = true ] && ! server_node_install_runtime_matches "$installed" "$expected_manifest"; then
        rollback_complete=false
      fi
      if [ "$rollback_complete" = true ] && [ "$unit_promoted" = true ]; then
        rm -f -- "$unit" || rollback_complete=false
      fi
      if [ "$rollback_complete" = true ] && [ "$runtime_promoted" = true ]; then
        rm -rf -- "$installed" || rollback_complete=false
      fi
      if [ "$unit_promoted" = true ]; then
        systemctl daemon-reload >/dev/null 2>&1 || rollback_complete=false
      fi
    fi

    # Only empty directories made by this attempt may be removed. Token files,
    # existing state, and any state the service may have created are retained.
    if [ "$token_created" = true ] || [ "$activation_attempted" = true ] || [ "$rollback_complete" = false ]; then
      persistent=true
    else
      if [ "$state_dir_created" = true ]; then rmdir -- "$state_dir" >/dev/null 2>&1 || { persistent=true; rollback_complete=false; }; fi
      if [ "$config_dir_created" = true ]; then rmdir -- "$(dirname "$config")" >/dev/null 2>&1 || { persistent=true; rollback_complete=false; }; fi
      if [ "$service_user_created" = true ] && [ "$activation_attempted" = false ] && [ "$rollback_complete" = true ]; then
        userdel "$service_user" >/dev/null 2>&1 || rollback_complete=false
      fi
    fi
    if [ "$runtime_parent_created" = true ]; then rmdir -- "$runtime_parent_created_path" >/dev/null 2>&1 || { persistent=true; rollback_complete=false; }; fi

    local installed_status=null
    if [ "$rollback_complete" = true ] && [ "$initial_paths_confirmed_absent" = true ]; then installed_status=false; fi
    if [ "$rollback_complete" = true ]; then
      server_node_install_report install-failed complete "$([ "$persistent" = true ] && printf 'token_and_control_state_preserved' || printf 'none')" "$installed_status"
    else
      server_node_install_report install-failed incomplete "$([ "$persistent" = true ] && printf 'token_and_control_state_preserved;manual_recovery_required' || printf 'manual_recovery_required')" null
    fi
    exit "$original_status"
  }

  local runtime_parent_created_path=''
  trap 'install_failure $?' ERR
  trap 'install_failure 130' INT
  trap 'install_failure 143' TERM

  validate_server_node_package "$source"
  [ "$(id -u)" = "$token_owner" ] || { echo 'privileged Server Node installation required' >&2; install_failure 1; }
  validate_server_node_supervisor_runtime "$service_node"
  command -v systemctl >/dev/null 2>&1 || { echo 'systemd is required for Server Node installation' >&2; install_failure 1; }
  command -v curl >/dev/null 2>&1 || { echo 'curl is required for Server Node installation' >&2; install_failure 1; }
  command -v flock >/dev/null 2>&1 || { echo 'flock is required for Server Node installation' >&2; install_failure 1; }
  validate_server_node_token_file "$config" "$token_owner"

  install_parent="$(dirname "$installed")"
  if [ ! -d "$install_parent" ]; then
    install -d -m 0755 "$install_parent"
    runtime_parent_created=true
    runtime_parent_created_path="$install_parent"
  fi
  validate_server_node_directory "$install_parent" "$token_owner"
  exec 9< "$install_parent"
  flock -n 9 || { echo 'another Server Node installation is in progress' >&2; install_failure 1; }

  [ ! -L "$installed" ] || { echo 'refusing symlink Server Node installation target' >&2; install_failure 1; }
  [ ! -L "$unit" ] || { echo 'refusing symlink Server Node service unit' >&2; install_failure 1; }
  if [ -e "$installed" ]; then
    if [ -d "$installed" ] && [ -f "$installed/runtime.mjs" ] && [ -e "$unit" ]; then
      validate_server_node_existing_unit "$unit" "$token_owner"
      server_node_install_token "$config" "$token_owner"
      token_created="$SERVER_NODE_TOKEN_CREATED"
      config_dir_created="$SERVER_NODE_CONFIG_DIR_CREATED"
      trap - ERR INT TERM
      update_server_node "$source" "$installed" "$unit" "$(dirname "$installed")-backups" "$config"
      return 0
    fi
    echo 'refusing unexpected or partial existing Server Node installation' >&2
    install_failure 1
  fi
  if [ -e "$unit" ]; then
    echo 'refusing unexpected existing titan-server-node.service unit' >&2
    install_failure 1
  fi
  initial_paths_confirmed_absent=true
  server_node_install_checkpoint preflight-complete

  runtime_stage="$(mktemp -d "${installed}.stage.XXXXXX")"
  chmod 0755 "$runtime_stage"
  for file in runtime.mjs directadmin-relay.mjs file-bridge.mjs package.json plugin.conf; do
    install -m 0644 "$source/$file" "$runtime_stage/$file"
  done
  install -m 0755 "$source/health.sh" "$runtime_stage/health.sh"
  install -m 0644 "$source/titan-server-node.service" "$runtime_stage/titan-server-node.service"
  (cd "$runtime_stage" && sha256sum runtime.mjs directadmin-relay.mjs file-bridge.mjs package.json plugin.conf health.sh titan-server-node.service > SHA256SUMS)
  chmod 0644 "$runtime_stage/SHA256SUMS"
  expected_manifest="$(cat "$runtime_stage/SHA256SUMS")"
  validate_server_node_package "$runtime_stage" runtime
  server_node_install_checkpoint runtime-staged

  unit_stage="$(mktemp "${unit}.stage.XXXXXX")"
  install -m 0644 "$source/titan-server-node.service" "$unit_stage"
  unit_hash="$(sha256sum "$unit_stage" | cut -d' ' -f1)"
  server_node_install_checkpoint unit-staged

  if ! id "$service_user" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$state_dir" --shell /usr/sbin/nologin "$service_user"
    service_user_created=true
  fi
  service_uid="$(id -u "$service_user")"
  server_node_install_checkpoint service-user-ready

  if [ -e "$state_dir" ] || [ -L "$state_dir" ]; then
    validate_server_node_directory "$state_dir" "$service_uid"
  else
    install -d -o "$service_user" -g "$service_group" -m 0750 "$state_dir"
    state_dir_created=true
    validate_server_node_directory "$state_dir" "$service_uid"
  fi
  server_node_install_checkpoint state-directory-ready

  server_node_install_token "$config" "$token_owner"
  token_created="$SERVER_NODE_TOKEN_CREATED"
  if [ "$SERVER_NODE_CONFIG_DIR_CREATED" = true ]; then config_dir_created=true; fi
  server_node_install_checkpoint token-ready

  [ ! -e "$installed" ] && [ ! -L "$installed" ] || { initial_paths_confirmed_absent=false; echo 'Server Node installation target appeared during install' >&2; install_failure 1; }
  mv -Tn -- "$runtime_stage" "$installed"
  [ ! -e "$runtime_stage" ] && [ -d "$installed" ] || { echo 'unable to atomically promote Server Node runtime' >&2; return 1; }
  runtime_stage=''
  runtime_promoted=true
  server_node_install_checkpoint runtime-promoted

  [ ! -e "$unit" ] && [ ! -L "$unit" ] || { initial_paths_confirmed_absent=false; echo 'service unit appeared during install' >&2; install_failure 1; }
  mv -Tn -- "$unit_stage" "$unit"
  [ ! -e "$unit_stage" ] && [ -f "$unit" ] || { echo 'unable to atomically promote Server Node service unit' >&2; return 1; }
  unit_stage=''
  unit_promoted=true
  server_node_install_checkpoint unit-promoted

  cmp "$installed/titan-server-node.service" "$unit"
  systemctl daemon-reload
  server_node_install_checkpoint systemd-reloaded
  activation_attempted=true
  systemctl enable --now titan-server-node.service
  server_node_install_checkpoint service-started
  verify_server_node_process "$(server_node_port "$config")"
  server_node_install_checkpoint service-live
  trap - ERR INT TERM
  server_node_install_report installed not-applicable "$([ "$token_created" = true ] && printf 'token_and_control_state_created' || printf 'token_and_control_state_preserved')" true
)

main() {
  local root
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ "${1:-}" = "--validate-only" ] && [ "$#" -eq 1 ]; then
    validate_server_node_package "$root"
    printf '%s\n' '{"plugin":"titan-server-node","lifecycle":"validated","installation_attempted":false,"installed":null,"updated":false,"mode":"validation-only"}'
    return 0
  fi
  [ "$#" -eq 0 ] || { echo 'usage: install.sh [--validate-only]' >&2; return 2; }
  validate_server_node_package "$root"
  [ "$(id -u)" -eq 0 ] || { echo 'privileged Server Node installation required' >&2; return 1; }
  command -v systemctl >/dev/null 2>&1 || { echo 'systemd is required for Server Node installation' >&2; return 1; }
  install_server_node "$root" /usr/local/titan/server-node /etc/systemd/system/titan-server-node.service /var/lib/titan/server-node /etc/titan/server-node.env 0 titan-node titan-node /usr/bin/node
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
