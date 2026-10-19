import { clearSession, getToken, type User } from "./auth";

export type DoseStatus = "pending" | "reminded" | "taken" | "missed" | "skipped";
export type AlertType = "missed_dose" | "no_checkin" | "needs_help";

export interface Dose {
  id: number;
  medicine: string;
  dosage: string;
  scheduled_for: string;
  status: DoseStatus;
}

export interface PatientSummary {
  id: number;
  full_name: string;
  taken: number;
  pending: number;
  missed: number;
  total: number;
  last_checkin: string | null;
  doses: Dose[];
}

export interface Alert {
  id: number;
  patient_id: number;
  patient_name: string;
  type: AlertType;
  message: string;
  created_at: string;
}

export interface Medicine {
  id: number;
  name: string;
  dosage: string;
  instructions: string | null;
  times: string[];
  end_date: string | null;
}

export interface PatientDetail {
  id: number;
  full_name: string;
  phone_whatsapp: string;
  doses: Dose[];
  medicines: Medicine[];
  adherence_7d: { day: string; taken: number; total: number }[];
}

export interface NewMedicine {
  name: string;
  dosage: string;
  instructions: string;
  times: string[];
  days: number | null; // null means ongoing
}

export interface AdminPatient {
  id: number;
  full_name: string;
  chat_id: string;
  opted_in: boolean;
  checkin_time: string;
  taken: number;
  total: number;
  missed: number;
  open_alerts: number;
  caregiver_ids: number[];
}

export interface Caregiver {
  id: number;
  full_name: string;
  username: string | null;
  role: "admin" | "caregiver";
  chat_id: string | null;
}

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init?.headers,
      },
      cache: "no-store",
    });
  } catch {
    throw new Error("Cannot reach the server. Is the backend running on port 8000?");
  }
  if (res.status === 401 && !path.startsWith("/api/auth/login")) {
    clearSession();
    window.location.href = "/login";
    throw new Error("Session expired. Please sign in again.");
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") message = body.detail;
      else if (Array.isArray(body?.detail)) message = "Please check the form and try again.";
    } catch {
      /* keep the default message */
    }
    throw new Error(message);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
}

export function timeAgo(iso: string): string {
  const minutes = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/* ---------- Sign in ---------- */
export const login = (username: string, password: string) =>
  request<{ token: string; user: User }>("/api/auth/login", send("POST", { username, password }));

/* ---------- Care board ---------- */
export const getDashboard = () =>
  request<{ patients: PatientSummary[]; alerts: Alert[] }>("/api/dashboard");
export const getPatient = (id: number) => request<PatientDetail>(`/api/patients/${id}`);
export const resolveAlert = (id: number) => request<void>(`/api/alerts/${id}/resolve`, send("POST"));
export const replyToDose = (id: number, action: "taken" | "skip") =>
  request<unknown>(`/api/doses/${id}/reply`, send("POST", { action }));
export const addMedicine = (patientId: number, med: NewMedicine) =>
  request<Medicine>(`/api/patients/${patientId}/medicines`, send("POST", med));
export const deleteMedicine = (patientId: number, medicineId: number) =>
  request<void>(`/api/patients/${patientId}/medicines/${medicineId}`, send("DELETE"));

/* ---------- Admin ---------- */
export const getAdminPatients = () => request<AdminPatient[]>("/api/admin/patients");
export const getCaregivers = () => request<Caregiver[]>("/api/admin/caregivers");
export const createPatient = (body: {
  full_name: string;
  chat_id: string;
  checkin_time: string;
  caregiver_ids: number[];
}) => request<{ id: number }>("/api/admin/patients", send("POST", body));
export const updatePatient = (
  id: number,
  body: { opted_in?: boolean; caregiver_ids?: number[]; full_name?: string; chat_id?: string; checkin_time?: string },
) => request<void>(`/api/admin/patients/${id}`, send("PATCH", body));
export const deletePatient = (id: number) => request<void>(`/api/admin/patients/${id}`, send("DELETE"));
export const createCaregiver = (body: {
  full_name: string;
  username: string;
  password: string;
  role: "admin" | "caregiver";
  chat_id: string;
}) => request<{ id: number }>("/api/admin/caregivers", send("POST", body));
export const deleteCaregiver = (id: number) => request<void>(`/api/admin/caregivers/${id}`, send("DELETE"));
export const resetPassword = (id: number, password: string) =>
  request<void>(`/api/admin/caregivers/${id}/password`, send("POST", { password }));
