import { Factory, Warehouse, Home, Building2, ListChecks } from "lucide-react";
import type { ComponentType } from "react";

export type EnvironmentType = "factory" | "warehouse" | "home" | "corporate_office";

export const ENVIRONMENT_LABELS: Record<EnvironmentType, string> = {
  factory: "Factory",
  warehouse: "Warehouse",
  home: "Home",
  corporate_office: "Corporate Office",
};

// Quick-start "what to include in your walk-through" hints shown to operators
// in the capture sheet, tailored to the area's environmentType. Kept to 3-5
// short bullets per environment so the list is scannable on a phone before
// the operator hits record. The Corporate Office set is the original
// motivator — desks/meeting rooms/kitchen/cupboards/print zones are the
// least obvious targets in an office 5S walk-through.
export const ENVIRONMENT_CHECKLIST: Record<EnvironmentType, string[]> = {
  factory: [
    "Walk past every machine and workstation",
    "Pan over PPE racks and emergency exits",
    "Capture chemical or oil storage areas",
    "Show the scrap and waste collection points",
  ],
  warehouse: [
    "Walk each aisle end-to-end",
    "Capture the loading dock and outbound staging",
    "Show forklift and pallet-jack parking spots",
    "Pan over the receiving area and inventory racks",
    "Include spill kits and fire-safety stations",
  ],
  home: [
    "Walk through every room you're auditing",
    "Open the pantry and main cupboards",
    "Capture the kitchen sink and counters",
    "Show the laundry or utility area",
    "Include shared spaces like the entryway",
  ],
  corporate_office: [
    "Walk past every desk in the workspace",
    "Open meeting room doors and pan inside",
    "Capture the shared kitchen and sink",
    "Show storage cupboards and supply closets",
    "Include the printer and copy zones",
  ],
};

const ENVIRONMENT_ICONS: Record<EnvironmentType, ComponentType<{ className?: string }>> = {
  factory: Factory,
  warehouse: Warehouse,
  home: Home,
  corporate_office: Building2,
};

const ENVIRONMENT_TONE: Record<EnvironmentType, string> = {
  factory: "bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  warehouse: "bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  home: "bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
  corporate_office: "bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
};

export function normalizeEnvironment(value: unknown): EnvironmentType {
  if (
    value === "warehouse" ||
    value === "home" ||
    value === "factory" ||
    value === "corporate_office"
  ) {
    return value;
  }
  return "factory";
}

export function EnvironmentBadge({
  type,
  size = "sm",
  className = "",
  testId,
}: {
  type: EnvironmentType;
  size?: "sm" | "xs";
  className?: string;
  testId?: string;
}) {
  const Icon = ENVIRONMENT_ICONS[type];
  const tone = ENVIRONMENT_TONE[type];
  const sizeCls = size === "xs"
    ? "text-[10.5px] px-1.5 py-0.5 gap-1 [&>svg]:w-2.5 [&>svg]:h-2.5"
    : "text-[11px] px-2 py-0.5 gap-1 [&>svg]:w-3 [&>svg]:h-3";
  return (
    <span
      className={`inline-flex items-center rounded-full font-semibold ${tone} ${sizeCls} ${className}`}
      data-testid={testId}
    >
      <Icon />
      {ENVIRONMENT_LABELS[type]}
    </span>
  );
}

// Renders the environment-specific quick-start checklist as a compact card
// in the operator capture sheet. Lives next to ProfileHint so the operator
// sees both "what good looks like" (from the AI profile) AND "what to point
// the camera at" (from the static, environment-aware list) before they
// hit record.
//
// `override` lets a manager swap the default bullets for this area. When
// `override` is a non-empty array we render those bullets instead of the
// environment default; when it's `null`/`undefined`/empty, we fall back to
// the static list keyed by `type`. Operators see no UI change when no
// override is set.
export function EnvironmentChecklist({
  type,
  override,
  testId = "environment-checklist",
}: {
  type: EnvironmentType;
  override?: string[] | null;
  testId?: string;
}) {
  const cleanedOverride = override?.map((s) => s.trim()).filter(Boolean) ?? null;
  const usingOverride = !!cleanedOverride && cleanedOverride.length > 0;
  const items = usingOverride ? cleanedOverride! : ENVIRONMENT_CHECKLIST[type];
  if (!items || items.length === 0) return null;
  return (
    <div
      className="rounded-xl bg-secondary/60 p-3 space-y-2"
      data-testid={testId}
      data-environment={type}
      data-source={usingOverride ? "override" : "default"}
    >
      <p className="eyebrow inline-flex items-center gap-1.5">
        <ListChecks className="w-3 h-3" /> Include in your walk-through
      </p>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li
            key={i}
            className="text-[12.5px] text-foreground/85 leading-snug flex gap-2 items-start"
            data-testid={`${testId}-item-${i}`}
          >
            <span
              className="mt-1.5 inline-block w-1 h-1 rounded-full bg-foreground/60 shrink-0"
              aria-hidden="true"
            />
            <span className="flex-1">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
