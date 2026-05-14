import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useLocation } from "wouter";
import { useState } from "react";
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
import { useToast } from "@/hooks/use-toast";
import { ThemeToggle } from "@/components/theme-toggle";

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

  // Wouter's <Route> doesn't surface query params, so read them off the
  // browser URL directly. The token is mandatory; without it the page
  // explains what went wrong and links back to the request form.
  const token = new URLSearchParams(window.location.search).get("token");

  const form = useForm<ResetValues>({
    resolver: zodResolver(resetSchema),
    defaultValues: { password: "", confirmPassword: "" },
  });

  const onSubmit = async (values: ResetValues) => {
    if (!token) return;
    setPending(true);
    try {
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
          <img
            src="/granules-logo.png"
            alt="Granules"
            className="w-20 h-20 drop-shadow-[0_8px_24px_rgba(37,99,235,0.18)] select-none"
            draggable={false}
          />
          <div className="space-y-2">
            <p className="brand-wordmark text-[11px] text-blue-700 dark:text-blue-300">
              Granules · 5S Compliance
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
          {!token ? (
            <div className="space-y-4 text-[14px]">
              <p>This reset link is missing its token. Request a new one from the sign-in page.</p>
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
                        <Input
                          placeholder="At least 8 characters"
                          type="password"
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
                        <Input
                          placeholder="Re-enter the new password"
                          type="password"
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
