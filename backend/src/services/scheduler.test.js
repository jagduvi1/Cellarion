/**
 * services/scheduler — stopScheduler (graceful shutdown): once a stop signal
 * arrives, no scheduled job may start another run. Every registered task is
 * stopped, and one that fails to stop doesn't keep the others running.
 */
jest.mock('node-cron', () => {
  const tasks = new Map();
  return {
    schedule: jest.fn(() => {
      const task = { stop: jest.fn() };
      tasks.set(`task-${tasks.size}`, task);
      return task;
    }),
    getTasks: () => tasks,
  };
});
// The jobs themselves are not run here — stub every module the scheduler wires.
jest.mock('./drinkWindowNotifier', () => ({ runDrinkWindowCheck: jest.fn() }));
jest.mock('./cellarValueSnapshotJob', () => ({ runCellarValueSnapshots: jest.fn() }));
jest.mock('./communityPriceJob', () => ({ runCommunityPriceAggregation: jest.fn() }));
jest.mock('./userDeletionJob', () => ({ runUserDeletionJob: jest.fn() }));
jest.mock('./cellarRetentionJob', () => ({ runCellarRetentionPurge: jest.fn() }));
jest.mock('./recommendationRetentionJob', () => ({ runRecommendationEmailScrub: jest.fn() }));
jest.mock('./scanImageRetentionJob', () => ({ runScanImageRetentionSweep: jest.fn() }));
jest.mock('./wineDraftExpiryJob', () => ({ runWineDraftExpirySweep: jest.fn() }));
jest.mock('./searchReconcileJob', () => ({ runSearchIndexReconcile: jest.fn() }));
jest.mock('./securityAlertJob', () => ({ runSecurityAlertCheck: jest.fn() }));
jest.mock('./climateOfflineJob', () => ({ runClimateOfflineCheck: jest.fn() }));
jest.mock('./demoSweepJob', () => ({ runDemoSweep: jest.fn() }));
jest.mock('./registryHealthJob', () => ({ runRegistryHealthCheck: jest.fn() }));
jest.mock('./registryReadReportJob', () => ({ runRegistryReadReport: jest.fn() }));
jest.mock('./embeddingJob', () => ({}));
jest.mock('./registryBridge', () => ({ isEnabled: () => false }));
jest.mock('../models/DiscussionReply', () => ({}));

const cron = require('node-cron');
const { startScheduler, stopScheduler } = require('./scheduler');

test('stopScheduler stops every task startScheduler registered', async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  startScheduler();
  const tasks = [...cron.getTasks().values()];
  expect(tasks.length).toBe(cron.schedule.mock.calls.length);
  expect(tasks.length).toBeGreaterThan(10);

  // One task failing to stop must not keep the rest running.
  tasks[0].stop.mockRejectedValueOnce(new Error('already stopped'));
  await expect(stopScheduler()).resolves.toBeUndefined();
  for (const task of tasks) expect(task.stop).toHaveBeenCalledTimes(1);
});
