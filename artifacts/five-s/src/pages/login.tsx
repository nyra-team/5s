import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useLogin } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useEffect, useState, forwardRef } from "react";
import { Eye, EyeOff } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { getSupabase } from "@/lib/supabase-client";

// Password input with an inline eye toggle so users can verify what they
// typed without retyping. Wraps the shared Input + an absolutely-positioned
// button. Forwarding the ref lets react-hook-form's field.ref pass through
// to the underlying <input> (otherwise validation focus jumps don't work).
type PasswordInputProps = React.ComponentProps<typeof Input>;
const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput({ className, ...props }, ref) {
    const [visible, setVisible] = useState(false);
    return (
      <div className="relative">
        <Input
          ref={ref}
          {...props}
          type={visible ? "text" : "password"}
          className={`${className ?? ""} pr-11`}
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label={visible ? "Hide password" : "Show password"}
          onClick={() => setVisible((v) => !v)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:text-foreground"
        >
          {visible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
    );
  },
);

type Mode = "login" | "signup" | "forgot";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, "Password is required"),
  rememberMe: z.boolean().default(false),
});

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  displayName: z.string().trim().min(1, "Display name is required").max(120),
  role: z.enum(["OPERATOR", "MANAGER"]),
});

const forgotSchema = z.object({
  email: z.string().email(),
});

type LoginValues = z.infer<typeof loginSchema>;
type SignupValues = z.infer<typeof signupSchema>;
type ForgotValues = z.infer<typeof forgotSchema>;

const API_BASE_URL = (import.meta as any).env.VITE_API_URL ?? "";

function ForgotPasswordForm() {
  const { toast } = useToast();
  const [pending, setPending] = useState(false);
  // In dev the API responds with `devResetUrl` so the user can click straight
  // through without configuring email; we surface it inline below the form.
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);
  const [devResetUrl, setDevResetUrl] = useState<string | null>(null);

  const form = useForm<ForgotValues>({
    resolver: zodResolver(forgotSchema),
    defaultValues: { email: "" },
  });

  const onSubmit = async (values: ForgotValues) => {
    setPending(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const body = await res.json().catch(() => ({}));
      // The endpoint always returns 200 even when the email is unknown, so we
      // always advance to the "check your inbox" state — never reveal whether
      // the account exists.
      setSubmittedEmail(values.email);
      if (typeof body?.devResetUrl === "string") {
        setDevResetUrl(body.devResetUrl);
      }

      // If the backend confirmed the email exists in auth.users AND the
      // Supabase client is configured on the frontend, trigger Supabase's
      // hosted email send. The reset link Supabase generates lands the user
      // back on our /reset-password page (carrying a Supabase magic-link
      // code) where the page hands off to supabase.auth.updateUser to
      // rotate the credential. Best-effort: we don't toast on Supabase
      // failure because the dev-link path below is still useful.
      if (body?.viaSupabase) {
        const supabase = getSupabase();
        if (supabase) {
          const origin = window.location.origin;
          const { error } = await supabase.auth.resetPasswordForEmail(
            values.email,
            { redirectTo: `${origin}/reset-password` },
          );
          if (error) {
            // Don't surface to user — the email transport is best-effort.
            // The dev fallback (if present) still works.
            console.warn("supabase.auth.resetPasswordForEmail failed:", error.message);
          }
        }
      }
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Couldn't send reset link",
        description: err instanceof Error ? err.message : "Network error",
      });
    } finally {
      setPending(false);
    }
  };

  if (submittedEmail) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl bg-secondary/60 p-4 text-[14px] text-foreground/90">
          If an account exists for <span className="font-medium">{submittedEmail}</span>, we've sent a password reset link. The link is valid for one hour.
        </div>
        {devResetUrl && (
          <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 p-4 text-[13px]">
            <p className="font-medium text-amber-700 dark:text-amber-300 mb-1">Dev mode</p>
            <p className="text-muted-foreground mb-2">
              Email isn't configured locally, so the link is shown below:
            </p>
            <a
              href={devResetUrl}
              className="block break-all font-mono text-[12px] text-primary hover:underline"
            >
              {devResetUrl}
            </a>
          </div>
        )}
      </div>
    );
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-[13px] font-medium text-muted-foreground">Email</FormLabel>
              <FormControl>
                <Input
                  placeholder="you@factory.com"
                  type="email"
                  autoComplete="email"
                  className="h-12 rounded-xl text-[15px] bg-secondary/60 border-transparent focus-visible:bg-card focus-visible:border-ring"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button
          type="submit"
          className="btn-granules w-full h-12 mt-3 text-[15px]"
          disabled={pending}
        >
          {pending ? "Sending…" : "Send reset link"}
        </Button>
      </form>
    </Form>
  );
}

