import type { AppointmentSource, AppointmentStatus, PaymentStatus, Segment, Service } from "./types";

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export const brl = (cents: number) => BRL.format(cents / 100);

/** "12,50" | "12.50" | "12" -> 1250. Retorna null se inválido. */
export function parseBRL(input: string): number | null {
  const cleaned = input.replace(/[R$\s]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(parseFloat(cleaned) * 100);
}

export const centsToInput = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");

/** Preço como o cliente lê: "R$ 80,00", "a partir de R$ 180,00" ou "Sem custo". */
export function priceLabel(service: Pick<Service, "price_cents" | "price_from">) {
  if (service.price_cents === 0) return service.price_from ? "Valor na avaliação" : "Sem custo";
  return `${service.price_from ? "a partir de " : ""}${brl(service.price_cents)}`;
}

/** 90 -> "1h30", 60 -> "1h", 45 -> "45 min". */
export function durationLabel(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, "0")}`;
}

/** Antecedência em palavras: 30 -> "30 minutos", 120 -> "2 horas", 1440 -> "24 horas", 2880 -> "2 dias". */
export function noticeLabel(minutes: number) {
  if (minutes === 0) return "qualquer momento";
  if (minutes < 60) return `${minutes} minutos`;
  if (minutes % 1440 === 0 && minutes >= 2880) return `${minutes / 1440} dias`;
  if (minutes % 60 === 0) return minutes === 60 ? "1 hora" : `${minutes / 60} horas`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

export const STATUS_LABEL: Record<AppointmentStatus, string> = {
  pending: "Aguardando confirmação",
  confirmed: "Confirmado",
  completed: "Concluído",
  no_show: "Faltou",
  canceled: "Cancelado",
};

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  none: "Sem pagamento registrado",
  awaiting: "Aguardando pagamento do sinal",
  paid: "Sinal pago",
  manual_paid: "Pagamento recebido",
  refund_pending: "Estorno em andamento",
  refunded: "Sinal estornado",
};

/** Mesma conta do banco (deposit_for): quanto é o sinal para um preço. */
export function depositFor(business: { deposit_type: "percent" | "fixed" | "full"; deposit_value: number }, priceCents: number) {
  if (business.deposit_type === "full") return priceCents;
  if (business.deposit_type === "fixed") return Math.min(business.deposit_value, priceCents);
  return Math.floor((priceCents * business.deposit_value) / 100);
}

export const SOURCE_LABEL: Record<AppointmentSource, string> = {
  web: "Site",
  ai: "Atendente de IA",
  panel: "Painel",
};

export const SEGMENTS: { value: Segment; label: string; hint: string; professional: string }[] = [
  { value: "salao", label: "Salão de beleza", hint: "Cabelo, unhas, barba, sobrancelha", professional: "Ex.: Carla" },
  { value: "estetica", label: "Estética", hint: "Facial, corporal, depilação, cílios", professional: "Ex.: Juliana" },
  { value: "clinica", label: "Clínica ou consultório", hint: "Consulta, retorno, avaliação", professional: "Ex.: Dra. Ana" },
  { value: "bronze", label: "Studio de bronzeamento", hint: "Natural, a jato, cabine", professional: "Ex.: Vaga 1" },
];

export const SEGMENT_LABEL = Object.fromEntries(SEGMENTS.map((s) => [s.value, s.label])) as Record<Segment, string>;

export function formatPhone(digits: string) {
  const d = digits.replace(/\D/g, "");
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return digits;
}

/** Mesma regra do banco (normalize_phone): só dígitos, sem o 55; null se não for DDD + número. */
export function normalizePhone(input: string): string | null {
  let d = input.replace(/\D/g, "");
  if (/^55\d{10,11}$/.test(d)) d = d.slice(2);
  return /^[1-9]\d{9,10}$/.test(d) ? d : null;
}

/** Link do WhatsApp com mensagem pronta. O telefone já está sem o 55. */
export const whatsappLink = (phone: string, text?: string) =>
  `https://wa.me/55${phone.replace(/\D/g, "")}${text ? `?text=${encodeURIComponent(text)}` : ""}`;

export function slugify(name: string) {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/** Mensagem do banco quando ela é nossa (códigos AG...); senão, um texto genérico. */
export function errorMessage(error: { code?: string; message?: string } | null | undefined, fallback: string) {
  if (error?.code?.startsWith("AG") && error.message) return error.message;
  return fallback;
}

/** Agrupa serviços pela categoria, mantendo a ordem de cadastro. Sem categoria = grupo sem título. */
export function groupByCategory<T extends { category: string | null }>(services: T[]) {
  const groups: { category: string | null; items: T[] }[] = [];
  for (const service of services) {
    const key = service.category?.trim() || null;
    const group = groups.find((g) => g.category === key);
    if (group) group.items.push(service);
    else groups.push({ category: key, items: [service] });
  }
  return groups;
}
