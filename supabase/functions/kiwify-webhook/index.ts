import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
}

// Identifica o plano pelo NOME do produto que o Kiwify envia no corpo.
// (O Kiwify NAO manda o token cru no corpo — por isso a versao por token falhava.)
function planoDoProduto(nome: string): { nome: string; creditos: number } | null {
    const n = (nome || '').toLowerCase()
    if (n.includes('starter'))      return { nome: 'Starter',      creditos: 200  }
    if (n.includes('profissional')) return { nome: 'Profissional', creditos: 500  }
    if (n.includes('premium'))      return { nome: 'Premium',      creditos: 1200 }
    return null
}

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
    } catch (_) { /* alerta nunca derruba o webhook */ }
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
    if (req.method !== 'POST')    return new Response('Method Not Allowed', { status: 405, headers: CORS })

    let ctxEmail = '?', ctxOrder = '?', ctxPlano = '?'
    try {
        const body = await req.json()
        console.log('[kiwify] BODY:', JSON.stringify(body))

        // [B1] valida o segredo do webhook ANTES de qualquer crédito (token via ?token= ou body.webhook_token)
        const expected = Deno.env.get('KIWIFY_WEBHOOK_TOKEN')
        const got = (new URL(req.url).searchParams.get('token') || body?.webhook_token || '').toString()
        if (!expected || got !== expected) {
            // Token errado = ruído normal (smoke test diário, bots escaneando a URL). NÃO alerta no Telegram.
            console.warn('[kiwify] webhook REJEITADO: token invalido/ausente')
            return new Response(JSON.stringify({ ok: false, erro: 'nao_autorizado' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } })
        }

        const status   = (body.order_status || body.status || body.webhook_event_type || '').toString()
        const prodNome = (body.Product?.product_name || body.product?.product_name || body.product_name || '').toString()
        const email    = (body.Customer?.email || body.customer?.email || '').toLowerCase().trim()
        const orderId  = (body.order_id || body.Subscription?.id || body.id || null)
        ctxEmail = email || '?'; ctxOrder = orderId || '?'

        console.log('[kiwify] produto:', prodNome, '| status:', status, '| email:', email)

        const isApproved = ['paid', 'approved', 'order_approved', 'subscription_renewed', 'renewed']
            .some((s) => status.toLowerCase().includes(s))
        if (!isApproved) {
            return new Response(JSON.stringify({ ok: true, skipped: status }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
        }

        const plan = planoDoProduto(prodNome)
        if (!plan) {
            await alertAdmin(`⚠️ PlanejaEdge — produto não reconhecido.\nE-mail: ${ctxEmail}\nPedido: ${ctxOrder}\n>> Produto: "${prodNome}" <<`)
            return new Response(JSON.stringify({ ok: true, ignorado: 'produto_nao_eh_planejaedge', produto: prodNome }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
        }
        ctxPlano = plan.nome
        if (!email) {
            await alertAdmin(`⚠️ PlanejaEdge — pagamento sem e-mail.\nPedido: ${ctxOrder}\nPlano: ${plan.nome}`)
            return new Response(JSON.stringify({ error: 'email_ausente' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        }

        const _sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
        const { data: result, error } = await _sb.rpc('kiwify_grant', {
            p_order_id: orderId, p_email: email, p_plano: plan.nome, p_creditos: plan.creditos, p_status: status, p_payload: body,
        })
        if (error) throw error

        console.log(`kiwify-webhook: ${result} — ${email} (${plan.nome}, +${plan.creditos})`)
        return new Response(JSON.stringify({ ok: true, result, plano: plan.nome, creditos: plan.creditos }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    } catch (err) {
        const e = err as { message?: string; details?: string; hint?: string; code?: string }
        const msg = e?.message || e?.details || e?.hint || JSON.stringify(err)
        console.error('kiwify-webhook error:', JSON.stringify(err))
        await alertAdmin(`🚨 PlanejaEdge — FALHA ao creditar.\nE-mail: ${ctxEmail}\nPedido: ${ctxOrder}\nPlano: ${ctxPlano}\nErro: ${msg}`)
        return new Response(JSON.stringify({ error: 'internal_error' }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
})
