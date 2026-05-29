import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "framer-motion";
import { Suspense, lazy } from "react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/lib/auth";
import { ThemeProvider } from "@/lib/theme";
import { LightboxProvider } from "@/components/frame-lightbox";
import { Layout } from "@/components/layout";
import { ProtectedRoute } from "@/components/protected-route";
import { useScoringCompletionToasts } from "@/hooks/use-scoring-completion-toasts";

// Pages that ship on the initial paint (login flow + operator home).
// Anything operators don't need on first paint is lazy-imported below so
// the operator's bundle doesn't carry Recharts / dashboard panels / etc.
import NotFound from "@/pages/not-found";
import Login from "@/pages/login";
import ResetPassword from "@/pages/reset-password";
import OperatorHome from "@/pages/operator";

// Manager-only pages — lazy so the operator path doesn't pay for them.
// Each becomes its own bundle chunk on `pnpm build`.
const Dashboard = lazy(() => import("@/pages/dashboard"));
const Submissions = lazy(() => import("@/pages/submissions"));
const Areas = lazy(() => import("@/pages/areas"));
const Escalations = lazy(() => import("@/pages/escalations"));
const LiveShift = lazy(() => import("@/pages/live"));
const Notifications = lazy(() => import("@/pages/notifications"));
const OperatorThresholds = lazy(() => import("@/pages/operator-thresholds"));
const AiSettingsPage = lazy(() => import("@/pages/ai-settings"));
const FacilitySettingsPage = lazy(() => import("@/pages/facility-settings"));
const SettingsPage = lazy(() => import("@/pages/settings"));
const AdminUsers = lazy(() => import("@/pages/admin-users"));

// Light-weight loader shown while a lazy route resolves. Sub-100 ms on a
// warm cache; the spinner is mostly for cold first-loads or slow networks.
function RouteLoading() {
  return (
    <div className="flex justify-center py-20">
      <div className="animate-spin rounded-full h-6 w-6 border-2 border-muted border-t-primary" />
    </div>
  );
}

const queryClient = new QueryClient();

// Mounts the global background-scoring completion poller. Sits between
// AuthProvider (needed for the role check) and the route switch so the
// toast fires no matter which screen the operator is on when scoring lands.
function GlobalEffects() {
  useScoringCompletionToasts();
  return null;
}

function Router() {
  return (
    <Suspense fallback={<RouteLoading />}>
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/reset-password" component={ResetPassword} />

      <Route path="/">
        <ProtectedRoute allowedRoles={["OPERATOR"]}>
          <Layout>
            <OperatorHome />
          </Layout>
        </ProtectedRoute>
      </Route>

      <Route path="/live">
        <ProtectedRoute allowedRoles={["MANAGER"]}>
          <Layout>
            <LiveShift />
          </Layout>
        </ProtectedRoute>
      </Route>

      <Route path="/dashboard">
        <ProtectedRoute allowedRoles={["MANAGER"]}>
          <Layout>
            <Dashboard />
          </Layout>
        </ProtectedRoute>
      </Route>

      <Route path="/submissions">
        <ProtectedRoute allowedRoles={["MANAGER"]}>
          <Layout>
            <Submissions />
          </Layout>
        </ProtectedRoute>
      </Route>

      <Route path="/areas">
        <ProtectedRoute allowedRoles={["MANAGER"]}>
          <Layout>
            <Areas />
          </Layout>
        </ProtectedRoute>
      </Route>

      <Route path="/escalations">
        <ProtectedRoute allowedRoles={["MANAGER"]}>
          <Layout>
            <Escalations />
          </Layout>
        </ProtectedRoute>
      </Route>

      <Route path="/notifications">
        <ProtectedRoute allowedRoles={["MANAGER"]}>
          <Layout>
            <Notifications />
          </Layout>
        </ProtectedRoute>
      </Route>

      <Route path="/operator-thresholds">
        <ProtectedRoute allowedRoles={["MANAGER"]}>
          <Layout>
            <OperatorThresholds />
          </Layout>
        </ProtectedRoute>
      </Route>

      <Route path="/facility-settings">
        <ProtectedRoute allowedRoles={["MANAGER"]}>
          <Layout>
            <FacilitySettingsPage />
          </Layout>
        </ProtectedRoute>
      </Route>

      <Route path="/ai-settings">
        <ProtectedRoute allowedRoles={["MANAGER"]}>
          <Layout>
            <AiSettingsPage />
          </Layout>
        </ProtectedRoute>
      </Route>

      <Route path="/settings">
        <ProtectedRoute allowedRoles={["MANAGER"]}>
          <Layout>
            <SettingsPage />
          </Layout>
        </ProtectedRoute>
      </Route>

      <Route path="/users">
        <ProtectedRoute allowedRoles={["ADMIN"]}>
          <Layout>
            <AdminUsers />
          </Layout>
        </ProtectedRoute>
      </Route>

      <Route component={NotFound} />
    </Switch>
    </Suspense>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MotionConfig reducedMotion="user">
          <AuthProvider>
            <TooltipProvider>
              <LightboxProvider>
                <GlobalEffects />
                <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
                  <Router />
                </WouterRouter>
                <Toaster />
              </LightboxProvider>
            </TooltipProvider>
          </AuthProvider>
        </MotionConfig>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
