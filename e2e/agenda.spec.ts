import { devices, expect, test, type Browser, type Page } from "@playwright/test";

// Fluxo completo do núcleo, dos dois lados: a dona cria a conta e o estabelecimento no computador,
// a cliente agenda pelo celular, e uma enxerga o que a outra faz.
// Requer o Supabase local (npm run db:start); o e-mail de confirmação é lido no Mailpit local.

const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";
const run = Date.now().toString(36);
const slug = `salao-e2e-${run}`;
const email = `dona-${run}@teste.local`;
const password = "senha-de-teste-123";

let owner: Page;
let bookingDate = "";
let bookingTime = "";
let appointmentUrl = "";

async function confirmationLink(to: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const list = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)).json();
    const id = list.messages?.[0]?.ID;
    if (id) {
      const message = await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json();
      const link = String(message.Text).match(/https?:\/\/[^\s)\]]+\/auth\/v1\/verify[^\s)\]]+/)?.[0];
      if (link) return link;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("E-mail de confirmação não chegou ao Mailpit.");
}

const phone = (browser: Browser) => browser.newContext({ ...devices["Pixel 7"], locale: "pt-BR", timezoneId: "Asia/Tokyo" });

/** Cliente no celular: escolhe o serviço e para na lista de horários do primeiro dia livre. */
async function openSlots(page: Page, service: string | RegExp) {
  await page.goto(`/${slug}`);
  await page.getByRole("button", { name: service }).click();
  const any = page.getByRole("button", { name: /Qualquer profissional/ });
  await expect(page.getByRole("heading", { name: /Com quem\?|Quando\?/ })).toBeVisible();
  if (await any.isVisible()) await any.click();
  await expect(page.getByText("Horários de")).toBeVisible();
}

async function fillCustomer(page: Page, name: string, whatsapp: string) {
  await page.getByLabel("Nome").fill(name);
  await page.getByLabel("WhatsApp com DDD").fill(whatsapp);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "pt-BR", timezoneId: "Asia/Tokyo" });
  owner = await context.newPage();
});

test("dona cria a conta, confirma o e-mail e cria o salão com o modelo do ramo", async () => {
  await owner.goto("/painel");
  await expect(owner).toHaveURL(/\/login$/); // painel exige login

  await owner.goto("/cadastro");
  await owner.getByLabel("E-mail").fill(email);
  await owner.getByLabel("Senha").fill(password);
  await owner.getByRole("button", { name: "Criar conta" }).click();
  await expect(owner.getByText("Aguardando a confirmação do e-mail")).toBeVisible();

  await owner.goto(await confirmationLink(email));
  await expect(owner.getByRole("heading", { name: "Vamos criar a sua agenda" })).toBeVisible();

  await owner.getByText("Salão de beleza").click();
  await owner.getByLabel("Nome do estabelecimento").fill(`Salão E2E ${run}`);
  await owner.getByLabel("Endereço da sua página").fill(slug);
  await owner.getByLabel("WhatsApp (opcional)").fill("11988887777");
  await owner.getByLabel("Primeiro profissional").fill("Carla");
  await owner.getByRole("button", { name: "Criar minha agenda" }).click();

  await expect(owner.getByRole("link", { name: "Agenda", exact: true })).toBeVisible();
  await expect(owner.getByRole("region", { name: "Agenda de Carla" })).toBeVisible();

  await owner.getByRole("link", { name: "Serviços" }).click();
  await expect(owner.getByText("Corte feminino")).toBeVisible();
  await expect(owner.getByText("Manicure e pedicure")).toBeVisible();
});

test("dona cadastra serviço e segundo profissional", async () => {
  await owner.getByRole("button", { name: "+ Novo serviço" }).click();
  await owner.getByLabel("Nome").fill("Penteado");
  await owner.getByLabel("Duração (minutos)").fill("60");
  await owner.getByLabel("Preço (R$)").fill("120,00");
  await owner.getByRole("button", { name: "Salvar" }).click();
  await expect(owner.getByText("1h · R$ 120,00")).toBeVisible();

  await owner.getByRole("link", { name: "Profissionais" }).click();
  await owner.getByRole("button", { name: "+ Novo profissional" }).click();
  await owner.getByLabel("Nome").fill("Bia");
  await owner.getByRole("button", { name: "Salvar" }).click();
  await expect(owner.getByText("Bia")).toBeVisible();
  await expect(owner.getByText("13 serviços · horário da casa")).toHaveCount(2);
});

