# Manual de Confiabilidade — EDS Soluções Inteligentes

Runbook operacional dos produtos EDS. Objetivo: produto confiável, vendável em qualquer lugar.
Mantenha este documento atualizado a cada mudança de infraestrutura.

---

## 1. Arquitetura de confiança (o que já está sólido)

| Camada | Garantia | Onde |
|--------|----------|------|
| Chave Gemini | Nunca no cliente. Só em secret do servidor. | `ai-proxy` (Edge Function) |
| Autenticação | JWT validado a cada chamada de IA | `ai-proxy` |
| CORS | Travado por origem (allowlist + previews Netlify) | `ai-proxy` |
| Custo de IA | Débito atômico antes de chamar; estorno se a IA falha | `ai-proxy` + `debit_credit`/`refund_credit` |
| Pagamento | Idempotente por `order_id` (índice único) | `kiwify_grant` |
| Pagamento | Só `service_role` executa o grant | `kiwify_grant` |
| Falha de pagamento | Alerta no Telegram + retry pela Kiwify | `kiwify-webhook` |
| Dados | Row Level Security (cada usuário só vê o próprio) | `profiles` |
| Front | HSTS, CSP base, anti-clickjacking, nosniff | `netlify.toml` / `_headers` |

---

## 2. Alerta de pagamento (configurar no Supabase)

O `kiwify-webhook` avisa o admin no Telegram se um cliente pagar e o crédito falhar.
Para ativar, defina 2 secrets no Supabase:

```bash
# Pode reusar o token do bot de suporte, ou criar um bot dedicado de alertas no @BotFather
supabase secrets set TELEGRAM_ALERT_BOT_TOKEN="<token do bot>"
supabase secrets set TELEGRAM_ALERT_CHAT_ID="<seu chat id>"
```

**Como descobrir seu CHAT_ID:** abra o bot, envie qualquer mensagem, e acesse
`https://api.telegram.org/bot<TOKEN>/getUpdates` — o número em `chat.id` é o seu.

**Deploy da função após mudanças:**
```bash
supabase functions deploy kiwify-webhook --no-verify-jwt
```

Se os secrets não forem definidos, o webhook funciona normalmente — só não envia alerta.

---

## 3. Monitoramento de uptime (UptimeRobot — grátis)

Avisa por e-mail/Telegram se um app sair do ar.

1. Crie conta grátis em https://uptimerobot.com (50 monitores, sem custo)
2. Add New Monitor → tipo **HTTP(s)** → cole cada URL:
   - `https://planejaedge-eds.netlify.app/`
   - `https://eds-licitaedg-pro.netlify.app/`
   - `https://eds-solucoes-inteligentes.netlify.app/`
3. Intervalo: 5 minutos
4. Alert Contacts: seu e-mail `suporte@edssi.com.br` (e/ou integração Telegram)

**Bot de suporte (Railway):** o `main.py` já expõe `/` como health check.
Monitore também a URL pública do Railway para saber se o bot caiu.

---

## 4. Backup e recuperação (Supabase)

> Dados são o ativo mais crítico. Confiança = saber que sobrevive a um acidente.

- **Backups automáticos:** ativos no plano Pro (diários, retenção 7 dias).
  Free tier NÃO tem backup automático — avaliar upgrade antes de escalar.
  Painel: Project → Database → Backups.
- **Point-in-Time Recovery (PITR):** recomendado quando houver clientes pagantes.
- **Backup manual periódico** (rodar no seu PC, guardar fora do Supabase):
  ```bash
  supabase db dump --db-url "$SUPABASE_DB_URL" -f backup_$(date +%F).sql
  ```
- **Teste de restauração:** ao menos 1x, restaure um backup num projeto de teste.
  Backup que nunca foi restaurado não é backup — é esperança.

### Auditoria de RLS (rodar no SQL Editor do Supabase)

Confirma que toda tabela com dado de usuário tem Row Level Security ligado:

```sql
-- Tabelas SEM RLS (devem aparecer só tabelas públicas/sem dado sensível)
SELECT tablename
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename NOT IN (
    SELECT tablename FROM pg_tables t
    JOIN pg_class c ON c.relname = t.tablename
    WHERE c.relrowsecurity = true
  );

-- Políticas ativas por tabela
SELECT tablename, policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename;
```

---

## 5. Checklist de QA pré-deploy

Rodar antes de subir qualquer mudança para produção. Evita bug em produção.

### Todo deploy
- [ ] Testei a mudança localmente / em preview do Netlify
- [ ] Não há chave, token ou senha no código (só `anon key` no cliente)
- [ ] Console do navegador sem erro vermelho
- [ ] Login + uma ação real funcionam ponta a ponta

### Quando mexer em pagamento (`kiwify-webhook` / `kiwify_grant`)
- [ ] Fiz uma compra de teste (modo sandbox da Kiwify) e o crédito entrou
- [ ] Reenviei o mesmo webhook e o crédito NÃO dobrou (idempotência)
- [ ] Deploy da Edge Function feito: `supabase functions deploy kiwify-webhook --no-verify-jwt`

### Quando mexer em IA (`ai-proxy`)
- [ ] Usuário sem crédito recebe erro 402 (não consome IA)
- [ ] Falha da Gemini estorna o crédito
- [ ] Deploy: `supabase functions deploy ai-proxy`

### Quando mexer em front (apps/landings)
- [ ] PWA ainda instala e funciona offline
- [ ] Páginas LGPD (termos/privacidade) acessíveis
- [ ] Service worker atualizado (bump de versão se necessário)

---

## 6. Plano de incidente (quando algo quebra)

1. **Cliente pagou e não recebeu crédito** → alerta chega no Telegram. Abrir Supabase →
   `payment_log` pelo `order_id`. Se não creditou, conceder manualmente via SQL.
2. **App fora do ar** → UptimeRobot avisa. Checar deploy no Netlify (rollback se preciso).
3. **Bot sem responder** → checar logs no Railway. Verificar secrets `GEMINI_API_KEY_SUPORTE`.
4. **Custo de IA disparou** → checar `payment_log`/uso. Rate limit já existe no `ai-proxy`.

Contato técnico: `suporte@edssi.com.br` · Suporte usuário: `t.me/AtendimentoEDSSI_bot`
