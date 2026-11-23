import { hoursFor } from "../data";
import { addDays, formatDateShort, hm, WEEKDAYS, weekdayOf } from "../dates";
import { durationLabel, noticeLabel, priceLabel } from "../format";
import type { Catalog, Professional, Service } from "../types";

export type ChatTurn = { role: "user" | "assistant"; content: string };

/**
 * Códigos curtos (s1, p2...) no lugar de UUIDs: menos tokens e menos erros do modelo.
 * A ordem do cadastro é determinística, então os códigos são estáveis entre requisições.
 */
export function buildCodes(catalog: Catalog) {
  const serviceByCode = new Map<string, Service>();
  const codeByServiceId = new Map<string, string>();
  const professionalByCode = new Map<string, Professional>();
  const codeByProfessionalId = new Map<string, string>();
  catalog.services.forEach((service, index) => {
    serviceByCode.set(`s${index + 1}`, service);
    codeByServiceId.set(service.id, `s${index + 1}`);
  });
  catalog.professionals.forEach((professional, index) => {
    professionalByCode.set(`p${index + 1}`, professional);
    codeByProfessionalId.set(professional.id, `p${index + 1}`);
  });
  return { serviceByCode, codeByServiceId, professionalByCode, codeByProfessionalId };
}

export type Codes = ReturnType<typeof buildCodes>;

/** Serviços e profissionais em texto, com os códigos entre colchetes. */
export function renderCatalog(catalog: Catalog, codes: Codes, options: { showInactive: boolean }) {
  const lines: string[] = ["## Serviços"];
  for (const service of catalog.services) {
    if (!service.is_active && !options.showInactive) continue;
    const who = catalog.professionals
      .filter((p) => p.service_ids.includes(service.id) && (p.is_active || options.showInactive))
      .map((p) => codes.codeByProfessionalId.get(p.id))
      .join(", ");
    lines.push(
      `- [${codes.codeByServiceId.get(service.id)}] ${service.name}${service.category ? ` (${service.category})` : ""}: ` +
        `${durationLabel(service.duration_minutes)}, ${priceLabel(service)}` +
        `${service.is_active ? "" : " [PAUSADO]"}${service.description ? ` — ${service.description}` : ""}` +
        ` | quem faz: ${who || "ninguém"}`,
    );
  }
  lines.push("", "## Profissionais");
  for (const professional of catalog.professionals) {
    if (!professional.is_active && !options.showInactive) continue;
    lines.push(
      `- [${codes.codeByProfessionalId.get(professional.id)}] ${professional.name}` +
        `${professional.role ? ` (${professional.role})` : ""}${professional.is_active ? "" : " [INATIVO]"}` +
        `${professional.custom_hours ? ` | horário próprio: ${renderHours(catalog, professional)}` : ""}`,
    );
  }
  return lines.join("\n");
}

/** Expediente em uma linha: "Segunda 09:00-12:00 e 13:00-18:00; Terça ...". */
export function renderHours(catalog: Catalog, professional: Professional | null) {
  const hours = hoursFor(catalog.hours, professional);
  const days = WEEKDAYS.map((label, weekday) => {
    const periods = hours.filter((h) => h.weekday === weekday);
    return periods.length ? `${label} ${periods.map((h) => `${hm(h.start_time)}-${hm(h.end_time)}`).join(" e ")}` : null;
  }).filter(Boolean);
  return days.length ? days.join("; ") : "sem expediente cadastrado";
}

/**
 * Calendário dos próximos dias, para o modelo não fazer conta de data de cabeça:
 * "hoje = segunda 23/11 (2026-11-23); amanhã = terça 24/11 (2026-11-24); ...".
 */
export function renderCalendar(today: string, days: number, startOffset = 0) {
  const items: string[] = [];
  for (let offset = startOffset; offset < startOffset + days; offset++) {
    const date = addDays(today, offset);
    const label = offset === 0 ? "hoje = " : offset === 1 ? "amanhã = " : offset === -1 ? "ontem = " : "";
    items.push(`${label}${WEEKDAYS[weekdayOf(date)].toLowerCase()} ${formatDateShort(date)} (${date})`);
  }
  return items.join("; ");
}

export function renderRules(catalog: Catalog) {
  const { business } = catalog;
  return [
    `- Agendamento online: ${business.is_accepting ? "ABERTO" : "FECHADO (não é possível agendar agora)"}`,
    `- Antecedência mínima para agendar: ${noticeLabel(business.min_notice_minutes)}`,
    `- Agenda aberta para os próximos ${business.max_advance_days} dias`,
    `- Cancelar ou remarcar: até ${noticeLabel(business.cancel_notice_minutes)} antes do horário`,
    `- Confirmação: ${business.auto_confirm ? "o agendamento já entra confirmado" : "o agendamento fica aguardando o estabelecimento confirmar"}`,
  ].join("\n");
}

export const isISODate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
export const isHM = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
