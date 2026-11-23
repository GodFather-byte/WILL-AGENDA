import type Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { dateInSaoPaulo, diffDays, formatDateShort, WEEKDAYS, weekdayOf } from "../dates";
import { brl, durationLabel, SOURCE_LABEL, STATUS_LABEL } from "../format";
import type { Agenda, Catalog, CustomerSummary, OwnerAppointment, OwnerSlot } from "../types";
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

const dateField = (what: string) => z.string().describe(`${what}, no formato AAAA-MM-DD, tirado do calendário de <contexto_atual>`);
const timeField = (what: string) => z.string().describe(`${what}, no formato HH:MM`);

function systemPrompt(catalog: Catalog, codes: Codes) {
  const { business } = catalog;
  return `Você é o copiloto do dono de "${business.name}" dentro do painel de agendamento. Você conversa com o dono, não com clientes. Ele usa você para entender como a agenda está e para fazer alterações sem abrir telas.

# Como trabalhar
- Responda em português do Brasil, direto ao ponto, em texto simples (sem markdown nem tabelas; listas com hífen quando ajudar). O dono está ocupado: comece pela resposta e pelo número que ele pediu.
- Todo número ou fato sobre agenda, horários vagos, faltas e clientes vem das ferramentas de consulta. Nunca estime nem invente; se a ferramenta não trouxer dados suficientes, diga isso.
- Datas: use sempre o calendário de <contexto_atual> para transformar "quinta", "amanhã", "este mês", "sábado à tarde" em datas. Nunca calcule data de cabeça. "Manhã" é do início do expediente até 12:00, "tarde" é de 12:00 até 18:00 e "noite" é depois das 18:00, salvo se o dono disser outro horário.
- Para alterações (bloquear ou liberar agenda, mudar serviço, abrir ou fechar a agenda online, confirmar, cancelar ou dar baixa em agendamento): se o pedido for claro, execute e confirme o que mudou. Se houver dúvida sobre qual dia, profissional, serviço ou agendamento, pergunte antes. Mudanças valem na hora para os clientes.
- Bloquear a agenda não cancela agendamentos que já existem no período. Quando a ferramenta avisar que há agendamentos dentro do bloqueio, diga quantos são e sugira remarcar ou cancelar cada um.
- Você não cria nem apaga serviços e profissionais, não muda o horário de funcionamento, não remarca agendamentos e não envia mensagens a clientes. Se pedirem isso, diga em qual tela do painel se faz (Serviços, Profissionais, Horários, Agenda, Clientes).
- Este sistema guarda só agenda e contato: não registre nem comente informações de saúde de clientes.

# Sobre o histórico desta conversa
O histórico mostra apenas o texto das mensagens anteriores. As consultas e alterações que você fez em turnos anteriores não aparecem nele, mas aconteceram: os números que você já informou vieram das ferramentas, e as alterações que você confirmou foram aplicadas. A situação e os cadastros abaixo já refletem essas alterações, por isso podem diferir do "antes" que você relatou. Nada disso é um erro seu: não se corrija, não peça desculpas, não ponha em dúvida respostas anteriores e não repita uma alteração já confirmada. Se o dono pedir um número de novo, consulte de novo.

# Situação atual
- Horário de funcionamento: ${renderHours(catalog, null)}
- Horários oferecidos a cada ${business.slot_step_minutes} minutos
${renderRules(catalog)}

# Serviços e profissionais (códigos entre colchetes são para as ferramentas; não mostre códigos ao dono)
${renderCatalog(catalog, codes, { showInactive: true }) || "(nada cadastrado)"}`;
}

