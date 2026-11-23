# Will Agenda

Plataforma de agendamento online para clínicas, estéticas, salões de beleza e studios de bronzeamento
(SaaS multi-estabelecimento). Cada estabelecimento tem a própria página pública, com a marca dele.

> "Will Agenda" é nome provisório. Ele fica em um único arquivo: `src/lib/brand.ts`.

## O que já funciona

- **Página pública** em `/{slug}`: o cliente escolhe serviço, profissional (ou "qualquer um"), dia e horário livre,
  informa nome e WhatsApp e confirma. Sem baixar app e sem criar conta.
- **Página do agendamento** em `/{slug}/agendamento/{token}` (link secreto): ver, remarcar e cancelar dentro do prazo
  definido pelo estabelecimento. Atualiza sozinha quando o dono confirma ou cancela.
- **Painel do dono** em `/painel`: agenda do dia por profissional em tempo real, agendamento manual (com "encaixe"),
  confirmar, remarcar, cancelar, marcar falta e concluído, bloquear horários.
- **Cadastros**: serviços (duração, preço, "a partir de", categoria), profissionais (serviços que faz, horário próprio),
  horário de funcionamento com intervalos, folgas e bloqueios.
- **Clientes**: atendimentos, faltas, cancelamentos, histórico, anotação interna e mensagem para chamar de volta quem
  sumiu, aberta no WhatsApp do próprio dono.
- **Modelo por segmento**: ao criar a conta o dono escolhe salão, estética, clínica ou bronze e recebe serviços,
  horários e regras típicas para ajustar (`segment_template` no banco).
- **Marca própria**: logotipo, cor, nome, endereço da página e textos. Página e painel instaláveis na tela inicial,
  com manifesto por estabelecimento.

- **Atendente de IA** na página pública: tira dúvidas, oferece horários livres e agenda, remarca e cancela pelo chat.
  Só grava depois de mostrar o resumo e o cliente confirmar, e isso é conferido no servidor, não só pedido ao modelo.
  Motor em `src/lib/ai/attendant.ts`.
- **Copiloto do dono** (botão no painel): responde sobre agenda, horários vagos, faltas e clientes, e executa
  alterações (bloquear e liberar agenda, mudar serviço, abrir ou fechar a agenda online, dar baixa em agendamento).
  Motor em `src/lib/ai/copilot.ts`.
- **Mensagem de reconquista** escrita pela IA na tela Clientes (sem IA, usa um texto padrão).

Ainda não entrou: checkout de pagamento (próxima fase).

## Stack

Next.js 16 (App Router) · Supabase (Postgres, Auth, Realtime, Storage) · Tailwind CSS 4 · deploy na Vercel.

## Rodando localmente

Requer Node 22+ e Docker.

```bash
npm install
npx supabase start         # sobe Postgres/Auth/Realtime locais e aplica as migrações
cp .env.example .env.local # preencha com a URL e a publishable key que o comando acima imprime
npm run dev
```

## Testes

```bash
npm run test:db   # regras de agenda, fuso, permissões e cliques simultâneos (precisa do Supabase local)
npm run test:e2e  # fluxo completo no navegador: cliente no celular e dono no painel
npm run lint && npm run typecheck && npm run build
```

- `supabase/tests/agenda.sql`: horário livre (expediente, intervalo, duração, bloqueio, antecedência, janela),
  agendar/remarcar/cancelar, fuso e virada de dia, painel, e quem pode o quê (anônimo, outro dono, lista exata de
  funções expostas). Roda numa transação desfeita no final.
- `supabase/tests/concorrencia.sh`: conexões reais em paralelo disputando o mesmo horário.
- `e2e/agenda.spec.ts`: Playwright, com o navegador de propósito no fuso de Tóquio.

## IA

- Usa o tool runner do SDK (`@anthropic-ai/sdk`). O modelo vem de `ANTHROPIC_MODEL` (padrão `claude-opus-5-5`; em
  produção, `claude-haiku-5-5`). O parâmetro `fallbacks` só é enviado para modelos que aceitam (o Haiku não aceita).
- Serviços e profissionais vão para o prompt com códigos curtos (`s1`, `p2`), nunca UUIDs.
- Entre um turno e outro só o texto das mensagens é reenviado; os dois prompts explicam isso ao modelo para ele não
  "se corrigir" do que já fez.
