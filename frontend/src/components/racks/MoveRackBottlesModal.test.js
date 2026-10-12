import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => {
  const t = (key, a, b) => {
    const vars = b && typeof b === 'object' ? b : (a && typeof a === 'object' ? a : undefined);
    if (!vars) return key;
    const { defaultValue, ...rest } = vars;
    return `${key}:${JSON.stringify(rest)}`;
  };
  return { useTranslation: () => ({ t }) };
});
vi.mock('../BetaBadge', () => ({ default: () => null }));

const { default: MoveRackBottlesModal, freeSlotsOf } = await import('./MoveRackBottlesModal');

const grid = (id, name, rows, cols, filled, extra = {}) => ({
  _id: id, name, type: 'grid', rows, cols, disabledPositions: [],
  slots: Array.from({ length: filled }, (_, i) => ({ position: i + 1, bottle: { _id: `${id}-b${i}` } })),
  ...extra,
});

describe('freeSlotsOf', () => {
  test('capacity less disabled and taken slots', () => {
    expect(freeSlotsOf(grid('r', 'R', 2, 3, 2, { disabledPositions: [6] }))).toBe(3);
    expect(freeSlotsOf(grid('r', 'R', 1, 2, 2))).toBe(0);
  });
});

describe('MoveRackBottlesModal', () => {
  const source = grid('src', 'Old rack', 4, 5, 12);
  const roomy = grid('cab', 'Wine fridge', 13, 6, 0);
  const small = grid('box', 'Small box', 2, 2, 0);
  const full = grid('full', 'Full rack', 1, 2, 2);

  test('offers the other racks with their free slots, picks the first with room, and moves', async () => {
    const onMove = vi.fn().mockResolvedValue({ ok: true, data: { moved: 12, left: 0 } });
    const onShowRack = vi.fn();
    render(<MoveRackBottlesModal rack={source} racks={[full, source, roomy, small]} onMove={onMove} onShowRack={onShowRack} onClose={() => {}} />);

    expect(screen.queryByRole('radio', { name: /Old rack/ })).toBeNull(); // not itself
    const fullRadio = screen.getByRole('radio', { name: /Full rack/ });
    expect(fullRadio.disabled).toBe(true);
    expect(screen.getByRole('radio', { name: /Wine fridge/ }).checked).toBe(true);
    expect(screen.getByText('racks.moveBottles.freeSlots:{"count":78}')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'racks.moveBottles.submit:{"count":12}' }));
    await waitFor(() => expect(onMove).toHaveBeenCalledWith('cab'));
    expect(await screen.findByText('racks.moveBottles.doneInfo:{"count":12,"to":"Wine fridge"}')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'racks.moveBottles.showRack:{"name":"Wine fridge"}' }));
    expect(onShowRack).toHaveBeenCalledWith('cab');
  });

  test('a rack with too little room says which bottles stay', async () => {
    const onMove = vi.fn().mockResolvedValue({ ok: true, data: { moved: 4, left: 8 } });
    render(<MoveRackBottlesModal rack={source} racks={[source, small]} onMove={onMove} onShowRack={() => {}} onClose={() => {}} />);
    expect(screen.getByText('racks.moveBottles.notAllFit:{"fit":4,"count":12,"left":8,"from":"Old rack"}')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'racks.moveBottles.submit:{"count":4}' }));
    expect(await screen.findByText('racks.moveBottles.doneLeft:{"count":8,"from":"Old rack"}')).toBeTruthy();
  });

  test('a refused move shows the error and keeps the dialog', async () => {
    const onMove = vi.fn().mockResolvedValue({ ok: false, error: 'The other rack was changed at the same moment — nothing was moved.' });
    render(<MoveRackBottlesModal rack={source} racks={[source, roomy]} onMove={onMove} onShowRack={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'racks.moveBottles.submit:{"count":12}' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'racks.moveBottles.submit:{"count":12}' })).toBeTruthy();
  });

  test('no other rack: says to create one first', () => {
    render(<MoveRackBottlesModal rack={source} racks={[source]} onMove={vi.fn()} onShowRack={() => {}} onClose={() => {}} />);
    expect(screen.getByText('racks.moveBottles.noOtherRack')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /racks\.moveBottles\.submit/ })).toBeNull();
  });

  test('only full racks: the move button stays off', () => {
    render(<MoveRackBottlesModal rack={source} racks={[source, full]} onMove={vi.fn()} onShowRack={() => {}} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'racks.moveBottles.submit:{"count":0}' }).disabled).toBe(true);
  });
});
