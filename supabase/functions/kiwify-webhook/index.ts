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

// Alerta operacional no Telegram — avisa o admin se um pagamento falhar.
// Defensivo: se os secrets não estiverem configurados, simplesmente não faz nada.
async function alertAdmin(texto: string): Promise<void> {
    const token  = Deno.env.get('TELEGRAM_ALERT_BOT_TOKEN')
    const chatId = Deno.env.get('TELEGRAM_ALERT_CHAT_ID')
    if (!token || !chatId) return
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: texto, disable_web_page_preview: true }),
        })
    } catch (_) { /* alerta nunca pode derrubar o webhook */ }
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
    if (req.method !== 'POST')    return new Response('Method Not Allowed', { status: 405, headers: CORS })

    // Contexto preservado para o alerta em caso de falha inesperada
    let ctxEmail = '?'
    let ctxOrder = '?'
    let ctxPlano = '?'

    try {
        const body = await req.json()

        // Kiwify envia um token único por webhook — identifica o plano e prova a autenticidade
        const token   = (body.webhook_token || '').toString().trim()
        const status  = (body.order_status || body.status || body.webhook_event_type || '').toString()
        const email   = (body.Customer?.email || body.customer?.email || '').toLowerCase().trim()
        const orderId = (body.order_id || body.Subscription?.id || body.id || null)
        ctxEmail = email || '?'
        ctxOrder = orderId || '?'

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
            // Pagamento aprovado mas token não bate: possível erro de configuração — avisa o admin
            await alertAdmin(`⚠️ EDS PlanejaEdge — webhook com token inválido.\nE-mail: ${ctxEmail}\nPedido: ${ctxOrder}\nStatus: ${status}\nVerifique os secrets KIWIFY_TOKEN_*.`)
            return new Response(JSON.stringify({ error: 'token_invalido' }), {
                status: 401, headers: { ...CORS, 'Content-Type': 'application/json' },
            })
        }
        ctxPlano = plan.nome
        if (!email) {
            await alertAdmin(`⚠️ EDS PlanejaEdge — pagamento aprovado SEM e-mail.\nPedido: ${ctxOrder}\nPlano: ${plan.nome}\nCrédito NÃO concedido — verifique manualmente.`)
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
        // Falha crítica: cliente PAGOU mas o crédito pode não ter entrado. Avisa o admin com contexto.
        console.error('kiwify-webhook error:', msg)
        await alertAdmin(`🚨 EDS PlanejaEdge — FALHA ao conceder crédito.\nE-mail: ${ctxEmail}\nPedido: ${ctxOrder}\nPlano: ${ctxPlano}\nErro: ${msg}\n\nO cliente pode ter pago sem receber crédito — verifique e conceda manualmente se necessário.`)
        // Não vaza detalhe interno na resposta HTTP — Kiwify reenviará o webhook.
        return new Response(JSON.stringify({ error: 'internal_error' }), {
            status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
        })
    }
})
