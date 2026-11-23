import { expect, test, type Page } from "@playwright/test";
import { chat, createSalon, phone } from "./helpers";

// Ferramentas do atendente e do copiloto, de ponta a ponta, contra o banco local.
// A IA aqui é SIMULADA (e2e/mock-anthropic.mjs): o teste dita qual ferramenta o "modelo" chama.
// Isso prova que as ferramentas, as travas e as telas funcionam; a qualidade das respostas do
// modelo de verdade só se confirma com a chave em produção.

const MOCK = "http://127.0.0.1:4010";
const run = Date.now().toString(36);
const slug = `salao-ia-${run}`;
const tool = (name: string, input: object) => `[[${name} ${JSON.stringify(input)}]]`;
// Tira o prefixo do simulador, o rótulo do botão e os espaços não separáveis de "R$ 80,00".
const parse = (answer: string) =>
  JSON.parse(answer.replace("RESULTADO ", "").replace(/Ver meu agendamento$/, "").replace(/\u00a0/g, " "));
const ddmm = (date: string) => `${date.slice(8)}/${date.slice(5, 7)}`;

let owner: Page;
let customer: Page;
let date = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  owner = await createSalon(browser, { email: `dona-ia-${run}@teste.local`, slug, name: `Salão IA ${run}` });
  customer = await (await phone(browser)).newPage();
  // Primeiro dia com horário livre, lido da própria página.
  await customer.goto(`/${slug}`);
  await customer.getByRole("button", { name: /Corte feminino/ }).click();
  await expect(customer.getByText("Horários de")).toBeVisible();
  date = (await customer.locator('[role="option"][aria-selected="true"]').getAttribute("data-date"))!;
  await customer.goto(`/${slug}`);
  await customer.getByRole("button", { name: "Agendar pelo chat" }).click();
});

test("atendente consulta horários livres de verdade", async () => {
  const answer = await chat(customer, "Atendente virtual", tool("consultar_horarios", { servico: "s1", data: date }));
  const result = parse(answer);
  expect(result.servico).toBe("Corte feminino");
  expect(result.horarios_livres).toContain("09:00");
  expect(result.horarios_livres).toContain("17:30");

  // Código inventado e data torta voltam como erro para o modelo, não como exceção.
  expect(await chat(customer, "Atendente virtual", tool("consultar_horarios", { servico: "s99", data: date }))).toContain(
    "Código de serviço inexistente",
  );
  expect(await chat(customer, "Atendente virtual", tool("consultar_horarios", { servico: "s1", data: "amanhã" }))).toContain(
    "Data inválida",
  );
});

test("atendente não grava sem ter mostrado o resumo antes", async () => {
  const booking = { servico: "s1", data: date, horario: "09:00", nome: "Clara Chat", telefone: "11999990101" };
  const refused = await chat(customer, "Atendente virtual", tool("agendar", booking));
  expect(refused).toContain("Gravação recusada");

  // Resumo com outro horário também não serve.
  await chat(customer, "Atendente virtual", `[[diga]] Corte feminino, ${ddmm(date)} às 10:00, R$ 80,00. Posso confirmar?`);
  expect(await chat(customer, "Atendente virtual", tool("agendar", booking))).toContain("Gravação recusada");

  await owner.getByLabel("Data da agenda").fill(date);
  await expect(owner.getByRole("region", { name: "Agenda de Carla" })).toBeVisible();
  await expect(owner.getByRole("button", { name: /Clara Chat/ })).toHaveCount(0);
});

