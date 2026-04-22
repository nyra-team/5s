import { Sun, Moon, Monitor } from "lucide-react";
import { useTheme, ThemeMode } from "@/lib/theme";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function ThemeToggle() {
  const { mode, resolved, setMode } = useTheme();

  const Icon = resolved === "dark" ? Moon : Sun;

  const items: { value: ThemeMode; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
    { value: "system", label: "System", icon: Monitor },
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="p-2 rounded-full text-muted-foreground hover:text-foreground hover-overlay transition-colors"
          title="Theme"
          data-testid="button-theme-toggle"
          aria-label="Toggle theme"
        >
          <Icon className="w-[18px] h-[18px]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="rounded-xl min-w-[160px]">
        {items.map((item) => {
          const ItemIcon = item.icon;
          const active = mode === item.value;
          return (
            <DropdownMenuItem
              key={item.value}
              onClick={() => setMode(item.value)}
              className={`gap-2.5 text-[13px] cursor-pointer ${active ? "font-semibold text-foreground" : "text-muted-foreground"}`}
              data-testid={`theme-option-${item.value}`}
            >
              <ItemIcon className="w-4 h-4" />
              {item.label}
              {active && <span className="ml-auto text-primary">●</span>}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
