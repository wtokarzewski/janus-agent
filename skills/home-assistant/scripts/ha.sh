#!/usr/bin/env bash
# Home Assistant CLI wrapper for Janus
# Usage: ha.sh <command> [args...]

set -euo pipefail

CONFIG_FILE="${HA_CONFIG:-$HOME/.janus/home-assistant/config.json}"

# Load config
if [[ -f "$CONFIG_FILE" ]]; then
  HA_URL="${HA_URL:-$(jq -r '.url // empty' "$CONFIG_FILE")}"
  HA_TOKEN="${HA_TOKEN:-$(jq -r '.token // empty' "$CONFIG_FILE")}"
fi

: "${HA_URL:?Set HA_URL or configure $CONFIG_FILE}"
: "${HA_TOKEN:?Set HA_TOKEN or configure $CONFIG_FILE}"

# Strip trailing slash from URL
HA_URL="${HA_URL%/}"

cmd="${1:-help}"
shift || true

api() {
  curl -s -H "Authorization: Bearer $HA_TOKEN" -H "Content-Type: application/json" "$@"
}

# Validate entity_id format: domain.name (alphanumeric, underscores, dots)
validate_entity() {
  local entity="$1"
  if [[ ! "$entity" =~ ^[a-z_]+\.[a-z0-9_]+$ ]]; then
    echo "Error: Invalid entity_id format: $entity" >&2
    echo "Expected format: domain.name (e.g., light.living_room)" >&2
    exit 1
  fi
}

# Validate numeric value
validate_number() {
  local value="$1"
  local name="$2"
  if [[ ! "$value" =~ ^[0-9]+\.?[0-9]*$ ]]; then
    echo "Error: $name must be a number, got: $value" >&2
    exit 1
  fi
}

