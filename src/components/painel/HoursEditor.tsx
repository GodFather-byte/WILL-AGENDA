"use client";

import { useState } from "react";
import { hm, WEEKDAYS } from "@/lib/dates";
import { errorMessage } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import type { WorkingHour } from "@/lib/types";
import { useBusiness } from "./BusinessContext";

type Period = { start: string; end: string };

/**
 * Expediente por dia da semana, em períodos. Dois períodos no mesmo dia formam o intervalo
 * (09:00 às 12:00 e 13:00 às 18:00). Vale para o estabelecimento (professionalId nulo) ou para um profissional.
 */
export function HoursEditor({ professionalId, hours }: { professionalId: string | null; hours: WorkingHour[] }) {
  const { business, reload } = useBusiness();
  const [days, setDays] = useState<Period[][]>(() =>
    WEEKDAYS.map((_, weekday) =>
      hours.filter((h) => h.weekday === weekday).map((h) => ({ start: hm(h.start_time), end: hm(h.end_time) })),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const update = (weekday: number, periods: Period[]) => {
    setMessage(null);
    setDays((current) => current.map((list, index) => (index === weekday ? periods : list)));
  };

  async function save() {
    setBusy(true);
    setMessage(null);
    const { error } = await createClient().rpc("set_working_hours", {
      p_business_id: business.id,
      p_professional_id: professionalId,
      p_hours: days.flatMap((periods, weekday) => periods.map((p) => ({ weekday, start: p.start, end: p.end }))),
    });
    setBusy(false);
    if (error) return setMessage({ ok: false, text: errorMessage(error, "Não foi possível salvar o expediente.") });
    await reload();
    setMessage({ ok: true, text: "Expediente salvo." });
  }

  return (
    <div className="space-y-3">
      <ul className="divide-y divide-stone-100">
        {WEEKDAYS.map((label, weekday) => {
          const periods = days[weekday];
          return (
            <li key={label} className="flex flex-wrap items-start gap-x-3 gap-y-2 py-2.5 text-sm">
              <span className="w-20 shrink-0 pt-2 font-medium">{label}</span>
              <div className="flex-1 space-y-2">
                {periods.length === 0 && <p className="pt-2 text-stone-500">Fechado</p>}
                {periods.map((period, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <input type="time" aria-label={`${label}, início do período ${index + 1}`} className="input w-auto py-1.5" value={period.start}
                      onChange={(e) => update(weekday, periods.map((p, i) => (i === index ? { ...p, start: e.target.value } : p)))} />
                    <span className="text-stone-500">às</span>
                    <input type="time" aria-label={`${label}, fim do período ${index + 1}`} className="input w-auto py-1.5" value={period.end}
                      onChange={(e) => update(weekday, periods.map((p, i) => (i === index ? { ...p, end: e.target.value } : p)))} />
                    <button type="button" aria-label={`Remover período ${index + 1} de ${label}`} className="px-2 text-stone-400 hover:text-red-700"
                      onClick={() => update(weekday, periods.filter((_, i) => i !== index))}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              <button type="button" className="btn-ghost py-1.5 text-xs"
                onClick={() => {
                  const last = periods[periods.length - 1];
                  update(weekday, [...periods, last ? { start: last.end, end: "18:00" } : { start: "09:00", end: "18:00" }]);
                }}>
                {periods.length === 0 ? "Abrir" : "+ Período"}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-stone-500">
        Para ter intervalo (almoço), use dois períodos no mesmo dia. Mudar o expediente não cancela agendamentos já feitos.
      </p>
      {message && (
        <p role={message.ok ? "status" : "alert"} className={`text-sm ${message.ok ? "text-green-700" : "text-red-700"}`}>
          {message.text}
        </p>
      )}
      <button type="button" className="btn-primary" disabled={busy} onClick={save}>
        {busy ? "Salvando..." : "Salvar expediente"}
      </button>
    </div>
  );
}
