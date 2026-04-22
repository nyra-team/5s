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
import { ClipboardList } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useEffect } from "react";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, "Password is required"),
});

export default function Login() {
  const loginMutation = useLogin();
  const { login, user } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const form = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  useEffect(() => {
    if (user) {
      setLocation(user.role === "OPERATOR" ? "/" : "/dashboard");
    }
  }, [user, setLocation]);

  const onSubmit = (values: z.infer<typeof loginSchema>) => {
    loginMutation.mutate(
      { data: values },
      {
        onSuccess: (data) => {
          login(data.token);
        },
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
    <div className="min-h-[100dvh] bg-background flex flex-col justify-center items-center p-6">
      <div className="w-full max-w-[400px] flex flex-col gap-10">
        <div className="flex flex-col items-center text-center gap-5">
          <div className="w-14 h-14 bg-primary text-primary-foreground rounded-2xl flex items-center justify-center shadow-elevated">
            <ClipboardList className="w-7 h-7" />
          </div>
          <div className="space-y-2">
            <h1 className="text-[34px] leading-tight font-semibold tracking-tight text-foreground">
              Welcome back
            </h1>
            <p className="text-muted-foreground text-[15px]">
              Sign in to your 5S Compliance account
            </p>
          </div>
        </div>

        <div className="bg-card rounded-2xl shadow-elevated p-7 sm:p-8">
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
                      <Input
                        placeholder="••••••••"
                        type="password"
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
                className="w-full h-12 mt-3 rounded-xl text-[15px] font-medium"
                disabled={loginMutation.isPending}
              >
                {loginMutation.isPending ? "Signing in…" : "Sign In"}
              </Button>
            </form>
          </Form>
        </div>
      </div>
    </div>
  );
}
