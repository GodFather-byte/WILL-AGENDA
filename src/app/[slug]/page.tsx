import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { BookingFlow } from "@/components/booking/BookingFlow";
import { aiConfigured } from "@/lib/ai/client";
import { bookableCatalog, fetchBusinessBySlug, fetchCatalog } from "@/lib/data";
import { todayInSaoPaulo } from "@/lib/dates";
import { createPublicClient } from "@/lib/supabase/public";

// Dados sempre atuais (serviços, agenda aberta ou fechada): a rota renderiza a cada requisição.
export const instant = false;

export async function generateMetadata({ params }: PageProps<"/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const business = await fetchBusinessBySlug(createPublicClient(), slug);
  if (!business) return { title: "Página não encontrada" };
  return {
    title: `${business.name} — agendamento online`,
    description: business.description ?? `Agende seu horário em ${business.name}.`,
    // Cada estabelecimento pode ser instalado na tela inicial do cliente como um app próprio.
    manifest: `/${business.slug}/manifest.webmanifest`,
    appleWebApp: { capable: true, title: business.name },
    icons: business.logo_url ? { icon: business.logo_url, apple: business.logo_url } : undefined,
    other: { "theme-color": business.primary_color },
  };
}

export default async function BusinessPage({ params }: PageProps<"/[slug]">) {
  const { slug } = await params;
  const supabase = createPublicClient();
  const business = await fetchBusinessBySlug(supabase, slug);
  if (!business) notFound();
  const catalog = bookableCatalog(await fetchCatalog(supabase, business));
  // A data de hoje é lida a cada acesso, nunca pré-renderizada.
  await connection();
  // O botão do atendente só aparece se o dono ligou a IA e a instalação tem a chave configurada.
  return <BookingFlow catalog={catalog} today={todayInSaoPaulo()} chat={business.ai_enabled && aiConfigured()} />;
}
