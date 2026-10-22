import { createClient } from "jsr:@supabase/supabase-js@2";

const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: ok } = await sb.rpc("verificar_clave_cerebro", { p: req.headers.get("x-cerebro-clave") ?? "" });
  if (ok !== true) return json({ error: "No autorizado" }, 401);

  const nombres = Object.keys(Deno.env.toObject()).filter((n) => !n.startsWith("SUPABASE_") && !n.startsWith("SB_") && !n.startsWith("DENO_"));
  const key = (Deno.env.get("GROQ_API_KEY") ?? "").trim();
  const modelo = Deno.env.get("GROQ_MODEL") || "openai/gpt-oss-120b";
  if (!key) return json({ ok: false, error: "No existe el secreto GROQ_API_KEY", secretos_visibles: nombres });

  const resultado: Record<string, unknown> = {
    modelo_usado: modelo,
    modelo_viene_de: Deno.env.get("GROQ_MODEL") ? "secreto GROQ_MODEL" : "valor por defecto",
  };
  try {
    const t0 = Date.now();
    const c = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: modelo, messages: [{ role: "user", content: "Responde solo con la palabra: listo" }], max_tokens: 200 }),
      signal: AbortSignal.timeout(25000),
    });
    const cd = await c.json().catch(() => null);
    resultado.prueba_chat = c.ok
      ? { ok: true, ms: Date.now() - t0, respuesta: String(cd?.choices?.[0]?.message?.content ?? "").slice(0, 60) }
      : { ok: false, status: c.status, error: cd?.error?.message ?? "sin detalle" };
  } catch (e) {
    resultado.prueba_chat = { ok: false, error: String((e as Error)?.message ?? e) };
  }
  return json(resultado);
});
