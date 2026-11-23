import { execSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { createSalon, phone } from "./helpers";

// Checkout do sinal, de ponta a ponta, com o provedor SIMULADO (e2e/mock-mercadopago.mjs).
// Prova a lógica (interruptor desligado por padrão, conferência na API do provedor, idempotência,
// estorno, prazo). O Mercado Pago de verdade não foi exercitado.

const MP = "http://127.0.0.1:4020";
const CREDENTIAL = "TEST-credencial-simulada-do-estabelecimento-1234";
const DB = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
// O mesmo valor que playwright.config.ts dá ao servidor de teste.
const TEST_SECRET = "segredo-de-teste-com-mais-de-32-caracteres-0001";
const run = Date.now().toString(36);
const slug = `salao-pix-${run}`;

type MockState = {
  calls: { method: string; path: string; authorized: boolean; key: string | null }[];
  payments: { id: number; status: string; transaction_amount: number; external_reference: string; notification_url: string; payer_email: string; refunds: number }[];
};
const mp = async (): Promise<MockState> => (await fetch(`${MP}/_state`)).json();
/** Só as chamadas e cobranças deste teste (o simulador é compartilhado entre execuções). */
const mine = async () => {
  const state = await mp();
  const payments = state.payments.filter((p) => p.notification_url.includes(businessId));
  return { payments, creates: payments.length, refunds: payments.reduce((sum, p) => sum + p.refunds, 0) };
};
const webhook = (page: Page, id: number | string, extra: object = {}) =>
  page.request.post(`/api/webhooks/pagamento/mercadopago?b=${businessId}`, { data: { type: "payment", data: { id }, ...extra } });

let owner: Page;
let customer: Page;
let businessId = "";

/** Cliente agenda o primeiro horário livre de um serviço. */
async function book(page: Page, service: RegExp, name: string, whatsapp: string) {
  await page.goto(`/${slug}`);
  await page.getByRole("button", { name: service }).click();
  await expect(page.getByText("Horários de")).toBeVisible();
  const date = (await page.locator('[role="option"][aria-selected="true"]').getAttribute("data-date"))!;
  await page.locator("button[aria-pressed]").first().click();
  await page.getByLabel("Nome").fill(name);
  await page.getByLabel("WhatsApp com DDD").fill(whatsapp);
  return date;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  owner = await createSalon(browser, { email: `dona-pix-${run}@teste.local`, slug, name: `Salão Pix ${run}` });
  customer = await (await phone(browser)).newPage();
  businessId = execSync(`psql "${DB}" -qAt -c "select id from public.businesses where slug = '${slug}'"`).toString().trim();
  // Habilita a cobrança nesta instalação de teste, como o README manda fazer em produção.
  const sql = execSync("node scripts/payments-setup.mjs", { env: { ...process.env, PAYMENTS_SECRET: TEST_SECRET } }).toString();
  execSync(`psql "${DB}" -q`, { input: sql });
});

test("desligado por padrão: Pix copia e cola da chave do salão, confirmação manual, nenhuma chamada ao provedor", async () => {
  const before = (await mp()).calls.length;

  await owner.getByRole("link", { name: "Configurações" }).click();
  await expect(owner.getByLabel("Cobrar o sinal no agendamento")).not.toBeChecked();
  await expect(owner.getByLabel("Cobrar o sinal no agendamento")).toBeDisabled(); // sem credencial não liga
  await owner.getByLabel("Chave Pix").fill("pix@salao.exemplo");
  await owner.getByRole("button", { name: "Salvar pagamentos" }).click();
  await expect(owner.getByText("Pagamentos salvos.")).toBeVisible();

  // O fluxo do cliente é o de sempre.
  const date = await book(customer, /Corte feminino/, "Paga Depois", "11999990301");
  await expect(customer.getByRole("button", { name: "Confirmar agendamento" })).toBeVisible();
  await customer.getByRole("button", { name: "Confirmar agendamento" }).click();
  await expect(customer.getByRole("heading", { name: "Agendamento confirmado!" })).toBeVisible();
  await customer.getByRole("link", { name: "Ver, remarcar ou cancelar" }).click();

  // Pix estático com o valor exato do sinal (30% de R$ 80,00 = R$ 24,00), gerado da chave do salão.
  await expect(customer.getByRole("heading", { name: /Pagamento via Pix · R\$\s24,00/ })).toBeVisible();
  const code = await customer.getByTestId("pix-code").textContent();
  expect(code).toMatch(/^000201/);
  expect(code).toContain("br.gov.bcb.pix");
  expect(code).toContain("pix@salao.exemplo");
  expect(code).toContain("540524.00"); // campo 54 (valor), 5 caracteres: 24.00
  expect(code).toMatch(/6304[0-9A-F]{4}$/); // termina com o CRC
  await expect(customer.getByText("A confirmação do pagamento é feita pelo estabelecimento.")).toBeVisible();

  // A dona confere o extrato e marca como recebido; a cliente vê.
  await owner.getByRole("link", { name: "Agenda", exact: true }).click();
  await owner.getByLabel("Data da agenda").fill(date);
  await owner.getByRole("button", { name: /Paga Depois, Corte feminino/ }).click();
  await owner.getByRole("button", { name: "Marcar pagamento recebido" }).click();
  await expect(owner.getByRole("dialog").getByText("Pagamento recebido (sinal de R$ 24,00)")).toBeVisible();
  await owner.getByRole("dialog").getByRole("button", { name: "Fechar" }).click();
  await customer.reload();
  await expect(customer.getByText(`Pagamento confirmado por Salão Pix ${run}.`)).toBeVisible();

  expect((await mp()).calls.length).toBe(before); // nenhuma chamada ao provedor com o interruptor desligado
});

