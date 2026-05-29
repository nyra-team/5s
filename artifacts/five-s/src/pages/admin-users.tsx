import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, UserCheck, UserX, Users as UsersIcon, Trash2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";

const API_BASE_URL = (import.meta as any).env.VITE_API_URL ?? "";

const ROLES = ["OPERATOR", "MANAGER", "ADMIN"] as const;
type Role = (typeof ROLES)[number];

interface AdminUser {
  id: number;
  email: string;
  displayName?: string | null;
  role: Role;
  requestedRole?: string | null;
}

/** Authenticated fetch — attaches the JWT the rest of the app stores in
 *  localStorage and throws the API's error message on a non-2xx. */
async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem("token");
  const res = await fetch(`${API_BASE_URL}/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string })?.error ?? `Request failed (${res.status})`);
  return body as T;
}

function nameFor(u: AdminUser): string {
  return u.displayName?.trim() || u.email.split("@")[0];
}

const roleBadge: Record<Role, string> = {
  OPERATOR: "bg-secondary text-foreground/70",
  MANAGER: "bg-primary/15 text-primary",
  ADMIN: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
};

export default function AdminUsers() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user: me } = useAuth();
  // The account queued for deletion — drives the confirm dialog. null = closed.
  const [toDelete, setToDelete] = useState<AdminUser | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => apiFetch<{ users: AdminUser[] }>("/admin/users"),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["admin-users"] });

  const approve = useMutation({
    mutationFn: (id: number) => apiFetch(`/admin/users/${id}/approve`, { method: "POST" }),
    onSuccess: () => {
      toast({ title: "Request approved" });
      invalidate();
    },
    onError: (e: Error) => toast({ variant: "destructive", title: "Couldn't approve", description: e.message }),
  });

  const deny = useMutation({
    mutationFn: (id: number) => apiFetch(`/admin/users/${id}/deny`, { method: "POST" }),
    onSuccess: () => {
      toast({ title: "Request denied" });
      invalidate();
    },
    onError: (e: Error) => toast({ variant: "destructive", title: "Couldn't deny", description: e.message }),
  });

  const setRole = useMutation({
    mutationFn: ({ id, role }: { id: number; role: Role }) =>
      apiFetch(`/admin/users/${id}/role`, { method: "PATCH", body: JSON.stringify({ role }) }),
    onSuccess: () => {
      toast({ title: "Role updated" });
      invalidate();
    },
    onError: (e: Error) => toast({ variant: "destructive", title: "Couldn't update role", description: e.message }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => apiFetch(`/admin/users/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: "User deleted" });
      setToDelete(null);
      invalidate();
    },
    onError: (e: Error) => toast({ variant: "destructive", title: "Couldn't delete user", description: e.message }),
  });

  const users = data?.users ?? [];
  const pending = users.filter((u) => u.requestedRole);

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <UsersIcon className="w-6 h-6 text-primary" /> User management
        </h1>
        <p className="text-[13.5px] text-muted-foreground">
          Approve access requests and manage roles. Everyone signs up as an operator; managers and admins are granted here.
        </p>
      </header>

      {isLoading && (
        <div className="flex justify-center py-16">
          <div className="animate-spin rounded-full h-6 w-6 border-2 border-muted border-t-primary" />
        </div>
      )}

      {error && (
        <div className="p-4 rounded-xl bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300 text-[13.5px]">
          Couldn't load users: {(error as Error).message}
        </div>
      )}

      {!isLoading && !error && (
        <>
          {/* Pending approvals */}
          <section className="space-y-3" data-testid="pending-approvals">
            <p className="eyebrow flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-primary" /> Pending approvals ({pending.length})
            </p>
            {pending.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">No access requests waiting.</p>
            ) : (
              <ul className="space-y-2">
                {pending.map((u) => (
                  <li
                    key={u.id}
                    className="flex items-center justify-between gap-3 p-3 rounded-xl bg-card shadow-soft border"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-[14px] truncate">{nameFor(u)}</div>
                      <div className="text-[12.5px] text-muted-foreground truncate">
                        {u.email} · requesting <span className="font-medium">{u.requestedRole}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        size="sm"
                        onClick={() => approve.mutate(u.id)}
                        disabled={approve.isPending || deny.isPending}
                        className="gap-1.5"
                      >
                        <UserCheck className="w-4 h-4" /> Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => deny.mutate(u.id)}
                        disabled={approve.isPending || deny.isPending}
                        className="gap-1.5"
                      >
                        <UserX className="w-4 h-4" /> Deny
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Full roster */}
          <section className="space-y-3" data-testid="user-roster">
            <p className="eyebrow">All users ({users.length})</p>
            <ul className="divide-y rounded-xl border bg-card overflow-hidden">
              {users.map((u) => (
                <li key={u.id} className="flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <div className="font-medium text-[14px] truncate flex items-center gap-2">
                      {nameFor(u)}
                      <span className={`text-[10.5px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full ${roleBadge[u.role]}`}>
                        {u.role}
                      </span>
                    </div>
                    <div className="text-[12.5px] text-muted-foreground truncate">{u.email}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Select
                      value={u.role}
                      onValueChange={(role) => setRole.mutate({ id: u.id, role: role as Role })}
                      disabled={setRole.isPending}
                    >
                      <SelectTrigger className="h-9 w-36 text-[13px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ROLES.map((r) => (
                          <SelectItem key={r} value={r}>
                            {r.charAt(0) + r.slice(1).toLowerCase()}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => setToDelete(u)}
                      // Admins delete their own account from settings, not here.
                      disabled={me?.id === u.id}
                      title={me?.id === u.id ? "Use account settings to delete your own account" : "Delete user"}
                      aria-label={`Delete ${nameFor(u)}`}
                      className="h-9 w-9 text-muted-foreground hover:text-destructive disabled:opacity-30"
                      data-testid={`button-delete-user-${u.id}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      <AlertDialog open={!!toDelete} onOpenChange={(open) => !open && setToDelete(null)}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {toDelete ? nameFor(toDelete) : "user"}?</AlertDialogTitle>
            <AlertDialogDescription>
              {toDelete?.email} will no longer be able to sign in, and their name and email
              are scrubbed. Their past submissions and history stay intact for the records.
              This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-full">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Keep the dialog open until the mutation resolves so the
                // error toast (e.g. last-admin guard) is visible in context.
                e.preventDefault();
                if (toDelete) remove.mutate(toDelete.id);
              }}
              disabled={remove.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 rounded-full"
            >
              {remove.isPending ? "Deleting…" : "Delete user"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
