"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addDays, dayOfMonth, formatDateLong, monthLong, relativeDay } from "@/lib/dates";
import { errorMessage } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import type { Availability, Slot } from "@/lib/types";

const CHUNK_DAYS = 21;

const PERIODS = [
  { label: "Manhã", from: 0, to: 12 },
  { label: "Tarde", from: 12, to: 18 },
  { label: "Noite", from: 18, to: 24 },
];

type Loaded = { today: string; lastDate: string; loadedTo: string; accepting: boolean; slots: Record<string, Slot[]> };

/**
 * Dia e horário. Os horários livres vêm do banco (get_availability), já no relógio de São Paulo;
 * aqui só se escolhe. Dias sem horário aparecem desabilitados.
 */
export function SlotPicker({
  businessId,
  serviceId,
  professionalId,
  token,
  refreshKey = 0,
  selected,
  onSelect,
}: {
  businessId: string;
  serviceId: string;
  /** null = qualquer profissional que faça o serviço. */
  professionalId: string | null;
  /** Ao remarcar: o link do próprio agendamento, para o horário atual dele contar como livre. */
  token?: string;
  /** Mude para recarregar (ex.: depois de "este horário acabou de ser ocupado"). */
  refreshKey?: number;
  selected: Slot | null;
  onSelect: (slot: Slot, date: string) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const load = useCallback(
    async (from: string | null, previous: Loaded | null) => {
      const current = ++request.current;
      setBusy(true);
      setError(null);
      const { data, error } = await supabase.rpc("get_availability", {
        p_business_id: businessId,
        p_service_id: serviceId,
        p_professional_id: professionalId,
        p_from: from,
        p_days: CHUNK_DAYS,
        p_token: token ?? null,
      });
      if (current !== request.current) return;
      setBusy(false);
      if (error) {
        setError(errorMessage(error, "Não foi possível carregar os horários. Tente de novo."));
        return;
      }
      const availability = data as Availability;
      const slots = { ...(previous?.slots ?? {}) };
      for (const day of availability.days) slots[day.date] = day.slots;
      const next: Loaded = {
        today: availability.today,
        lastDate: availability.last_date,
        loadedTo: availability.to,
        accepting: availability.accepting,
        slots,
      };
      setLoaded(next);
      // Abre no primeiro dia com horário livre (do trecho novo, ou do que já estava carregado).
      setDate((chosen) => {
        if (chosen && slots[chosen]?.length) return chosen;
        return availability.days[0]?.date ?? Object.keys(slots).sort()[0] ?? null;
      });
    },
    [supabase, businessId, serviceId, professionalId, token],
  );

  useEffect(() => {
    // Serviço ou profissional mudou: começa de novo, a partir de hoje.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoaded(null);
    setDate(null);
    load(null, null);
  }, [load, refreshKey]);

  const days = useMemo(() => {
    if (!loaded) return [];
    const list: string[] = [];
    for (let day = loaded.today; day <= loaded.loadedTo; day = addDays(day, 1)) list.push(day);
    return list;
  }, [loaded]);

  if (!loaded) {
    return (
      <div className="py-6 text-center text-sm text-stone-500" role="status">
        {error ? (
          <>
            <p role="alert" className="text-red-700">{error}</p>
            <button type="button" className="btn-outline mt-3" onClick={() => load(null, null)}>Tentar de novo</button>
          </>
        ) : (
          "Buscando horários livres..."
        )}
      </div>
    );
  }

  if (!loaded.accepting) {
    return <p className="py-4 text-sm text-stone-600">A agenda online está fechada no momento.</p>;
  }

  const canLoadMore = loaded.loadedTo < loaded.lastDate;
  const hasAny = Object.values(loaded.slots).some((list) => list.length > 0);
  const slots = date ? (loaded.slots[date] ?? []) : [];

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-sm font-medium text-stone-700 first-letter:uppercase">
          {date ? `${monthLong(date)}` : monthLong(loaded.today)}
        </p>
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2" role="listbox" aria-label="Dia">
          {days.map((day) => {
            const free = (loaded.slots[day]?.length ?? 0) > 0;
            const active = day === date;
            return (
              <button
                key={day}
                type="button"
                role="option"
                aria-selected={active}
                aria-label={formatDateLong(day)}
                data-date={day}
                disabled={!free}
                onClick={() => setDate(day)}
                className={`flex w-14 shrink-0 flex-col items-center rounded-xl border px-1 py-2 text-sm transition ${
                  active
                    ? "border-brand bg-brand text-brand-fg"
                    : free
                      ? "border-stone-300 bg-white text-stone-800 hover:border-brand"
                      : "border-stone-200 bg-stone-100 text-stone-400"
                }`}
              >
                <span className="text-xs">{relativeDay(day, loaded.today)}</span>
                <span className="text-lg font-bold leading-tight">{dayOfMonth(day)}</span>
              </button>
            );
          })}
          {canLoadMore && (
            <button
              type="button"
              disabled={busy}
              onClick={() => load(addDays(loaded.loadedTo, 1), loaded)}
              className="flex w-20 shrink-0 flex-col items-center justify-center rounded-xl border border-dashed border-stone-300 px-1 py-2 text-xs font-medium text-stone-600 hover:border-brand"
            >
              {busy ? "Buscando..." : "Mais datas"}
            </button>
          )}
        </div>
      </div>

      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}

      {!hasAny ? (
        <p className="rounded-lg bg-stone-100 px-3 py-3 text-sm text-stone-700">
          Não há horários livres até {formatDateLong(loaded.loadedTo)}.
          {canLoadMore ? " Toque em “Mais datas” para ver adiante." : ""}
        </p>
      ) : (
        date && (
          <div aria-live="polite">
            <p className="mb-2 text-sm text-stone-600">
              Horários de <span className="font-medium text-stone-900">{formatDateLong(date)}</span>
            </p>
            {slots.length === 0 ? (
              <p className="text-sm text-stone-500">Nenhum horário livre neste dia.</p>
            ) : (
              <div className="space-y-3">
                {PERIODS.map((period) => {
                  const list = slots.filter((slot) => {
                    const hour = Number(slot.time.slice(0, 2));
                    return hour >= period.from && hour < period.to;
                  });
                  if (list.length === 0) return null;
                  return (
                    <div key={period.label}>
                      <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-stone-500">{period.label}</p>
                      <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                        {list.map((slot) => {
                          const active = selected?.at === slot.at;
                          return (
                            <button
                              key={slot.at}
                              type="button"
                              aria-pressed={active}
                              onClick={() => onSelect(slot, date)}
                              className={`rounded-lg border px-2 py-2.5 text-sm font-semibold transition ${
                                active
                                  ? "border-brand bg-brand text-brand-fg"
                                  : "border-stone-300 bg-white text-stone-800 hover:border-brand"
                              }`}
                            >
                              {slot.time}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )
      )}
    </div>
  );
}
