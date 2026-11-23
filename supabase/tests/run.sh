#!/usr/bin/env bash
# Roda todos os testes do banco contra o Supabase local (ou o banco em DATABASE_URL).
#   npm run test:db
set -uo pipefail
cd "$(dirname "$0")"

export DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

for file in *.sql; do
  echo "== $file"
  if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$file" >"$OUT" 2>&1; then
    grep -E "passaram|passou" "$OUT" || true
  else
    grep -E "ERROR|NOTICE|CONTEXT" "$OUT" || cat "$OUT"
    echo "FALHOU: $file"
    exit 1
  fi
done

echo "== concorrencia.sh"
bash concorrencia.sh || exit 1
echo "Todos os testes do banco passaram."
