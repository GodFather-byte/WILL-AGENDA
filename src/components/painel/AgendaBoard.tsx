"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hoursFor } from "@/lib/data";
import { addDays, formatDateLong, minutesOf, timeOf, weekdayOf } from "@/lib/dates";
import { brl, STATUS_LABEL } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import type { Agenda, Block, Professional } from "@/lib/types";
import { AppointmentModal, BlockModal, NewAppointmentModal } from "./AgendaModals";
import { DATA_CHANGED, useBusiness } from "./BusinessContext";

const PX_PER_MINUTE = 1.2;
const ON_GRID = ["pending", "confirmed", "completed"];

const CARD_STYLE: Record<string, string> = {
  pending: "border-amber-300 bg-amber-50 text-amber-950",
  confirmed: "border-brand/40 bg-brand/10 text-stone-900",
  completed: "border-stone-300 bg-stone-100 text-stone-600",
};

function beep() {
  try {
    const ctx = new AudioContext();
    [0, 0.25].forEach((offset) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.2, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.2);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.2);
    });
  } catch {
    // Navegador bloqueou áudio antes de interação; o destaque visual continua.
  }
}

/** Agenda do dia, por profissional, em tempo real. */
export function AgendaBoard() {
  const { business, catalog, today: openedOn } = useBusiness();
  const supabase = useMemo(() => createClient(), []);
  const [date, setDate] = useState(openedOn);
  const [agenda, setAgenda] = useState<Agenda | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ professionalId?: string; time?: string } | null>(null);
  const [blocking, setBlocking] = useState(false);
  const known = useRef<Set<string> | null>(null);
  const knownDate = useRef(date);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("owner_agenda", { p_business_id: business.id, p_from: date, p_to: date });
    if (error) {
      setError("Sem conexão com o servidor. Tentando de novo...");
      return;
    }
    setError(null);
    const next = data as Agenda;
    // Aviso sonoro quando chega agendamento novo feito pelo cliente (site ou IA) no dia aberto.
    if (known.current && knownDate.current === date) {
      if (next.appointments.some((a) => a.source !== "panel" && !known.current!.has(a.id))) beep();
    }
    known.current = new Set(next.appointments.map((a) => a.id));
    knownDate.current = date;
    setAgenda(next);
  }, [supabase, business.id, date]);

  useEffect(() => {
    // Estornos que ficaram pendentes (cliente cancelou e fechou a página): o servidor conclui.
    if (business.charge_on_booking) void fetch("/api/painel/pagamentos/pendencias", { method: "POST" }).catch(() => null);
  }, [business.charge_on_booking]);

  useEffect(() => {
    const first = setTimeout(load, 0);
    // Tempo real + consulta de segurança: se a conexão em tempo real cair, a agenda não fica cega.
    const channel = supabase
      .channel(`agenda-${business.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "appointments", filter: `business_id=eq.${business.id}` }, load)
      .subscribe();
    const interval = setInterval(load, 20000);
    window.addEventListener(DATA_CHANGED, load);
    return () => {
      window.removeEventListener(DATA_CHANGED, load);
      clearTimeout(first);
      clearInterval(interval);
      supabase.removeChannel(channel);
    };
  }, [supabase, business.id, load]);

  const appointments = useMemo(() => agenda?.appointments ?? [], [agenda]);
  const blocks = agenda?.blocks ?? [];
  // O "hoje" vem do banco a cada atualização, então a virada do dia é acompanhada com o painel aberto.
  const today = agenda?.today ?? openedOn;
  const weekday = weekdayOf(date);

  // Colunas: profissionais ativos, mais quem tiver agendamento no dia mesmo desativado.
  const columns = catalog.professionals.filter(
    (p) => (p.is_active || appointments.some((a) => a.professional_id === p.id)) && (!filter || p.id === filter),
  );

  // Faixa de horas da grade: do primeiro expediente ao último, esticada pelos agendamentos do dia.
  const range = useMemo(() => {
    let start = Infinity;
    let end = -Infinity;
    for (const h of catalog.hours) {
      if (h.weekday !== weekday) continue;
      start = Math.min(start, minutesOf(h.start_time));
      end = Math.max(end, minutesOf(h.end_time));
    }
    for (const a of appointments) {
      if (!ON_GRID.includes(a.status)) continue;
      const from = minutesOf(a.time);
      start = Math.min(start, from);
      end = Math.max(end, Math.min(from + a.duration_minutes, 1440));
    }
    if (start === Infinity) [start, end] = [480, 1080];
    return { start: Math.floor(start / 60) * 60, end: Math.min(Math.ceil(end / 60) * 60, 1440) };
  }, [catalog.hours, appointments, weekday]);

  const height = (range.end - range.start) * PX_PER_MINUTE;
  const hours: number[] = [];
  for (let m = range.start; m < range.end; m += 60) hours.push(m);

  const active = appointments.filter((a) => ON_GRID.includes(a.status));
  const pending = appointments.filter((a) => a.status === "pending");
  const off = appointments.filter((a) => !ON_GRID.includes(a.status));
  const revenue = active.reduce((sum, a) => sum + a.price_cents, 0);
  const current = appointments.find((a) => a.id === opened) ?? null;
  const nowLine = date === today && agenda ? minutesOf(agenda.now_time) : null;

  function blockSpan(block: Block) {
    const from = block.start_date < date ? 0 : minutesOf(block.start_time);
    const to = block.end_date > date ? 1440 : minutesOf(block.end_time);
    return { from: Math.max(from, range.start), to: Math.min(to, range.end) };
  }

  function clickColumn(event: React.MouseEvent<HTMLDivElement>, professional: Professional) {
    if (event.target !== event.currentTarget) return;
    const offset = event.clientY - event.currentTarget.getBoundingClientRect().top;
    const step = business.slot_step_minutes;
    const minutes = range.start + Math.floor(offset / PX_PER_MINUTE / step) * step;
    setCreating({ professionalId: professional.id, time: timeOf(Math.min(minutes, 1439)) });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <button className="btn-outline px-3" aria-label="Dia anterior" onClick={() => setDate(addDays(date, -1))}>‹</button>
          <button className="btn-outline" onClick={() => setDate(today)} disabled={date === today}>Hoje</button>
          <button className="btn-outline px-3" aria-label="Próximo dia" onClick={() => setDate(addDays(date, 1))}>›</button>
        </div>
        <input type="date" aria-label="Data da agenda" className="input w-auto" value={date}
          onChange={(e) => e.target.value && setDate(e.target.value)} />
        <h1 className="text-lg font-bold first-letter:uppercase">{date === today ? `Hoje, ${formatDateLong(date)}` : formatDateLong(date)}</h1>
        <div className="ml-auto flex gap-2">
          <button className="btn-outline" onClick={() => setBlocking(true)}>Bloquear horário</button>
          <button className="btn-primary" onClick={() => setCreating({})}>+ Novo agendamento</button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {[
          ["Agendamentos", String(active.length)],
          ["Aguardando confirmação", String(pending.length)],
          ["Previsto no dia", brl(revenue)],
        ].map(([label, value]) => (
          <div key={label} className="card px-4 py-3">
            <p className="text-xs text-stone-500">{label}</p>
            <p className="text-xl font-bold">{value}</p>
          </div>
        ))}
      </div>

      {catalog.professionals.filter((p) => p.is_active).length > 1 && (
        <div className="flex gap-2 overflow-x-auto" role="group" aria-label="Filtrar por profissional">
          <FilterChip active={filter === null} onClick={() => setFilter(null)}>Todos</FilterChip>
          {catalog.professionals.filter((p) => p.is_active).map((p) => (
            <FilterChip key={p.id} active={filter === p.id} onClick={() => setFilter(p.id)}>{p.name}</FilterChip>
          ))}
        </div>
      )}

      {error && <p role="alert" className="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-800">{error}</p>}

      {agenda === null ? (
        <p className="text-sm text-stone-500">Carregando agenda...</p>
      ) : columns.length === 0 ? (
        <p className="card px-5 py-8 text-center text-sm text-stone-600">Cadastre um profissional para começar a agendar.</p>
      ) : (
        <div className="card overflow-x-auto">
          <div className="flex min-w-max">
            <div className="sticky left-0 z-20 w-12 shrink-0 border-r border-stone-200 bg-white">
              <div className="h-10 border-b border-stone-200" />
              <div className="relative" style={{ height }}>
                {hours.map((m) => (
                  <span key={m} className="absolute right-1.5 -translate-y-1/2 text-xs text-stone-500"
                    style={{ top: (m - range.start) * PX_PER_MINUTE }}>
                    {m === range.start ? "" : timeOf(m)}
                  </span>
                ))}
              </div>
            </div>
            {columns.map((professional) => {
              const periods = hoursFor(catalog.hours, professional).filter((h) => h.weekday === weekday);
              return (
                <section key={professional.id} aria-label={`Agenda de ${professional.name}`}
                  className="min-w-[170px] flex-1 border-r border-stone-200 last:border-r-0">
                  <h2 className="flex h-10 items-center justify-center border-b border-stone-200 px-2 text-sm font-semibold">
                    <span className="truncate">{professional.name}</span>
                    {!professional.is_active && <span className="ml-1 text-xs font-normal text-stone-500">(inativo)</span>}
                  </h2>
                  <div className="relative cursor-pointer bg-stone-100" style={{ height }}
                    onClick={(event) => clickColumn(event, professional)}>
                    {/* Expediente em branco; fora dele, cinza. */}
                    {periods.map((h) => {
                      const from = Math.max(minutesOf(h.start_time), range.start);
                      const to = Math.min(minutesOf(h.end_time), range.end);
                      return (
                        <div key={h.id} className="pointer-events-none absolute inset-x-0 bg-white"
                          style={{ top: (from - range.start) * PX_PER_MINUTE, height: (to - from) * PX_PER_MINUTE }} />
                      );
                    })}
                    {hours.map((m) => (
                      <div key={m} className="pointer-events-none absolute inset-x-0 border-t border-stone-200/80"
                        style={{ top: (m - range.start) * PX_PER_MINUTE }} />
                    ))}
                    {blocks
                      .filter((b) => b.professional_id === null || b.professional_id === professional.id)
                      .map((block) => {
                        const span = blockSpan(block);
                        if (span.to <= span.from) return null;
                        return (
                          <div key={block.id}
                            className="pointer-events-none absolute inset-x-0 overflow-hidden border-y border-stone-300 bg-[repeating-linear-gradient(135deg,#e7e5e4,#e7e5e4_6px,#f5f5f4_6px,#f5f5f4_12px)] px-2 py-0.5 text-xs font-medium text-stone-600"
                            style={{ top: (span.from - range.start) * PX_PER_MINUTE, height: (span.to - span.from) * PX_PER_MINUTE }}>
                            Bloqueado{block.reason ? `: ${block.reason}` : ""}
                          </div>
                        );
                      })}
                    {nowLine !== null && nowLine >= range.start && nowLine <= range.end && (
                      <div className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-red-500"
                        style={{ top: (nowLine - range.start) * PX_PER_MINUTE }} />
                    )}
                    {active
                      .filter((a) => a.professional_id === professional.id)
                      .map((a) => (
                        <button key={a.id} type="button" onClick={() => setOpened(a.id)}
                          aria-label={`${a.time} ${a.customer_name}, ${a.service_name}, ${STATUS_LABEL[a.status]}`}
                          className={`absolute inset-x-1 z-10 overflow-hidden rounded-lg border px-2 py-1 text-left text-xs leading-tight shadow-sm ${CARD_STYLE[a.status]}`}
                          style={{
                            top: (minutesOf(a.time) - range.start) * PX_PER_MINUTE + 1,
                            height: Math.max(a.duration_minutes * PX_PER_MINUTE - 2, 22),
                          }}>
                          <span className="font-bold">{a.time}</span> <span className="font-semibold">{a.customer_name}</span>
                          <span className="block truncate">{a.service_name}</span>
                          {a.status === "pending" && (
                            <span className="block font-semibold">
                              {a.payment_status === "awaiting" ? "Aguardando pagamento" : "Aguardando confirmação"}
                            </span>
                          )}
                          {(a.payment_status === "paid" || a.payment_status === "manual_paid") && <span className="block">Sinal pago</span>}
                          {a.status === "confirmed" && a.is_past && <span className="block font-semibold">Dar baixa</span>}
                        </button>
                      ))}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}

      {blocks.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-stone-700">Bloqueios neste dia</h2>
          <ul className="card divide-y divide-stone-100 text-sm">
            {blocks.map((block) => (
              <li key={block.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
                <span className="font-medium">
                  {block.professional_id ? (catalog.professionals.find((p) => p.id === block.professional_id)?.name ?? "Profissional") : "Todos"}
                </span>
                <span className="text-stone-600">
                  {block.start_date === block.end_date
                    ? `${block.start_time} às ${block.end_time}`
                    : `${block.start_date.slice(8)}/${block.start_date.slice(5, 7)} ${block.start_time} até ${block.end_date.slice(8)}/${block.end_date.slice(5, 7)} ${block.end_time}`}
                </span>
                {block.reason && <span className="text-stone-500">{block.reason}</span>}
                <button className="ml-auto text-sm font-semibold text-red-700"
                  onClick={async () => {
                    if (!window.confirm("Remover este bloqueio?")) return;
                    await supabase.from("blocks").delete().eq("id", block.id);
                    load();
                  }}>
                  Remover
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {off.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-stone-700">Cancelados e faltas</h2>
          <ul className="card divide-y divide-stone-100 text-sm">
            {off.map((a) => (
              <li key={a.id}>
                <button className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-left hover:bg-stone-50" onClick={() => setOpened(a.id)}>
                  <span className="font-semibold">{a.time}</span>
                  <span>{a.customer_name}</span>
                  <span className="text-stone-600">{a.service_name}</span>
                  <span className="ml-auto text-red-700">{STATUS_LABEL[a.status]}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {current && <AppointmentModal appointment={current} today={today} onClose={() => setOpened(null)} onChanged={load} />}
      {creating && (
        <NewAppointmentModal date={date} professionalId={creating.professionalId} time={creating.time}
          onClose={() => setCreating(null)} onCreated={load} />
      )}
      {blocking && <BlockModal date={date} onClose={() => setBlocking(false)} onCreated={load} />}
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick}
      className={`shrink-0 rounded-full border px-3 py-1.5 text-sm font-medium ${
        active ? "border-stone-900 bg-stone-900 text-white" : "border-stone-300 bg-white text-stone-700"
      }`}>
      {children}
    </button>
  );
}

