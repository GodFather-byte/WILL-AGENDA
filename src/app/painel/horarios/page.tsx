import { HoursManager } from "@/components/painel/HoursManager";

// Painel é sempre por requisição (sessão do dono): fora da validação de navegação instantânea.
export const instant = false;

export default function Page() {
  return <HoursManager />;
}