export async function runCopilot(params: {
  supabase: SupabaseClient;
  catalog: Catalog;
  history: ChatTurn[];
  today: string;
  nowTime: string;
}) {
  const { supabase, catalog, history, today, nowTime } = params;
  const { business } = catalog;
  const codes = buildCodes(catalog);
  let changed = false;

  const json = (value: unknown) => JSON.stringify(value);
  const fail = (message: string) => json({ erro: message });
  const dayLabel = (date: string) => `${WEEKDAYS[weekdayOf(date)].toLowerCase()} ${formatDateShort(date)}`;
  const professionalName = (id: string | null) =>
    id ? (catalog.professionals.find((p) => p.id === id)?.name ?? "profissional removido") : "todos";

  // Leituras passam pela sessão do dono: o banco só devolve dados do estabelecimento dele.
  async function agenda(from: string, to: string) {
    const { data, error } = await supabase.rpc("owner_agenda", { p_business_id: business.id, p_from: from, p_to: to });
    if (error) throw new Error(error.message);
    return data as Agenda;
  }

  function period(from: string, to: string) {
    if (!isISODate(from) || !isISODate(to)) return "Datas inválidas. Use AAAA-MM-DD.";
    if (to < from) return "A data final vem antes da inicial.";
    if (diffDays(from, to) > 62) return "Período longo demais: consulte no máximo 62 dias por vez.";
    return null;
  }

  const view = (a: OwnerAppointment) => ({
    dia: dayLabel(a.date),
    horario: `${a.time}-${a.end_time}`,
    cliente: a.customer_name,
    servico: a.service_name,
    profissional: professionalName(a.professional_id),
    situacao: a.status === "confirmed" && a.is_past ? "Confirmado (sem baixa)" : STATUS_LABEL[a.status],
    valor: brl(a.price_cents),
    feito_por: SOURCE_LABEL[a.source],
  });

  const tools = [
    betaZodTool({
      name: "agenda_do_dia",
      description: "Agendamentos e bloqueios de um dia: horário, cliente, serviço, profissional e situação. Use para 'como está minha agenda', 'quem vem amanhã'.",
      inputSchema: z.object({ data: dateField("Dia") }),
      run: async ({ data }) => {
        const problem = period(data, data);
        if (problem) return fail(problem);
        try {
          const result = await agenda(data, data);
          const active = result.appointments.filter((a) => a.status !== "canceled" && a.status !== "no_show");
          return json({
            dia: dayLabel(data),
            agendamentos_ativos: active.length,
            previsto: brl(active.reduce((sum, a) => sum + a.price_cents, 0)),
            agendamentos: result.appointments.map(view),
            bloqueios: result.blocks.map((b) => ({
              quem: professionalName(b.professional_id),
              de: `${formatDateShort(b.start_date)} ${b.start_time}`,
              ate: `${formatDateShort(b.end_date)} ${b.end_time}`,
              motivo: b.reason ?? undefined,
            })),
          });
        } catch (error) {
          return fail((error as Error).message);
        }
      },
    }),
    betaZodTool({
      name: "horarios_vagos",
      description:
        "Horários ainda livres em um dia, por profissional, para um serviço. Use para 'quantos horários vagos tenho quinta'. Sem serviço informado, usa o serviço ativo mais curto (e diz qual foi), porque o número de vagas depende da duração.",
      inputSchema: z.object({
        data: dateField("Dia"),
        servico: z.string().optional().describe("Código do serviço, ex.: s2"),
        profissional: z.string().optional().describe("Código do profissional, ex.: p1. Omita para todos."),
      }),
      run: async (input) => {
        if (!isISODate(input.data)) return fail("Data inválida. Use AAAA-MM-DD.");
        const active = catalog.services.filter((s) => s.is_active);
        const service = input.servico
          ? codes.serviceByCode.get(input.servico)
          : [...active].sort((a, b) => a.duration_minutes - b.duration_minutes)[0];
        if (!service) return fail(input.servico ? "Código de serviço inexistente." : "Não há serviço ativo cadastrado.");
        const professional = input.profissional ? codes.professionalByCode.get(input.profissional) : null;
        if (input.profissional && !professional) return fail("Código de profissional inexistente.");
        const { data, error } = await supabase.rpc("owner_availability", {
          p_business_id: business.id,
          p_service_id: service.id,
          p_professional_id: professional?.id ?? null,
          p_date: input.data,
        });
        if (error) return fail(error.message);
        const slots = (data ?? []) as OwnerSlot[];
        const byProfessional = new Map<string, string[]>();
        for (const slot of slots) {
          byProfessional.set(slot.professional_id, [...(byProfessional.get(slot.professional_id) ?? []), slot.time]);
        }
        return json({
          dia: dayLabel(input.data),
          servico_considerado: `${service.name} (${durationLabel(service.duration_minutes)})`,
          ...(input.servico ? {} : { aviso: "Nenhum serviço foi informado: a conta usa o serviço ativo mais curto." }),
          total_de_horarios_vagos: slots.length,
          por_profissional: [...byProfessional].map(([id, times]) => ({
            profissional: professionalName(id),
            vagos: times.length,
            horarios: times,
          })),
          observacao: input.data === today ? "Só conta horários que ainda não passaram hoje." : undefined,
        });
      },
    }),
    betaZodTool({
      name: "resumo_periodo",
      description:
        "Resumo da agenda em um período (até 62 dias): agendamentos por situação, faturamento concluído e previsto, por profissional, por serviço e por origem (site, atendente de IA, painel). Use para perguntas de desempenho.",
      inputSchema: z.object({ de: dateField("Primeiro dia"), ate: dateField("Último dia") }),
      run: async ({ de, ate }) => {
        const problem = period(de, ate);
        if (problem) return fail(problem);
        try {
          const all = (await agenda(de, ate)).appointments;
          const count = (test: (a: OwnerAppointment) => boolean) => all.filter(test).length;
          const sum = (test: (a: OwnerAppointment) => boolean) => all.filter(test).reduce((total, a) => total + a.price_cents, 0);
          const group = (key: (a: OwnerAppointment) => string) => {
            const map = new Map<string, { agendamentos: number; faltas: number; centavos: number }>();
            for (const a of all) {
              if (a.status === "canceled") continue;
              const entry = map.get(key(a)) ?? { agendamentos: 0, faltas: 0, centavos: 0 };
              entry.agendamentos++;
              if (a.status === "no_show") entry.faltas++;
              else entry.centavos += a.price_cents;
              map.set(key(a), entry);
            }
            return [...map]
              .sort((x, y) => y[1].agendamentos - x[1].agendamentos)
              .map(([nome, v]) => ({ nome, agendamentos: v.agendamentos, faltas: v.faltas, valor: brl(v.centavos) }));
          };
          return json({
            periodo: `${dayLabel(de)} a ${dayLabel(ate)}`,
            concluidos: count((a) => a.status === "completed"),
            em_aberto_futuros: count((a) => ["pending", "confirmed"].includes(a.status) && !a.is_past),
            passados_sem_baixa: count((a) => ["pending", "confirmed"].includes(a.status) && a.is_past),
            aguardando_confirmacao: count((a) => a.status === "pending"),
            faltas: count((a) => a.status === "no_show"),
            cancelados: count((a) => a.status === "canceled"),
            faturamento_concluido: brl(sum((a) => a.status === "completed")),
            previsto_em_aberto: brl(sum((a) => ["pending", "confirmed"].includes(a.status))),
            por_profissional: group((a) => professionalName(a.professional_id)),
            por_servico: group((a) => a.service_name),
            por_origem: group((a) => SOURCE_LABEL[a.source]),
          });
        } catch (error) {
          return fail((error as Error).message);
        }
      },
    }),
    betaZodTool({
      name: "faltas",
      description: "Quem faltou em um período (até 62 dias): cliente, dia, serviço e profissional. Use para 'quem faltou este mês'.",
      inputSchema: z.object({ de: dateField("Primeiro dia"), ate: dateField("Último dia") }),
      run: async ({ de, ate }) => {
        const problem = period(de, ate);
        if (problem) return fail(problem);
        try {
          const missed = (await agenda(de, ate)).appointments.filter((a) => a.status === "no_show");
          return json({
            periodo: `${dayLabel(de)} a ${dayLabel(ate)}`,
            total_de_faltas: missed.length,
            faltas: missed.map((a) => ({
              cliente: a.customer_name,
              dia: dayLabel(a.date),
              horario: a.time,
              servico: a.service_name,
              profissional: professionalName(a.professional_id),
            })),
          });
        } catch (error) {
          return fail((error as Error).message);
        }
      },
    }),
    betaZodTool({
      name: "clientes",
      description:
        "Clientes do estabelecimento: total, quem sumiu (sem vir há 45 dias ou mais e sem horário marcado), quem mais falta e quem mais vem. Não traz telefones; para falar com clientes o dono usa a tela Clientes.",
      inputSchema: z.object({}),
      run: async () => {
        const { data, error } = await supabase.rpc("owner_customers", { p_business_id: business.id });
        if (error) return fail(error.message);
        const list = ((data ?? []) as CustomerSummary[]).map((c) => ({
          nome: c.name,
          atendimentos: c.completed,
          faltas: c.no_shows,
          cancelamentos: c.canceled,
          tem_horario_marcado: c.upcoming > 0,
          dias_sem_vir: c.last_visit_at ? diffDays(dateInSaoPaulo(c.last_visit_at), today) : null,
          gasto: brl(c.spent_cents),
          servico_mais_feito: c.favorite_service ?? undefined,
        }));
        return json({
          total_de_clientes: list.length,
          sumidos: list
            .filter((c) => c.dias_sem_vir !== null && c.dias_sem_vir >= 45 && !c.tem_horario_marcado)
            .sort((a, b) => (b.dias_sem_vir ?? 0) - (a.dias_sem_vir ?? 0))
            .slice(0, 15),
          mais_faltam: list.filter((c) => c.faltas > 0).sort((a, b) => b.faltas - a.faltas).slice(0, 10),
          mais_frequentes: [...list].sort((a, b) => b.atendimentos - a.atendimentos).slice(0, 10),
        });
      },
    }),
    betaZodTool({
      name: "bloquear_agenda",
      description:
        "Bloqueia um período da agenda para novos agendamentos (folga, almoço, feriado). Vale na hora. Não cancela agendamentos que já existem no período: a resposta diz quantos ficaram dentro do bloqueio.",
      inputSchema: z.object({
        profissional: z.string().optional().describe("Código do profissional, ex.: p1. Omita para bloquear o estabelecimento inteiro."),
        data_inicio: dateField("Dia em que o bloqueio começa"),
        hora_inicio: timeField("Hora em que começa"),
        data_fim: dateField("Dia em que o bloqueio termina (igual ao início se for no mesmo dia)"),
        hora_fim: timeField("Hora em que termina. Para o dia inteiro, use 00:00 do dia seguinte"),
        motivo: z.string().max(120).optional(),
      }),
      run: async (input) => {
        const professional = input.profissional ? codes.professionalByCode.get(input.profissional) : null;
        if (input.profissional && !professional) return fail("Código de profissional inexistente.");
        if (!isISODate(input.data_inicio) || !isISODate(input.data_fim) || !isHM(input.hora_inicio) || !isHM(input.hora_fim)) {
          return fail("Datas em AAAA-MM-DD e horas em HH:MM.");
        }
        const { data, error } = await supabase.rpc("owner_create_block", {
          p_business_id: business.id,
          p_professional_id: professional?.id ?? null,
          p_start_date: input.data_inicio,
          p_start_time: input.hora_inicio,
          p_end_date: input.data_fim,
          p_end_time: input.hora_fim,
          p_reason: input.motivo ?? null,
        });
        if (error) return fail(error.message);
        changed = true;
        return json({
          bloqueado: true,
          quem: professional?.name ?? "o estabelecimento inteiro",
          de: `${dayLabel(input.data_inicio)} ${input.hora_inicio}`,
          ate: `${dayLabel(input.data_fim)} ${input.hora_fim}`,
          agendamentos_ja_existentes_no_periodo: (data as { conflicts: number }).conflicts,
        });
      },
    }),
    betaZodTool({
      name: "remover_bloqueio",
      description: "Remove um bloqueio da agenda, identificado pelo dia e pela hora em que começa (veja em agenda_do_dia).",
      inputSchema: z.object({
        data_inicio: dateField("Dia em que o bloqueio começa"),
        hora_inicio: timeField("Hora em que o bloqueio começa"),
        profissional: z.string().optional().describe("Código do profissional do bloqueio. Omita se o bloqueio é do estabelecimento inteiro."),
      }),
      run: async (input) => {
        const professional = input.profissional ? codes.professionalByCode.get(input.profissional) : null;
        if (input.profissional && !professional) return fail("Código de profissional inexistente.");
        if (!isISODate(input.data_inicio) || !isHM(input.hora_inicio)) return fail("Data em AAAA-MM-DD e hora em HH:MM.");
        try {
          const blocks = (await agenda(input.data_inicio, input.data_inicio)).blocks.filter(
            (b) =>
              b.start_date === input.data_inicio &&
              b.start_time === input.hora_inicio &&
              b.professional_id === (professional?.id ?? null),
          );
          if (blocks.length === 0) return fail("Não achei bloqueio começando nesse dia e hora. Confira em agenda_do_dia.");
          const { data, error } = await supabase.from("blocks").delete().eq("id", blocks[0].id).select("id");
          if (error || !data?.length) return fail("Não foi possível remover o bloqueio.");
          changed = true;
          return json({ removido: true, quem: professionalName(blocks[0].professional_id), ate: `${formatDateShort(blocks[0].end_date)} ${blocks[0].end_time}` });
        } catch (error) {
          return fail((error as Error).message);
        }
      },
    }),
    betaZodTool({
      name: "situacao_agendamento",
      description:
        "Confirma, cancela, conclui ou marca falta em um agendamento, identificado pelo dia, horário de início e nome do cliente (veja em agenda_do_dia). Concluir e falta só valem depois do horário.",
      inputSchema: z.object({
        data: dateField("Dia do agendamento"),
        horario: timeField("Horário de início"),
        cliente: z.string().describe("Nome do cliente, como aparece na agenda"),
        acao: z.enum(["confirmar", "cancelar", "concluir", "falta"]),
        motivo: z.string().max(200).optional().describe("Motivo do cancelamento; o cliente vê no link dele"),
      }),
      run: async (input) => {
        if (!isISODate(input.data) || !isHM(input.horario)) return fail("Data em AAAA-MM-DD e hora em HH:MM.");
        try {
          const wanted = input.cliente.trim().toLowerCase();
          const matches = (await agenda(input.data, input.data)).appointments.filter(
            (a) => a.time === input.horario && a.customer_name.toLowerCase().includes(wanted),
          );
          if (matches.length !== 1) {
            return fail(matches.length ? "Mais de um agendamento bate com isso: pergunte ao dono qual." : "Não achei esse agendamento. Confira em agenda_do_dia.");
          }
          const status = { confirmar: "confirmed", cancelar: "canceled", concluir: "completed", falta: "no_show" }[input.acao];
          const { data, error } = await supabase.rpc("owner_set_appointment_status", {
            p_appointment_id: matches[0].id,
            p_status: status,
            p_reason: input.motivo ?? null,
          });
          if (error) return fail(error.message);
          changed = true;
          return json({ antes: STATUS_LABEL[matches[0].status], depois: view(data as OwnerAppointment) });
        } catch (error) {
          return fail((error as Error).message);
        }
      },
    }),
    betaZodTool({
      name: "alterar_servico",
      description: "Pausa ou reativa um serviço e/ou muda preço e duração. Vale na hora para os clientes; agendamentos já feitos não mudam. Informe só o que deve mudar.",
      inputSchema: z.object({
        servico: z.string().describe("Código do serviço, ex.: s3"),
        ativo: z.boolean().optional().describe("false pausa; true reativa"),
        preco_reais: z.number().min(0).max(1000000).optional().describe("Novo preço em reais, ex.: 89.9"),
        duracao_minutos: z.number().int().min(5).max(720).optional().describe("Nova duração, múltiplo de 5"),
      }),
      run: async (input) => {
        const service = codes.serviceByCode.get(input.servico);
        if (!service) return fail("Código de serviço inexistente.");
        const patch: { is_active?: boolean; price_cents?: number; duration_minutes?: number } = {};
        if (input.ativo !== undefined) patch.is_active = input.ativo;
        if (input.preco_reais !== undefined) patch.price_cents = Math.round(input.preco_reais * 100);
        if (input.duracao_minutos !== undefined) {
          if (input.duracao_minutos % 5 !== 0) return fail("A duração precisa ser múltiplo de 5 minutos.");
          patch.duration_minutes = input.duracao_minutos;
        }
        if (Object.keys(patch).length === 0) return fail("Nada para alterar.");
        const { data, error } = await supabase.from("services").update(patch).eq("id", service.id).select("id");
        if (error || !data?.length) return fail("Não foi possível alterar o serviço.");
        changed = true;
        return json({
          servico: service.name,
          antes: { ativo: service.is_active, preco: brl(service.price_cents), duracao: durationLabel(service.duration_minutes) },
          depois: {
            ativo: patch.is_active ?? service.is_active,
            preco: brl(patch.price_cents ?? service.price_cents),
            duracao: durationLabel(patch.duration_minutes ?? service.duration_minutes),
          },
        });
      },
    }),
    betaZodTool({
      name: "alterar_agenda_online",
      description: "Abre ou fecha o agendamento pelo site e/ou liga ou desliga a confirmação automática. Vale na hora. Informe só o que deve mudar.",
      inputSchema: z.object({
        aberta: z.boolean().optional().describe("false fecha o agendamento online; true reabre"),
        confirmacao_automatica: z.boolean().optional(),
      }),
      run: async (input) => {
        const patch: { is_accepting?: boolean; auto_confirm?: boolean } = {};
        if (input.aberta !== undefined) patch.is_accepting = input.aberta;
        if (input.confirmacao_automatica !== undefined) patch.auto_confirm = input.confirmacao_automatica;
        if (Object.keys(patch).length === 0) return fail("Nada para alterar.");
        const { data, error } = await supabase.from("businesses").update(patch).eq("id", business.id).select("id");
        if (error || !data?.length) return fail("Não foi possível alterar.");
        changed = true;
        return json({
          antes: { aberta: business.is_accepting, confirmacao_automatica: business.auto_confirm },
          depois: {
            aberta: patch.is_accepting ?? business.is_accepting,
            confirmacao_automatica: patch.auto_confirm ?? business.auto_confirm,
          },
        });
      },
    }),
  ];

  const context =
    `<contexto_atual>\nAgora: ${dayLabel(today)} (${today}), ${nowTime}, horário de São Paulo.\n` +
    `Próximos dias: ${renderCalendar(today, 21)}\n` +
    `Dias anteriores: ${renderCalendar(today, 35, -35)}\n</contexto_atual>`;

  const messages: Anthropic.Beta.BetaMessageParam[] = history.map((turn, index) =>
    index === history.length - 1 && turn.role === "user"
      ? { role: "user", content: [{ type: "text", text: context }, { type: "text", text: turn.content }] }
      : { role: turn.role, content: turn.content },
  );

  const final = await anthropic().beta.messages.toolRunner({
    model: AI_MODEL,
    max_tokens: 16000,
    max_iterations: 10,
    output_config: { effort: "low" },
    ...FALLBACK_PARAMS,
    system: [{ type: "text", text: systemPrompt(catalog, codes), cache_control: { type: "ephemeral" } }],
    tools,
    messages,
  });

  return {
    reply: textOf(final) || "Não consegui responder agora. Pode perguntar de outro jeito?",
    changed,
  };
}