test("credencial entra cifrada, não volta para a tela, e só então o interruptor liga", async () => {
  await owner.getByRole("link", { name: "Configurações" }).click();
  await owner.getByLabel("Access token de produção do Mercado Pago").fill(CREDENTIAL);
  await owner.getByRole("button", { name: "Guardar" }).click();
  await expect(owner.getByText("Mercado Pago conectado")).toBeVisible();
  await expect(owner.getByText("credencial terminada em 1234")).toBeVisible();

  // Nem a tela, nem a API do painel, nem o banco têm a credencial em texto legível.
  expect(await owner.content()).not.toContain(CREDENTIAL);
  const status = await (await owner.request.get("/api/painel/pagamentos/credenciais")).text();
  expect(status).not.toContain(CREDENTIAL);
  expect(JSON.parse(status)).toMatchObject({ available: true, connected: true, key_hint: "1234" });
  const stored = execSync(`psql "${DB}" -qAt -c "select ciphertext from public.payment_credentials where business_id = '${businessId}'"`).toString();
  expect(stored).toMatch(/^v1\./);
  expect(stored).not.toContain(CREDENTIAL);
  expect(stored).not.toContain("credencial-simulada");

  // Sem estar logado, ninguém cadastra nem consulta credencial.
  expect((await customer.request.get("/api/painel/pagamentos/credenciais")).status()).toBe(401);
  expect((await customer.request.post("/api/painel/pagamentos/credenciais", { data: { provider: "mercadopago", credential: "x".repeat(40) } })).status()).toBe(401);

  await owner.getByLabel("Cobrar o sinal no agendamento").click();
  await expect(owner.getByLabel("Cobrar o sinal no agendamento")).toBeChecked();
});

test("ligado: reserva, Pix do provedor, webhook falso não confirma, pagamento conferido confirma uma vez só", async () => {
  const date = await book(customer, /Escova/, "Paga Agora", "11999990302");
  await expect(customer.getByText(/cobrado um sinal de\s+R\$\s18,00/)).toBeVisible(); // 30% de R$ 60,00
  await customer.getByRole("button", { name: "Reservar e pagar o sinal" }).click();

  await expect(customer.getByRole("main").getByText("Aguardando pagamento", { exact: true })).toBeVisible();
  await expect(customer.getByRole("heading", { name: /Pague o sinal para confirmar · R\$\s18,00/ })).toBeVisible();
  await expect(customer.getByTestId("pix-code")).toContainText("00020126SIMULADO");
  await expect(customer.getByRole("button", { name: "Remarcar" })).toBeVisible();

  // Uma cobrança só, com a credencial do salão, mesmo recarregando a página (idempotência).
  await customer.reload();
  await expect(customer.getByTestId("pix-code")).toContainText("00020126SIMULADO");
  await customer.reload();
  await expect(customer.getByTestId("pix-code")).toContainText("00020126SIMULADO");
  let state = await mine();
  expect(state.creates).toBe(1);
  const payment = state.payments[0];
  expect(payment.transaction_amount).toBe(18);
  expect(payment.payer_email).toMatch(/@pagamentos\.invalid$/); // nenhum dado pessoal inventado
  expect((await mp()).calls.every((call) => call.authorized)).toBe(true);

  // Webhook forjado dizendo "aprovado": o sistema consulta o provedor, vê pendente e não confirma.
  expect((await webhook(customer, payment.id, { action: "payment.updated", status: "approved" })).ok()).toBe(true);
  // Webhook de cobrança que não existe, de outro estabelecimento ou malformado: ignorado sem erro.
  expect((await webhook(customer, 123456789)).ok()).toBe(true);
  expect((await customer.request.post(`/api/webhooks/pagamento/mercadopago?b=nao-e-uuid`, { data: { type: "payment", data: { id: payment.id } } })).ok()).toBe(true);
  expect((await customer.request.post(`/api/webhooks/pagamento/outro?b=${businessId}`, { data: {} })).ok()).toBe(true);
  await customer.reload();
  await expect(customer.getByRole("main").getByText("Aguardando pagamento", { exact: true })).toBeVisible();

  // Valor pago diferente do cobrado: não confirma.
  await fetch(`${MP}/_approve/${payment.id}`, { method: "POST", body: JSON.stringify({ amount: 1 }) });
  await webhook(customer, payment.id);
  await customer.reload();
  await expect(customer.getByRole("main").getByText("Aguardando pagamento", { exact: true })).toBeVisible();

  // Pagamento de verdade no provedor (valor certo) + aviso: confirma. Aviso repetido não muda nada.
  await fetch(`${MP}/_approve/${payment.id}`, { method: "POST", body: JSON.stringify({ amount: 18 }) });
  await webhook(customer, payment.id);
  await webhook(customer, payment.id);
  await expect(customer.getByText(/Sinal de R\$\s18,00 pago/)).toBeVisible();
  await expect(customer.getByRole("main").getByText("Confirmado", { exact: true })).toBeVisible();

  await owner.getByRole("link", { name: "Agenda", exact: true }).click();
  await owner.getByLabel("Data da agenda").fill(date);
  await expect(owner.getByRole("button", { name: /Paga Agora, Escova, Confirmado/ })).toContainText("Sinal pago");
  state = await mine();
  expect(state.creates).toBe(1);
  expect(state.refunds).toBe(0);
});

