---
name: home-assistant
description: "Control Home Assistant smart home devices, run automations, and manage scenes. Use when controlling lights, switches, climate, scenes, scripts, or any HA entity."
version: "1.0.0"
requires:
  bins: [jq, curl]
always: false
---

# Home Assistant

Control your smart home via Home Assistant's REST API.

## Setup

### Option 1: Config File (Recommended)

Create `~/.janus/home-assistant/config.json` (restrict permissions — contains secret token):
```bash
mkdir -p ~/.janus/home-assistant
cat > ~/.janus/home-assistant/config.json << 'EOF'
{
  "url": "https://your-ha-instance.duckdns.org",
  "token": "your-long-lived-access-token"
}
EOF
chmod 600 ~/.janus/home-assistant/config.json
```

### Option 2: Environment Variables

```bash
export HA_URL="http://homeassistant.local:8123"
export HA_TOKEN="your-long-lived-access-token"
```

### Getting a Long-Lived Access Token

1. Open Home Assistant → Profile (bottom left)
2. Scroll to "Long-Lived Access Tokens"
3. Click "Create Token", name it (e.g., "Janus")
4. Copy the token immediately (shown only once)

## CLI Wrapper

Use `scripts/ha.sh` via `exec` for all HA operations:

```bash
# Test connection
ha.sh info

# List entities
ha.sh list all          # all entities
ha.sh list lights       # just lights
ha.sh list switch       # just switches

# Search entities
ha.sh search kitchen    # find entities by name

# Get/set state
ha.sh state light.living_room
ha.sh states light.living_room   # full details with attributes
ha.sh on light.living_room
ha.sh on light.living_room 200   # with brightness (0-255)
ha.sh off light.living_room
ha.sh toggle switch.fan

# Scenes & scripts
ha.sh scene movie_night
ha.sh script goodnight

# Climate
ha.sh climate climate.thermostat 22

# Call any service
ha.sh call light turn_on '{"entity_id":"light.room","brightness":200}'
```

## Common Services

| Domain | Service | Example entity_id |
|--------|---------|-------------------|
| `light` | `turn_on`, `turn_off`, `toggle` | `light.kitchen` |
| `switch` | `turn_on`, `turn_off`, `toggle` | `switch.fan` |
| `climate` | `set_temperature`, `set_hvac_mode` | `climate.thermostat` |
| `cover` | `open_cover`, `close_cover`, `stop_cover` | `cover.garage` |
| `media_player` | `play_media`, `media_pause`, `volume_set` | `media_player.tv` |
| `scene` | `turn_on` | `scene.relax` |
| `script` | `turn_on` | `script.welcome_home` |
| `automation` | `trigger`, `turn_on`, `turn_off` | `automation.sunrise` |

## Troubleshooting

- **401 Unauthorized**: Token expired or invalid. Generate a new one.
- **Connection refused**: Check HA_URL, ensure HA is running and accessible.
- **Entity not found**: List entities to find the correct entity_id.

## API Reference

For advanced usage, see [references/api.md](references/api.md).
