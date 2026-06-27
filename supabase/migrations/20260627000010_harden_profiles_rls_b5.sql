-- ════════════════════════════════════════════════════════════════════
--  B5 — Blindagem da RLS de profiles (auditoria EDS Visual, aplicado ao vivo 27/06)
--
--  PROBLEMA: a policy de UPDATE em profiles (auth.uid() = id) não restringe
--  colunas → o cliente (anon/authenticated) conseguia `update profiles set
--  creditos = 999999 where id = auth.uid()` via PostgREST (auto-crédito).
--  Comprovado ao vivo (204 success) antes do fix.
--
--  CORREÇÃO: revogar UPDATE da tabela (o front NÃO atualiza profiles pelo
--  cliente — créditos/admin vão por RPC SECURITY DEFINER / service_role).
--  Pós-fix: o teste dá 403.
-- ════════════════════════════════════════════════════════════════════

revoke update on public.profiles from anon, authenticated;