test("cancelar dentro da regra devolve o sinal, uma vez só", async () => {
  await customer.getByRole("button", { name: "Cancelar agendamento" }).click();
  await customer.getByRole("button", { name: "Sim, cancelar" }).click();
  await expect(customer.getByText(/O sinal de R\$\s18,00 foi devolvido/)).toBeVisible();
  await expect(customer.getByText("Cancelado por você")).toBeVisible();

  // Repetir a conferência (página recarregada, painel aberto) não estorna de novo.
  await customer.reload();
  await customer.request.post("/api/pagamento/status", { data: { token: customer.url().split("/").pop() } });
  await owner.request.post("/api/painel/pagamentos/pendencias");
  const state = await mine();
  expect(state.refunds).toBe(1);
  expect(state.payments[0].status).toBe("refunded");
});

test("sem pagamento no prazo a reserva cai e o horário volta; pagamento atrasado é devolvido", async () => {
  await book(customer, /Hidratação/, "Esqueceu de Pagar", "11999990303");
  await customer.getByRole("button", { name: "Reservar e pagar o sinal" }).click();
  await expect(customer.getByTestId("pix-code")).toContainText("00020126SIMULADO");
  const token = customer.url().split("/").pop()!;
  const late = (await mine()).payments.find((p) => p.status === "pending")!;

  // O teste não espera 15 minutos: adianta o vencimento direto no banco local.
  execSync(`psql "${DB}" -q -c "update public.appointments set hold_expires_at = now() - interval '1 minute' where public_token = '${token}'"`);
  await expect(customer.getByText("Cancelado", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(customer.getByText("Motivo: Pagamento não realizado no prazo")).toBeVisible();

  // Pagou depois que a reserva caiu: o sistema confere, não reativa o horário e devolve o dinheiro.
  await fetch(`${MP}/_approve/${late.id}`, { method: "POST", body: "{}" });
  await webhook(customer, late.id);
  await customer.reload();
  await expect(customer.getByText(/O sinal de R\$\s21,00 foi devolvido/)).toBeVisible(); // 30% de R$ 70,00
  await expect(customer.getByText("Cancelado", { exact: true })).toBeVisible();
  expect((await mine()).payments.find((p) => p.id === late.id)!.refunds).toBe(1);
});

test("desligar o interruptor devolve o fluxo ao normal", async () => {
  await owner.getByRole("link", { name: "Configurações" }).click();
  await owner.getByLabel("Cobrar o sinal no agendamento").click();
  await expect(owner.getByLabel("Cobrar o sinal no agendamento")).not.toBeChecked();
  const before = (await mp()).calls.length;
  await book(customer, /Corte masculino/, "Sem Cobrança", "11999990304");
  await customer.getByRole("button", { name: "Confirmar agendamento" }).click();
  await expect(customer.getByRole("heading", { name: "Agendamento confirmado!" })).toBeVisible();
  expect((await mp()).calls.length).toBe(before);
});
