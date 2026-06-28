# 🔁 REAUDITORIA INDEPENDENTE — EDS PlanejaEdge (Nível 4)

> Padrão EDS de Auditoria · Versão 1.0 · **Auditor independente** (não vincula ao auto-laudo anterior)
> App: **EDS PlanejaEdge** — assistente pedagógico com IA (PT-BR · BNCC · Kiwify · BRL)
> Nível 4: estático completo + **verificação dinâmica ao vivo** · Data: 2026-06-27
> Benchmark de calibração: EDS Visual (8,3/10)
>
> _Reaudita o veredito interno de **9,6/10**. Conclusão independente: **8,1/10 · APTO**, com 1 achado novo (drift do webhook) que o auto-laudo não registrou._

---

## 1. Stack (confirmado)
PWA estático (`index.html`) em Netlify + **Supabase** (Auth, Postgres+RLS, 2 Edge Functions: `ai-proxy`, `kiwify-webhook`), pagamento **Kiwify**, IA **Gemini via proxy**. Migrations, funções, CI e headers **versionados no repo** — muito mais auditável que o app irmão.

## 2. ✅ Provado AO VIVO (Nível 4)

| # | Portão | Evidência estática | Prova dinâmica |
|---|---|---|---|
| ✅1 | `ai-proxy` exige JWT | `functions/ai-proxy/index.ts:51-58` (`getUser(token)`) | sem token → **HTTP 401** |
| ✅2 | RLS `profiles` (não vaza saldos) | `migrations/...harden_profiles_insert.sql` | GET anon → **200 `[]`** |
| ✅3 | `debit_credit`/`refund_credit` não-anônimos | `debit_credit_fn.sql` (`SECURITY DEFINER`) | RPC anon → **HTTP 404** (não exposta) |
| ✅4 | Webhook Kiwify protegido | (ver PE-01) | mesmo **com anon key pública** → **`{"erro":"nao_autorizado"}` 401** |
| ✅5 | Débito **atômico** anti-race | `debit_credit_fn.sql:12-16` (`UPDATE … WHERE creditos>0` single-stmt) | — |
| ✅6 | Crédito **idempotente** (anti-replay de webhook) | `kiwify_grant.sql` (índice único `order_id` + check) | — |
| ✅7 | Estorno em falha da IA | `refund_credit_fn.sql` | — |
| ✅8 | Insert do cliente limitado a `creditos<=100` | `harden_profiles_insert.sql` | — |
| ✅9 | Headers + CSP **versionados** (HSTS preload, X-Frame DENY, COOP, nosniff) | `netlify.toml:6-13` | — |
| ✅10 | CORS allowlist + allowlist de modelos + cap 12M chars | `ai-proxy/index.ts:5-44` | — |
| ✅11 | CI no GitHub Actions (smoke + `deno check`) | `.github/workflows/ci.yml` | — |
| ✅12 | LGPD: `privacidade.html` + `termos.html` presentes | `tree` | — |

## 3. ⚠️ Achados novos / a corrigir

### ⚠️🔴 PE-01 · **DRIFT do webhook** — repo ≠ produção · `functions/kiwify-webhook/index.ts`
- **Prova:** a função em produção rejeita um POST autenticado com a anon key pública (`{"ok":false,"erro":"nao_autorizado"}`), mas **a string `nao_autorizado` e qualquer checagem de segredo/assinatura NÃO existem no código do repo** (a função versionada credita com base apenas no `product_name`/`email` do corpo, sem validar assinatura).
- **Risco:** o código versionado **não é a fonte da verdade** do componente que move dinheiro. Quem auditar/redeployar o repo derruba a proteção que existe em produção (webhook passaria a ser **forjável** por qualquer um com a anon key pública). O auto-laudo 9,6 não detectou isso.
- **Como deve ser feito (indicação):** versionar no repo a versão real (com verificação de assinatura/segredo do Kiwify, ex. HMAC do header ou token comparado a `Deno.env`), e adicionar à CI um `deno check` da função `kiwify-webhook` (hoje a CI só checa `ai-proxy`).

### ⚠️ PE-02 · **Migration duplicada e divergente** de `kiwify_grant`
- `migrations/...05_kiwify_grant.sql` (RETURNS **TEXT**, INSERT sem `ON CONFLICT`) e `...06_kiwify_grant.sql` (RETURNS **JSONB**, com `ON CONFLICT DO NOTHING`) definem a mesma função de formas diferentes. Vence a última aplicada — ambiguidade de "fonte de verdade dupla". **Indicação:** manter uma só (a JSONB), remover/anular a outra.

### ⚠️ PE-03 · **CI é smoke-only** — sem teste da lógica de crédito
- `ci.yml` valida arquivos/sintaxe/HTML e `deno check ai-proxy`, mas **não testa** débito/estorno/idempotência. Benchmark tinha 19 testes verdes. **Indicação:** testes (pgTAP ou integração) para `debit_credit`, `refund_credit`, `kiwify_grant` (replay do mesmo `order_id` não credita 2x).

