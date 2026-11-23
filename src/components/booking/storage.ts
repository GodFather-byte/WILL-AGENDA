import { STORAGE_PREFIX } from "@/lib/brand";

// O que fica guardado no aparelho do cliente: nome e WhatsApp (para não digitar de novo) e os
// links secretos dos agendamentos feitos aqui (para achar, remarcar e cancelar depois).

export type CustomerInfo = { name: string; phone: string };
export type SavedAppointment = { token: string; date: string; time: string; service: string };

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Armazenamento indisponível (aba anônima): a página funciona sem lembrar os dados.
  }
}

const appointmentsKey = (slug: string) => `${STORAGE_PREFIX}:agendamentos:${slug}`;

export const loadCustomer = () => read<CustomerInfo>(`${STORAGE_PREFIX}:cliente`, { name: "", phone: "" });
export const saveCustomer = (customer: CustomerInfo) => write(`${STORAGE_PREFIX}:cliente`, customer);

export function loadAppointments(slug: string): SavedAppointment[] {
  const list = read<SavedAppointment[]>(appointmentsKey(slug), []);
  return Array.isArray(list) ? list.filter((item) => item && typeof item.token === "string").slice(0, 10) : [];
}

/** Guarda (ou atualiza) um agendamento deste aparelho; os mais recentes ficam na frente. */
export function saveAppointment(slug: string, appointment: SavedAppointment) {
  const others = loadAppointments(slug).filter((item) => item.token !== appointment.token);
  write(appointmentsKey(slug), [appointment, ...others].slice(0, 10));
}

export function forgetAppointment(slug: string, token: string) {
  write(
    appointmentsKey(slug),
    loadAppointments(slug).filter((item) => item.token !== token),
  );
}