test("cliente agenda pelo celular, sem conta, e o horário aparece para a dona em tempo real", async ({ browser }) => {
  await owner.getByRole("link", { name: "Agenda", exact: true }).click();
  await expect(owner.getByRole("region", { name: "Agenda de Bia" })).toBeVisible();

  const context = await phone(browser);
  const page = await context.newPage();
  await openSlots(page, /Corte masculino/);

  bookingDate = (await page.locator('[role="option"][aria-selected="true"]').getAttribute("data-date"))!;
  const first = page.locator("button[aria-pressed]").first();
  bookingTime = (await first.textContent())!.trim();
  // Salão abre às 09:00 de São Paulo; o aparelho de teste está no fuso de Tóquio e isso não pode mudar nada.
  expect(bookingTime).toMatch(/^(09|1\d|2\d):[03]0$/);
  await first.click();

  await fillCustomer(page, "Maria Cliente", "(11) 99999-0001");
  await page.getByLabel("Observação (opcional)").fill("Primeira vez");
  await page.getByRole("button", { name: "Confirmar agendamento" }).click();
  await expect(page.getByRole("heading", { name: "Agendamento confirmado!" })).toBeVisible();
  await expect(page.getByText(`às ${bookingTime}`)).toBeVisible();

  await page.getByRole("link", { name: "Ver, remarcar ou cancelar" }).click();
  await expect(page.getByRole("button", { name: "Remarcar" })).toBeVisible();
  await expect(page.getByRole("main").getByText("Confirmado", { exact: true })).toBeVisible();
  appointmentUrl = page.url();

  // A dona está com a agenda aberta em outro dia: vai para o dia do agendamento e ele está lá.
  await owner.getByLabel("Data da agenda").fill(bookingDate);
  const card = owner.getByRole("button", { name: new RegExp(`${bookingTime} Maria Cliente, Corte masculino, Confirmado`) });
  await expect(card).toBeVisible({ timeout: 30_000 });

  // Segundo agendamento com a agenda da dona parada neste dia: tem de aparecer sozinho (tempo real).
  await openSlots(page, /Escova/);
  await page.locator(`[role="option"][data-date="${bookingDate}"]`).click();
  await page.locator("button[aria-pressed]").first().click();
  await fillCustomer(page, "Paula Tempo Real", "11999990002");
  await page.getByRole("button", { name: "Confirmar agendamento" }).click();
  await expect(page.getByRole("heading", { name: "Agendamento confirmado!" })).toBeVisible();
  await expect(owner.getByRole("button", { name: /Paula Tempo Real, Escova/ })).toBeVisible({ timeout: 30_000 });

  // De volta à página do salão, o aparelho lembra dos agendamentos feitos nele.
  await page.goto(`/${slug}`);
  await expect(page.getByText("Você tem").first()).toBeVisible();
  await context.close();
});

test("duas pessoas no mesmo horário: só a primeira fica com ele", async ({ browser }) => {
  // Deixa só a Carla fazendo Barba, para o horário ter uma vaga só.
  await owner.getByRole("link", { name: "Profissionais" }).click();
  await owner.getByRole("listitem").filter({ hasText: "Bia" }).getByRole("button", { name: "Editar" }).click();
  await owner.getByLabel("Barba", { exact: true }).uncheck();
  await owner.getByRole("button", { name: "Salvar" }).click();
  await expect(owner.getByText("12 serviços · horário da casa")).toBeVisible();

  const [a, b] = await Promise.all([phone(browser), phone(browser)]);
  const [pa, pb] = [await a.newPage(), await b.newPage()];
  for (const page of [pa, pb]) {
    await openSlots(page, /^Barba/);
    await page.locator(`[role="option"][data-date="${bookingDate}"]`).click();
  }
  const time = (await pa.locator("button[aria-pressed]").last().textContent())!.trim();
  for (const page of [pa, pb]) await page.getByRole("button", { name: time, exact: true }).click();
  await fillCustomer(pa, "Primeiro Rápido", "11999990003");
  await fillCustomer(pb, "Segundo Atrasado", "11999990004");

  await pa.getByRole("button", { name: "Confirmar agendamento" }).click();
  await expect(pa.getByRole("heading", { name: "Agendamento confirmado!" })).toBeVisible();
  await pb.getByRole("button", { name: "Confirmar agendamento" }).click();
  await expect(pb.getByRole("main").getByRole("alert")).toContainText("não está mais disponível");
  // Volta para a escolha de horário, e o horário perdido saiu da lista.
  await expect(pb.getByRole("heading", { name: "Quando?" })).toBeVisible();
  await pb.locator(`[role="option"][data-date="${bookingDate}"]`).click();
  await expect(pb.getByRole("button", { name: time, exact: true })).toHaveCount(0);
  await a.close();
  await b.close();
});

