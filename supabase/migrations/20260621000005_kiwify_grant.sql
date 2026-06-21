-- ============================================================
-- Kiwify: crédito de assinatura idempotente
-- ============================================================

-- Plano atual no perfil
ALTER TABLE public.profiles    ADD COLUMN IF NOT EXISTS plano TEXT;

-- order_id para evitar creditar o mesmo pedido 2x (Kiwify reenvia webhooks)
ALTER TABLE public.payment_log ADD COLUMN IF NOT EXISTS order_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS payment_log_order_uidx
    ON public.payment_log (order_id) WHERE order_id IS NOT NULL;

-- Concede os créditos do plano de forma atômica e idempotente.
-- Chamada pela Edge Function kiwify-webhook (service_role).
CREATE OR REPLACE FUNCTION public.kiwify_grant(
    p_order_id  TEXT,
    p_email     TEXT,
    p_plano     TEXT,
    p_creditos  INTEGER,
    p_status    TEXT,
    p_payload   JSONB
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_uid UUID;
BEGIN
    -- Idempotência: se esse pedido já foi processado, não credita de novo
    IF p_order_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM payment_log WHERE order_id = p_order_id
    ) THEN
        RETURN 'duplicate';
    END IF;

    SELECT id INTO v_uid FROM profiles WHERE lower(email) = lower(p_email);

    IF v_uid IS NOT NULL THEN
        UPDATE profiles
           SET creditos   = creditos + p_creditos,
               plano      = p_plano,
               updated_at = NOW()
         WHERE id = v_uid;
    END IF;

    INSERT INTO payment_log (order_id, email, plano, creditos_adicionados, kiwify_status, payload)
    VALUES (p_order_id, p_email, p_plano, p_creditos, p_status, p_payload);

    RETURN CASE WHEN v_uid IS NULL THEN 'logged_no_user' ELSE 'granted' END;
END; $$;
