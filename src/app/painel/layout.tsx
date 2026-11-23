import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { CreateBusinessForm } from "@/components/painel/CreateBusinessForm";
import { PainelShell } from "@/components/painel/PainelShell";
import { fetchBusinessByOwner, fetchCatalog } from "@/lib/data";
import { todayInSaoPaulo } from "@/lib/dates";
import { createClient } from "@/lib/supabase/server";

// Dados sempre atuais (sessão, agenda): a rota renderiza a cada requisição.
export const instant = false;

// Uma leitura só por requisição, usada pelo layout e pelos metadados.
const loadOwner = cache(async () => {
  // Sessão e relógio dependem da requisição: nada daqui entra na parte pré-renderizada.
  await connection();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const business = user ? await fetchBusinessByOwner(supabase, user.id) : null;
  return { user, business, catalog: business ? await fetchCatalog(supabase, business) : null };
});

// O painel instalado no celular leva o nome e o logotipo do estabelecimento.
export async function generateMetadata(): Promise<Metadata> {
  const { business } = await loadOwner();
  if (!business) return { title: "Painel" };
  return {
    title: `${business.name} — painel`,
    manifest: `/${business.slug}/painel.webmanifest`,
    appleWebApp: { capable: true, title: business.name },
    icons: business.logo_url ? { icon: business.logo_url, apple: business.logo_url } : undefined,
    robots: { index: false },
  };
}

export default async function PainelLayout({ children }: LayoutProps<"/painel">) {
  const { user, catalog } = await loadOwner();
  if (!user) redirect("/login");
  if (!catalog) return <CreateBusinessForm />;
  return (
    <PainelShell initialCatalog={catalog} today={todayInSaoPaulo()}>
      {children}
    </PainelShell>
  );
}