function LoginForm({ onForgotPassword }: { onForgotPassword: () => void }) {
  const loginMutation = useLogin();
  const { login } = useAuth();
  const { toast } = useToast();

  const form = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "", rememberMe: false },
  });

  const onSubmit = (values: LoginValues) => {
    // `rememberMe` isn't in the generated LoginBody zod schema yet, so the
    // typed mutation argument doesn't include it — pass through as a
    // loose-typed override. The api-server reads it directly off req.body
    // and extends the JWT expiry to 30 days when true.
    loginMutation.mutate(
      { data: values as unknown as { email: string; password: string } },
      {
        onSuccess: (data) => login(data.token),
        onError: () => {
          toast({
            variant: "destructive",
            title: "Sign in failed",
            description: "Please check your credentials and try again.",
          });
        },
      }
    );
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-[13px] font-medium text-muted-foreground">Email</FormLabel>
              <FormControl>
                <Input
                  placeholder="you@factory.com"
                  type="email"
                  autoComplete="email"
                  className="h-12 rounded-xl text-[15px] bg-secondary/60 border-transparent focus-visible:bg-card focus-visible:border-ring"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-[13px] font-medium text-muted-foreground">Password</FormLabel>
              <FormControl>
                <PasswordInput
                  placeholder="••••••••"
                  autoComplete="current-password"
                  className="h-12 rounded-xl text-[15px] bg-secondary/60 border-transparent focus-visible:bg-card focus-visible:border-ring"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="rememberMe"
          render={({ field }) => (
            <FormItem className="flex items-center gap-2 mt-1">
              <FormControl>
                <input
                  type="checkbox"
                  checked={!!field.value}
                  onChange={(e) => field.onChange(e.target.checked)}
                  className="w-4 h-4 rounded border-input accent-primary cursor-pointer"
                  data-testid="login-remember-me"
                />
              </FormControl>
              <FormLabel className="text-[13px] text-muted-foreground !m-0 cursor-pointer select-none">
                Keep me signed in on this device
              </FormLabel>
            </FormItem>
          )}
        />
        <Button
          type="submit"
          className="btn-granules w-full h-12 mt-3 text-[15px]"
          disabled={loginMutation.isPending}
        >
          {loginMutation.isPending ? "Signing in…" : "Sign In"}
        </Button>
        <div className="text-center pt-1">
          <button
            type="button"
            onClick={onForgotPassword}
            className="text-[13px] text-primary hover:underline focus:outline-none focus-visible:underline"
          >
            Forgot password?
          </button>
        </div>
      </form>
    </Form>
  );
}

