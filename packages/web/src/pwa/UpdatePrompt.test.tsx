import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = { needRefresh: false, update: vi.fn(), set: vi.fn() };
vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: () => ({
    needRefresh: [state.needRefresh, state.set],
    offlineReady: [false, vi.fn()],
    updateServiceWorker: state.update,
  }),
}));

import { UpdatePrompt } from './UpdatePrompt';

afterEach(() => {
  state.needRefresh = false;
  state.update.mockClear();
  state.set.mockClear();
});

describe('UpdatePrompt', () => {
  it('renders nothing when no update is waiting', () => {
    const { container } = render(<UpdatePrompt />);
    expect(container.textContent).toBe('');
  });

  it('offers a reload that activates the new worker', () => {
    state.needRefresh = true;
    render(<UpdatePrompt />);
    expect(screen.getByText('New version available')).toBeTruthy();
    fireEvent.click(screen.getByText('Reload'));
    expect(state.update).toHaveBeenCalledWith(true);
  });

  it('can be dismissed', () => {
    state.needRefresh = true;
    render(<UpdatePrompt />);
    fireEvent.click(screen.getByText('Later'));
    expect(state.set).toHaveBeenCalledWith(false);
  });
});
