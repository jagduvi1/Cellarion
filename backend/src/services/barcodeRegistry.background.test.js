/**
 * The registry learns in the background (services/barcodeRegistry.js): a bottle
 * save never waits for it, and a failure is logged, never thrown. That has to
 * hold also where the audit module has no logger: a failed log call that
 * escapes becomes an unhandled rejection, which fails whatever happens to be
 * running at that moment.
 */
jest.mock('./audit', () => ({ logAudit: jest.fn() }));
jest.mock('../models/Bottle', () => ({
  aggregate: jest.fn().mockRejectedValue(new Error('database down')),
  distinct: jest.fn().mockRejectedValue(new Error('database down')),
}));
jest.mock('../models/User', () => ({ distinct: jest.fn().mockResolvedValue([]) }));
jest.mock('../models/WineDefinition', () => ({}));

const registry = require('./barcodeRegistry');

test('a background failure is logged and never becomes an unhandled rejection, also without a logger', async () => {
  const unhandled = jest.fn();
  process.on('unhandledRejection', unhandled);
  const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    registry.learnBarcodeSoon('4006381333931', { via: 'test' });
    registry.learnBarcodesSoon(['5000112637922'], { via: 'test' });
    registry.learnWineBarcodesSoon('w1', { via: 'test' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(unhandled).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledTimes(3);
  } finally {
    process.off('unhandledRejection', unhandled);
    consoleWarn.mockRestore();
  }
});