### ⚠️ PE-04 · `kiwify-webhook` com `Access-Control-Allow-Origin: '*'`
- `functions/kiwify-webhook/index.ts:4`. Aceitável para webhook server-to-server, mas sem assinatura validada no repo amplifica o PE-01. Resolver junto do PE-01.

## 4. Notas por dimensão & global

| # | Dimensão | Peso | Nota | Nota auto-laudo | Justificativa da divergência |
|---|---|---|---|---|---|
| 1 | Arquitetura | 12% | 9,0 | — | supabase+CI+headers no repo; −1 drift webhook |
| 2 | Segurança | 20% | 8,5 | — | gates provados ao vivo; −1,5 drift (auth real não auditável) |
| 3 | Lógica de Negócio | 15% | 8,5 | — | débito/estorno/idempotência sólidos; −1,5 entrada (webhook) não verificável + migration dupla |
| 4 | Frontend/UX/PWA | 8% | 8,0 | — | PWA + compressão de imagem |
| 5 | Qualidade & Testes/CI | 12% | 6,5 | — | CI smoke-only, sem testes de negócio, monolito |
| 6 | Conformidade/LGPD | 8% | 7,5 | — | privacidade+termos presentes |
| 7 | Prontidão MVP | 10% | 8,5 | — | live, billing, alertas Telegram, estorno, rate-limit |
| 8 | Escalabilidade/SaaS | 15% | 7,5 | — | RLS multi-tenant, idempotência, backup.yml; DR/quotas parciais |

**Global ponderada = 8,1/10** (auto-laudo: 9,6 — superestimado, principalmente por não contabilizar o drift do webhook PE-01 e a CI smoke-only).

## 5. 🚦 Veredito independente: **APTO** (mantém o lançamento), com ressalva
- Nenhum 🔴 **provado** em Segurança/Lógica: todos os portões críticos passaram ao vivo, **inclusive** o webhook (protegido em produção).
- **Ressalva forte (PE-01):** a aprovação se apoia em proteção que **só existe em produção, não no repo**. Enquanto o repo não refletir a versão real e assinada do webhook, qualquer redeploy a partir do `master` reintroduz um bloqueante de dinheiro. Tratar PE-01 como Sprint 0 mesmo com o app no ar.
- Calibração: 8,1 fica logo abaixo do benchmark EDS Visual (8,3), coerente — lá o webhook assinado estava **versionado e provado**; aqui ele está provado em prod mas **não versionado**.

## 6. 🕳️ Pontos cegos
**🛠️ Analista executa:** teste de inserção real (usuário comum tentando `creditos>100` → rejeitar); replay de webhook real (mesmo `order_id` 2x); carga/rate-limit; compra Kiwify ponta a ponta; verificar segredo do webhook em prod.
**📂 Disponibilizar no repo:** **versão real da função `kiwify-webhook` (com a verificação de assinatura)** — hoje em drift; consolidar `kiwify_grant` numa migration única.

## 7. 🗺️ Roadmap
- **Sprint 0:** PE-01 (versionar webhook assinado + CI `deno check` da função) · PE-02 (consolidar migration).
- **Sprint 1:** PE-03 (testes de débito/estorno/idempotência na CI) · revisar CORS do webhook (PE-04).
- **Sprint 2:** DR/backup testado, quotas de custo, observabilidade de saldo.

— _Reauditoria independente · Padrão de Excelência EDS · EDS Soluções Inteligentes_

---

# 🔁 CICLO 2 — Reauditoria Nível 4 (2026-06-27)

| Achado | Disposição | Prova dinâmica (ao vivo) |
|---|---|---|
| **PE-01** DRIFT do webhook | ✅ **Resolvido** | `kiwify-webhook` valida `KIWIFY_WEBHOOK_TOKEN` **no repo** (`master:functions/kiwify-webhook/index.ts:40-46`) · POST sem token → **401 `nao_autorizado`** |
| **B5** auto-crédito (RLS) | ✅ **Corrigido + versionado + provado** | migration `…_harden_profiles_rls_b5.sql` · PATCH anon `creditos` → **`42501 permission denied for table profiles` (401)** |
| Testes de negócio (PE-03) | ⏳ **Pendência assumida** (já há CI de sintaxe + backup) | — |

**Nota revista:** Arquitetura **9,5** · Seg **9,0** · Lóg.Negócio **9,0** · MVP **9,0** · SaaS **8,0** · Front **8,0** · LGPD **7,5** · Qualidade/Testes **6,5**.
**Nota global Ciclo 2 = 8,4/10** (era 8,1).

**Veredito Ciclo 2: 🟢 APTO (ressalva PE-01 removida).** Drift fechado — o repo voltou a ser a fonte da verdade do webhook que move dinheiro, e a proteção está **provada ao vivo**. Nenhum 🔴; todas as dimensões ≥ 6; núcleo financeiro (webhook assinado + débito atômico + B5) provado. Acima do piso do benchmark EDS Visual (8,3). Resta apenas a frente de testes de negócio (Sprint 1).
