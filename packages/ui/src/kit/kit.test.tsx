import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations, renderWithTheme } from '../../test/axe';
import { AnimatedList, BlurFade, NumberTicker } from '../motion';
import { reducedMotionStore } from '../theme/motion';
import {
  Accordion,
  AccordionItem,
  Badge,
  BentoGrid,
  BentoItem,
  Button,
  ButtonLink,
  Card,
  Dialog,
  Drawer,
  Field,
  IconButton,
  Input,
  Logo,
  RelativeTime,
  SegmentedControl,
  Select,
  Skeleton,
  StatCard,
  TabNav,
  TabPanel,
  Tabs,
  Textarea,
  ThemeToggle,
  formatRelative,
} from '.';

afterEach(() => reducedMotionStore.set('system'));

describe('Button', () => {
  it('is a plain button that never submits a form by accident', () => {
    renderWithTheme(
      <form onSubmit={(event) => event.preventDefault()}>
        <Button>Save</Button>
      </form>,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('type', 'button');
  });

  it('ignores clicks and reports busy while loading, and keeps its label and focus', async () => {
    const onClick = vi.fn();
    renderWithTheme(
      <Button variant="primary" loading onClick={onClick}>
        Create case
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Create case' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    button.focus();
    expect(button).toHaveFocus();
  });

  it('can look disabled yet stay focusable, so a keyboard user can find out why', async () => {
    const onClick = vi.fn();
    renderWithTheme(
      <Button disabledFocusable onClick={onClick}>
        Run the review
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Run the review' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    await userEvent.tab();
    expect(button).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('gives an icon-only button its accessible name, and a link-button is a link', () => {
    renderWithTheme(
      <>
        <IconButton icon={<span />} label="Copy fix" />
        <ButtonLink href="/cases/new" variant="primary">
          Add a case
        </ButtonLink>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Copy fix' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add a case' })).toHaveAttribute('href', '/cases/new');
  });
});

describe('Badge', () => {
  it('shows its label, and an icon-only badge is still named', () => {
    renderWithTheme(
      <>
        <Badge tone="productive" icon={<span />}>
          Good
        </Badge>
        <Badge tone="unsupported" iconOnly>
          Needs attention
        </Badge>
      </>,
    );
    expect(screen.getByText('Good')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Needs attention' })).toBeInTheDocument();
  });
});

function TabsDemo() {
  const [value, setValue] = useState('one');
  return (
    <Tabs
      aria-label="Sections"
      value={value}
      onValueChange={setValue}
      items={[
        { value: 'one', label: 'One' },
        { value: 'two', label: 'Two' },
        { value: 'three', label: 'Three' },
      ]}
    >
      <TabPanel value="one">First panel</TabPanel>
      <TabPanel value="two">Second panel</TabPanel>
      <TabPanel value="three">Third panel</TabPanel>
    </Tabs>
  );
}

describe('Tabs', () => {
  it('wires tabs to panels and keeps only the selected tab in the tab order', () => {
    renderWithTheme(<TabsDemo />);
    const one = screen.getByRole('tab', { name: 'One' });
    const two = screen.getByRole('tab', { name: 'Two' });
    expect(screen.getByRole('tablist', { name: 'Sections' })).toBeInTheDocument();
    expect(one).toHaveAttribute('aria-selected', 'true');
    expect(one).toHaveAttribute('tabindex', '0');
    expect(two).toHaveAttribute('tabindex', '-1');
    const panel = screen.getByRole('tabpanel', { name: 'One' });
    expect(panel).toHaveTextContent('First panel');
    expect(screen.queryByText('Second panel')).not.toBeInTheDocument();
  });

  it('moves with the arrow keys, wraps around, and jumps with Home and End', async () => {
    renderWithTheme(<TabsDemo />);
    await userEvent.tab();
    expect(screen.getByRole('tab', { name: 'One' })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Two' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Two' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Two' })).toHaveTextContent('Second panel');
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Three' })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'One' })).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Three' })).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'One' })).toHaveFocus();
  });
});