test("cliente remarca pelo link e a dona vê a mudança", async ({ browser }) => {
  const context = await phone(browser);
  const page = await context.newPage();
  await page.goto(appointmentUrl);
  await page.getByRole("button", { name: "Remarcar" }).click();
  await page.locator(`[role="option"][data-date="${bookingDate}"]`).click();
  const slot = page.locator('button[aria-pressed="false"]').nth(4);
  const newTime = (await slot.textContent())!.trim();
  expect(newTime).not.toBe(bookingTime);
  await slot.click();
  await page.getByRole("button", { name: /^Remarcar para/ }).click();
  await expect(page.getByText("Agendamento remarcado.")).toBeVisible();
  await expect(page.getByRole("heading", { name: new RegExp(`às ${newTime}`) })).toBeVisible();

  await owner.getByRole("link", { name: "Agenda", exact: true }).click();
  await owner.getByLabel("Data da agenda").fill(bookingDate);
  await expect(owner.getByRole("button", { name: new RegExp(`${newTime} Maria Cliente`) })).toBeVisible({ timeout: 30_000 });
  await expect(owner.getByRole("button", { name: new RegExp(`${bookingTime} Maria Cliente`) })).toHaveCount(0);
  bookingTime = newTime;
  await context.close();
});

test("dona agenda manualmente, bloqueia um período e cancela com motivo; a cliente vê", async ({ browser }) => {
  // Agendamento manual.
  await owner.getByRole("button", { name: "+ Novo agendamento" }).click();
  await owner.getByLabel("Serviço").selectOption({ label: "Manicure (40 min)" });
  await owner.getByLabel("Profissional", { exact: true }).selectOption({ label: "Bia" });
  await expect(owner.getByRole("group", { name: "Horários livres" })).toBeVisible();
  await owner.getByRole("group", { name: "Horários livres" }).getByRole("button").last().click();
  await owner.getByLabel("Nome do cliente").fill("Joana Balcão");
  await owner.getByLabel("WhatsApp do cliente").fill("11999990005");
  await owner.getByRole("button", { name: "Agendar", exact: true }).click();
  await expect(owner.getByRole("button", { name: /Joana Balcão, Manicure/ })).toBeVisible();

  // Bloqueio das 12:00 às 13:00 para todos: esses horários somem para o cliente.
  await owner.getByRole("button", { name: "Bloquear horário" }).click();
  await owner.getByLabel("Motivo (só você vê)").fill("Almoço da equipe");
  await owner.getByRole("button", { name: "Bloquear", exact: true }).click();
  await expect(owner.getByText("Almoço da equipe").first()).toBeVisible();

  const context = await phone(browser);
  const page = await context.newPage();
  await openSlots(page, /Corte feminino/);
  await page.locator(`[role="option"][data-date="${bookingDate}"]`).click();
  await expect(page.getByRole("button", { name: "11:00", exact: true })).toBeVisible(); // termina 12:00, encosta no bloqueio
  for (const blocked of ["11:30", "12:00", "12:30"]) {
    await expect(page.getByRole("button", { name: blocked, exact: true })).toHaveCount(0);
  }

  // Cancelamento pela dona, com motivo: aparece no link da cliente.
  await owner.getByRole("button", { name: new RegExp(`${bookingTime} Maria Cliente`) }).click();
  await owner.getByRole("button", { name: "Cancelar", exact: true }).click();
  await owner.getByLabel("Motivo (o cliente vê no link dele)").fill("Profissional indisponível");
  await owner.getByRole("button", { name: "Cancelar agendamento" }).click();
  // Sai da grade e vai para a lista de cancelados.
  await expect(owner.getByRole("button", { name: new RegExp(`${bookingTime} Maria Cliente, Corte masculino, Confirmado`) })).toHaveCount(0);
  await expect(owner.getByText("Cancelados e faltas")).toBeVisible();

  await page.goto(appointmentUrl);
  await expect(page.getByRole("main").getByText("Cancelado", { exact: true })).toBeVisible();
  await expect(page.getByText("Motivo: Profissional indisponível")).toBeVisible();
  await expect(page.getByRole("button", { name: "Remarcar" })).toHaveCount(0);
  await context.close();
});

