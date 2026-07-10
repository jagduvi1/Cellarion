import {
  listClimateDevices,
  createClimateDevice,
  updateClimateDevice,
  deleteClimateDevice,
  getCellarClimate,
  getCellarClimateReadings,
  updateCellarClimateConfig,
} from './climate';

// The api/ modules are the single place URLs and payload shapes live — pages
// never write raw fetch calls. These tests pin the contract each function
// sends so a route rename can't silently drift from the backend.
describe('api/climate', () => {
  const apiFetch = vi.fn();
  beforeEach(() => apiFetch.mockClear());

  test('listClimateDevices GETs the devices collection', () => {
    listClimateDevices(apiFetch);
    expect(apiFetch).toHaveBeenCalledWith('/api/climate/devices');
  });

  test('createClimateDevice POSTs name/cellar/password, omitting empty cellar', () => {
    createClimateDevice(apiFetch, { name: 'ESP32', cellarId: '', password: 'pw' });
    const [url, opts] = apiFetch.mock.calls[0];
    expect(url).toBe('/api/climate/devices');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ name: 'ESP32', password: 'pw' });
  });

  test('updateClimateDevice PUTs to the device id', () => {
    updateClimateDevice(apiFetch, 'd1', { name: 'Renamed', cellarId: null });
    const [url, opts] = apiFetch.mock.calls[0];
    expect(url).toBe('/api/climate/devices/d1');
    expect(opts.method).toBe('PUT');
    expect(JSON.parse(opts.body)).toEqual({ name: 'Renamed', cellarId: null });
  });

  test('deleteClimateDevice DELETEs the device id', () => {
    deleteClimateDevice(apiFetch, 'd1');
    expect(apiFetch).toHaveBeenCalledWith('/api/climate/devices/d1', { method: 'DELETE' });
  });

  test('getCellarClimate GETs the current snapshot', () => {
    getCellarClimate(apiFetch, 'c1');
    expect(apiFetch).toHaveBeenCalledWith('/api/climate/cellars/c1/current');
  });

  test('getCellarClimateReadings encodes the range and defaults to 24h', () => {
    getCellarClimateReadings(apiFetch, 'c1', '7d');
    expect(apiFetch).toHaveBeenCalledWith('/api/climate/cellars/c1/readings?range=7d');
    getCellarClimateReadings(apiFetch, 'c1');
    expect(apiFetch).toHaveBeenCalledWith('/api/climate/cellars/c1/readings?range=24h');
  });

  test('updateCellarClimateConfig PUTs the thresholds', () => {
    updateCellarClimateConfig(apiFetch, 'c1', { tempMin: 9, alertsEnabled: false });
    const [url, opts] = apiFetch.mock.calls[0];
    expect(url).toBe('/api/climate/cellars/c1/config');
    expect(opts.method).toBe('PUT');
    expect(JSON.parse(opts.body)).toEqual({ tempMin: 9, alertsEnabled: false });
  });
});
