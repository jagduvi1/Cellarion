import { JSON_HEADERS } from './apiConstants';

// Climate monitoring (docs/climate-monitoring.md). Devices are sensor clients
// (ESP32 kit or any HTTP poster) bound 1:1 to a climate-scoped API token; the
// token is minted at device creation and shown exactly ONCE.

// GET /api/climate/devices — { devices: [...], maxDevices }
export const listClimateDevices = (apiFetch) => apiFetch('/api/climate/devices');

// POST /api/climate/devices — body: { name, cellarId?, password }.
// Returns { device, token } where `token` is the plaintext shown exactly ONCE.
// Errors: 400 (validation / device or token cap), 403 (wrong password — NOT
// 401, which apiFetch treats as session expiry), 429 (auth limit).
export const createClimateDevice = (apiFetch, { name, cellarId, password }) =>
  apiFetch('/api/climate/devices', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name, cellarId: cellarId || undefined, password }),
  });

// PUT /api/climate/devices/:id — { name?, cellarId? (null unassigns),
// channels?: [{ key, type, label?, calibrationOffset? }] }
export const updateClimateDevice = (apiFetch, id, data) =>
  apiFetch(`/api/climate/devices/${id}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });

// DELETE /api/climate/devices/:id — revokes the token and deletes readings.
export const deleteClimateDevice = (apiFetch, id) =>
  apiFetch(`/api/climate/devices/${id}`, { method: 'DELETE' });

// GET /api/climate/cellars/:id/current — { config, isOwner, devices }
export const getCellarClimate = (apiFetch, cellarId) =>
  apiFetch(`/api/climate/cellars/${cellarId}/current`);

// GET /api/climate/cellars/:id/readings?range=24h|7d|30d|1y
// — { range, bucketMinutes, since, series: [{ deviceId, deviceName, channel, type, points }] }
export const getCellarClimateReadings = (apiFetch, cellarId, range = '24h') =>
  apiFetch(`/api/climate/cellars/${cellarId}/readings?range=${encodeURIComponent(range)}`);

// PUT /api/climate/cellars/:id/config — thresholds + alert toggle (owner only)
export const updateCellarClimateConfig = (apiFetch, cellarId, config) =>
  apiFetch(`/api/climate/cellars/${cellarId}/config`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(config),
  });
