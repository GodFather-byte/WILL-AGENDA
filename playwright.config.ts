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
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
