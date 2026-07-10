# Climate monitoring

Cellarion can track temperature and humidity in your physical cellar: sensor
devices post readings to an ingest API, and Cellarion renders current values
and history on the cellar page, and notifies you when values leave the safe
range or a sensor goes silent.

**Standalone by design — no Home Assistant required.** The reference device
(an ESP32, see [`firmware/`](../firmware/README.md)) talks directly to
Cellarion over your network. And the ingest API is deliberately **open**:
anything that can POST JSON with a bearer token is a first-class citizen —
a Home Assistant automation, a Raspberry Pi script, your own hardware.

## Concepts

- **Device** — one posting client, created under *Settings → Climate devices*.
  Creating a device mints a `climate`-scoped API token (shown once) that is
  the device's identity: ingest resolves the device *from the token*, so
  payloads carry no device id and cannot post as another device. Revoking the
  token (or deleting the device) cuts it off instantly.
- **Channel** — one measurement stream on a device, identified by
  `(channel, type)` — e.g. `("ambient", temperature)` and
  `("ambient", humidity)` from the same physical sensor. Channels
  auto-register on first post (up to 16 per device); rename them and set
  per-channel calibration offsets in the device settings.
- **Cellar assignment** — a device is assigned to one cellar; its readings
  power that cellar's climate card, history charts, and alerts. Unassigned
  devices still store readings but appear in no cellar view.

## The ingest API (public contract)

> **Stability promise:** this contract evolves additively only. New optional
> fields may appear; existing fields are never renamed or removed without a
> deprecation cycle. There is no `/v1` — additive-only discipline is the
> versioning.

```
POST /api/climate/ingest
Authorization: Bearer cel_...        ← climate-scoped device token
Content-Type: application/json
```

```json
{
  "firmware": "my-client/1.0",
  "rssi": -61,
  "readings": [
    { "channel": "ambient",  "type": "temperature", "value": 12.4 },
    { "channel": "ambient",  "type": "humidity",    "value": 68 },
    { "channel": "probe-a",  "type": "temperature", "value": 13.1,
      "ts": "2026-07-10T14:05:00Z" }
  ]
}
```

| Field | Required | Rules |
|---|---|---|
| `readings` | yes | 1–100 entries per request |
| `readings[].channel` | yes | `[a-z0-9][a-z0-9_-]{0,63}` (case-insensitive) |
| `readings[].type` | yes | `temperature` or `humidity` |
| `readings[].value` | yes | number; accepted range −30…60 °C / 0…100 %RH (after calibration offset) |
| `readings[].ts` | no | ISO 8601. Omit to use server time. Accepted window: 48 h past … 5 min future (backfill after an outage is welcome) |
| `firmware` | no | free-form string, shown on the device page |
| `rssi` | no | Wi-Fi signal at the device, shown on the device page |

**Response `202`** — invalid entries are rejected individually, the valid
remainder is stored:

```json
{ "accepted": 3, "rejected": 0, "intervalS": 300 }
```

`intervalS` is the *suggested* posting cadence (default 5 min); clients may
honor it. When entries were rejected, an `errors` array lists the first few
`{ index, reason }` pairs (`invalid_channel`, `invalid_type`, `invalid_value`,
`out_of_bounds`, `invalid_ts`, `ts_too_old`, `ts_in_future`, `channel_limit`,
`daily_quota`).

**Errors:** `400` malformed envelope · `401` invalid/revoked token ·
`403` non-device credential (JWT sessions cannot ingest) · `404` token not
bound to a device · `429` rate-limited.

**Rate limits** (two, both per device): at most **60 requests / 15 min**
(supports the fastest allowed cadence of one post per minute with headroom for
retries and backfill batches), and at most **20,000 readings / UTC day**
(`CLIMATE_MAX_READINGS_PER_DAY`) — a hard bound on storage abuse that normal
use never approaches (5-min cadence × 6 channels ≈ 1,700/day).

