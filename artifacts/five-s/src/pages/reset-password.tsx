import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useLocation } from "wouter";
import { useState, useEffect, forwardRef } from "react";
import { getSupabase } from "@/lib/supabase-client";
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
import { Eye, EyeOff } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ThemeToggle } from "@/components/theme-toggle";

// Mirrors the PasswordInput on the login page so the reset flow shows the
// same eye toggle. Inline copy is intentional: keeping the helper inside
// each page avoids a circular-ish import between auth screens and an even
// thinner shared component file that's only used twice in the app.
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

const resetSchema = z
  .object({
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string().min(1, "Please confirm your password"),
  })
  .refine((d) => d.password === d.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords don't match",
  });

type ResetValues = z.infer<typeof resetSchema>;

const API_BASE_URL = (import.meta as any).env.VITE_API_URL ?? "";

export default function ResetPassword() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  // When the user lands here via Supabase's hosted email, the URL carries
  // `?code=…` instead of our `?token=…`. supabase-js auto-detects the
  // code on page load and exchanges it for a session — we just have to
  // wait one tick before reading the session. `null` = haven't checked
  // yet; `{ accessToken: null }` = no Supabase session present;
  // a real value = active session, the form should submit via the
  // Supabase path.
  const [supabaseAccessToken, setSupabaseAccessToken] = useState<string | null | undefined>(undefined);

  // Wouter's <Route> doesn't surface query params, so read them off the
  // browser URL directly. The token is for OUR backend-issued recovery
  // flow; absence is fine when the user came in through Supabase email.
  const token = new URLSearchParams(window.location.search).get("token");

  useEffect(() => {
    let cancelled = false;
    // If our own token is present we don't need to look up the Supabase
    // session — the existing reset flow handles it.
    if (token) {
      setSupabaseAccessToken(null);
      return;
    }
    const supabase = getSupabase();
    if (!supabase) {
      setSupabaseAccessToken(null);
      return;
    }
    // Give supabase-js a tick to exchange the URL `?code=` for a session.
    setTimeout(async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      setSupabaseAccessToken(data.session?.access_token ?? null);
    }, 50);
    return () => {
      cancelled = true;
    };
  }, [token]);

  const form = useForm<ResetValues>({
    resolver: zodResolver(resetSchema),
    defaultValues: { password: "", confirmPassword: "" },
  });

  const onSubmit = async (values: ResetValues) => {
    setPending(true);
    try {
      if (token) {
        // Backend-issued reset token flow — existing path. Hits our
        // /auth/reset-password which validates the token + rotates the
        // bcrypt hash in public.users (and mirrors into auth.users when
        // Supabase Auth is configured server-side).
        const res = await fetch(`${API_BASE_URL}/api/auth/reset-password`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, password: values.password }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast({
            variant: "destructive",
            title: "Couldn't reset password",
            description: body?.error ?? `Request failed (${res.status})`,
          });
          return;
        }
      } else if (supabaseAccessToken) {
        // Supabase-recovery-email flow — the user clicked an emailed
        // link, supabase-js exchanged the magic-link code for a session,
        // we now have an access token. Two-step:
        //   1. Update auth.users via supabase.auth.updateUser so future
        //      Supabase emails work with the new credential.
        //   2. Mirror into public.users so OUR JWT login accepts the new
        //      password (validated server-side via the access token).
        const supabase = getSupabase();
        if (!supabase) {
          toast({
            variant: "destructive",
            title: "Couldn't reset password",
            description: "Supabase client unavailable.",
          });
          return;
        }
        const { error: supError } = await supabase.auth.updateUser({ password: values.password });
        if (supError) {
          toast({
            variant: "destructive",
            title: "Couldn't reset password",
            description: supError.message,
          });
          return;
        }
        const syncRes = await fetch(`${API_BASE_URL}/api/auth/sync-password-from-supabase`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            access_token: supabaseAccessToken,
            password: values.password,
          }),
        });
        if (!syncRes.ok) {
          const syncBody = await syncRes.json().catch(() => ({}));
          toast({
            variant: "destructive",
            title: "Password set on Supabase but app sync failed",
            description: syncBody?.error ?? `Sync failed (${syncRes.status})`,
          });
          return;
        }
        // Sign out the recovery session so a stale Supabase token can't
        // linger in storage after the reset completes.
        await supabase.auth.signOut().catch(() => {});
      } else {
        // No backend token AND no Supabase session — the user hit this
        // page directly or with an invalid link.
        toast({
          variant: "destructive",
          title: "Reset link is missing or expired",
          description: "Request a new password reset from the sign-in page.",
        });
        return;
      }

      setDone(true);
      toast({
        title: "Password updated",
        description: "You can now sign in with your new password.",
      });
      // Brief pause so the toast registers, then redirect to login.
      setTimeout(() => setLocation("/login"), 1200);
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Couldn't reset password",
        description: err instanceof Error ? err.message : "Network error",
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="relative min-h-[100dvh] flex flex-col justify-center items-center p-6 overflow-hidden
                    bg-gradient-to-br from-slate-50 via-blue-50/40 to-indigo-50/30
                    dark:from-background dark:via-background dark:to-background">
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
              Set new password
            </h1>
            <p className="text-muted-foreground text-[14.5px]">
              Choose a new password for your 5S Compliance account
            </p>
          </div>
        </div>

        <div className="bg-card rounded-2xl shadow-elevated p-7 sm:p-8 border border-slate-200/70 dark:border-border">
          {/* Three rendering states beyond done:
                a) we have our backend token (`token`) → show the form
                b) we have a Supabase recovery session → show the form
                c) we have neither (and the Supabase check has resolved) →
                   show the "missing link" guidance
              `supabaseAccessToken === undefined` means we're still
              checking, so render the form skeleton anyway to avoid a
              flash of error UI during the ~50 ms post-mount tick. */}
          {!token && supabaseAccessToken === null ? (
            <div className="space-y-4 text-[14px]">
              <p>This reset link is missing or expired. Request a new one from the sign-in page.</p>
              <Button
                type="button"
                onClick={() => setLocation("/login")}
                className="btn-granules w-full h-12"
              >
                Back to sign in
              </Button>
            </div>
          ) : done ? (
            <p className="text-[14px]">Password updated — taking you to sign in…</p>
          ) : (
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-[13px] font-medium text-muted-foreground">New password</FormLabel>
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
                  name="confirmPassword"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-[13px] font-medium text-muted-foreground">Confirm password</FormLabel>
                      <FormControl>
                        <PasswordInput
                          placeholder="Re-enter the new password"
                          autoComplete="new-password"
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
                  {pending ? "Updating…" : "Update password"}
                </Button>
              </form>
            </Form>
          )}
        </div>
      </div>
    </div>
  );
}
