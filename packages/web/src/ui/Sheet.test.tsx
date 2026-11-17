import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Sheet } from './Sheet';

afterEach(cleanup);

function Harness({ empty }: { empty?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>opener</button>
      <Sheet open={open} onClose={() => setOpen(false)} label="Test sheet">
        {empty ? (
          <p>nothing</p>
        ) : (
          <>
            <button>one</button>
            <button>two</button>
          </>
        )}
      </Sheet>
    </>
  );
}

function openIt() {
  const opener = screen.getByText('opener');
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

describe('Sheet focus', () => {
  it('has dialog semantics and focuses the first focusable on open', () => {
    render(<Harness />);
    openIt();
    const d = screen.getByRole('dialog', { name: 'Test sheet' });
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(screen.getByText('one'));
  });

  it('focuses the dialog itself when nothing is focusable', () => {
    render(<Harness empty />);
    openIt();
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('wraps Tab and Shift+Tab', () => {
    render(<Harness />);
    openIt();
    const two = screen.getByText('two');
    two.focus();
    fireEvent.keyDown(two, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByText('one'));
    fireEvent.keyDown((document.activeElement as Element), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(two);
  });

  it('pulls focus back in if it escaped', () => {
    render(<Harness />);
    const opener = openIt();
    opener.focus();
    fireEvent.keyDown(opener, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByText('one'));
  });

  it('restores focus on Escape and on backdrop click', () => {
    render(<Harness />);
    const opener = openIt();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    openIt();
    fireEvent.click((screen.getByRole('dialog').parentElement as HTMLElement));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('does not close on unrelated keys', () => {
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} label="x">
        <button>a</button>
      </Sheet>,
    );
    fireEvent.keyDown(window, { key: 'a' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
