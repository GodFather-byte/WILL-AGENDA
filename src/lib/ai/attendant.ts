import type Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { formatDateShort, WEEKDAYS, weekdayOf } from "../dates";
import { brl, normalizePhone, STATUS_LABEL } from "../format";
import type { Availability, BookedAppointment, Catalog, PublicAppointment } from "../types";
import { AI_MODEL, anthropic, FALLBACK_PARAMS } from "./client";
import {
  buildCodes,
  isHM,
  isISODate,
  renderCalendar,
  renderCatalog,
  renderHours,
  renderRules,
  type ChatTurn,
  type Codes,
} from "./context";
import { textOf } from "./errors";

/** Agendamento criado ou alterado nesta resposta: a tela guarda o link e mostra o botão. */
export type AttendantAppointment = { token: string; date: string; time: string; service: string; status: string };

export type AttendantResult = { reply: string; appointments: AttendantAppointment[] };

function systemPrompt(catalog: Catalog, codes: Codes) {
  const { business } = catalog;
  return `Você é o atendente virtual de "${business.name}", conversando com um cliente pelo chat da página de agendamento. Seu trabalho é tirar dúvidas, oferecer horários livres e agendar, remarcar ou cancelar, como uma boa recepcionista faria: simpática, rápida e sem enrolação.

# Como conversar
- Escreva em português do Brasil, em mensagens curtas (o cliente está no celular). Sem markdown, sem tabelas; listas simples com hífen quando ajudar.
- Responda só com base nos dados do estabelecimento abaixo e no que as ferramentas devolvem. Se o cliente pedir um serviço que não existe, diga que não tem e sugira o mais parecido. Nunca invente serviço, preço, profissional ou horário.
- Faça uma pergunta por vez. Para agendar você precisa de: serviço, dia e horário, nome e WhatsApp com DDD.${business.choose_professional ? " Pergunte se o cliente tem preferência de profissional só quando mais de um faz o serviço; se não tiver, use qualquer um." : " O cliente não escolhe profissional: o sistema escolhe quem estiver livre."}
- Datas: use sempre o calendário de <contexto_atual> para transformar "amanhã", "quinta", "dia 30" em uma data. Nunca calcule data de cabeça. Se o cliente disser um dia da semana ambíguo, confirme a data.
- Este sistema guarda só agenda e contato. Não peça nem registre informações de saúde (sintomas, diagnósticos, medicamentos). Se o cliente quiser tratar disso, oriente a falar direto com o estabelecimento.
- Assuntos fora da agenda (reclamação, reembolso, orientação profissional) devem ser encaminhados ao WhatsApp do estabelecimento.

# Como usar as ferramentas
- Horário livre só existe se veio de consultar_horarios nesta resposta ou está escrito em uma mensagem sua anterior. Antes de oferecer ou confirmar um horário, consulte. Ofereça poucas opções (três ou quatro), não a lista inteira.
- Agendar, remarcar e cancelar gravam de verdade na agenda. O caminho é sempre em duas mensagens:
  1. Primeiro você mostra um resumo e pergunta se pode confirmar. O resumo traz o serviço, a data no formato DD/MM, o horário no formato HH:MM, o profissional (se houver) e o valor. Exemplo: "Corte feminino, quinta 26/11 às 14:30, com a Carla, R$ 80,00. Posso confirmar?"
  2. Só depois que o cliente responder que sim, na mensagem seguinte, você chama agendar, remarcar ou cancelar.
  O sistema recusa a gravação se a sua mensagem anterior não for essa pergunta, com a data e o horário. Para cancelar, a pergunta precisa dizer que é um cancelamento (exemplo: "Vou cancelar o corte de 26/11 às 14:30. Confirma?"). Se o cliente mudar qualquer coisa, mostre um novo resumo e pergunte de novo.
- Se uma ferramenta retornar erro, explique ao cliente em palavras simples e ajude a corrigir (por exemplo, oferecendo outro horário).
- Sempre que agendar ou remarcar dá certo, a tela do cliente mostra, logo abaixo da sua mensagem, o botão "Ver meu agendamento", que abre a página para acompanhar, remarcar e cancelar. Isso é um fato do sistema: pode mencionar o botão e não precisa se corrigir depois.
- Para remarcar, cancelar ou responder "qual é o meu horário?", use meus_agendamentos: ela mostra os agendamentos feitos neste aparelho. Se não houver nenhum, explique que o cliente pode abrir o link que recebeu ao agendar ou falar com o estabelecimento; você não consegue localizar agendamento por nome ou telefone.

# Sobre o histórico desta conversa
O histórico mostra apenas o texto das mensagens anteriores. As chamadas de ferramenta de turnos anteriores não aparecem nele, mas aconteceram: os horários que você ofereceu vieram da consulta, e um agendamento, uma remarcação ou um cancelamento que você confirmou foi gravado. Não se corrija, não peça desculpas e não ponha em dúvida o que você já disse por esse motivo. Não grave de novo algo que você já confirmou como feito.

# Dados do estabelecimento
- Nome: ${business.name}
${business.description ? `- Sobre: ${business.description}\n` : ""}- Endereço: ${business.address || "não informado"}
- WhatsApp: ${business.phone || "não informado"}
- Horário de funcionamento: ${renderHours(catalog, null)}
${renderRules(catalog)}
${business.booking_notice ? `- Recado para quem agenda: ${business.booking_notice}\n` : ""}
# Serviços e profissionais (códigos entre colchetes são para as ferramentas; nunca mostre códigos ao cliente)
${renderCatalog(catalog, codes, { showInactive: false })}`;
}

