import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/lib/auth";
import { Layout } from "@/components/layout";
import { ProtectedRoute } from "@/components/protected-route";

// Pages
import NotFound from "@/pages/not-found";
import Login from "@/pages/login";
import OperatorHome from "@/pages/operator";
import Dashboard from "@/pages/dashboard";
import Submissions from "@/pages/submissions";
import Areas from "@/pages/areas";

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

      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
