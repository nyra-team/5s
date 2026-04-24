import { Factory, Warehouse, Home } from "lucide-react";
import type { ComponentType } from "react";

export type EnvironmentType = "factory" | "warehouse" | "home";

export const ENVIRONMENT_LABELS: Record<EnvironmentType, string> = {
  factory: "Factory",
  warehouse: "Warehouse",
  home: "Home",
};

const ENVIRONMENT_ICONS: Record<EnvironmentType, ComponentType<{ className?: string }>> = {
  factory: Factory,
  warehouse: Warehouse,
  home: Home,
};

const ENVIRONMENT_TONE: Record<EnvironmentType, string> = {
  factory: "bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  warehouse: "bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  home: "bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
};

export function normalizeEnvironment(value: unknown): EnvironmentType {
  if (value === "warehouse" || value === "home" || value === "factory") return value;
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
