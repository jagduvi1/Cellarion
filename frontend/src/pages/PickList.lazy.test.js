/**
 * The pick list's consume dialog is a lazy chunk like every other one, so it
 * goes through utils/lazyWithReload: a tab left open across a deploy reloads
 * onto the new build instead of failing on the old chunk's filename.
 */
const { lazySpy, Modal } = vi.hoisted(() => ({
  lazySpy: vi.fn(() => () => null),
  Modal: () => null,
}));

vi.mock('../utils/lazyWithReload', () => ({ lazy: lazySpy, default: lazySpy }));
// BetaBadge has lazy chunks of its own; mocked so only PickList's calls count.
vi.mock('../components/BetaBadge', () => ({ default: () => null }));
vi.mock('../components/BulkConsumeModal', () => ({ default: Modal }));

it('loads BulkConsumeModal through lazyWithReload', async () => {
  await import('./PickList');

  expect(lazySpy).toHaveBeenCalledTimes(1);
  const factory = lazySpy.mock.calls[0][0];
  const mod = await factory();
  expect(mod.default).toBe(Modal);
});