export async function runAttendant(params: {
  supabase: SupabaseClient;
  /** Só o que o cliente pode agendar (bookableCatalog). */
  catalog: Catalog;
  history: ChatTurn[];
  /** Links secretos dos agendamentos feitos neste aparelho. */
  tokens: string[];
  today: string;
  nowTime: string;
}): Promise<AttendantResult> {
  const { supabase, catalog, history, today, nowTime } = params;
  const { business } = catalog;
  const codes = buildCodes(catalog);
  const changed = new Map<string, AttendantAppointment>();
  const tokens = [...params.tokens];

  const json = (value: unknown) => JSON.stringify(value);
  const fail = (message: string) => json({ erro: message });
  const dayLabel = (date: string) => `${WEEKDAYS[weekdayOf(date)].toLowerCase()} ${formatDateShort(date)}`;

  // Trava de confirmação: a gravação só passa se a mensagem anterior do atendente (a que o
  // cliente acabou de responder) mostrou o resumo com esta data e este horário.
  const lastAssistant = [...history].reverse().find((turn) => turn.role === "assistant")?.content ?? "";
  // Precisa ser uma pergunta (para "Remarcado para 24/11 às 15:00" não valer como pedido de
  // confirmação do passo seguinte) e, no cancelamento, precisa falar em cancelar.
  const summarized = (date: string, time: string, action: "gravar" | "cancelar" = "gravar") =>
    lastAssistant.includes(time) &&
    lastAssistant.includes(formatDateShort(date)) &&
    lastAssistant.includes("?") &&
    (action === "gravar" || /cancel/i.test(lastAssistant));
  const NEEDS_SUMMARY =
    "Gravação recusada: a sua mensagem anterior não foi a pergunta de confirmação com esta data (DD/MM) e este horário (HH:MM). " +
    "Mostre o resumo agora, pergunte se pode confirmar (se for cancelamento, diga que vai cancelar) e só grave depois que o cliente responder que sim.";

  async function availability(serviceId: string, professionalId: string | null, from: string, days: number, token?: string) {
    const { data, error } = await supabase.rpc("get_availability", {
      p_business_id: business.id,
      p_service_id: serviceId,
      p_professional_id: professionalId,
      p_from: from,
      p_days: days,
      p_token: token ?? null,
    });
    if (error) throw new Error(error.message);
    return data as Availability;
  }

  // Agendamentos deste aparelho, com códigos a1, a2... válidos dentro desta resposta.
  async function mine() {
    const list: { code: string; token: string; appointment: PublicAppointment }[] = [];
    for (const token of tokens.slice(0, 5)) {
      const { data } = await supabase.rpc("get_appointment", { p_token: token });
      const appointment = data as PublicAppointment | null;
      if (appointment && appointment.business.id === business.id) {
        list.push({ code: `a${list.length + 1}`, token, appointment });
      }
    }
    return list;
  }

  const describe = (a: PublicAppointment) => ({
    servico: a.service_name,
    dia: dayLabel(a.date),
    data: a.date,
    horario: a.time,
    profissional: a.professional_name,
    valor: brl(a.price_cents),
    situacao: a.is_past && a.status === "confirmed" ? "Já passou" : STATUS_LABEL[a.status],
    pode_remarcar_ou_cancelar_pelo_chat: a.can_change,
  });

  const track = (token: string, a: { date: string; time: string; service_name: string; status: string }) =>
    changed.set(token, { token, date: a.date, time: a.time, service: a.service_name, status: a.status });

  const tools = [
    betaZodTool({
      name: "consultar_horarios",
      description:
        "Consulta os horários livres de um serviço em um dia. Use sempre antes de oferecer ou confirmar um horário. Se o dia pedido não tiver horário, devolve os próximos dias com horário livre.",
      inputSchema: z.object({
        servico: z.string().describe("Código do serviço, ex.: s2"),
        profissional: z.string().optional().describe("Código do profissional, ex.: p1. Omita para qualquer profissional."),
        data: z.string().describe("Dia no formato AAAA-MM-DD, tirado do calendário de <contexto_atual>"),
        agendamento: z
          .string()
          .optional()
          .describe("Ao remarcar: código do agendamento (ex.: a1), para o horário atual dele contar como livre"),
      }),
      run: async (input) => {
        const service = codes.serviceByCode.get(input.servico);
        if (!service) return fail("Código de serviço inexistente.");
        const professional = input.profissional ? codes.professionalByCode.get(input.profissional) : null;
        if (input.profissional && !professional) return fail("Código de profissional inexistente.");
        if (professional && !professional.service_ids.includes(service.id)) {
          return fail(`${professional.name} não faz ${service.name}.`);
        }
        if (!isISODate(input.data)) return fail("Data inválida. Use AAAA-MM-DD, do calendário de <contexto_atual>.");
        const token = input.agendamento ? (await mine()).find((item) => item.code === input.agendamento)?.token : undefined;
        try {
          const result = await availability(service.id, professional?.id ?? null, input.data, 14, token);
          if (!result.accepting) return fail("A agenda online está fechada no momento.");
          const day = result.days.find((d) => d.date === input.data);
          return json({
            servico: service.name,
            profissional: professional?.name ?? "qualquer profissional",
            dia: dayLabel(input.data),
            data: input.data,
            horarios_livres: day?.slots.map((slot) => slot.time) ?? [],
            ...(day
              ? {}
              : {
                  aviso:
                    input.data < result.today
                      ? "Esta data já passou."
                      : input.data > result.last_date
                        ? `A agenda só está aberta até ${formatDateShort(result.last_date)}.`
                        : "Sem horário livre neste dia.",
                  proximos_dias_com_horario: result.days.slice(0, 3).map((d) => ({
                    dia: dayLabel(d.date),
                    data: d.date,
                    horarios_livres: d.slots.map((slot) => slot.time).slice(0, 8),
                  })),
                }),
          });
        } catch (error) {
          return fail((error as Error).message);
        }
      },
    }),
    betaZodTool({
      name: "agendar",
      description:
        "Grava um agendamento de verdade na agenda do estabelecimento. Só chame depois de mostrar o resumo (serviço, data DD/MM, horário HH:MM, valor) e o cliente confirmar na mensagem seguinte.",
      inputSchema: z.object({
        servico: z.string().describe("Código do serviço, ex.: s2"),
        profissional: z.string().optional().describe("Código do profissional. Omita para qualquer profissional."),
        data: z.string().describe("Dia no formato AAAA-MM-DD"),
        horario: z.string().describe("Horário no formato HH:MM, exatamente como veio de consultar_horarios"),
        nome: z.string().describe("Nome do cliente"),
        telefone: z.string().describe("WhatsApp do cliente com DDD"),
        observacao: z.string().max(300).optional().describe("Recado do cliente sobre o horário. Nunca informação de saúde."),
      }),
      run: async (input) => {
        const service = codes.serviceByCode.get(input.servico);
        if (!service) return fail("Código de serviço inexistente.");
        const professional = input.profissional ? codes.professionalByCode.get(input.profissional) : null;
        if (input.profissional && !professional) return fail("Código de profissional inexistente.");
        if (!isISODate(input.data) || !isHM(input.horario)) return fail("Data ou horário em formato inválido.");
        if (!normalizePhone(input.telefone)) return fail("WhatsApp inválido: peça o número com DDD.");
        if (!summarized(input.data, input.horario)) return fail(NEEDS_SUMMARY);
        try {
          const result = await availability(service.id, professional?.id ?? null, input.data, 1);
          const slot = result.days.find((d) => d.date === input.data)?.slots.find((s) => s.time === input.horario);
          if (!slot) return fail("Este horário não está mais livre. Consulte os horários de novo e ofereça outro.");
          const { data, error } = await supabase.rpc("book_appointment", {
            p: {
              business_id: business.id,
              service_id: service.id,
              professional_id: professional?.id ?? null,
              starts_at: slot.at,
              customer_name: input.nome,
              customer_phone: input.telefone,
              notes: input.observacao ?? null,
              source: "ai",
            },
          });
          if (error) return fail(error.message);
          const booked = data as BookedAppointment;
          tokens.unshift(booked.token);
          track(booked.token, booked);
          return json({
            agendado: true,
            situacao: STATUS_LABEL[booked.status],
            servico: booked.service_name,
            dia: dayLabel(booked.date),
            horario: booked.time,
            profissional: booked.professional_name,
            valor: brl(booked.price_cents),
            aviso: "O cliente verá na tela o botão 'Ver meu agendamento'.",
          });
        } catch (error) {
          return fail((error as Error).message);
        }
      },
    }),
    betaZodTool({
      name: "meus_agendamentos",
      description:
        "Lista os agendamentos feitos neste aparelho, com um código (a1, a2...) para remarcar ou cancelar. Use quando o cliente perguntar pelo horário dele ou quiser remarcar ou cancelar.",
      inputSchema: z.object({}),
      run: async () => {
        const list = await mine();
        if (list.length === 0) return fail("Não há agendamento guardado neste aparelho.");
        return json({ agendamentos: list.map((item) => ({ codigo: item.code, ...describe(item.appointment) })) });
      },
    }),
    betaZodTool({
      name: "remarcar",
      description:
        "Muda de verdade o dia e o horário de um agendamento deste aparelho. Só chame depois de mostrar o resumo com a nova data (DD/MM) e o novo horário (HH:MM) e o cliente confirmar na mensagem seguinte.",
      inputSchema: z.object({
        agendamento: z.string().describe("Código do agendamento em meus_agendamentos, ex.: a1"),
        data: z.string().describe("Novo dia no formato AAAA-MM-DD"),
        horario: z.string().describe("Novo horário no formato HH:MM, como veio de consultar_horarios"),
        qualquer_profissional: z.boolean().optional().describe("true se o cliente aceita outro profissional"),
      }),
      run: async (input) => {
        const item = (await mine()).find((entry) => entry.code === input.agendamento);
        if (!item) return fail("Agendamento não encontrado neste aparelho. Chame meus_agendamentos.");
        if (!item.appointment.service_id) return fail("Este serviço não pode mais ser remarcado pelo chat.");
        if (!isISODate(input.data) || !isHM(input.horario)) return fail("Data ou horário em formato inválido.");
        if (!summarized(input.data, input.horario)) return fail(NEEDS_SUMMARY);
        const keep = business.choose_professional && !input.qualquer_profissional;
        const professionalId = keep ? item.appointment.professional_id : null;
        try {
          const result = await availability(item.appointment.service_id, professionalId, input.data, 1, item.token);
          const slot = result.days.find((d) => d.date === input.data)?.slots.find((s) => s.time === input.horario);
          if (!slot) return fail("Este horário não está livre. Consulte os horários de novo e ofereça outro.");
          const { data, error } = await supabase.rpc("reschedule_appointment", {
            p_token: item.token,
            p_starts_at: slot.at,
            p_professional_id: professionalId,
          });
          if (error) return fail(error.message);
          const updated = data as PublicAppointment;
          track(item.token, updated);
          return json({ remarcado: true, ...describe(updated) });
        } catch (error) {
          return fail((error as Error).message);
        }
      },
    }),
    betaZodTool({
      name: "cancelar",
      description:
        "Cancela de verdade um agendamento deste aparelho. Só chame depois de dizer qual agendamento será cancelado (com a data DD/MM e o horário HH:MM) e o cliente confirmar na mensagem seguinte.",
      inputSchema: z.object({
        agendamento: z.string().describe("Código do agendamento em meus_agendamentos, ex.: a1"),
        motivo: z.string().max(200).optional().describe("Motivo dito pelo cliente. Nunca informação de saúde."),
      }),
      run: async (input) => {
        const item = (await mine()).find((entry) => entry.code === input.agendamento);
        if (!item) return fail("Agendamento não encontrado neste aparelho. Chame meus_agendamentos.");
        if (!summarized(item.appointment.date, item.appointment.time, "cancelar")) return fail(NEEDS_SUMMARY);
        const { error } = await supabase.rpc("cancel_appointment", { p_token: item.token, p_reason: input.motivo ?? null });
        if (error) return fail(error.message);
        track(item.token, { ...item.appointment, status: "canceled" });
        return json({ cancelado: true, servico: item.appointment.service_name, dia: dayLabel(item.appointment.date) });
      },
    }),
  ];

  // O que muda a cada mensagem (relógio, calendário) vai na última mensagem, depois do prefixo em cache.
  const context =
    `<contexto_atual>\nAgora: ${dayLabel(today)} (${today}), ${nowTime}, horário de São Paulo.\n` +
    `Calendário: ${renderCalendar(today, 21)}\n` +
    `Agendamentos guardados neste aparelho: ${tokens.length ? "sim (use meus_agendamentos)" : "nenhum"}\n</contexto_atual>`;

  const messages: Anthropic.Beta.BetaMessageParam[] = history.map((turn, index) =>
    index === history.length - 1 && turn.role === "user"
      ? { role: "user", content: [{ type: "text", text: context }, { type: "text", text: turn.content }] }
      : { role: turn.role, content: turn.content },
  );

  const final = await anthropic().beta.messages.toolRunner({
    model: AI_MODEL,
    max_tokens: 16000,
    max_iterations: 8,
    output_config: { effort: "low" },
    // Se o modelo principal recusar por política, a API tenta o modelo reserva na mesma chamada.
    ...FALLBACK_PARAMS,
    system: [{ type: "text", text: systemPrompt(catalog, codes), cache_control: { type: "ephemeral" } }],
    tools,
    messages,
  });

  return {
    reply: textOf(final) || "Desculpe, não consegui responder agora. Pode repetir de outro jeito?",
    appointments: [...changed.values()],
  };
}
