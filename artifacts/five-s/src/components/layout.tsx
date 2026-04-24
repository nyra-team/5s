import { useAuth } from "@/lib/auth";
import { Link, useLocation } from "wouter";
import { LogOut, ClipboardList, LayoutDashboard, LayoutGrid, List, Inbox, Activity, Bell } from "lucide-react";
import { useGetEscalationCount } from "@workspace/api-client-react";
import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { ThemeToggle } from "@/components/theme-toggle";

function useISTClock() {
  const [time, setTime] = useState(() =>
    new Date().toLocaleTimeString("en-US", {
      timeZone: "Asia/Kolkata",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
  );

  useEffect(() => {
    const id = setInterval(() => {
      setTime(
        new Date().toLocaleTimeString("en-US", {
          timeZone: "Asia/Kolkata",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        })
      );
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return time;
}

export function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const [location] = useLocation();
  const istTime = useISTClock();

  if (!user) return <>{children}</>;

  const isOperator = user.role === "OPERATOR";

  const { data: escalationCount } = useGetEscalationCount({
    query: { enabled: !isOperator, refetchInterval: 30_000, queryKey: ["escalation-count"] },
  });
  const openCount = escalationCount?.open ?? 0;

  const tabs = [
    { href: "/live", label: "Live shift", icon: Activity, badge: 0 },
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, badge: 0 },
    { href: "/submissions", label: "Submissions", icon: List, badge: 0 },
    { href: "/areas", label: "Areas", icon: LayoutGrid, badge: 0 },
    { href: "/escalations", label: "Escalations", icon: Inbox, badge: openCount },
    { href: "/notifications", label: "Notifications", icon: Bell, badge: 0 },
  ];

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      <header className="glass-bar sticky top-0 z-20 hairline-b">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5 font-semibold text-[15px] tracking-tight text-foreground">
            <div className="w-7 h-7 rounded-lg bg-primary text-primary-foreground flex items-center justify-center shadow-soft">
              <ClipboardList className="w-4 h-4" />
            </div>
            <span>5S Compliance</span>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-3">
            <span className="text-[13px] tabular-nums text-muted-foreground">
              {istTime} <span className="opacity-60">IST</span>
            </span>
            <span className="text-[13px] text-muted-foreground hidden sm:inline-block ml-2">
              {user.email}
            </span>
            <ThemeToggle />
            <button
              onClick={logout}
              className="p-2 -mr-2 rounded-full text-muted-foreground hover:text-foreground hover-overlay transition-colors"
              title="Sign out"
            >
              <LogOut className="w-[18px] h-[18px]" />
            </button>
          </div>
        </div>

        {!isOperator && (
          <div className="max-w-6xl mx-auto px-5 sm:px-8 pb-3 -mt-1">
            <nav className="inline-flex items-center gap-1 p-1 pill-track rounded-full">
              {tabs.map((tab) => {
                const active = location === tab.href;
                const Icon = tab.icon;
                return (
                  <Link
                    key={tab.href}
                    href={tab.href}
                    className={`relative inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[13px] font-medium whitespace-nowrap transition-colors ${
                      active
                        ? "text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {active && (
                      <motion.span
                        layoutId="header-tab-pill"
                        className="absolute inset-0 pill-thumb-bg rounded-full shadow-soft"
                        transition={{ type: "spring", stiffness: 500, damping: 38 }}
                      />
                    )}
                    <span className="relative z-10 inline-flex items-center gap-1.5">
                      <Icon className="w-3.5 h-3.5" />
                      {tab.label}
                      {tab.badge > 0 && (
                        <span className="ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10.5px] font-bold rounded-full bg-rose-500 text-white">
                          {tab.badge > 99 ? "99+" : tab.badge}
                        </span>
                      )}
                    </span>
                  </Link>
                );
              })}
            </nav>
          </div>
        )}
      </header>

      <main className="flex-1 max-w-6xl mx-auto w-full px-5 sm:px-8 py-8 sm:py-10">
        {children}
      </main>
    </div>
  );
}