test("cliente cancela pelo link; clientes, marca e agenda fechada", async ({ browser }) => {
  const context = await phone(browser);
  const page = await context.newPage();
  await openSlots(page, /Pedicure/);
  await page.locator("button[aria-pressed]").first().click();
  await fillCustomer(page, "Maria Cliente", "11999990001");
  await page.getByRole("button", { name: "Confirmar agendamento" }).click();
  await page.getByRole("link", { name: "Ver, remarcar ou cancelar" }).click();
  await page.getByRole("button", { name: "Cancelar agendamento" }).click();
  await page.getByLabel("Motivo (opcional)").fill("Imprevisto");
  await page.getByRole("button", { name: "Sim, cancelar" }).click();
  await expect(page.getByText("Cancelado por você")).toBeVisible();

  // Clientes: a Maria tem dois cancelamentos e nenhum atendimento.
  await owner.getByRole("link", { name: "Clientes" }).click();
  await expect(owner.getByRole("heading", { name: "Clientes" })).toBeVisible();
  await owner.getByRole("button", { name: /Maria Cliente.*99999-0001/ }).click();
  const dialog = owner.getByRole("dialog");
  await expect(dialog.getByText("(11) 99999-0001")).toBeVisible();
  await expect(dialog.getByText("Cancelado")).toHaveCount(2);
  await dialog.getByRole("button", { name: "Fechar" }).click();

  // Marca: muda a cor e o recado; a página pública e o manifesto refletem.
  await owner.getByRole("link", { name: "Configurações" }).click();
  await owner.getByLabel("Cor").fill("#0f766e");
  await owner.getByLabel("Descrição curta").fill("Beleza sem pressa");
  await owner.getByRole("button", { name: "Salvar configurações" }).click();
  await expect(owner.getByText("Configurações salvas.")).toBeVisible();
  const manifest = await (await page.request.get(`/${slug}/manifest.webmanifest`)).json();
  expect(manifest.name).toBe(`Salão E2E ${run}`);
  expect(manifest.theme_color).toBe("#0f766e");
  expect(manifest.start_url).toBe(`/${slug}`);
  await page.goto(`/${slug}`);
  await expect(page.getByText("Beleza sem pressa")).toBeVisible();

  // Agenda online fechada: a página continua no ar, mas não aceita agendamento.
  await owner.getByRole("button", { name: /Agenda online aberta/ }).click();
  await expect(owner.getByRole("button", { name: /Agenda online fechada/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Agenda online fechada no momento" })).toBeVisible();
  await owner.getByRole("button", { name: /Agenda online fechada/ }).click();
  await expect(owner.getByRole("button", { name: /Agenda online aberta/ })).toBeVisible();
  await context.close();
});

test("outra conta não enxerga este salão no painel", async ({ browser }) => {
  const other = `intruso-${run}@teste.local`;
  const context = await browser.newContext({ locale: "pt-BR" });
  const page = await context.newPage();
  await page.goto("/cadastro");
  await page.getByLabel("E-mail").fill(other);
  await page.getByLabel("Senha").fill(password);
  await page.getByRole("button", { name: "Criar conta" }).click();
  await expect(page.getByText("Aguardando a confirmação do e-mail")).toBeVisible();
  await page.goto(await confirmationLink(other));
  // Conta nova não tem estabelecimento: vê o formulário de criação, não a agenda de ninguém.
  await expect(page.getByRole("heading", { name: "Vamos criar a sua agenda" })).toBeVisible();
  await expect(page.getByText("Maria Cliente")).toHaveCount(0);
  await context.close();
});