describe('TabNav', () => {
  it('marks the current page and leaves the others as plain links', () => {
    renderWithTheme(
      <TabNav
        aria-label="Case pages"
        items={[
          { href: '/cases/1/review', label: 'Review', active: true },
          { href: '/cases/1/evidence', label: 'Evidence', active: false },
        ]}
      />,
    );
    expect(screen.getByRole('link', { name: 'Review' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Evidence' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('navigation', { name: 'Case pages' })).toBeInTheDocument();
  });
});

describe('SegmentedControl', () => {
  it('is a radio group: one choice, arrow keys select, disabled choices are skipped', async () => {
    const onValueChange = vi.fn();
    renderWithTheme(
      <SegmentedControl
        aria-label="Source"
        value="paste"
        onValueChange={onValueChange}
        options={[
          { value: 'paste', label: 'Paste' },
          { value: 'upload', label: 'Upload', disabled: true },
          { value: 'sample', label: 'Sample' },
        ]}
      />,
    );
    expect(screen.getByRole('radiogroup', { name: 'Source' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Paste' })).toBeChecked();
    await userEvent.tab();
    await userEvent.keyboard('{ArrowRight}');
    expect(onValueChange).toHaveBeenCalledWith('sample');
  });
});

describe('Accordion', () => {
  it('opens and closes with aria-expanded, keeps closed content inert, and mounts it lazily', async () => {
    const { container } = renderWithTheme(
      <Accordion>
        <AccordionItem title="What is still missing" subtitle="3 open">
          Exact failure timestamps
        </AccordionItem>
      </Accordion>,
    );
    const trigger = screen.getByRole('button', { name: /What is still missing/ });
    const region = container.querySelector('[role="region"]');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(region).toHaveAttribute('inert');
    expect(screen.queryByText('Exact failure timestamps')).not.toBeInTheDocument();

    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(region).not.toHaveAttribute('inert');
    expect(screen.getByText('Exact failure timestamps')).toBeInTheDocument();

    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(region).toHaveAttribute('inert');
  });
});

describe('RelativeTime', () => {
  it('says how long ago in words, keeps the exact UTC time in the tooltip and for screen readers, and rounds a week or more to the date', () => {
    const now = Date.parse('2026-11-06T12:00:00.000Z');
    expect(formatRelative(new Date('2026-11-06T11:59:40.000Z'), now)).toBe('just now');
    expect(formatRelative(new Date('2026-11-06T11:15:00.000Z'), now)).toBe('45 minutes ago');
    expect(formatRelative(new Date('2026-11-06T09:00:00.000Z'), now)).toBe('3 hours ago');
    expect(formatRelative(new Date('2026-11-05T12:00:00.000Z'), now)).toBe('yesterday');
    expect(formatRelative(new Date('2026-11-08T12:00:00.000Z'), now)).toBe('in 2 days');
    expect(formatRelative(new Date('2026-10-01T08:00:00.000Z'), now)).toBe('1 Oct 2026');

    const value = new Date(Date.now() - 3 * 3_600_000).toISOString();
    renderWithTheme(<RelativeTime value={value} />);
    const time = screen.getByText(/3 hours ago/).closest('time');
    expect(time).toHaveAttribute('datetime', value);
    expect(time).toHaveAttribute('title', expect.stringMatching(/UTC$/));
    expect(time).toHaveTextContent(/\(.+UTC\)/);
  });

  it('shows a dash for a missing or invalid value', () => {
    renderWithTheme(
      <>
        <RelativeTime value={null} />
        <RelativeTime value="not a date" />
      </>,
    );
    expect(screen.getAllByText('—')).toHaveLength(2);
  });
});

describe('Dialog and Drawer', () => {
  it('shows a titled dialog, closes on Escape and on the close button', async () => {
    const onOpenChange = vi.fn();
    renderWithTheme(
      <Dialog
        open
        onOpenChange={onOpenChange}
        title="Delete this case"
        description="The case and its review are removed."
        actions={<Button variant="danger">Delete</Button>}
      />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Delete this case' });
    expect(within(dialog).getByText('The case and its review are removed.')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    onOpenChange.mockClear();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('an alert dialog is announced as one, has no close button, and Escape still cancels it', async () => {
    const onOpenChange = vi.fn();
    renderWithTheme(
      <Dialog
        open
        onOpenChange={onOpenChange}
        modalType="alert"
        title="Reset the demo"
        actions={<Button>Reset</Button>}
      />,
    );
    const dialog = await screen.findByRole('alertdialog', { name: 'Reset the demo' });
    expect(within(dialog).queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('shows a drawer with its title and subtitle', async () => {
    renderWithTheme(
      <Drawer open onOpenChange={() => undefined} title="Evidence" subtitle="Quoted from the chat">
        The customer said the error appeared after the update.
      </Drawer>,
    );
    const drawer = await screen.findByRole('dialog', { name: /Evidence/ });
    expect(within(drawer).getByText('Quoted from the chat')).toBeInTheDocument();
    expect(within(drawer).getByText(/appeared after the update/)).toBeInTheDocument();
  });
});

describe('Field and controls', () => {
  it('connects the label, hint and error to the control', async () => {
    renderWithTheme(
      <Field
        label="Case text"
        hint="Paste the whole conversation."
        error="Add at least 20 characters."
        required
      >
        <Textarea />
      </Field>,
    );
    const control = screen.getByLabelText(/Case text/);
    expect(control).toHaveAttribute('aria-invalid', 'true');
    expect(control).toHaveAttribute('aria-required', 'true');
    const described = control.getAttribute('aria-describedby') ?? '';
    expect(described.split(' ')).toHaveLength(2);
    expect(screen.getByText('Paste the whole conversation.')).toHaveAttribute(
      'id',
      described.split(' ')[0],
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Add at least 20 characters.');
  });

  it('forwards typing and selection to the native elements', async () => {
    renderWithTheme(
      <>
        <Field label="Title">
          <Input />
        </Field>
        <Field label="Workload">
          <Select defaultValue="">
            <option value="">Any workload</option>
            <option value="teams">Microsoft Teams</option>
          </Select>
        </Field>
      </>,
    );
    await userEvent.type(screen.getByLabelText('Title'), 'Sign-in failures');
    expect(screen.getByLabelText('Title')).toHaveValue('Sign-in failures');
    await userEvent.selectOptions(screen.getByLabelText('Workload'), 'teams');
    expect(screen.getByLabelText('Workload')).toHaveValue('teams');
  });
});

describe('StatCard and motion', () => {
  it('shows the label, the value and its status in words', () => {
    reducedMotionStore.set('reduce');
    renderWithTheme(
      <StatCard
        label="Time that could have been saved"
        value={58}
        unit="%"
        status="unsupported"
        statusLabel="High"
        delta={{ text: '+4 points since the last case', judgement: 'worsening' }}
        help="Share of effort a better step would have avoided."
      />,
    );
    expect(
      screen.getByRole('heading', { name: 'Time that could have been saved' }),
    ).toBeInTheDocument();
    expect(screen.getByText('58')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByText('(worsening)')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'About Time that could have been saved' }),
    ).toBeInTheDocument();
  });

  it('says so when there is no value', () => {
    renderWithTheme(<StatCard label="Score" value={null} />);
    expect(screen.getByText('No value available')).toBeInTheDocument();
  });

  it('counts up to its value and ends exactly on it', async () => {
    renderWithTheme(<NumberTicker value={72} />);
    await waitFor(() => expect(screen.getByText('72')).toBeInTheDocument(), { timeout: 2000 });
  });

  it('shows the final value at once when reduced motion is on', () => {
    reducedMotionStore.set('reduce');
    renderWithTheme(<NumberTicker value={72} />);
    expect(screen.getByText('72')).toBeInTheDocument();
  });

  it('keeps list semantics with and without motion', () => {
    const items = ['Ask for logs earlier', 'Rule out DNS first'];
    const { unmount } = renderWithTheme(
      <AnimatedList
        aria-label="Fixes"
        items={items}
        getKey={(item) => item}
        renderItem={(item) => item}
      />,
    );
    expect(
      within(screen.getByRole('list', { name: 'Fixes' })).getAllByRole('listitem'),
    ).toHaveLength(2);
    unmount();
    reducedMotionStore.set('reduce');
    renderWithTheme(
      <AnimatedList
        aria-label="Fixes"
        items={items}
        getKey={(item) => item}
        renderItem={(item) => item}
      />,
    );
    expect(
      within(screen.getByRole('list', { name: 'Fixes' })).getAllByRole('listitem'),
    ).toHaveLength(2);
  });

  it('staggers blur-fade by position, up to five steps, in CSS only', () => {
    renderWithTheme(
      <>
        <BlurFade data-testid="first">First</BlurFade>
        <BlurFade index={9} data-testid="late">
          Late
        </BlurFade>
      </>,
    );
    expect(screen.getByTestId('first')).toHaveClass('cg-blur-fade');
    expect(screen.getByTestId('first').style.getPropertyValue('--cg-stagger')).toBe('0');
    expect(screen.getByTestId('late').style.getPropertyValue('--cg-stagger')).toBe('5');
  });
});

describe('ThemeToggle, Logo, layout', () => {
  it('switches the theme and remembers it in the cookie the server reads', async () => {
    renderWithTheme(<ThemeToggle />, 'system');
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked();
    expect(document.documentElement.dataset.cgTheme).toBe('dark');
    expect(document.cookie).toContain('cg-theme=dark');
  });

  it('names the mark when there is no wordmark', () => {
    const { unmount } = renderWithTheme(<Logo />);
    expect(screen.getByText('CaseGuard')).toBeInTheDocument();
    unmount();
    renderWithTheme(<Logo wordmark={false} />);
    expect(screen.getByRole('img', { name: 'CaseGuard AI' })).toBeInTheDocument();
  });

  it('lets an item say how many of the 12 columns it takes at each width', () => {
    renderWithTheme(
      <BentoGrid>
        <BentoItem span={12} spanSm={6} spanLg={4} data-testid="cell">
          <Skeleton height={20} />
        </BentoItem>
      </BentoGrid>,
    );
    const cell = screen.getByTestId('cell');
    expect(cell.style.getPropertyValue('--cg-span')).toBe('12');
    expect(cell.style.getPropertyValue('--cg-span-sm')).toBe('6');
    expect(cell.style.getPropertyValue('--cg-span-lg')).toBe('4');
  });
});

describe('accessibility', () => {
  it('has no axe violations on a composed screen (light and dark)', async () => {
    for (const mode of ['light', 'dark'] as const) {
      const { container, unmount } = renderWithTheme(
        <main>
          <h1>Review</h1>
          <Card glow hero>
            <StatCard
              label="Score"
              value={36}
              status="unsupported"
              statusLabel="Poor"
              headingLevel={2}
            />
            <Button variant="primary">Copy fix list</Button>
            <IconButton icon={<span />} label="More" />
          </Card>
          <TabsDemo />
          <Accordion>
            <AccordionItem title="How this was calculated">Details</AccordionItem>
          </Accordion>
          <Field label="Search" hint="Reference, title or customer">
            <Input />
          </Field>
          <SegmentedControl
            aria-label="View"
            value="a"
            onValueChange={() => undefined}
            options={[
              { value: 'a', label: 'List' },
              { value: 'b', label: 'Cards' },
            ]}
          />
          <Badge tone="uncertain">Estimate</Badge>
        </main>,
        mode,
      );
      await act(async () => {
        await expectNoAxeViolations(container);
      });
      unmount();
    }
  });
});