**Choosing a cadence:** 5 min is the sweet spot — frequent enough for the
15-minute alert hysteresis to catch a cooling failure quickly, cheap enough to
be negligible. Hourly is fine for pure logging, but then raise the cellar's
*offline after* setting above the cadence (e.g. 150 min), or every gap between
posts will be flagged as an outage — and expect threshold alerts to lag up to
two hours.

The token is default-deny scoped: a leaked device token can reach **only**
this endpoint — no cellar reads, no account access, nothing else.

## Integration recipes

**curl** (anything that can run curl can be a "sensor"):

```bash
curl -X POST https://cellarion.app/api/climate/ingest \
  -H "Authorization: Bearer cel_..." \
  -H "Content-Type: application/json" \
  -d '{"readings":[{"channel":"ambient","type":"temperature","value":12.4}]}'
```

**Python** (e.g. a Raspberry Pi with a sensor HAT):

```python
import requests
requests.post(
    "https://cellarion.app/api/climate/ingest",
    headers={"Authorization": "Bearer cel_..."},
    json={"readings": [
        {"channel": "ambient", "type": "temperature", "value": read_temp()},
        {"channel": "ambient", "type": "humidity", "value": read_rh()},
    ]},
    timeout=10,
)
```

**Home Assistant** — forward any sensors HA already knows (Zigbee, Z-Wave,
BLE, cloud) with a `rest_command` + time-pattern automation. No custom
integration needed:

```yaml
# configuration.yaml
rest_command:
  cellarion_climate:
    url: https://cellarion.app/api/climate/ingest
    method: POST
    headers:
      Authorization: !secret cellarion_climate_token   # "Bearer cel_..."
    content_type: application/json
    payload: >-
      {"readings":[
        {"channel":"cellar","type":"temperature","value":{{ states('sensor.cellar_temperature') }}},
        {"channel":"cellar","type":"humidity","value":{{ states('sensor.cellar_humidity') }}}
      ]}

# automations.yaml
- alias: Push cellar climate to Cellarion
  trigger:
    - platform: time_pattern
      minutes: "/5"
  condition:
    - condition: template
      value_template: "{{ states('sensor.cellar_temperature') not in ['unknown', 'unavailable'] }}"
  action:
    - service: rest_command.cellarion_climate
```

## Alerts

Thresholds are per cellar (cellar page → climate card → settings, owner only).
Shipped defaults: **8–16 °C** and **45–80 %RH**, alerts enabled.

The alert engine is deliberately calm:

- a breach must persist **15 minutes** before it notifies (a door opening is
  not an emergency),
- after an alert, the same channel is quiet for **6 hours** unless it recovers
  first — recovery always notifies (once),
- a device silent longer than **60 minutes** (configurable) triggers one
  *sensor offline* notification, and a *back online* notice when it returns.

Notifications use the normal Cellarion channels (in-app, web push).

## Data & retention

- Readings are stored in a MongoDB time-series collection; retention defaults
  to **730 days** (`CLIMATE_RETENTION_DAYS`, applied when the collection is
  first created — changing it later needs a `collMod`).
- History charts are served pre-bucketed (5 min / 1 h / 6 h / 1 d for the
  24 h / 7 d / 30 d / 1 y ranges).
- Deleting a device deletes its readings. Deleting your account deletes
  devices, tokens, and readings (and the data export includes them) — see
  `backend/src/services/userDataRegistry.js`.
- Devices are capped at 5 per user (`CLIMATE_MAX_DEVICES_PER_USER`); each
  device consumes one of the account's API-token slots.

## Self-hosting notes

No docker-compose changes: the feature rides the existing backend and MongoDB
(7+, already required). Optional environment variables, all with safe
defaults: `CLIMATE_RETENTION_DAYS` (730), `CLIMATE_MAX_DEVICES_PER_USER` (5),
`CLIMATE_SUGGESTED_INTERVAL_S` (300). Devices on your LAN may post over plain
HTTP if you accept that on your own network.
