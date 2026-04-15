import { useAuth } from "@/lib/auth";
import { Link, useLocation } from "wouter";
import { LogOut, ClipboardList, LayoutDashboard, LayoutGrid, List } from "lucide-react";

export function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const [location] = useLocation();

  if (!user) return <>{children}</>;

  const isOperator = user.role === "OPERATOR";

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      <header className="bg-primary text-primary-foreground shadow-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold text-lg tracking-tight">
            <ClipboardList className="w-5 h-5" />
            <span>5S TRACKER</span>
          </div>

          <div className="flex items-center gap-4">
            <span className="text-sm font-medium opacity-80 hidden sm:inline-block">
              {user.email}
            </span>
            <button
              onClick={logout}
              className="p-2 hover:bg-primary-foreground/10 rounded-md transition-colors"
              title="Logout"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      {!isOperator && (
        <div className="bg-white border-b border-border shadow-sm overflow-x-auto">
          <div className="max-w-7xl mx-auto px-4 flex gap-6 h-12">
            <Link
              href="/dashboard"
              className={`flex items-center gap-2 px-1 border-b-2 transition-colors whitespace-nowrap text-sm font-bold ${
                location === "/dashboard"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <LayoutDashboard className="w-4 h-4" />
              DASHBOARD
            </Link>
            <Link
              href="/submissions"
              className={`flex items-center gap-2 px-1 border-b-2 transition-colors whitespace-nowrap text-sm font-bold ${
                location === "/submissions"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <List className="w-4 h-4" />
              SUBMISSIONS
            </Link>
            <Link
              href="/areas"
              className={`flex items-center gap-2 px-1 border-b-2 transition-colors whitespace-nowrap text-sm font-bold ${
                location === "/areas"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <LayoutGrid className="w-4 h-4" />
              AREAS
            </Link>
          </div>
        </div>
      )}

      <main className="flex-1 max-w-7xl mx-auto w-full p-4 md:p-6 lg:p-8">
        {children}
      </main>
    </div>
  );
}