- Relógio e calendário dos próximos dias vão na última mensagem (o modelo não calcula data de cabeça), depois do
  prompt de sistema, que fica em cache.
- Limite de uso no banco (`ai_rate_hit`): 25 mensagens por cliente a cada 10 minutos e 600 por estabelecimento a cada
  hora. O IP é guardado só como hash.
- O atendente só enxerga agendamentos cujo link secreto está guardado no aparelho do cliente; não localiza ninguém
  por nome ou telefone. O copiloto não recebe telefones.
- Sem `ANTHROPIC_API_KEY` o sistema funciona normalmente: o botão do chat não aparece e o copiloto avisa que a IA não
  foi configurada.
- `e2e/ia.spec.ts` testa as ferramentas contra uma **API simulada** (`e2e/mock-anthropic.mjs`). Isso valida
  ferramentas, travas e telas; a qualidade das respostas do modelo só se confirma com a chave real.

## Modelo de dados

| Tabela | O que guarda |
| --- | --- |
| `businesses` | Estabelecimento: dono, slug, nome, segmento, marca, textos e regras de agendamento |
| `services` | Serviços: duração, preço em centavos, categoria |
| `professionals` | Profissionais (ou vagas/cabines) |
| `professional_services` | Quem faz qual serviço |
| `working_hours` | Expediente por dia da semana, em períodos; da casa ou de um profissional |
| `blocks` | Folgas e bloqueios |
| `customers` | Nome e WhatsApp, um cadastro por telefone em cada estabelecimento |
| `appointments` | Agendamentos, com link secreto e cópia de nome/duração/preço do serviço |
| `rate_limits` | Contadores de limite de uso |

## Regras de agenda

- **Nunca dois no mesmo horário.** A restrição `appointments_no_overlap` (exclusão por intervalo) impede dois
  agendamentos ativos do mesmo profissional em horários sobrepostos. Vale no banco, então dois cliques simultâneos não
  passam. Cancelado e falta liberam o horário; pendente, confirmado e concluído ocupam.
- **Horário livre** é calculado por uma função só (`slot_candidates`): duração do serviço, expediente com intervalos,
  bloqueios, antecedência mínima, janela máxima e agendamentos existentes. Página, painel e (depois) IA usam a mesma.
- **Fuso de São Paulo.** Instantes ficam em UTC; toda conversão de data e hora local acontece no banco
  (`local_ts`, `local_today`). O navegador só exibe.
- **"Qualquer profissional"** escolhe quem está livre, começando por quem tem o dia mais vazio.

## Segurança dos dados

- O app usa só a chave pública do Supabase.
- Visitante anônimo nunca lê nem grava nas tabelas de agendamentos, clientes e bloqueios. Ele usa cinco funções do
  banco: `get_availability`, `book_appointment`, `get_appointment`, `reschedule_appointment` e `cancel_appointment`.
  Preço, duração e disponibilidade são sempre recalculados no banco.
- Cada dono só enxerga e altera o próprio estabelecimento (Row Level Security em todas as tabelas). Agendamentos só
  são alterados pelas funções `owner_*`, que conferem o dono.
- Nenhuma função é pública por padrão: a migração revoga tudo e libera uma lista explícita, conferida pelo teste.
- Proteção contra enxurrada: no máximo 5 agendamentos em aberto por telefone, 60 agendamentos online por hora por
  estabelecimento e 20 por hora por visitante (IP guardado só como hash, que muda a cada dia).
- **Dados sensíveis (LGPD):** o sistema guarda só agenda e contato. Não há prontuário, anamnese, diagnóstico nem foto
  de procedimento. Os campos de observação avisam na tela que não são lugar para informação de saúde. O dono pode
  apagar um cliente com todo o histórico.

## Limites conhecidos

- Um serviço por agendamento (combo se cadastra como um serviço).
- Um login por estabelecimento; profissionais não têm acesso próprio.
- Uma vaga por profissional por horário: para atender várias pessoas ao mesmo tempo (bronzeamento em grupo),
  cadastre cada vaga como um profissional.
- Fuso fixo de São Paulo.
- Sem lembrete automático: o dono envia confirmação e link pelo próprio WhatsApp, com um toque.
- Trocar o slug quebra os links já enviados.
