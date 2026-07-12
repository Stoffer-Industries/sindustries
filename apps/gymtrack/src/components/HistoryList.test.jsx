import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('../lib/supabase.js', () => ({ supabase: { auth: { getUser: vi.fn(), onAuthStateChange: vi.fn() } } }));

const mockListWorkouts = vi.fn();
const mockListSetsForWorkouts = vi.fn();
vi.mock('../lib/workouts.js', () => ({
  listWorkouts: (...args) => mockListWorkouts(...args),
  listSetsForWorkouts: (...args) => mockListSetsForWorkouts(...args)
}));

vi.mock('../lib/auth.jsx', () => ({
  useAuth: () => ({
    session: { user: { id: 'user-1' } },
    user: { id: 'user-1' },
    loading: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn()
  }),
  AuthProvider: ({ children }) => children
}));

import HistoryList from './HistoryList.jsx';

function renderHistory() {
  return render(
    <MemoryRouter initialEntries={['/history']}>
      <Routes>
        <Route path="/history" element={<HistoryList />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('HistoryList', () => {
  it('shows empty state when there are no workouts', async () => {
    mockListWorkouts.mockResolvedValueOnce({ data: [], error: null });

    renderHistory();
    expect(await screen.findByTestId('history-empty')).toBeInTheDocument();
  });

  it('groups workouts by date and shows their sets', async () => {
    mockListWorkouts.mockResolvedValueOnce({
      data: [
        { id: 'w-1', user_id: 'user-1', performed_at: '2026-07-12T08:00:00Z', notes: null },
        { id: 'w-2', user_id: 'user-1', performed_at: '2026-07-10T08:00:00Z', notes: null }
      ],
      error: null
    });
    mockListSetsForWorkouts.mockResolvedValueOnce({
      data: [
        { id: 's-1', workout_id: 'w-1', exercise_name: 'Bench Press', set_index: 1, reps: 5, weight: 80, unit: 'kg' },
        { id: 's-2', workout_id: 'w-1', exercise_name: 'Bench Press', set_index: 2, reps: 5, weight: 82.5, unit: 'kg' },
        { id: 's-3', workout_id: 'w-2', exercise_name: 'Back Squat', set_index: 1, reps: 5, weight: 120, unit: 'kg' }
      ],
      error: null
    });

    renderHistory();

    await waitFor(() => {
      expect(screen.getByTestId('day-2026-07-12')).toBeInTheDocument();
    });
    expect(screen.getByTestId('day-2026-07-10')).toBeInTheDocument();

    const today = screen.getByTestId('workout-w-1');
    expect(within(today).getAllByText(/Bench Press/)).toHaveLength(2);
    expect(within(today).getByText(/#2 · 5 × 82.5 kg/)).toBeInTheDocument();
  });

  it('shows an error banner on failure', async () => {
    mockListWorkouts.mockResolvedValueOnce({ data: null, error: new Error('oops') });

    renderHistory();
    expect(await screen.findByTestId('history-error')).toHaveTextContent(/oops/);
  });
});