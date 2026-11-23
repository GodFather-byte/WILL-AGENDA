"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { addDays, formatDateShort } from "@/lib/dates";
import { createClient } from "@/lib/supabase/client";
import type { Agenda, Block } from "@/lib/types";
import { BlockModal } from "./AgendaModals";
import { DATA_CHANGED, useBusiness } from "./BusinessContext";
import { HoursEditor } from "./HoursEditor";

/** Expediente do estabelecimento e os próximos bloqueios e folgas. */
export function HoursManager() {
  const { business, catalog, today } = useBusiness();
  const supabase = useMemo(() => createClient(), []);
  const [blocks, setBlocks] = useState<Block[] | null>(null);
  const [blocking, setBlocking] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase.rpc("owner_agenda", { p_business_id: business.id, p_from: today, p_to: addDays(today, 60) });
    setBlocks((data as Agenda | null)?.blocks ?? []);
  }, [supabase, business.id, today]);

  useEffect(() => {
    const first = setTimeout(load, 0);
    window.addEventListener(DATA_CHANGED, load);
    return () => {
      clearTimeout(first);
      window.removeEventListener(DATA_CHANGED, load);
    };
  }, [load]);

  return (
    <div className="max-w-3xl space-y-8">
      <section className="card p-5">
        <h1 className="text-xl font-bold">Horário de funcionamento</h1>
        <p className="mb-3 text-sm text-stone-600">
          Vale para todos os profissionais, menos para quem tem horário próprio (configurado em Profissionais).
        </p>
        <HoursEditor professionalId={null} hours={catalog.hours.filter((h) => h.professional_id === null)} />
      </section>

      <section className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">Bloqueios e folgas</h2>
            <p className="text-sm text-stone-600">Períodos sem agendamento nos próximos 60 dias.</p>
          </div>
          <button className="btn-primary" onClick={() => setBlocking(true)}>+ Bloquear</button>
        </div>
        {blocks === null ? (
          <p className="mt-3 text-sm text-stone-500">Carregando...</p>
        ) : blocks.length === 0 ? (
          <p className="mt-3 text-sm text-stone-500">Nenhum bloqueio.</p>
        ) : (
          <ul className="mt-3 divide-y divide-stone-100 text-sm">
            {blocks.map((block) => (
              <li key={block.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
                <span className="font-medium">
                  {block.professional_id ? (catalog.professionals.find((p) => p.id === block.professional_id)?.name ?? "Profissional") : "Todos"}
                </span>
                <span className="text-stone-600">
                  {block.start_date === block.end_date
                    ? `${formatDateShort(block.start_date)}, ${block.start_time} às ${block.end_time}`
                    : `${formatDateShort(block.start_date)} ${block.start_time} até ${formatDateShort(block.end_date)} ${block.end_time}`}
                </span>
                {block.reason && <span className="text-stone-500">{block.reason}</span>}
                <button className="ml-auto font-semibold text-red-700"
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
        )}
      </section>
      {blocking && <BlockModal date={today} onClose={() => setBlocking(false)} onCreated={load} />}
    </div>
  );
}
