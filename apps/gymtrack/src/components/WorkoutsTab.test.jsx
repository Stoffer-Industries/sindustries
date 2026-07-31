import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Mock plans.js — drives WorkoutsTab's pending-workouts query.
const mockListPendingPlannedWorkouts = vi.fn();
vi.mock('../lib/plans.js', () => ({
  listPendingPlannedWorkouts: (...args) => mockListPendingPlannedWorkouts(...args),
  fetchPlannedWorkoutForDate: vi.fn(),
  fetchPlannedWorkoutById: vi.fn(),
  shapePlannedWorkout: (row) => row,
  markPlannedWorkoutCompleted: vi.fn()
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

import WorkoutsTab from './WorkoutsTab.jsx';
import { dateBadgeStatus } from './WorkoutCard.jsx';

function renderWorkoutsTab() {
  return render(
    <MemoryRouter initialEntries={['/workouts']}>
      <Routes>
        <Route path="/workouts" element={<WorkoutsTab />} />
        <Route path="/login" element={<div data-testid="login-page">Login</div>} />
      </Routes>
    </MemoryRouter>
  );
}

const TODAY = '2026-08-01'; // a fixed reference date for deterministic tests

function makeWorkout({ id, scheduled_for, title = 'Push day', sets = [] }) {
  return {
    id,
    user_id: 'user-1',
    agent_key_id: null,
    scheduled_for,
    title,
    notes: null,
    status: 'planned',
    sets
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('WorkoutsTab', () => {
  it('renders a loading state on first render', () => {
    mockListPendingPlannedWorkouts.mockReturnValue(new Promise(() => {})); // never resolves
    renderWorkoutsTab();
    expect(screen.getByTestId('workouts-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('workout-cards')).not.toBeInTheDocument();
  });

  it('renders the empty state when there are no pending workouts', async () => {
    mockListPendingPlannedWorkouts.mockResolvedValueOnce({ data: [], error: null });
    renderWorkoutsTab();
    expect(await screen.findByTestId('workouts-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('workout-cards')).not.toBeInTheDocument();
  });

  it('renders one card per workout, in the order returned by the fetch', async () => {
    const nextWeek = makeWorkout({
      id: 'w-next-week',
      scheduled_for: '2026-08-08',
      title: 'Pull day',
      sets: [
        { id: 's-1', exercise_name: 'Deadlift', set_index: 1, target_reps: 5, target_weight: 140, unit: 'kg' }
      ]
    });
    const today = makeWorkout({
      id: 'w-today',
      scheduled_for: '2026-08-01',
      title: 'Push day',
      sets: [
        { id: 's-2', exercise_name: 'Bench Press', set_index: 1, target_reps: 5, target_weight: 80, unit: 'kg' },
        { id: 's-3', exercise_name: 'Bench Press', set_index: 2, target_reps: 5, target_weight: 82.5, unit: 'kg' }
      ]
    });
    // Supabase ordering is asserted by the integration test (e2e + plans.js
    // unit test); here we assert the UI honours the array order it's given.
    mockListPendingPlannedWorkouts.mockResolvedValueOnce({ data: [today, nextWeek], error: null });
    renderWorkoutsTab();

    const cardsList = await screen.findByTestId('workout-cards');
    const todayCard = within(cardsList).getByTestId('workout-card-w-today');
    const nextWeekCard = within(cardsList).getByTestId('workout-card-w-next-week');
    expect(todayCard).toHaveAttribute('data-testid', 'workout-card-w-today');
    expect(nextWeekCard).toHaveAttribute('data-testid', 'workout-card-w-next-week');
    // DOM order reflects the order the fetch returned them in.
    expect(todayCard.compareDocumentPosition(nextWeekCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('visually distinguishes today, overdue, and upcoming cards via data-status + badge testIDs', async () => {
    const upcoming = makeWorkout({
      id: 'w-upcoming',
      scheduled_for: '2026-08-15',
      title: 'Future leg day',
      sets: [{ id: 's-u', exercise_name: 'Back Squat', set_index: 1, target_reps: 5, target_weight: 120, unit: 'kg' }]
    });
    const today = makeWorkout({
      id: 'w-today',
      scheduled_for: TODAY,
      title: "Today's push day",
      sets: [{ id: 's-t', exercise_name: 'Bench Press', set_index: 1, target_reps: 5, target_weight: 80, unit: 'kg' }]
    });
    const overdue = makeWorkout({
      id: 'w-overdue',
      scheduled_for: '2026-07-25',
      title: 'Last week pull day',
      sets: [{ id: 's-o', exercise_name: 'Pull-up', set_index: 1, target_reps: 8, target_weight: 0, unit: 'kg' }]
    });
    mockListPendingPlannedWorkouts.mockResolvedValueOnce({
      data: [overdue, today, upcoming],
      error: null
    });
    renderWorkoutsTab();

    expect(await screen.findByTestId('workout-card-w-today')).toHaveAttribute('data-status', 'today');
    expect(screen.getByTestId('workout-card-w-today-badge')).toHaveTextContent('Today');

    expect(screen.getByTestId('workout-card-w-overdue')).toHaveAttribute('data-status', 'overdue');
    expect(screen.getByTestId('workout-card-w-overdue-badge')).toHaveTextContent('Overdue');

    expect(screen.getByTestId('workout-card-w-upcoming')).toHaveAttribute('data-status', 'upcoming');
    expect(screen.queryByTestId('workout-card-w-upcoming-badge')).not.toBeInTheDocument();
  });

  it('renders an exercise/set summary on each card', async () => {
    mockListPendingPlannedWorkouts.mockResolvedValueOnce({
      data: [
        makeWorkout({
          id: 'w-multi',
          scheduled_for: '2026-08-02',
          title: 'Multi-exercise day',
          sets: [
            { id: 's-1', exercise_name: 'Bench Press', set_index: 1, target_reps: 5, target_weight: 80, unit: 'kg' },
            { id: 's-2', exercise_name: 'Bench Press', set_index: 2, target_reps: 5, target_weight: 82.5, unit: 'kg' },
            { id: 's-3', exercise_name: 'Overhead Press', set_index: 1, target_reps: 5, target_weight: 40, unit: 'kg' }
          ]
        })
      ],
      error: null
    });
    renderWorkoutsTab();
    expect(await screen.findByTestId('workout-card-w-multi')).toBeInTheDocument();
    expect(screen.getByText(/Bench Press, Overhead Press · 3 sets/i)).toBeInTheDocument();
  });

  it('links each card to /workout?date=<scheduled_for>', async () => {
    mockListPendingPlannedWorkouts.mockResolvedValueOnce({
      data: [
        makeWorkout({
          id: 'w-link',
          scheduled_for: '2026-08-12',
          title: 'Future push',
          sets: [{ id: 's-l', exercise_name: 'Bench Press', set_index: 1, target_reps: 5, target_weight: 80, unit: 'kg' }]
        })
      ],
      error: null
    });
    renderWorkoutsTab();
    const card = await screen.findByTestId('workout-card-w-link');
    expect(card.tagName.toLowerCase()).toBe('a');
    expect(card).toHaveAttribute('href', '/workout?date=2026-08-12');
  });

  it('renders an inline error banner when the fetch fails', async () => {
    mockListPendingPlannedWorkouts.mockResolvedValueOnce({
      data: null,
      error: new Error('RLS denied (token expired)')
    });
    renderWorkoutsTab();
    expect(await screen.findByTestId('workouts-error')).toHaveTextContent(/RLS denied/i);
    expect(screen.queryByTestId('workout-cards')).not.toBeInTheDocument();
  });
});

describe('dateBadgeStatus (AC2 visual-distinction helper)', () => {
  it('classifies dates relative to today: overdue, today, upcoming', () => {
    expect(dateBadgeStatus('2026-07-25', TODAY)).toBe('overdue');
    expect(dateBadgeStatus(TODAY, TODAY)).toBe('today');
    expect(dateBadgeStatus('2026-08-02', TODAY)).toBe('upcoming');
  });
});