case "$cmd" in
  state|get)
    entity="${1:?Usage: ha.sh state <entity_id>}"
    validate_entity "$entity"
    api "$HA_URL/api/states/$entity" | jq -r '.state // "unknown"'
    ;;

  states)
    entity="${1:?Usage: ha.sh states <entity_id>}"
    validate_entity "$entity"
    api "$HA_URL/api/states/$entity" | jq
    ;;

  on|turn_on)
    entity="${1:?Usage: ha.sh on <entity_id> [brightness]}"
    validate_entity "$entity"
    domain="${entity%%.*}"
    brightness="${2:-}"
    if [[ -n "$brightness" ]]; then
      validate_number "$brightness" "brightness"
      api -X POST "$HA_URL/api/services/$domain/turn_on" \
        -d "$(jq -n --arg e "$entity" --argjson b "$brightness" '{entity_id: $e, brightness: $b}')"
    else
      api -X POST "$HA_URL/api/services/$domain/turn_on" \
        -d "$(jq -n --arg e "$entity" '{entity_id: $e}')"
    fi
    echo "OK: $entity turned on"
    ;;

  off|turn_off)
    entity="${1:?Usage: ha.sh off <entity_id>}"
    validate_entity "$entity"
    domain="${entity%%.*}"
    api -X POST "$HA_URL/api/services/$domain/turn_off" \
      -d "$(jq -n --arg e "$entity" '{entity_id: $e}')" >/dev/null
    echo "OK: $entity turned off"
    ;;

  toggle)
    entity="${1:?Usage: ha.sh toggle <entity_id>}"
    validate_entity "$entity"
    domain="${entity%%.*}"
    api -X POST "$HA_URL/api/services/$domain/toggle" \
      -d "$(jq -n --arg e "$entity" '{entity_id: $e}')" >/dev/null
    echo "OK: $entity toggled"
    ;;

  scene)
    scene="${1:?Usage: ha.sh scene <scene_name>}"
    [[ "$scene" == scene.* ]] || scene="scene.$scene"
    validate_entity "$scene"
    api -X POST "$HA_URL/api/services/scene/turn_on" \
      -d "$(jq -n --arg e "$scene" '{entity_id: $e}')" >/dev/null
    echo "OK: Scene $scene activated"
    ;;

  script)
    script="${1:?Usage: ha.sh script <script_name>}"
    [[ "$script" == script.* ]] || script="script.$script"
    validate_entity "$script"
    api -X POST "$HA_URL/api/services/script/turn_on" \
      -d "$(jq -n --arg e "$script" '{entity_id: $e}')" >/dev/null
    echo "OK: Script $script executed"
    ;;

  automation|trigger)
    auto="${1:?Usage: ha.sh automation <automation_name>}"
    [[ "$auto" == automation.* ]] || auto="automation.$auto"
    validate_entity "$auto"
    api -X POST "$HA_URL/api/services/automation/trigger" \
      -d "$(jq -n --arg e "$auto" '{entity_id: $e}')" >/dev/null
    echo "OK: Automation $auto triggered"
    ;;

  climate|temp)
    entity="${1:?Usage: ha.sh climate <entity_id> <temperature>}"
    temp="${2:?Usage: ha.sh climate <entity_id> <temperature>}"
    validate_entity "$entity"
    validate_number "$temp" "temperature"
    api -X POST "$HA_URL/api/services/climate/set_temperature" \
      -d "$(jq -n --arg e "$entity" --argjson t "$temp" '{entity_id: $e, temperature: $t}')" >/dev/null
    echo "OK: $entity set to ${temp}°"
    ;;

  list)
    filter="${1:-all}"
    if [[ "$filter" == "all" ]]; then
      api "$HA_URL/api/states" | jq -r '.[].entity_id' | sort
    else
      # Normalize: "lights" -> "light", "switches" -> "switch"
      filter="${filter%s}"
      api "$HA_URL/api/states" | jq -r --arg d "$filter" \
        '.[] | select(.entity_id | startswith($d + ".")) | .entity_id' | sort
    fi
    ;;

  search)
    pattern="${1:?Usage: ha.sh search <pattern>}"
    # Use contains() instead of test() to avoid regex injection
    api "$HA_URL/api/states" | jq -r --arg p "${pattern,,}" \
      '.[] | select(.entity_id | ascii_downcase | contains($p)) | "\(.entity_id): \(.state)"'
    ;;

  call)
    domain="${1:?Usage: ha.sh call <domain> <service> [json_data]}"
    service="${2:?Usage: ha.sh call <domain> <service> [json_data]}"
    data="${3:-{}}"
    # Validate domain/service: alphanumeric + underscores only
    if [[ ! "$domain" =~ ^[a-z_]+$ ]]; then
      echo "Error: Invalid domain: $domain" >&2
      exit 1
    fi
    if [[ ! "$service" =~ ^[a-z_]+$ ]]; then
      echo "Error: Invalid service: $service" >&2
      exit 1
    fi
    # Validate JSON
    if ! echo "$data" | jq empty 2>/dev/null; then
      echo "Error: Invalid JSON data" >&2
      exit 1
    fi
    api -X POST "$HA_URL/api/services/$domain/$service" -d "$data"
    ;;

  info)
    api "$HA_URL/api/" | jq
    ;;

  help|*)
    cat <<EOF
Home Assistant CLI (Janus)

Usage: ha.sh <command> [args...]

Commands:
  state <entity>              Get entity state
  states <entity>             Get full entity state with attributes
  on <entity> [brightness]    Turn on (optional brightness 0-255)
  off <entity>                Turn off
  toggle <entity>             Toggle on/off
  scene <name>                Activate scene
  script <name>               Run script
  automation <name>           Trigger automation
  climate <entity> <temp>     Set temperature
  list [domain]               List entities (lights, switches, all)
  search <pattern>            Search entities by name
  call <domain> <svc> [json]  Call any service
  info                        Get HA instance info

Environment:
  HA_URL    Home Assistant URL (required)
  HA_TOKEN  Long-lived access token (required)

Examples:
  ha.sh on light.living_room 200
  ha.sh scene movie_night
  ha.sh list lights
  ha.sh search kitchen
EOF
    ;;
esac