test("com resumo e confirmação, o atendente agenda e a dona vê na hora", async () => {
  const booking = { servico: "s1", data: date, horario: "09:00", nome: "Clara Chat", telefone: "(11) 99999-0101" };
  await chat(customer, "Atendente virtual", `[[diga]] Corte feminino, ${ddmm(date)} às 09:00, com a Carla, R$ 80,00. Posso confirmar?`);
  const answer = await chat(customer, "Atendente virtual", `Sim, pode confirmar. ${tool("agendar", booking)}`);
  const result = parse(answer);
  expect(result).toMatchObject({ agendado: true, servico: "Corte feminino", horario: "09:00", valor: "R$ 80,00" });
  await expect(customer.getByRole("link", { name: "Ver meu agendamento" })).toBeVisible();

  const card = owner.getByRole("button", { name: /09:00 Clara Chat, Corte feminino, Confirmado/ });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();
  await expect(owner.getByRole("dialog").getByText("Feito por: Atendente de IA")).toBeVisible();
  await owner.getByRole("dialog").getByRole("button", { name: "Fechar" }).click();

  // Telefone inválido e horário já ocupado: erro claro para o modelo, nada gravado.
  await chat(customer, "Atendente virtual", `[[diga]] Corte feminino, ${ddmm(date)} às 09:00. Posso confirmar?`);
  expect(await chat(customer, "Atendente virtual", tool("agendar", { ...booking, telefone: "123" }))).toContain("WhatsApp inválido");
  await chat(customer, "Atendente virtual", `[[diga]] Corte feminino, ${ddmm(date)} às 09:00. Posso confirmar?`);
  expect(await chat(customer, "Atendente virtual", tool("agendar", { ...booking, nome: "Outra Pessoa", telefone: "11999990102" }))).toContain(
    "não está mais livre",
  );
});

test("atendente remarca e cancela o agendamento deste aparelho, com a mesma trava", async () => {
  const mine = parse(await chat(customer, "Atendente virtual", tool("meus_agendamentos", {})));
  expect(mine.agendamentos).toHaveLength(1);
  expect(mine.agendamentos[0]).toMatchObject({ codigo: "a1", servico: "Corte feminino", horario: "09:00" });

  expect(await chat(customer, "Atendente virtual", tool("remarcar", { agendamento: "a1", data: date, horario: "15:00" }))).toContain(
    "Gravação recusada",
  );
  await chat(customer, "Atendente virtual", `[[diga]] Remarcar para ${ddmm(date)} às 15:00. Posso confirmar?`);
  const moved = await chat(customer, "Atendente virtual", tool("remarcar", { agendamento: "a1", data: date, horario: "15:00" }));
  expect(moved).toContain('"remarcado":true');
  await expect(owner.getByRole("button", { name: /15:00 Clara Chat/ })).toBeVisible({ timeout: 30_000 });

  expect(await chat(customer, "Atendente virtual", tool("cancelar", { agendamento: "a1" }))).toContain("Gravação recusada");
  await chat(customer, "Atendente virtual", `[[diga]] Vou cancelar o corte de ${ddmm(date)} às 15:00. Confirma?`);
  expect(await chat(customer, "Atendente virtual", tool("cancelar", { agendamento: "a1", motivo: "mudança de planos" }))).toContain(
    '"cancelado":true',
  );
  await expect(owner.getByRole("button", { name: /15:00 Clara Chat, Corte feminino, Confirmado/ })).toHaveCount(0, { timeout: 30_000 });
  // Cancelado, o aparelho esquece o link.
  expect(await chat(customer, "Atendente virtual", tool("meus_agendamentos", {}))).toContain("Não há agendamento guardado");
});

