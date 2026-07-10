# Cellarion climate sensor firmware (ESP32)

Reference ESPHome firmware for feeding cellar temperature + humidity into
Cellarion. **Standalone by design — no Home Assistant required**: the device
POSTs directly to Cellarion's ingest API over your network (works with both
self-hosted installs and cellarion.app).

Full documentation — including the open ingest API that any HTTP client can
use instead of this firmware — lives in
[`docs/climate-monitoring.md`](../docs/climate-monitoring.md).

## Reference hardware (~€30–40, zero soldering)

| Part | Notes |
|---|---|
| ESP32 DevKitC (WROOM-32, 38-pin) | Pins come pre-soldered on standard devkits |
| Screw-terminal GPIO expansion board | Devkit plugs in; every pin becomes a screw terminal. Match the pin count (38 vs 30)! |
| 2× DS18B20 waterproof probe (1–3 m) | Both screw into the SAME three terminals — parallel probes on one pin is what 1-Wire is designed for |
| 4.7 kΩ resistor | Legs screwed between the DATA and 3V3 terminals |
| 2× SHT31 module (pre-soldered pins) | Leave one at address 0x44; jumper the other's ADDR pin to 3V3 → 0x45 |
| USB power supply + Dupont jumper wires | |

## Wiring

| ESP32 terminal | Connects to |
|---|---|
| 3V3 | Both probe reds, both SHT31 VIN, one 4.7 kΩ leg |
| GND | Both probe blacks, both SHT31 GND |
| GPIO4 | Both probe DATA wires (usually yellow — colors vary by seller), other 4.7 kΩ leg |
| GPIO21 / GPIO22 | SHT31 SDA / SCL (both boards in parallel) |

Practical notes: keep the SHT31 leads short (≤ ~1 m — place the ESP32
centrally; the 1-Wire probes are the ones that happily run several metres),
mount the SHT31s in free air rather than against a cold wall, and buy DS18B20s
from a reputable seller (clones abound; the per-channel calibration offset in
Cellarion exists for a reason).

## Flashing

1. In Cellarion: **Settings → Climate devices → Add device**. Copy the token —
   it is shown exactly once.
2. `cp secrets.yaml.example secrets.yaml` and fill in Wi-Fi, the token
   (keep the `Bearer ` prefix), and your ingest URL. `secrets.yaml` is
   gitignored — never commit it.
3. Connect the ESP32 over USB and run, from this directory:

   ```bash
   docker run --rm -v "$PWD":/config --device=/dev/ttyUSB0 -it esphome/esphome run cellarion-climate.yaml
   ```

   (On Windows/macOS, where Docker cannot pass USB through: `pip install esphome`
   and `esphome run cellarion-climate.yaml` instead. Later updates go over the
   air, so USB is only needed once.)

4. Watch the boot log: the 1-Wire bus prints each probe's unique address.
   Paste them into the `address:` lines so channel names stay pinned to
   physical probes, and reflash (OTA this time).

Readings appear on the assigned cellar's page within one interval (5 min
default). Channels auto-register on first post — rename them and set
calibration offsets in Cellarion under Settings → Climate devices.

## Adapting the template

- **Different sensors?** Any temperature/humidity source ESPHome supports can
  feed the same POST — add its sensor block and a line in the `vals[]` table.
- **More probes?** Wire them into the same three terminals and add a
  `dallas_temp` block with the new address.
- **Different cadence?** Change `interval:` (the server accepts down to 60 s
  between posts per device; the 202 response's `intervalS` is the suggested
  cadence). Going slower than ~15 min? Raise the cellar's *offline after*
  setting above your cadence (e.g. hourly posts → 150 min) so the gaps between
  posts aren't flagged as outages — and note that threshold alerts can then
  lag by up to two posting intervals.
- **Self-hosted over plain HTTP on your LAN?** Set `verify_ssl: false` and use
  the `http://` URL in `secrets.yaml`. Your network, your choice.
