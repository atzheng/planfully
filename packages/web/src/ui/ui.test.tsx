import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Badge } from './Badge';
import { Button } from './Button';
import { Chip } from './Chip';
import { Field } from './Field';
import { Input, Select, Textarea } from './Input';
import { Menu, nextMenuIndex } from './Menu';
import { Popover, placePopover } from './Popover';
import { SegmentedControl, nextSegmentIndex } from './SegmentedControl';
import { Sheet } from './Sheet';

afterEach(cleanup);

describe('Button', () => {
  it('defaults to type=button and supports variants, sizes and the legacy primary flag', () => {
    render(
      <>
        <Button>a</Button>
        <Button primary>b</Button>
        <Button variant="danger" size="sm">
          c
        </Button>
      </>,
    );
    expect(screen.getByText('a').getAttribute('type')).toBe('button');
    expect(screen.getByText('b').className).toContain('primary');
    expect(screen.getByText('c').className).toMatch(/danger/);
    expect(screen.getByText('c').className).toMatch(/sm/);
  });
  it('icon-only and fab keep their aria-label', () => {
    render(
      <>
        <Button iconOnly aria-label="Close">
          x
        </Button>
        <Button fab aria-label="Add event">
          +
        </Button>
      </>,
    );
    expect(screen.getByLabelText('Close').className).toContain('iconOnly');
    expect(screen.getByLabelText('Add event').className).toContain('fab');
  });
});

describe('Chip and Badge', () => {
  it('chip toggles aria-pressed', () => {
    const onClick = vi.fn();
    render(
      <Chip selected onClick={onClick}>
        Food
      </Chip>,
    );
    const chip = screen.getByRole('button', { name: 'Food' });
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalled();
  });
  it('badge renders its count', () => {
    render(<Badge tone="accent">3</Badge>);
    expect(screen.getByText('3')).toBeTruthy();
  });
});

describe('Field', () => {
  it('links label, hint and error to the control', () => {
    render(
      <Field label="Name" hint="Shown on the trip" error="Required">
        {(p) => <Input {...p} />}
      </Field>,
    );
    const input = screen.getByLabelText('Name');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const described = input.getAttribute('aria-describedby') ?? '';
    expect(described.split(' ')).toHaveLength(2);
    expect(document.getElementById(described.split(' ')[0] ?? '')?.textContent).toBe('Required');
  });
  it('Textarea and Select forward refs and props', () => {
    render(
      <>
        <Textarea aria-label="t" />
        <Select aria-label="s">
          <option>one</option>
        </Select>
      </>,
    );
    expect(screen.getByLabelText('t').tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText('s').tagName).toBe('SELECT');
  });
});

