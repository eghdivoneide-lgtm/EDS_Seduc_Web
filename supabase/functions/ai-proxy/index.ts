import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Lista de origens permitidas (separadas por vírgula). Ex.:
//   ALLOWED_ORIGIN = https://planejaedge-eds.netlify.app, https://planejaedge.com.br
// Os previews do Netlify (deploy-preview-N--<site>.netlify.app, branch--<site>.netlify.app)
// são liberados automaticamente para os sites configurados.
const RAW_ORIGINS = (Deno.env.get('ALLOWED_ORIGIN') || '*').split(',').map((s) => s.trim()).filter(Boolean)
const ALLOW_ALL = RAW_ORIGINS.includes('*')

function netlifySite(origin: string): string | null {
    const m = origin.match(/^https:\/\/(?:[a-z0-9-]+--)?([a-z0-9-]+)\.netlify\.app$/i)
    return m ? m[1].toLowerCase() : null
}
const ALLOWED_SITES = new Set(RAW_ORIGINS.map(netlifySite).filter((x): x is string => !!x))

function resolveOrigin(origin: string | null): string {
    if (ALLOW_ALL) return origin || '*'
    if (!origin) return RAW_ORIGINS[0] || '*'
    if (RAW_ORIGINS.includes(origin)) return origin
    const site = netlifySite(origin)
    if (site && ALLOWED_SITES.has(site)) return origin   // libera previews do mesmo site
    return RAW_ORIGINS[0] || '*'
}

function corsHeaders(req: Request): Record<string, string> {
    return {
        'Access-Control-Allow-Origin': resolveOrigin(req.headers.get('Origin')),
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Vary': 'Origin',
    }
}

const ALLOWED_MODELS = new Set([
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
    'gemini-1.5-pro',
])

// Limite alto: PDFs (planos, provas) viram base64 grande. 12M chars (~9MB de
// arquivo) comporta uploads reais e ainda barra abuso.
const MAX_PAYLOAD_CHARS = 12_000_000

Deno.serve(async (req) => {
    const CORS = corsHeaders(req)
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

    try {
        const authHeader = req.headers.get('Authorization')
        if (!authHeader) return new Response('Unauthorized', { status: 401, headers: CORS })

        const _sb = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        )

        const token = authHeader.replace('Bearer ', '')
        const { data: { user }, error: authErr } = await _sb.auth.getUser(token)
        if (authErr || !user) return new Response('Unauthorized', { status: 401, headers: CORS })

        // Validar body
        const { model, contents, system_instruction, generationConfig } = await req.json()

        if (!contents) {
            return new Response(JSON.stringify({ error: 'conteudo_ausente' }), {
                status: 400,
                headers: { ...CORS, 'Content-Type': 'application/json' }
            })
        }

        if (JSON.stringify(contents).length > MAX_PAYLOAD_CHARS) {
            return new Response(JSON.stringify({ error: 'payload_muito_grande' }), {
                status: 413,
                headers: { ...CORS, 'Content-Type': 'application/json' }
            })
        }

        const modelName = ALLOWED_MODELS.has(model) ? model : 'gemini-2.5-flash'

        // Débito atômico ANTES de chamar Gemini — evita double-spend em requisições concorrentes
        const { data: remaining, error: debitErr } = await _sb.rpc('debit_credit', { p_user_id: user.id })
        if (debitErr) {
            return new Response(JSON.stringify({ error: 'sem_creditos' }), {
                status: 402,
                headers: { ...CORS, 'Content-Type': 'application/json' }
            })
        }
        if (remaining === -1) {
            return new Response(JSON.stringify({ error: 'rate_limit' }), {
                status: 429,
                headers: { ...CORS, 'Content-Type': 'application/json' }
            })
        }
        if (remaining === null || remaining === undefined) {
            return new Response(JSON.stringify({ error: 'sem_creditos' }), {
                status: 402,
                headers: { ...CORS, 'Content-Type': 'application/json' }
            })
        }

        // Chamar Gemini
        const geminiKey = Deno.env.get('GEMINI_KEY') ?? ''
        const geminiBody: Record<string, unknown> = { contents }
        if (system_instruction) geminiBody.system_instruction = system_instruction
        if (generationConfig)   geminiBody.generationConfig   = generationConfig

        const geminiResp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${geminiKey}`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(geminiBody) }
        )

        if (!geminiResp.ok) {
            // Estorna crédito — professor não deve pagar por falha da IA
            try { await _sb.rpc('refund_credit', { p_user_id: user.id }) } catch (_) { /* ignore */ }
            const errText = await geminiResp.text()
            return new Response(errText, { status: geminiResp.status, headers: CORS })
        }

        const data = await geminiResp.json()
        return new Response(JSON.stringify(data), {
            headers: { ...CORS, 'Content-Type': 'application/json' }
        })

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return new Response(JSON.stringify({ error: msg }), {
            status: 500,
            headers: { ...CORS, 'Content-Type': 'application/json' }
        })
    }
})
