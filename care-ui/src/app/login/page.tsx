"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { login } from "@/lib/api";
import { clearSession, getToken, readUser, saveSession } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"caregiver" | "admin">("caregiver");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Already signed in? Skip the form.
  useEffect(() => {
    const u = readUser();
    if (u && getToken()) router.replace(u.role === "admin" ? "/admin" : "/");
  }, [router]);

  async function submit(e: React.SyntheticEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { token, user } = await login(username.trim(), password);
      if (mode === "admin" && user.role !== "admin") {
        clearSession();
        setError("This account does not have admin access.");
        setBusy(false);
        return;
      }
      saveSession(token, user);
      router.replace(mode === "admin" ? "/admin" : "/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in");
      setBusy(false);
    }
  }

  const inputCls =
    "w-full rounded-xl border border-line bg-white px-4 py-3 text-lg placeholder:text-muted focus:border-brand";
  const tab = (active: boolean) =>
    `flex-1 rounded-xl px-4 py-2 font-bold transition ${active ? "bg-paper text-brand shadow-sm" : "text-muted"}`;

  return (
    <main className="mx-auto grid max-w-md gap-6 pt-4">
      <div className="rise text-center">
        <p className="text-sm font-bold uppercase tracking-widest text-brand">Smart elderly care</p>
        <h1 className="font-display text-5xl font-semibold tracking-tight">Welcome back</h1>
        <p className="mt-1 text-muted">Sign in to see how everyone is doing today.</p>
      </div>

      <form onSubmit={submit} className="card rise space-y-5 p-6" style={{ animationDelay: "80ms" }}>
        <div className="flex gap-1 rounded-2xl bg-mist p-1" role="tablist" aria-label="Sign in as">
          <button type="button" role="tab" aria-selected={mode === "caregiver"} className={tab(mode === "caregiver")} onClick={() => setMode("caregiver")}>
            Caregiver
          </button>
          <button type="button" role="tab" aria-selected={mode === "admin"} className={tab(mode === "admin")} onClick={() => setMode("admin")}>
            Admin
          </button>
        </div>

        <label className="block">
          <span className="mb-1 block font-bold">Username</span>
          <input
            className={inputCls}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            required
          />
        </label>

        <label className="block">
          <span className="mb-1 block font-bold">Password</span>
          <div className="relative">
            <input
              className={`${inputCls} pr-20`}
              type={show ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-3 py-1 text-sm font-bold text-brand hover:bg-brand-soft"
            >
              {show ? "Hide" : "Show"}
            </button>
          </div>
        </label>

        {error && (
          <p role="alert" className="rounded-xl bg-missed-bg px-4 py-2 font-bold text-missed">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-xl bg-brand px-6 py-3 text-lg font-bold text-white transition hover:brightness-110 active:scale-95 disabled:opacity-60"
        >
          {busy ? "Signing in" : mode === "admin" ? "Sign in as admin" : "Sign in"}
        </button>
      </form>

      <p className="text-center text-sm text-muted">Need an account? Ask your admin to create one for you.</p>
    </main>
  );
}