describe('SegmentedControl', () => {
  const options = [
    { value: 'none', label: 'None' },
    { value: 'type', label: 'Type' },
    { value: 'person', label: 'Person' },
  ] as const;
  function Harness() {
    const [v, setV] = useState<(typeof options)[number]['value']>('none');
    return <SegmentedControl label="Lanes" options={options} value={v} onChange={setV} />;
  }

  it('nextSegmentIndex wraps and handles Home/End', () => {
    expect(nextSegmentIndex('ArrowRight', 2, 3)).toBe(0);
    expect(nextSegmentIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(nextSegmentIndex('Home', 1, 3)).toBe(0);
    expect(nextSegmentIndex('End', 1, 3)).toBe(2);
    expect(nextSegmentIndex('a', 1, 3)).toBeNull();
  });

  it('has roving tabindex; arrow keys move focus and selection', () => {
    render(<Harness />);
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    radios[0]?.focus();
    fireEvent.keyDown(radios[0] as HTMLElement, { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: 'Type' }).getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Type' }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    expect(screen.getByRole('radio', { name: 'Person' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: 'None' }).getAttribute('aria-checked')).toBe('true');
  });

  it('click selects', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('radio', { name: 'Person' }));
    expect(screen.getByRole('radio', { name: 'Person' }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('placePopover', () => {
  const vp = { width: 400, height: 600 };
  it('goes below, aligned to the start', () => {
    const p = placePopover(
      { top: 10, left: 20, right: 60, bottom: 40 },
      { width: 100, height: 100 },
      vp,
    );
    expect(p).toEqual({ top: 44, left: 20, placement: 'below' });
  });
  it('aligns to the end and clamps to the viewport', () => {
    const p = placePopover(
      { top: 10, left: 350, right: 390, bottom: 40 },
      { width: 200, height: 100 },
      vp,
      { align: 'end' },
    );
    expect(p.left).toBe(190);
    const q = placePopover(
      { top: 10, left: 395, right: 399, bottom: 40 },
      { width: 200, height: 100 },
      vp,
    );
    expect(q.left).toBe(192);
  });
  it('flips above when there is no room below', () => {
    const p = placePopover(
      { top: 540, left: 0, right: 40, bottom: 570 },
      { width: 100, height: 200 },
      vp,
    );
    expect(p.placement).toBe('above');
    expect(p.top).toBe(336);
  });
});

describe('nextMenuIndex', () => {
  it('skips disabled items and wraps', () => {
    const enabled = [true, false, true];
    expect(nextMenuIndex('ArrowDown', 0, enabled)).toBe(2);
    expect(nextMenuIndex('ArrowDown', 2, enabled)).toBe(0);
    expect(nextMenuIndex('ArrowUp', 0, enabled)).toBe(2);
    expect(nextMenuIndex('Home', 2, enabled)).toBe(0);
    expect(nextMenuIndex('End', 0, enabled)).toBe(2);
    expect(nextMenuIndex('x', 0, enabled)).toBeNull();
  });
});

describe('Menu', () => {
  function Harness({ onSelect = vi.fn() }: { onSelect?: () => void }) {
    return (
      <>
        <button>outside</button>
        <Menu
          label="More"
          items={[
            { label: 'Export', onSelect },
            { label: 'Disabled', onSelect, disabled: true },
            { separator: true },
            { label: 'Settings', onSelect },
          ]}
          trigger={(p) => (
            <button {...p} data-testid="trigger">
              More
            </button>
          )}
        />
      </>
    );
  }
  const open = () => {
    const t = screen.getByTestId('trigger');
    t.focus();
    fireEvent.click(t);
    return t;
  };

  it('opens, focuses the first item and exposes menu roles', () => {
    render(<Harness />);
    const t = open();
    expect(t.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menu', { name: 'More' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Export' }));
  });

  it('arrow keys move between enabled items, wrapping', () => {
    render(<Harness />);
    open();
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Settings' }));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Export' }));
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Settings' }));
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Export' }));
  });

  it('Escape closes and returns focus to the trigger', () => {
    render(<Harness />);
    const t = open();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(t);
  });

  it('a press outside closes it without stealing focus', () => {
    render(<Harness />);
    open();
    const outside = screen.getByText('outside');
    fireEvent.pointerDown(outside);
    outside.focus();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it('a press inside does not close; selecting runs the action and closes', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    open();
    fireEvent.pointerDown(screen.getByRole('menu'));
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('ArrowDown on the closed trigger opens it', () => {
    render(<Harness />);
    fireEvent.keyDown(screen.getByTestId('trigger'), { key: 'ArrowDown' });
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('Escape inside a Sheet closes only the menu', () => {
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} label="Sheet">
        <Harness />
      </Sheet>,
    );
    open();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    // With the menu closed, Escape reaches the sheet again.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Popover', () => {
  it('moves focus in, closes on Escape and click-outside, and restores focus', () => {
    const onClose = vi.fn();
    function Harness({ open }: { open: boolean }) {
      const [ref] = useState(() => ({ current: null as HTMLButtonElement | null }));
      return (
        <>
          <button ref={(el) => void (ref.current = el)}>anchor</button>
          <button>other</button>
          <Popover open={open} onClose={onClose} anchorRef={ref} label="Filters">
            <input aria-label="query" />
          </Popover>
        </>
      );
    }
    const { rerender } = render(<Harness open />);
    expect(document.activeElement).toBe(screen.getByLabelText('query'));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(screen.getByText('other'));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.pointerDown(screen.getByText('anchor'));
    fireEvent.pointerDown(screen.getByLabelText('query'));
    expect(onClose).toHaveBeenCalledTimes(2);
    act(() => rerender(<Harness open={false} />));
    expect(document.activeElement).toBe(screen.getByText('anchor'));
  });
});
