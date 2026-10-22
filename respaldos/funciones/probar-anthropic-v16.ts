import { createClient } from "jsr:@supabase/supabase-js@2";

const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: ok } = await sb.rpc("verificar_clave_cerebro", { p: req.headers.get("x-cerebro-clave") ?? "" });
  if (ok !== true) return json({ error: "No autorizado" }, 401);

  // Solo nombres de secretos (nunca valores)
  const nombres = Object.keys(Deno.env.toObject()).filter((n) => !n.startsWith("SUPABASE_") && !n.startsWith("SB_") && !n.startsWith("DENO_"));
  const candidatos = nombres.filter((n) => /anthropic|claude/i.test(n));
  if (!candidatos.length) {
    return json({ ok: false, error: "No hay ningun secreto con nombre ANTHROPIC o CLAUDE", secretos_visibles: nombres });
  }

  const nombre = candidatos.includes("ANTHROPIC_API_KEY") ? "ANTHROPIC_API_KEY" : candidatos[0];
  const key = Deno.env.get(nombre) ?? "";
  let r: Response;
  try {
    r = await fetch("https://api.anthropic.com/v1/models?limit=20", {
      headers: { "x-api-key": key.trim(), "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    return json({ ok: false, error: `Error de red: ${String((e as Error)?.message ?? e)}`, secreto: nombre });
  }
  const d = await r.json().catch(() => null);
  return json({
    ok: r.ok,
    status: r.status,
    secreto: nombre,
    largo_llave: key.length,
    prefijo: key.slice(0, 4),
    formato_correcto: key.startsWith("sk-ant-"),
    modelos: r.ok ? (d?.data ?? []).map((m: any) => m.id) : null,
    error: r.ok ? null : (d?.error?.message ?? "sin detalle"),
    secretos_visibles: nombres,
  });
});
