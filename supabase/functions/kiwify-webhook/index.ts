import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
}

// Os TOKENS vêm de secrets do Supabase (NÃO ficam no código/repositório).
// Créditos e nomes podem ficar aqui — não são sensíveis.
const PLANS = [
    { token: Deno.env.get('KIWIFY_TOKEN_STARTER'),      nome: 'Starter',      creditos: 200  },
    { token: Deno.env.get('KIWIFY_TOKEN_PROFISSIONAL'), nome: 'Profissional', creditos: 500  },
    { token: Deno.env.get('KIWIFY_TOKEN_PREMIUM'),      nome: 'Premium',      creditos: 1200 },
]

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
    if (req.method !== 'POST')    return new Response('Method Not Allowed', { status: 405, headers: CORS })

    try {
        const body = await req.json()

        // Kiwify envia um token único por webhook — identifica o plano e prova a autenticidade
        const token   = (body.webhook_token || '').toString().trim()
        const status  = (body.order_status || body.status || body.webhook_event_type || '').toString()
        const email   = (body.Customer?.email || body.customer?.email || '').toLowerCase().trim()
        const orderId = (body.order_id || body.Subscription?.id || body.id || null)

        // Só processa compra aprovada ou renovação de assinatura
        const isApproved = ['paid', 'approved', 'order_approved', 'subscription_renewed', 'renewed']
            .some((s) => status.toLowerCase().includes(s))
        if (!isApproved) {
            return new Response(JSON.stringify({ ok: true, skipped: status }), {
                headers: { ...CORS, 'Content-Type': 'application/json' },
            })
        }

        const plan = token ? PLANS.find((p) => p.token && p.token === token) : undefined
        if (!plan) {
            return new Response(JSON.stringify({ error: 'token_invalido' }), {
                status: 401, headers: { ...CORS, 'Content-Type': 'application/json' },
            })
        }
        if (!email) {
            return new Response(JSON.stringify({ error: 'email_ausente' }), {
                status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
            })
        }

        const _sb = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
        )

        // Crédito atômico e idempotente (não credita o mesmo order_id 2x)
        const { data: result, error } = await _sb.rpc('kiwify_grant', {
            p_order_id: orderId,
            p_email:    email,
            p_plano:    plan.nome,
            p_creditos: plan.creditos,
            p_status:   status,
            p_payload:  body,
        })
        if (error) throw error

        console.log(`kiwify-webhook: ${result} — ${email} (${plan.nome}, +${plan.creditos})`)
        return new Response(JSON.stringify({ ok: true, result, plano: plan.nome, creditos: plan.creditos }), {
            headers: { ...CORS, 'Content-Type': 'application/json' },
        })

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('kiwify-webhook error:', msg)
        return new Response(JSON.stringify({ error: msg }), {
            status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
        })
    }
})
