import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Mock supabase so workouts.js doesn't try to instantiate the real client.
vi.mock('../lib/supabase.js', () => ({ supabase: { auth: { getUser: vi.fn(), onAuthStateChange: vi.fn() } } }));

// Mock workouts.js so we can drive createWorkout + addSets responses.
const mockCreateWorkout = vi.fn();
const mockAddSets = vi.fn();
vi.mock('../lib/workouts.js', () => ({
  createWorkout: (...args) => mockCreateWorkout(...args),
  addSets: (...args) => mockAddSets(...args)
}));

// Mock plans.js so the workout-date useEffect doesn't hit Supabase — these
// tests cover the freeform (no-plan) path. Plan-mode UI is exercised in
// the screenshot/E2E coverage.
const mockFetchPlannedWorkoutForDate = vi.fn();
const mockMarkPlannedWorkoutCompleted = vi.fn();
vi.mock('../lib/plans.js', () => ({
  fetchPlannedWorkoutForDate: (...args) => mockFetchPlannedWorkoutForDate(...args),
  markPlannedWorkoutCompleted: (...args) => mockMarkPlannedWorkoutCompleted(...args),
  fetchPlannedWorkoutById: vi.fn(),
  shapePlannedWorkout: (row) => row
}));

// Mock auth so useAuth() returns a signed-in session.
const mockSignOut = vi.fn();
vi.mock('../lib/auth.jsx', () => ({
  useAuth: () => ({
    session: { user: { id: 'user-1', email: 'tom@example.com' } },
    user: { id: 'user-1', email: 'tom@example.com' },
    loading: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: mockSignOut
  }),
  AuthProvider: ({ children }) => children
}));

import WorkoutLogger from './WorkoutLogger.jsx';

function renderLogger() {
  return render(
    <MemoryRouter initialEntries={['/workout']}>
      <Routes>
        <Route path="/workout" element={<WorkoutLogger />} />
        <Route path="/login" element={<div data-testid="login-page">Login</div>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchPlannedWorkoutForDate.mockResolvedValue({ data: null, error: null });
  mockMarkPlannedWorkoutCompleted.mockResolvedValue({ error: null });
});

describe('WorkoutLogger', () => {
  it('renders the form and an empty pending state', () => {
    renderLogger();
    expect(screen.getByTestId('set-form')).toBeInTheDocument();
    expect(screen.getByTestId('pending-sets')).toBeInTheDocument();
    expect(screen.getByText(/No extra sets added/i)).toBeInTheDocument();
  });

  it('adds a set and shows it grouped under the exercise', async () => {
    const user = userEvent.setup();
    renderLogger();

    // Default exercise is "Back Squat" (first in catalogue). Pick Bench Press.
    await user.selectOptions(screen.getByTestId('exercise-select'), 'Bench Press');

    // Fill reps and weight.
    const repsInput = screen.getByTestId('reps-input');
    const weightInput = screen.getByTestId('weight-input');
    await user.clear(repsInput);
    await user.type(repsInput, '5');
    await user.clear(weightInput);
    await user.type(weightInput, '80');

    await user.click(screen.getByTestId('add-set'));

    const group = screen.getByTestId('group-Bench Press');
    expect(within(group).getByText(/5 reps × 80 kg/)).toBeInTheDocument();
  });

  it('calls createWorkout + addSets on Save and clears the form', async () => {
    mockCreateWorkout.mockResolvedValueOnce({
      data: { id: 'w-1', user_id: 'user-1', performed_at: '2026-07-12T00:00:00.000Z' },
      error: null
    });
    mockAddSets.mockResolvedValueOnce({ data: [{ id: 's-1' }, { id: 's-2' }], error: null });

    const user = userEvent.setup();
    renderLogger();

    await user.click(screen.getByTestId('add-set')); // bench press default, 5x5x0
    await user.click(screen.getByTestId('add-set'));

    await user.click(screen.getByTestId('save-workout'));

    expect(mockCreateWorkout).toHaveBeenCalledTimes(1);
    expect(mockAddSets).toHaveBeenCalledTimes(1);
    const setsArg = mockAddSets.mock.calls[0][0];
    expect(setsArg.workout_id).toBe('w-1');
    expect(setsArg.sets).toHaveLength(2);

    // success status appears
    expect(await screen.findByTestId('save-status')).toHaveTextContent(/Workout saved/i);
    // pending list cleared
    expect(screen.getByText(/No extra sets added/i)).toBeInTheDocument();
  });

  it('shows an error banner when save fails', async () => {
    mockCreateWorkout.mockResolvedValueOnce({ data: null, error: new Error('DB down') });

    const user = userEvent.setup();
    renderLogger();

    await user.click(screen.getByTestId('add-set'));
    await user.click(screen.getByTestId('save-workout'));

    expect(await screen.findByTestId('save-status')).toHaveTextContent(/DB down/);
  });
});