test("copiloto responde sobre a agenda e executa alterações", async () => {
  await owner.getByRole("button", { name: "Copiloto" }).click();

  const free = parse(await chat(owner, "Copiloto", tool("horarios_vagos", { data: date })));
  expect(free.total_de_horarios_vagos).toBeGreaterThan(10);
  expect(free.servico_considerado).toContain("Corte masculino"); // o serviço ativo mais curto do modelo de salão (30 min)
  expect(free.por_profissional[0].profissional).toBe("Carla");

  const day = parse(await chat(owner, "Copiloto", tool("agenda_do_dia", { data: date })));
  expect(day.agendamentos).toHaveLength(1);
  expect(day.agendamentos[0]).toMatchObject({ cliente: "Clara Chat", situacao: "Cancelado", feito_por: "Atendente de IA" });

  // "Bloqueia minha agenda": grava o bloqueio e a tela da agenda se atualiza sozinha.
  const block = { data_inicio: date, hora_inicio: "13:00", data_fim: date, hora_fim: "18:00", motivo: "Teste do copiloto" };
  const blocked = parse(await chat(owner, "Copiloto", tool("bloquear_agenda", block)));
  expect(blocked).toMatchObject({ bloqueado: true, quem: "o estabelecimento inteiro", agendamentos_ja_existentes_no_periodo: 0 });
  await expect(owner.getByRole("main").getByText("Teste do copiloto").first()).toBeVisible();
  const after = parse(await chat(owner, "Copiloto", tool("horarios_vagos", { data: date })));
  expect(after.total_de_horarios_vagos).toBe(free.total_de_horarios_vagos - 10); // 13:00 a 17:30, de meia em meia hora

  expect(await chat(owner, "Copiloto", tool("remover_bloqueio", { data_inicio: date, hora_inicio: "13:00" }))).toContain('"removido":true');
  await expect(owner.getByRole("main").getByText("Teste do copiloto")).toHaveCount(0);

  // Alterar serviço: muda o preço e a página pública reflete.
  const changed = parse(await chat(owner, "Copiloto", tool("alterar_servico", { servico: "s1", preco_reais: 95 })));
  expect(changed).toMatchObject({ antes: { preco: "R$ 80,00" }, depois: { preco: "R$ 95,00" } });
  await customer.goto(`/${slug}`);
  await expect(customer.getByRole("button", { name: /Corte feminino.*R\$ 95,00/ })).toBeVisible();

  const missed = await chat(owner, "Copiloto", tool("faltas", { de: date, ate: date }));
  expect(missed).toContain('"total_de_faltas":0');
  expect(await chat(owner, "Copiloto", tool("clientes", {}))).toContain('"total_de_clientes":1');
  expect(await chat(owner, "Copiloto", tool("clientes", {}))).not.toContain("99999"); // sem telefone para o modelo
});

test("reconquista: a mensagem vem da IA com o link da página", async () => {
  await owner.getByRole("button", { name: "Fechar copiloto" }).click();
  await owner.getByRole("link", { name: "Clientes" }).click();
  await owner.getByRole("button", { name: "Chamar de volta" }).click();
  const message = owner.getByRole("dialog").getByLabel("Mensagem");
  await expect(message).toHaveValue(new RegExp(`Sentimos sua falta.*localhost:3000/${slug}`));
  await expect(owner.getByRole("dialog").getByRole("link", { name: "Abrir no WhatsApp" })).toHaveAttribute(
    "href",
    /^https:\/\/wa\.me\/5511999990101\?text=/,
  );
});

test("o que foi enviado à API: modelo, aviso sobre o histórico, códigos curtos e sem fallbacks no Haiku", async () => {
  const requests: { beta: string | null; body: Record<string, unknown> & { system: { text: string }[] | string; tools?: { name: string }[] } }[] =
    await (await fetch(`${MOCK}/_requests`)).json();
  const systemOf = (body: (typeof requests)[number]["body"]) =>
    typeof body.system === "string" ? body.system : (body.system ?? []).map((block) => block.text).join("\n");
  const attendant = requests.filter((r) => systemOf(r.body).includes(`atendente virtual de "Salão IA ${run}"`));
  const copilot = requests.filter((r) => systemOf(r.body).includes(`copiloto do dono de "Salão IA ${run}"`));
  expect(attendant.length).toBeGreaterThan(5);
  expect(copilot.length).toBeGreaterThan(5);

  for (const request of [...attendant, ...copilot]) {
    expect(request.body.model).toBe("claude-haiku-5-5");
    // O Haiku não aceita "fallbacks": o parâmetro e o cabeçalho beta não podem ir.
    expect(request.body).not.toHaveProperty("fallbacks");
    expect(request.beta ?? "").not.toContain("server-side-fallback");
    const system = systemOf(request.body);
    expect(system).toContain("O histórico mostra apenas o texto das mensagens anteriores");
    expect(system).toContain("[s1] Corte feminino");
    expect(system).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/); // nenhum UUID no prompt
  }
  expect(attendant[0].body.tools!.map((t) => t.name).sort()).toEqual(
    ["agendar", "cancelar", "consultar_horarios", "meus_agendamentos", "remarcar"],
  );
  expect(systemOf(attendant[0].body)).toContain("Só depois que o cliente responder que sim");
});
