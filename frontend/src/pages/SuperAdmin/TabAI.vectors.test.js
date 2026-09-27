import { render, screen, fireEvent } from '@testing-library/react';

// SuperAdmin → AI → Vector Search (2026-09): Qdrant is gone; the wine vectors
// are stored on the WineEmbedding rows and compared in memory. The panel
// shows what is stored and whether the registry-wide copy is loaded.

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch: vi.fn() }) }));

const { VectorSearchPanel } = await import('./TabAI');

test('shows the stored vectors, their size and the in-memory copy', () => {
  const onRefresh = vi.fn();
  render(<VectorSearchPanel onRefresh={onRefresh} vectors={{
    rows: 14106, dims: [2048], bytes: 14106 * 2048,
    memory: { rows: 14106, bytes: 14106 * 2048, builtAt: '2026-09-27T16:00:00Z' },
  }} />);
  expect(screen.getByText('Vector Search')).toBeInTheDocument();
  expect(screen.getByText('2048')).toBeInTheDocument();
  expect(screen.getByText('27.6 MB')).toBeInTheDocument();
  expect(screen.getByText(/vectors, 27\.6 MB/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(onRefresh).toHaveBeenCalled();
});

test('before any vector exists, and while the copy is not loaded', () => {
  render(<VectorSearchPanel onRefresh={() => {}} vectors={{ rows: 0, dims: [], bytes: 0, memory: null }} />);
  expect(screen.getByText('not loaded')).toBeInTheDocument();
  expect(screen.getByText('—')).toBeInTheDocument();
});
