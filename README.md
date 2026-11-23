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

- **Pix copia e cola** (sem credenciais): com a chave Pix do estabelecimento, o link do agendamento mostra um QR
  code com o valor exato do sinal. O dinheiro cai direto na conta do estabelecimento e o dono marca "pagamento
  recebido" na agenda.
- **Checkout do sinal, desligado por padrão**: pronto no código, ligado estabelecimento por estabelecimento quando ele
  cadastrar as credenciais de produção. Ver "Pagamentos" abaixo.

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

## Pagamentos

**Estado: construído e desligado.** `businesses.charge_on_booking` nasce `false` e só liga pela função
`set_charge_on_booking`, que exige credencial cadastrada. Com ele desligado nada muda no fluxo do cliente e nenhuma
chamada ao provedor acontece (conferido em teste).

Com o interruptor ligado:

1. O agendamento feito pelo cliente (site ou IA) nasce "aguardando pagamento" e reserva o horário por alguns minutos
   (`hold_minutes`). Agendamento feito pelo dono no painel não cobra.
2. O servidor cria um Pix no provedor com as credenciais **do estabelecimento** e mostra o código na página do
   agendamento.
3. O pagamento só é confirmado com o que a **API do provedor** responde. O webhook serve apenas de aviso: do corpo
   dele só sai o identificador da cobrança. Valor pago diferente do cobrado não confirma.
4. Sem pagamento no prazo, a reserva cai e o horário volta a ser oferecido. Pagamento que chega depois disso é
   devolvido.
5. Cancelamento dentro da regra (pelo cliente no prazo, ou pelo estabelecimento) com sinal pago gera estorno.

Como é feito:

- **Independente de provedor**: `src/lib/payments/types.ts` define três chamadas (criar Pix, consultar, estornar).
  O Mercado Pago é o primeiro (`mercadopago.ts`); outro provedor entra implementando a mesma interface.
- **Credenciais**: o dono digita o access token no painel; o servidor cifra (AES-256-GCM, chave derivada de
  `PAYMENTS_SECRET`) e grava só o texto cifrado. Nenhuma tela, resposta ou log recebe a credencial de volta; aparecem
  apenas os 4 últimos caracteres. Para ler o texto cifrado, o servidor apresenta ao banco uma chave de acesso
  derivada por estabelecimento, da qual o banco guarda só o hash.
- **Idempotência**: uma cobrança viva por agendamento (índice único no banco); a criação e o estorno no provedor
  usam chave de idempotência fixa por cobrança; registrar o mesmo resultado duas vezes não muda nada.
- **Estorno**: o cancelamento marca o pagamento como "estorno pendente" no banco; o servidor estorna e registra. Se o
  cliente fechar a página antes, o estorno é concluído quando a página do agendamento ou a agenda do painel abrir de
  novo. Não há rotina agendada; se quiser, dá para ligar um cron da Vercel em `/api/painel/pagamentos/pendencias`.

Para ligar em produção (só depois de validar com credenciais de teste do estabelecimento):

1. Na Vercel, em Settings → Environment Variables, cadastre `PAYMENTS_SECRET` (32 caracteres ou mais, aleatório).
   Trocar esse valor depois invalida as credenciais já guardadas.
2. Rode `PAYMENTS_SECRET=... node scripts/payments-setup.mjs` e execute o comando SQL que ele imprime no SQL Editor
   do Supabase. Ele registra só um hash (não é segredo) e é o que prova ao banco que a credencial veio do servidor
   do app, e não do dono chamando o banco direto. Sem esse passo o painel responde "a cobrança online ainda não foi
   habilitada nesta instalação".
3. No painel do estabelecimento, em Configurações → Pagamentos, o dono cola o access token de produção do Mercado
   Pago e liga "Cobrar o sinal no agendamento".

**O que foi e o que não foi testado:** a lógica acima foi testada no banco (`supabase/tests/pagamentos.sql`) e no
navegador (`e2e/pagamento.spec.ts`) contra um **simulador** do Mercado Pago (`e2e/mock-mercadopago.mjs`). O Mercado
Pago de verdade nunca foi chamado: formato exato dos campos, e-mail do pagador exigido pela API, prazo de expiração e
entrega dos webhooks precisam ser validados com credenciais de teste antes de ligar para alguém.

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
| `payments` | Cobranças do sinal no provedor: valor, situação, identificador no provedor, estorno |
| `payment_credentials` | Credencial do provedor por estabelecimento, cifrada; ninguém lê pela API |

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
- A chave Pix e o identificador do dono não entram na leitura pública do estabelecimento: a chave só chega a quem
  tem o link de um agendamento e ao próprio dono.
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
- O limite de uso da IA (`ai_rate_hit`) pode ser chamado direto por um visitante, que conseguiria esgotar o teto
  horário de um estabelecimento e deixar o atendente dele fora do ar por até uma hora. Não vaza dado nem gera custo;
  fechar isso exige uma prova do servidor como a dos pagamentos.
- A trava "só grava depois do resumo" do atendente protege contra erro do modelo, não contra um visitante mal
  intencionado: ele já pode agendar pela página, com as mesmas regras do banco.
- "Cliente não escolhe o profissional" vale na tela e no atendente, não no banco.
- O webhook de pagamento não confere assinatura nem tem limite de chamadas. Ele não confirma nada sozinho (a situação
  vem da API do provedor), mas alguém pode provocar consultas ao provedor em nome de um estabelecimento.
- Pagamento: só Pix, só sinal (ou valor total) no momento do agendamento, estorno sempre total. Sem cartão, sem
  parcelamento, sem cobrança de falta.
- Trocar o slug quebra os links já enviados.
