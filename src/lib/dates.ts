// Datas da agenda são sempre do relógio de São Paulo e circulam como texto "AAAA-MM-DD".
// As contas abaixo tratam essas datas como dias de calendário puros (em UTC, só para somar dias
// e descobrir o dia da semana), então não dependem do fuso do aparelho nem do servidor.
// Converter data e hora local em instante é trabalho do banco, nunca daqui.

export const TIME_ZONE = "America/Sao_Paulo";

const asUTC = (date: string) => {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
};

const toISODate = (value: Date) => value.toISOString().slice(0, 10);

export function addDays(date: string, days: number) {
  const value = asUTC(date);
  value.setUTCDate(value.getUTCDate() + days);
  return toISODate(value);
}

/** Diferença em dias entre duas datas de calendário (b - a). */
export const diffDays = (a: string, b: string) => Math.round((asUTC(b).getTime() - asUTC(a).getTime()) / 86400000);

/** 0 = domingo ... 6 = sábado. */
export const weekdayOf = (date: string) => asUTC(date).getUTCDay();

export const WEEKDAYS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
export const WEEKDAYS_SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const WEEKDAYS_LONG = [
  "domingo",
  "segunda-feira",
  "terça-feira",
  "quarta-feira",
  "quinta-feira",
  "sexta-feira",
  "sábado",
];
const MONTHS = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];
const MONTHS_SHORT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

/** "terça-feira, 24 de novembro" */
export function formatDateLong(date: string) {
  const value = asUTC(date);
  return `${WEEKDAYS_LONG[value.getUTCDay()]}, ${value.getUTCDate()} de ${MONTHS[value.getUTCMonth()]}`;
}

/** "24/11" */
export function formatDateShort(date: string) {
  const [, month, day] = date.split("-");
  return `${day}/${month}`;
}

/** "24/11/2026" */
export function formatDateFull(date: string) {
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year}`;
}

export const dayOfMonth = (date: string) => asUTC(date).getUTCDate();
export const monthShort = (date: string) => MONTHS_SHORT[asUTC(date).getUTCMonth()];
export const monthLong = (date: string) => MONTHS[asUTC(date).getUTCMonth()];

/** "hoje", "amanhã" ou o dia da semana abreviado. */
export function relativeDay(date: string, today: string) {
  const diff = diffDays(today, date);
  if (diff === 0) return "hoje";
  if (diff === 1) return "amanhã";
  return WEEKDAYS_SHORT[weekdayOf(date)];
}

/** "hoje, 24/11", "amanhã, 25/11" ou "quinta-feira, 26 de novembro". */
export function friendlyDate(date: string, today: string) {
  const diff = diffDays(today, date);
  if (diff === 0) return `hoje, ${formatDateShort(date)}`;
  if (diff === 1) return `amanhã, ${formatDateShort(date)}`;
  return formatDateLong(date);
}

/** Data de hoje em São Paulo, a partir do relógio de quem chama. */
export function todayInSaoPaulo(now: Date = new Date()) {
  // en-CA formata como AAAA-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(now);
}

/** Dia (AAAA-MM-DD) de um instante, em São Paulo. */
export const dateInSaoPaulo = (iso: string) => todayInSaoPaulo(new Date(iso));

/** Hora "HH:MM" de um instante, em São Paulo. */
export function timeInSaoPaulo(iso: string) {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false }).format(
    new Date(iso),
  );
}

/** "24/11 às 14:30" de um instante, em São Paulo. */
export const dateTimeInSaoPaulo = (iso: string) => `${formatDateShort(dateInSaoPaulo(iso))} às ${timeInSaoPaulo(iso)}`;

/** "09:00:00" -> "09:00". */
export const hm = (time: string) => time.slice(0, 5);

/** "09:30" -> 570. */
export function minutesOf(time: string) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

/** 570 -> "09:30". */
export function timeOf(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
