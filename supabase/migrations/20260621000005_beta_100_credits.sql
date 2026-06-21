-- Beta: aumenta créditos iniciais de 30 para 100
ALTER TABLE public.profiles ALTER COLUMN creditos SET DEFAULT 100;

-- Atualiza o trigger de novo usuário
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    INSERT INTO public.profiles (id, email, creditos)
    VALUES (NEW.id, NEW.email, 100)
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$;

-- Opcional: dar 100 créditos a quem já cadastrou com 30 (usuários beta)
UPDATE public.profiles SET creditos = 100 WHERE creditos = 30;
