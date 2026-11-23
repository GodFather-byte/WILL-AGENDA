"use client";

import { useState } from "react";
import { Modal } from "@/components/Modal";
import { centsToInput, durationLabel, groupByCategory, parseBRL, priceLabel } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import type { Service } from "@/lib/types";
import { useBusiness } from "./BusinessContext";

export function ServicesManager() {
  const { catalog, reload } = useBusiness();
  const [editing, setEditing] = useState<Service | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(service: Service) {
    const { error } = await createClient().from("services").update({ is_active: !service.is_active }).eq("id", service.id);
    setError(error ? "Não foi possível alterar o serviço." : null);
    await reload();
  }

  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Serviços</h1>
          <p className="text-sm text-stone-600">O que o cliente pode agendar, com duração e preço.</p>
        </div>
        <button className="btn-primary" onClick={() => setEditing("new")}>+ Novo serviço</button>
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {catalog.services.length === 0 && (
        <p className="card px-5 py-8 text-center text-sm text-stone-600">Nenhum serviço cadastrado.</p>
      )}
      {groupByCategory(catalog.services).map((group) => (
        <section key={group.category ?? ""}>
          <h2 className="mb-2 text-sm font-semibold text-stone-700">{group.category ?? "Sem categoria"}</h2>
          <ul className="card divide-y divide-stone-100">
            {group.items.map((service) => {
              const nobody = !catalog.professionals.some((p) => p.is_active && p.service_ids.includes(service.id));
              return (
                <li key={service.id} className={`flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm ${service.is_active ? "" : "opacity-60"}`}>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{service.name}</p>
                    <p className="text-stone-500">
                      {durationLabel(service.duration_minutes)} · {priceLabel(service)}
                      {!service.is_active && " · pausado"}
                    </p>
                    {service.is_active && nobody && (
                      <p className="text-xs font-medium text-amber-700">
                        Nenhum profissional faz este serviço: ele não aparece para o cliente.
                      </p>
                    )}
                  </div>
                  <button className="btn-ghost py-1.5" onClick={() => toggle(service)}>{service.is_active ? "Pausar" : "Reativar"}</button>
                  <button className="btn-outline py-1.5" onClick={() => setEditing(service)}>Editar</button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {editing && <ServiceModal service={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ServiceModal({ service, onClose }: { service: Service | null; onClose: () => void }) {
  const { business, catalog, reload } = useBusiness();
  const [form, setForm] = useState({
    name: service?.name ?? "",
    category: service?.category ?? "",
    description: service?.description ?? "",
    duration: String(service?.duration_minutes ?? 30),
    price: centsToInput(service?.price_cents ?? 0),
    price_from: service?.price_from ?? false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  const categories = [...new Set(catalog.services.map((s) => s.category).filter(Boolean))] as string[];

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const price = parseBRL(form.price);
    const duration = parseInt(form.duration);
    if (price === null) return setError("Preço inválido. Use o formato 80,00.");
    if (!(duration >= 5 && duration <= 720) || duration % 5 !== 0) {
      return setError("A duração deve ser em minutos, de 5 em 5 (entre 5 e 720).");
    }
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const patch = {
      name: form.name.trim(),
      category: form.category.trim() || null,
      description: form.description.trim() || null,
      duration_minutes: duration,
      price_cents: price,
      price_from: form.price_from,
    };
    if (service) {
      const { error } = await supabase.from("services").update(patch).eq("id", service.id);
      if (error) {
        setBusy(false);
        return setError("Não foi possível salvar.");
      }
    } else {
      const position = Math.max(0, ...catalog.services.map((s) => s.position)) + 1;
      const { data, error } = await supabase
        .from("services")
        .insert({ ...patch, business_id: business.id, position })
        .select("id")
        .single();
      if (error || !data) {
        setBusy(false);
        return setError("Não foi possível salvar.");
      }
      // Com um profissional só, o serviço novo já nasce ligado a ele.
      const active = catalog.professionals.filter((p) => p.is_active);
      if (active.length === 1) {
        await supabase.rpc("set_professional_services", {
          p_professional_id: active[0].id,
          p_service_ids: [...active[0].service_ids, data.id],
        });
      }
    }
    await reload();
    onClose();
  }

  async function remove() {
    if (!service || !window.confirm(`Apagar "${service.name}"? Os agendamentos já feitos continuam no histórico.`)) return;
    setBusy(true);
    const { error } = await createClient().from("services").delete().eq("id", service.id);
    if (error) {
      setBusy(false);
      return setError("Não foi possível apagar.");
    }
    await reload();
    onClose();
  }

  return (
    <Modal title={service ? "Editar serviço" : "Novo serviço"} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <div>
          <label className="label" htmlFor="sv-name">Nome</label>
          <input id="sv-name" required maxLength={80} className="input" value={form.name} onChange={(e) => set("name", e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="sv-category">Categoria (opcional)</label>
          <input id="sv-category" maxLength={40} className="input" list="sv-categories" placeholder="Ex.: Cabelo"
            value={form.category} onChange={(e) => set("category", e.target.value)} />
          <datalist id="sv-categories">
            {categories.map((c) => <option key={c} value={c} />)}
          </datalist>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label" htmlFor="sv-duration">Duração (minutos)</label>
            <input id="sv-duration" required inputMode="numeric" className="input" value={form.duration}
              onChange={(e) => set("duration", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="sv-price">Preço (R$)</label>
            <input id="sv-price" required inputMode="decimal" className="input" value={form.price}
              onChange={(e) => set("price", e.target.value)} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.price_from} onChange={(e) => set("price_from", e.target.checked)} />
          Mostrar como “a partir de” (o valor final depende da avaliação)
        </label>
        <div>
          <label className="label" htmlFor="sv-description">Descrição (opcional)</label>
          <textarea id="sv-description" rows={2} maxLength={500} className="input" value={form.description}
            onChange={(e) => set("description", e.target.value)} />
        </div>
        {!service && catalog.professionals.filter((p) => p.is_active).length > 1 && (
          <p className="text-xs text-stone-500">Depois de salvar, marque em Profissionais quem faz este serviço.</p>
        )}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          {service && <button type="button" className="btn-danger mr-auto" disabled={busy} onClick={remove}>Apagar</button>}
          <button type="button" className="btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn-primary" disabled={busy}>{busy ? "Salvando..." : "Salvar"}</button>
        </div>
      </form>
    </Modal>
  );
}
