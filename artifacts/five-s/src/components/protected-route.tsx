import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";
import { useEffect } from "react";
import { UserRole } from "@workspace/api-client-react";

interface ProtectedRouteProps {
  children: React.ReactNode;
  allowedRoles?: UserRole[];
}

/**
 * True if `role` may view a route gated to `allowedRoles`. ADMIN is a
 * superuser: it inherits everything MANAGER can reach (dashboards, areas,
 * etc.) on top of its own ADMIN-only routes — mirroring the backend's
 * requireRole, where ADMIN satisfies every guard. OPERATOR/MANAGER keep exact
 * matching.
 */
function roleAllowed(role: UserRole, allowedRoles?: UserRole[]): boolean {
  if (!allowedRoles) return true;
  if (allowedRoles.includes(role)) return true;
  if (role === "ADMIN" && allowedRoles.includes("MANAGER")) return true;
  return false;
}

export function ProtectedRoute({ children, allowedRoles }: ProtectedRouteProps) {
  const { user, isLoading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && !user) {
      setLocation("/login");
    } else if (!isLoading && user && !roleAllowed(user.role, allowedRoles)) {
      // Send privileged users to a screen they can actually see rather than
      // bouncing them to the operator home they can't use.
      if (user.role === "MANAGER" || user.role === "ADMIN") {
        setLocation("/dashboard");
      } else {
        setLocation("/");
      }
    }
  }, [user, isLoading, setLocation, allowedRoles]);

  if (isLoading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!roleAllowed(user.role, allowedRoles)) {
    return null;
  }

  return <>{children}</>;
}
