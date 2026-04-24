import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "framer-motion";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/lib/auth";
import { ThemeProvider } from "@/lib/theme";
import { Layout } from "@/components/layout";
import { ProtectedRoute } from "@/components/protected-route";

// Pages
import NotFound from "@/pages/not-found";
import Login from "@/pages/login";
import OperatorHome from "@/pages/operator";
import Dashboard from "@/pages/dashboard";
import Submissions from "@/pages/submissions";
import Areas from "@/pages/areas";
import Escalations from "@/pages/escalations";
import LiveShift from "@/pages/live";
import Notifications from "@/pages/notifications";
import OperatorThresholds from "@/pages/operator-thresholds";
import AiSettingsPage from "@/pages/ai-settings";
import FacilitySettingsPage from "@/pages/facility-settings";

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      
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

      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MotionConfig reducedMotion="user">
          <AuthProvider>
            <TooltipProvider>
              <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
                <Router />
              </WouterRouter>
              <Toaster />
            </TooltipProvider>
          </AuthProvider>
        </MotionConfig>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
