"use client";

/* eslint-disable @next/next/no-img-element -- logotipo vem do Storage já reduzido */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { InstallPrompt } from "@/components/InstallGuide";
import { STORAGE_PREFIX } from "@/lib/brand";
import { brandStyle } from "@/lib/color";
import { BUSINESS_COLUMNS, fetchCatalog } from "@/lib/data";
import { createClient } from "@/lib/supabase/client";
import type { Business, Catalog } from "@/lib/types";
import { BusinessContext, DATA_CHANGED } from "./BusinessContext";

const NAV = [
  { href: "/painel", label: "Agenda" },
  { href: "/painel/clientes", label: "Clientes" },
  { href: "/painel/servicos", label: "Serviços" },
  { href: "/painel/profissionais", label: "Profissionais" },
  { href: "/painel/horarios", label: "Horários" },
  { href: "/painel/configuracoes", label: "Configurações" },
];

export function PainelShell({
  initialCatalog,
  today,
  children,
}: {
  initialCatalog: Catalog;
  today: string;
  children: React.ReactNode;
}) {
  const [catalog, setCatalog] = useState(initialCatalog);
  const [toggling, setToggling] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const { business } = catalog;

  const setBusiness = useCallback((next: Business) => setCatalog((current) => ({ ...current, business: next })), []);

  const reload = useCallback(async () => {
    const { data } = await supabase.from("businesses").select(BUSINESS_COLUMNS).eq("id", business.id).maybeSingle();
    const fresh = (data as Business | null) ?? business;
    setCatalog(await fetchCatalog(supabase, fresh));
  }, [supabase, business]);

  useEffect(() => {
    const onChange = () => void reload();
    window.addEventListener(DATA_CHANGED, onChange);
    return () => window.removeEventListener(DATA_CHANGED, onChange);
  }, [reload]);

  async function toggleAccepting() {
    setToggling(true);
    const { error } = await supabase.from("businesses").update({ is_accepting: !business.is_accepting }).eq("id", business.id);
    if (!error) setBusiness({ ...business, is_accepting: !business.is_accepting });
    setToggling(false);
  }

  async function logout() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <BusinessContext.Provider value={{ business, catalog, today, setBusiness, reload }}>
      <div style={brandStyle(business.primary_color)} className="flex min-h-full flex-1 flex-col">
        <header className="border-b border-stone-200 bg-white print:hidden">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
            {business.logo_url && (
              <img src={business.logo_url} alt="" className="h-10 w-10 shrink-0 rounded-lg border border-stone-200 object-contain" />
            )}
            <div className="min-w-0 flex-1 sm:flex-none">
              <p className="truncate font-bold">{business.name}</p>
              <a href={`/${business.slug}`} target="_blank" className="text-xs text-stone-500 hover:text-brand">
                /{business.slug} ↗
              </a>
            </div>
            <nav className="order-last flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto" aria-label="Painel">
              {NAV.map((item) => {
                const active = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`shrink-0 rounded-lg px-3 py-2 text-sm font-medium ${
                      active ? "bg-stone-900 text-white" : "text-stone-600 hover:bg-stone-100"
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
            <div className="flex items-center gap-1 sm:ml-auto sm:gap-2">
              <button
                onClick={toggleAccepting}
                disabled={toggling}
                aria-pressed={business.is_accepting}
                title="Liga ou desliga o agendamento pelo site"
                className={`btn border ${
                  business.is_accepting
                    ? "border-green-200 bg-green-50 text-green-800 hover:bg-green-100"
                    : "border-red-200 bg-red-50 text-red-800 hover:bg-red-100"
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${business.is_accepting ? "bg-green-600" : "bg-red-600"}`} />
                <span className="hidden sm:inline">{business.is_accepting ? "Agenda online aberta" : "Agenda online fechada"}</span>
                <span className="sm:hidden">{business.is_accepting ? "Aberta" : "Fechada"}</span>
              </button>
              <button onClick={logout} className="btn-ghost">
                Sair
              </button>
            </div>
          </div>
        </header>
        <div className="mx-auto w-full max-w-7xl flex-1 px-4 pb-24 pt-6">
          <InstallPrompt variant="banner" appName={business.name} storageKey={`${STORAGE_PREFIX}:instalar:painel`} className="mb-4" />
          {children}
        </div>
      </div>
    </BusinessContext.Provider>
  );
}
