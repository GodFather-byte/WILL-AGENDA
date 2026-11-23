import { devices, expect, type Browser, type Page } from "@playwright/test";

const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";
export const PASSWORD = "senha-de-teste-123";

/** Lê no Mailpit local o link de confirmação enviado para o e-mail. */
export async function confirmationLink(to: string) {
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

/** Celular do cliente. De propósito fora do fuso de São Paulo. */
export const phone = (browser: Browser) =>
  browser.newContext({ ...devices["Pixel 7"], locale: "pt-BR", timezoneId: "Asia/Tokyo" });

/** Cria conta, confirma o e-mail e cria um salão pelo fluxo real da tela. Devolve a página do painel. */
export async function createSalon(browser: Browser, options: { email: string; slug: string; name: string }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "pt-BR", timezoneId: "Asia/Tokyo" });
  const page = await context.newPage();
  await page.goto("/cadastro");
  await page.getByLabel("E-mail").fill(options.email);
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Criar conta" }).click();
  await expect(page.getByText("Aguardando a confirmação do e-mail")).toBeVisible();
  await page.goto(await confirmationLink(options.email));
  await page.getByText("Salão de beleza").click();
  await page.getByLabel("Nome do estabelecimento").fill(options.name);
  await page.getByLabel("Endereço da sua página").fill(options.slug);
  await page.getByLabel("Primeiro profissional").fill("Carla");
  await page.getByRole("button", { name: "Criar minha agenda" }).click();
  await expect(page.getByRole("region", { name: "Agenda de Carla" })).toBeVisible();
  return page;
}

/** Envia uma mensagem no chat aberto e devolve o texto da resposta seguinte. */
export async function chat(page: Page, label: string, message: string) {
  const panel = page.getByRole("region", { name: label });
  const before = await panel.locator("[data-role=assistant]").count();
  await panel.getByRole("textbox").fill(message);
  await panel.getByRole("button", { name: "Enviar" }).click();
  const answer = panel.locator("[data-role=assistant]").nth(before);
  await expect(answer).toBeVisible({ timeout: 30_000 });
  return (await answer.textContent()) ?? "";
}
