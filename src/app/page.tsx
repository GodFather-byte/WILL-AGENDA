import Link from "next/link";
import { BRAND } from "@/lib/brand";
import { SEGMENTS } from "@/lib/format";

const features = [
  {
    title: "Sua marca, não a nossa",
    text: "Logotipo, cores, nome e endereço próprios. O cliente vê o seu estabelecimento e pode instalar a página na tela inicial do celular.",
  },
  {
    title: "Agendamento sem app e sem cadastro",
    text: "O cliente escolhe serviço, profissional, dia e horário, informa nome e WhatsApp e confirma. Leva menos de um minuto.",
  },
  {
    title: "Agenda em tempo real",
    text: "Cada agendamento aparece na hora no painel, por dia e por profissional. Confirme, remarque, cancele, marque falta ou concluído.",
  },
  {
    title: "Nunca dois clientes no mesmo horário",
    text: "A agenda considera duração do serviço, expediente, intervalos, folgas e bloqueios. Dois cliques ao mesmo tempo não viram dois agendamentos.",
  },
  {
    title: "Cliente remarca sozinho",
    text: "Cada agendamento tem um link próprio para ver, remarcar e cancelar dentro da regra que você definir.",
  },
  {
    title: "Clientes que somem voltam",
    text: "Histórico de atendimentos e faltas por cliente, com mensagem pronta para chamar de volta pelo seu WhatsApp.",
  },
];

export default function Home() {
  return (
    <main className="flex-1">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-5 py-5">
        <span className="text-lg font-bold tracking-tight">{BRAND.name}</span>
        <nav className="flex items-center gap-2">
          <Link href="/login" className="btn-ghost">
            Entrar
          </Link>
          <Link href="/cadastro" className="btn-primary">
            Criar minha agenda
          </Link>
        </nav>
      </header>

      <section className="mx-auto max-w-5xl px-5 pb-14 pt-12 sm:pt-20">
        <h1 className="max-w-3xl text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
          Agendamento online <span className="text-brand">com a marca do seu estabelecimento</span>.
        </h1>
        <p className="mt-5 max-w-2xl text-lg text-stone-600">
          Uma página de agendamento só sua e um painel para cuidar da agenda do dia. Comece com serviços e horários
          típicos do seu ramo e ajuste do seu jeito.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/cadastro" className="btn-primary px-6 py-3 text-base">
            Começar agora
          </Link>
          <Link href="/login" className="btn-outline px-6 py-3 text-base">
            Já tenho conta
          </Link>
        </div>
        <ul className="mt-10 flex flex-wrap gap-2">
          {SEGMENTS.map((segment) => (
            <li key={segment.value} className="chip border border-stone-200 bg-white px-3 py-1.5 text-sm text-stone-700">
              {segment.label}
            </li>
          ))}
        </ul>
      </section>

      <section className="border-t border-stone-200 bg-white">
        <div className="mx-auto grid max-w-5xl gap-x-10 gap-y-8 px-5 py-14 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <div key={feature.title}>
              <h2 className="font-semibold">{feature.title}</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-stone-600">{feature.text}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
