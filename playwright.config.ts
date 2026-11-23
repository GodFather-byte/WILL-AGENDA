import { defineConfig } from "@playwright/test";

// Teste do fluxo completo no navegador: cliente no celular e dono no painel.
// Precisa do Supabase local no ar (npm run db:start). O servidor do app sobe sozinho.
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    locale: "pt-BR",
    // De propósito fora de São Paulo: a agenda não pode depender do fuso do aparelho.
    timezoneId: "Asia/Tokyo",
    trace: "off",
  },
  webServer: [
    // API simulada da IA: valida as ferramentas, não a qualidade do modelo.
    { command: "node e2e/mock-anthropic.mjs", url: "http://127.0.0.1:4010", reuseExistingServer: true, timeout: 30_000 },
    {
      command: "npm run dev",
      url: "http://localhost:3000",
      reuseExistingServer: true,
      timeout: 120_000,
      env: {
        ANTHROPIC_API_KEY: "chave-de-teste-simulada",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:4010",
        ANTHROPIC_MODEL: "claude-haiku-5-5",
      },
    },
  ],
});
