"use client";

import { useState } from "react";
import {
  Button,
  Chip,
  Card,
  Input,
  Textarea,
  Slider,
  Toggle,
  SegmentedControl,
  StatusPill,
  BottomSheet,
  ProgressBar,
  ProgressDots,
  PageHeader,
  Icon,
} from "@/components/ui";
import { BottomNav } from "@/components/shell/BottomNav";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-label-sm uppercase tracking-wider text-on-surface-variant">{title}</h2>
      <div className="flex flex-col gap-4 rounded-lg border border-outline-variant/60 bg-surface-container-lowest p-4">
        {children}
      </div>
    </section>
  );
}

export default function KitPage() {
  const [chips, setChips] = useState<Record<string, boolean>>({ History: true, Art: true });
  const [slider, setSlider] = useState(3);
  const [toggle, setToggle] = useState(true);
  const [seg, setSeg] = useState<"timeline" | "calendar">("timeline");
  const [sheet, setSheet] = useState(false);
  const [dots, setDots] = useState(0);

  return (
    <main className="mx-auto flex max-w-[480px] flex-col gap-8 px-5 pb-24 pt-4">
      <PageHeader title="Roameo UI Kit" showBack action={<Icon name="tune" />} />

      <Section title="Buttons">
        <div className="flex flex-wrap gap-3">
          <Button variant="orange">Orange</Button>
          <Button variant="navy">Navy</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button variant="navy" leadingIcon="add">Leading</Button>
          <Button variant="outline" trailingIcon="arrow_forward">Trailing</Button>
          <Button variant="orange" size="sm">Small</Button>
          <Button variant="navy" disabled>Disabled</Button>
        </div>
        <Button variant="orange" fullWidth trailingIcon="arrow_forward">Full width CTA</Button>
      </Section>

      <Section title="Chips">
        <div className="flex flex-wrap gap-2">
          {(["History", "Anime", "Art", "Hiking", "Nightlife"] as const).map((c) => (
            <Chip
              key={c}
              label={c}
              leadingIcon="interests"
              selected={!!chips[c]}
              onClick={() => setChips((p) => ({ ...p, [c]: !p[c] }))}
            />
          ))}
        </div>
      </Section>

      <Section title="Cards">
        <Card>
          <h3 className="text-headline-sm text-on-surface">Plain card</h3>
          <p className="text-body-md text-on-surface-variant">White surface, 16px radius, soft shadow.</p>
        </Card>
        <Card accent>
          <h3 className="text-headline-sm text-on-surface">Accent card</h3>
          <p className="text-body-md text-on-surface-variant">Left navy accent bar for itinerary items.</p>
        </Card>
        <Card as="button" onClick={() => setSheet(true)} className="text-left w-full">
          <span className="text-body-md text-on-surface">Polymorphic (button) — opens the sheet</span>
        </Card>
      </Section>

      <Section title="Inputs">
        <Input label="Destination" placeholder="Where to?" leadingIcon="search" />
        <Input label="Email" placeholder="you@example.com" helperText="We never share this." />
        <Input label="Field with error" defaultValue="bad" error="Something went wrong" />
        <Textarea label="Rules for Roameo" placeholder="e.g. Always suggest window seats…" />
      </Section>

      <Section title="Sliders">
        <Slider
          value={slider}
          onChange={setSlider}
          leftLabel="Luxury"
          rightLabel="Backpacker"
          aria-label="Luxury to Backpacker"
        />
        <p className="text-label-sm text-on-surface-variant">value: {slider}</p>
      </Section>

      <Section title="Toggle & Segmented">
        <Toggle checked={toggle} onChange={setToggle} label="Weather alerts" />
        <SegmentedControl
          value={seg}
          onChange={setSeg}
          options={[
            { value: "timeline", label: "Timeline", icon: "view_agenda" },
            { value: "calendar", label: "Calendar", icon: "calendar_month" },
          ]}
        />
      </Section>

      <Section title="Status pills">
        <div className="flex flex-wrap gap-2">
          <StatusPill tone="success" icon="check_circle" label="Quiet now" />
          <StatusPill tone="info" icon="info" label="Open till 6pm" />
          <StatusPill tone="warning" icon="rainy" label="Rain expected" />
          <StatusPill tone="error" icon="error" label="Closed" />
          <StatusPill tone="neutral" label="$$$$" />
        </div>
      </Section>

      <Section title="Progress">
        <ProgressBar value={65} />
        <ProgressBar value={40} tone="orange" />
        <div className="flex items-center justify-between">
          <ProgressDots count={3} active={dots} />
          <Button size="sm" variant="ghost" onClick={() => setDots((d) => (d + 1) % 3)}>
            Next
          </Button>
        </div>
      </Section>

      <Section title="Icons">
        <div className="flex items-center gap-4 text-primary">
          <Icon name="home" />
          <Icon name="auto_awesome" filled />
          <Icon name="map" size={32} />
          <Icon name="star" filled size={20} className="text-secondary-container" />
        </div>
      </Section>

      <Section title="Bottom sheet">
        <Button variant="navy" onClick={() => setSheet(true)}>Open sheet</Button>
      </Section>

      <Section title="BottomNav (static preview)">
        <p className="text-label-sm text-on-surface-variant">
          Live nav is fixed at the bottom of the viewport.
        </p>
      </Section>

      <BottomSheet open={sheet} onClose={() => setSheet(false)} title="Add to trip">
        <div className="flex flex-col gap-2">
          <Button variant="ghost" fullWidth leadingIcon="place" className="justify-start">
            Find a Spot
          </Button>
          <Button variant="ghost" fullWidth leadingIcon="restaurant" className="justify-start">
            Add Reservation
          </Button>
          <Button variant="ghost" fullWidth leadingIcon="edit_note" className="justify-start">
            Add Note
          </Button>
        </div>
      </BottomSheet>

      <BottomNav />
    </main>
  );
}
