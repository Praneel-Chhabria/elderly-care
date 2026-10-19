"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { clearSession, readUser, type User } from "@/lib/auth";

export default function NavBar() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    setUser(pathname === "/login" ? null : readUser());
  }, [pathname]);

  function signOut() {
    clearSession();
    setUser(null);
    router.replace("/login");
  }

  const link = (href: string) =>
    `rounded-xl px-3 py-1.5 font-bold transition hover:bg-paper ${
      pathname === href ? "bg-paper text-brand shadow-sm" : "text-muted"
    }`;

  return (
    <nav className="mb-8 flex flex-wrap items-center justify-between gap-3">
      <Link href="/" className="inline-flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-2xl bg-brand text-white">
          <svg
            viewBox="0 0 24 24"
            width="22"
            height="22"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M3 12h4l2-5 4 10 2-5h6" />
          </svg>
        </span>
        <span className="font-display text-xl font-semibold">Elderly Care</span>
      </Link>

      {user && (
        <div className="flex flex-wrap items-center gap-1">
          <Link href="/" className={link("/")}>
            Care board
          </Link>
          {user.role === "admin" && (
            <Link href="/admin" className={link("/admin")}>
              Admin
            </Link>
          )}
          <span className="ml-2 hidden items-center gap-2 rounded-full bg-paper px-3 py-1 text-sm shadow-sm sm:inline-flex">
            <span className="font-bold">{user.full_name}</span>
            <span
              className={`rounded-full px-2 text-xs font-bold ${
                user.role === "admin" ? "bg-brand-soft text-brand" : "bg-mist text-muted"
              }`}
            >
              {user.role}
            </span>
          </span>
          <button
            onClick={signOut}
            className="ml-1 rounded-xl border border-line px-3 py-1.5 font-bold text-muted transition hover:bg-paper"
          >
            Sign out
          </button>
        </div>
      )}
    </nav>
  );
}
