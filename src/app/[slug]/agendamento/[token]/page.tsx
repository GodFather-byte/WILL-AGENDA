import type { Metadata } from "next";
import { connection } from "next/server";
import { AppointmentView } from "@/components/booking/AppointmentView";
import { todayInSaoPaulo } from "@/lib/dates";

// Dados sempre atuais (situação do agendamento): a rota renderiza a cada requisição.
export const instant = false;

// Link secreto: não deve aparecer em buscadores nem vazar por "referer".
export const metadata: Metadata = {
  title: "Meu agendamento",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function AppointmentPage({ params }: PageProps<"/[slug]/agendamento/[token]">) {
  const { slug, token } = await params;
  // A data de hoje é lida a cada acesso, nunca pré-renderizada.
  await connection();
  return <AppointmentView slug={slug} token={token} today={todayInSaoPaulo()} />;
}