function SignupForm() {
  const { login } = useAuth();
  const { toast } = useToast();
  const [pending, setPending] = useState(false);

  const form = useForm<SignupValues>({
    resolver: zodResolver(signupSchema),
    defaultValues: { email: "", password: "", displayName: "", role: "OPERATOR" },
  });

  const onSubmit = async (values: SignupValues) => {
    setPending(true);
    try {
      // Self-signup can't grant a role — everyone starts as an active
      // operator. Choosing "Manager" only records a request for an admin to
      // approve, so we send `requestedRole` (not `role`) to the API.
      const payload = {
        email: values.email,
        password: values.password,
        displayName: values.displayName,
        ...(values.role === "MANAGER" ? { requestedRole: "MANAGER" as const } : {}),
      };
      const res = await fetch(`${API_BASE_URL}/api/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({
          variant: "destructive",
          title: "Couldn't create account",
          description: body?.error ?? `Request failed (${res.status})`,
        });
        return;
      }
      if (values.role === "MANAGER") {
        toast({
          title: "Account created — manager access pending",
          description: "You're signed in as an operator. An admin will review your manager request.",
        });
      }
      login(body.token);
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Couldn't create account",
        description: err instanceof Error ? err.message : "Network error",
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        <FormField
          control={form.control}
          name="displayName"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-[13px] font-medium text-muted-foreground">Name</FormLabel>
              <FormControl>
                <Input
                  placeholder="Jane Operator"
                  autoComplete="name"
                  className="h-12 rounded-xl text-[15px] bg-secondary/60 border-transparent focus-visible:bg-card focus-visible:border-ring"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-[13px] font-medium text-muted-foreground">Email</FormLabel>
              <FormControl>
                <Input
                  placeholder="you@factory.com"
                  type="email"
                  autoComplete="email"
                  className="h-12 rounded-xl text-[15px] bg-secondary/60 border-transparent focus-visible:bg-card focus-visible:border-ring"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-[13px] font-medium text-muted-foreground">Password</FormLabel>
              <FormControl>
                <PasswordInput
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                  className="h-12 rounded-xl text-[15px] bg-secondary/60 border-transparent focus-visible:bg-card focus-visible:border-ring"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="role"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-[13px] font-medium text-muted-foreground">Access level</FormLabel>
              <FormControl>
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger className="h-12 rounded-xl text-[15px] bg-secondary/60 border-transparent focus-visible:bg-card focus-visible:border-ring">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="OPERATOR">Operator</SelectItem>
                    <SelectItem value="MANAGER">Manager (needs admin approval)</SelectItem>
                  </SelectContent>
                </Select>
              </FormControl>
              {field.value === "MANAGER" && (
                <p className="text-[12px] text-muted-foreground mt-1">
                  You'll start as an operator right away. An admin reviews and approves manager access.
                </p>
              )}
              <FormMessage />
            </FormItem>
          )}
        />
        <Button
          type="submit"
          className="btn-granules w-full h-12 mt-3 text-[15px]"
          disabled={pending}
        >
          {pending ? "Creating account…" : "Create account"}
        </Button>
      </form>
    </Form>
  );
}

export default function Login() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const [mode, setMode] = useState<Mode>("login");

  useEffect(() => {
    if (user) {
      setLocation(user.role === "OPERATOR" ? "/" : "/dashboard");
    }
  }, [user, setLocation]);

  const title = mode === "signup" ? "Create account" : mode === "forgot" ? "Reset password" : "Welcome back";
  const subtitle =
    mode === "signup"
      ? "Set up your 5S Compliance account"
      : mode === "forgot"
      ? "Enter your email and we'll send you a reset link"
      : "Sign in to your 5S Compliance account";

  return (
    <div className="relative min-h-[100dvh] flex flex-col justify-center items-center p-6 overflow-hidden
                    bg-gradient-to-br from-slate-50 via-blue-50/40 to-indigo-50/30
                    dark:from-background dark:via-background dark:to-background">
      {/* Soft brand glows in the corners — subtle so the surface still reads as enterprise-clean */}
      <div aria-hidden className="pointer-events-none absolute -top-32 -left-32 w-96 h-96 rounded-full bg-blue-400/20 blur-3xl dark:bg-blue-500/10" />
      <div aria-hidden className="pointer-events-none absolute -bottom-32 -right-32 w-[28rem] h-[28rem] rounded-full bg-indigo-400/20 blur-3xl dark:bg-indigo-500/10" />

      <div className="absolute top-4 right-4 z-10">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-md flex flex-col gap-9 relative z-10">
        <div className="flex flex-col items-center text-center gap-5">
          <div className="space-y-2">
            <p className="brand-wordmark text-[11px] text-blue-700 dark:text-blue-300">
              5S Compliance
            </p>
            <h1 className="font-heading text-[32px] leading-tight font-bold tracking-tight text-foreground">
              {title}
            </h1>
            <p className="text-muted-foreground text-[14.5px]">{subtitle}</p>
          </div>
        </div>

        <div className="bg-card rounded-2xl shadow-elevated p-7 sm:p-8 border border-slate-200/70 dark:border-border">
          {mode === "signup" ? (
            <SignupForm />
          ) : mode === "forgot" ? (
            <ForgotPasswordForm />
          ) : (
            <LoginForm onForgotPassword={() => setMode("forgot")} />
          )}

          <div className="mt-5 text-center text-[13px] text-muted-foreground">
            {mode === "signup" ? (
              <>
                Already have an account?{" "}
                <button
                  type="button"
                  onClick={() => setMode("login")}
                  className="font-medium text-primary hover:underline focus:outline-none focus-visible:underline"
                >
                  Sign in
                </button>
              </>
            ) : mode === "forgot" ? (
              <button
                type="button"
                onClick={() => setMode("login")}
                className="font-medium text-primary hover:underline focus:outline-none focus-visible:underline"
              >
                Back to sign in
              </button>
            ) : (
              <>
                Don't have an account?{" "}
                <button
                  type="button"
                  onClick={() => setMode("signup")}
                  className="font-medium text-primary hover:underline focus:outline-none focus-visible:underline"
                >
                  Create one
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
