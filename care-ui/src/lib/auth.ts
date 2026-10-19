import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export interface User {
  id: number;
  full_name: string;
  username: string;
  role: "admin" | "caregiver";
}

const TOKEN_KEY = "care.token";
const USER_KEY = "care.user";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function readUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

export function saveSession(token: string, user: User) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Sends the visitor to /login when nobody is signed in. Pass true for admin only pages. */
export function useSession(requireAdmin = false) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const u = readUser();
    if (!u || !getToken()) {
      router.replace("/login");
      return;
    }
    if (requireAdmin && u.role !== "admin") {
      router.replace("/");
      return;
    }
    setUser(u);
    setReady(true);
  }, [router, requireAdmin]);

  return { user, ready };
}
